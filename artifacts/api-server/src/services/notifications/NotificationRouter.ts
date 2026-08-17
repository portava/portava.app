/**
 * NotificationRouter
 *
 * Decides delivery channels for a notification record, dispatches via each
 * active channel, and logs every attempt to notification_delivery_attempts.
 *
 * Channel dispatch:
 *   in_app   — persisted in notifications table (already done by NotificationService)
 *   push     — via existing push.ts helper (Expo Push API)
 *   email    — stub (logs attempt as 'suppressed'; real provider wired separately)
 *   sms      — stub (logs attempt as 'suppressed'; real provider out of scope)
 *   telegraph — Telegraph system-message for telegraph-category events
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { sendPushNotification } from "../../lib/push.js";
import { PushRetryQueue } from "../../lib/pushRetryQueue.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { NotificationPreferenceService } from "./NotificationPreferenceService.js";
import { TEMPLATES } from "./NotificationTemplateService.js";
import type { NotificationRow } from "./NotificationService.js";
import type { NotificationPriority, NotificationChannel } from "./NotificationTemplateService.js";
import {
  evaluateNotification,
  type NotificationType,
  type NotificationPayload,
} from "../../compass/CompassNotificationEngine.js";

const logger = rootLogger.child({ service: "NotificationRouter" });

// ── Cleanup failure tracking ──────────────────────────────────────────────────
// Counts consecutive cleanup failures so the log level can escalate from warn
// to error after repeated problems — making zombie-token accumulation visible
// to monitoring even when individual failures look transient.
let _consecutiveCleanupFailures = 0;
const CLEANUP_ERROR_THRESHOLD = 3; // escalate to error after this many in a row

/** Exported for unit tests to reset between cases. */
export function _resetCleanupFailureCount(): void {
  _consecutiveCleanupFailures = 0;
}

/** Exported for unit tests to inspect current value. */
export function _getCleanupFailureCount(): number {
  return _consecutiveCleanupFailures;
}

/** Exported for unit tests to spy on logger calls (e.g. info-level success log). */
export { logger as _notificationRouterLogger };

/**
 * Map a NotificationRow's category/eventType to a CompassNotificationType
 * priority level. Safety-related events are always treated as highest priority
 * so they bypass quiet hours and other suppression rules.
 */
function mapToCompassNotificationType(n: NotificationRow): NotificationType {
  const cat = (n.category ?? "").toLowerCase();
  const evt = (n.eventType ?? "").toLowerCase();

  if (cat === "safety" || evt.includes("sos") || evt.includes("safe_return") || evt.includes("danger")) {
    return "emergency_safety";
  }
  if (cat === "moderation" || evt.includes("block") || evt.includes("suspend") || evt.includes("report_confirmed")) {
    return "safety_alert";
  }
  if (cat === "trip" && (evt.includes("cancel") || evt.includes("critical") || evt.includes("flight"))) {
    return "trip_critical";
  }
  if (cat === "booking" || evt.includes("booking")) return "booking_update";
  if (evt.includes("urgent") && (cat === "message" || evt.includes("message"))) return "message_urgent";
  if (cat === "message" || evt.includes("message") || evt.includes("chat")) return "message_normal";
  if (cat === "social" || evt.includes("follow") || evt.includes("like") || evt.includes("meetup") || evt.includes("circle")) {
    return "activity_social";
  }
  if (cat === "compass" || evt.includes("recommend") || evt.includes("suggestion")) return "recommendation";
  if (cat === "discovery" || evt.includes("discover") || evt.includes("nearby") || evt.includes("event")) {
    return "discovery";
  }
  return "general";
}

export class NotificationRouter {
  private readonly prefService: NotificationPreferenceService;

  constructor(private readonly db: SupabaseClient) {
    this.prefService = new NotificationPreferenceService(db);
  }

  /**
   * Route a notification to all appropriate channels.
   * Assumes the notification row has already been persisted by NotificationService.
   */
  async route(notification: NotificationRow): Promise<void> {
    const { userId } = notification;

    // Load user preferences
    const prefs    = await this.prefService.getPreferences(userId);
    const catPrefs = (await this.prefService.getCategoryPreferences(userId))
      .find((c) => c.category === notification.category);

    // Derive channels from the template definition; fall back to ['in_app','push']
    const template = TEMPLATES.find((t) => t.eventType === notification.eventType);
    const wantedChannels: NotificationChannel[] = (template?.defaultChannels as NotificationChannel[]) ?? ['in_app', 'push'];
    const activeChannels = this.prefService.filterChannels(
      wantedChannels,
      prefs,
      catPrefs,
      notification.priority as NotificationPriority,
      notification.category,
    );

    await Promise.allSettled([
      // in_app is already persisted — just log
      this.logAttempt(notification.id, userId, 'in_app', activeChannels.includes('in_app') ? 'sent' : 'suppressed'),
      // push
      activeChannels.includes('push')
        ? this.sendPush(notification, userId)
        : this.logAttempt(notification.id, userId, 'push', 'suppressed'),
      // telegraph — only dispatched when the channel is active after preference filtering
      activeChannels.includes('telegraph')
        ? this.sendTelegraphSystemMsg(notification, userId)
        : (notification.category === 'telegraph'
            ? this.logAttempt(notification.id, userId, 'telegraph', 'suppressed', 'telegraph channel suppressed by preferences')
            : Promise.resolve()),
      // email stub
      this.logAttempt(notification.id, userId, 'email', 'suppressed', 'email provider not configured'),
      // sms stub — logged for audit trail completeness; real provider out of scope
      this.logAttempt(notification.id, userId, 'sms', 'suppressed', 'sms provider not configured'),
    ]);
  }

  private async sendPush(notification: NotificationRow, userId: string): Promise<void> {
    try {
      // ── Admin kill switch ──────────────────────────────────────────────────
      // push_notifications_enabled is a CAPABILITY gate: true = push on.
      // isFlagEnabled returns false on any DB error (fail-closed), which is the
      // conservative direction — suppressing push on a DB error is preferable to
      // sending during an incident after an operator toggled this off.
      if (!(await isFlagEnabled(this.db, "push_notifications_enabled"))) {
        logger.debug(
          { notificationId: notification.id },
          "NotificationRouter: push suppressed — push_notifications_enabled=false",
        );
        await this.logAttempt(
          notification.id, userId, "push", "suppressed",
          "push_notifications_enabled=false",
        );
        return;
      }
      // ── Compass intelligence gate ──────────────────────────────────────────
      // Evaluate priority, quiet hours, category mute, safety filter, and
      // private-location redaction before dispatching the push.
      const compassPayload: NotificationPayload = {
        type:     mapToCompassNotificationType(notification),
        title:    notification.title,
        body:     notification.body,
        category: notification.category ?? undefined,
        data:     {
          notificationId: notification.id,
          category:       notification.category,
          eventType:      notification.eventType,
          actionUrl:      notification.actionUrl ?? undefined,
          ...(notification.metadata ?? {}),
        },
      };

      const decision = await evaluateNotification(this.db, userId, compassPayload);

      if (decision.outcome !== "sent") {
        logger.debug(
          { notificationId: notification.id, outcome: decision.outcome },
          "NotificationRouter: push suppressed by Compass intelligence",
        );
        await this.logAttempt(
          notification.id, userId, "push", "suppressed",
          decision.suppressionReason ?? decision.outcome,
        );
        return;
      }
      // ── End Compass gate ───────────────────────────────────────────────────

      // Gather all push tokens registered for this user
      const { data: devices } = await this.db
        .from('notification_devices')
        .select('push_token')
        .eq('user_id', userId);

      // Also check legacy expo_push_token on profiles
      const { data: profile } = await this.db
        .from('profiles')
        .select('expo_push_token')
        .eq('id', userId)
        .maybeSingle();

      // Deduped: the legacy profiles.expo_push_token was populated from the same
      // Expo token that later landed in devices.push_token, so for most users
      // the two sources return the SAME string and every routed push was
      // delivered twice.
      const tokens = [
        ...new Set(
          [
            ...((devices ?? []) as any[]).map((d: any) => d.push_token as string),
            (profile as any)?.expo_push_token ?? null,
          ].filter(Boolean),
        ),
      ];

      if (tokens.length === 0) {
        await this.logAttempt(notification.id, userId, 'push', 'suppressed', 'no push tokens');
        return;
      }

      // Use the stripped payload (private location redacted from body/data)
      const { strippedPayload } = decision;

      // Incoming-call notifications must use "high" priority so FCM wakes a
      // backgrounded Android device and APNs delivers immediately on iOS.
      // Other "important"-priority events keep the Expo default so we don't
      // over-use high-priority quota (FCM limits aggressive callers).
      const pushPriority: "high" | undefined =
        notification.eventType === "call.incoming" ? "high" : undefined;

      // Incoming-call notifications must target the "incoming_calls" Android
      // notification channel (registered in app.json with importance: max) so
      // FCM surfaces the notification as a heads-up overlay on Android 8+.
      const pushChannelId: string | undefined =
        notification.eventType === "call.incoming" ? "incoming_calls" : undefined;

      const pushPayload = {
        title:    strippedPayload.title,
        body:     strippedPayload.body,
        data:     strippedPayload.data ?? {},
        ...(pushPriority   !== undefined ? { priority:  pushPriority  } : {}),
        ...(pushChannelId  !== undefined ? { channelId: pushChannelId } : {}),
      };

      const pushResult = await sendPushNotification(tokens, pushPayload);

      // ── Retry queue for transient failures ─────────────────────────────────
      if (pushResult.retryable) {
        // Create a 'pending' delivery attempt — the retry queue will update it
        // to 'sent' or 'failed' once the delivery is resolved.
        const attemptId = await this.logAttemptReturnId(
          notification.id, userId, 'push', 'pending',
          'transient failure — queued for retry',
          { tokenCount: tokens.length },
        );

        const retryQueue = new PushRetryQueue(this.db);
        await retryQueue.enqueue({
          notificationId:     notification.id,
          userId,
          tokens:             tokens as string[],
          payload:            pushPayload,
          deliveryAttemptId:  attemptId,
          lastError:          'transient failure on initial attempt',
        });

        logger.info(
          { notificationId: notification.id, userId },
          'NotificationRouter: push queued for retry after transient failure',
        );
        return;
      }
      // ── End retry queue ────────────────────────────────────────────────────

      // ── Token error triage ─────────────────────────────────────────────────
      // DeviceNotRegistered  — device is permanently gone; delete the token.
      // InvalidCredentials   — push credentials are wrong for this token (always
      //                        undeliverable); treat the same as DeviceNotRegistered
      //                        and delete so the token doesn't accumulate.
      // MessageRateExceeded  — the token is still valid but the send rate is too
      //                        high right now.  Do NOT delete; log a warning so
      //                        operators can see the pressure.  The retry queue
      //                        handles re-dispatch for transient failures; a
      //                        separate rate-limit back-off strategy can be added
      //                        on top without touching the token registry.
      const staleTokens = pushResult.errors
        .filter((e) => e.error === "DeviceNotRegistered" || e.error === "InvalidCredentials")
        .map((e) => e.token);

      const rateLimitedTokens = pushResult.errors
        .filter((e) => e.error === "MessageRateExceeded")
        .map((e) => e.token);

      if (rateLimitedTokens.length > 0) {
        logger.warn(
          { userId, rateLimitedCount: rateLimitedTokens.length },
          "NotificationRouter: MessageRateExceeded — tokens are valid but rate-limited; not removed",
        );
      }

      if (staleTokens.length > 0) {
        await this.cleanupStaleTokens(
          userId,
          staleTokens,
          (profile as any)?.expo_push_token ?? null,
        );
      }

      await this.logAttempt(notification.id, userId, 'push', 'sent', undefined, {
        tokenCount: tokens.length,
      });
    } catch (err) {
      logger.warn({ err, notificationId: notification.id }, 'NotificationRouter: push failed');
      await this.logAttempt(notification.id, userId, 'push', 'failed', String(err));
    }
  }

  /**
   * Delete stale push tokens from the DB after Expo reports DeviceNotRegistered.
   * Clears matching rows from notification_devices and, if the legacy
   * profiles.expo_push_token column holds one of the stale tokens, nulls it out.
   *
   * Each DB operation is wrapped in its own try/catch so a failure in one step
   * is independently logged with a structured event (operation, staleCount,
   * consecutiveFailures). After CLEANUP_ERROR_THRESHOLD consecutive failures the
   * log level escalates from warn to error so monitoring can alert on zombie-token
   * accumulation.
   */
  private async cleanupStaleTokens(
    userId: string,
    staleTokens: string[],
    legacyToken: string | null,
  ): Promise<void> {
    const staleCount = staleTokens.length;
    let anyFailure = false;

    // ── Step 1: remove from notification_devices ──────────────────────────────
    try {
      const { error } = await this.db
        .from('notification_devices')
        .delete()
        .eq('user_id', userId)
        .in('push_token', staleTokens);

      if (error) throw error;
    } catch (err) {
      anyFailure = true;
      _consecutiveCleanupFailures += 1;
      const logFields = {
        err,
        userId,
        staleCount,
        operation: 'delete_notification_devices',
        consecutiveFailures: _consecutiveCleanupFailures,
      };
      if (_consecutiveCleanupFailures >= CLEANUP_ERROR_THRESHOLD) {
        logger.error(logFields, 'NotificationRouter: stale-token cleanup failed — zombie tokens may accumulate');
      } else {
        logger.warn(logFields, 'NotificationRouter: failed to delete stale tokens from notification_devices');
      }
    }

    // ── Step 2: null out legacy expo_push_token on profiles ───────────────────
    if (legacyToken && staleTokens.includes(legacyToken)) {
      try {
        const { error } = await this.db
          .from('profiles')
          .update({ expo_push_token: null })
          .eq('id', userId);

        if (error) throw error;
      } catch (err) {
        anyFailure = true;
        _consecutiveCleanupFailures += 1;
        const logFields = {
          err,
          userId,
          staleCount,
          operation: 'null_legacy_expo_push_token',
          consecutiveFailures: _consecutiveCleanupFailures,
        };
        if (_consecutiveCleanupFailures >= CLEANUP_ERROR_THRESHOLD) {
          logger.error(logFields, 'NotificationRouter: stale-token cleanup failed — zombie tokens may accumulate');
        } else {
          logger.warn(logFields, 'NotificationRouter: failed to null legacy expo_push_token on profile');
        }
      }
    }

    // ── Step 3: null out expo_push_token on rent_buddy_profiles ──────────────
    try {
      const { error } = await this.db
        .from('rent_buddy_profiles')
        .update({ expo_push_token: null })
        .in('expo_push_token', staleTokens);

      if (error) throw error;
    } catch (err) {
      anyFailure = true;
      _consecutiveCleanupFailures += 1;
      const logFields = {
        err,
        userId,
        staleCount,
        operation: 'null_rent_buddy_expo_push_token',
        consecutiveFailures: _consecutiveCleanupFailures,
      };
      if (_consecutiveCleanupFailures >= CLEANUP_ERROR_THRESHOLD) {
        logger.error(logFields, 'NotificationRouter: stale-token cleanup failed — zombie tokens may accumulate');
      } else {
        logger.warn(logFields, 'NotificationRouter: failed to null expo_push_token on rent_buddy_profiles');
      }
    }

    if (!anyFailure) {
      _consecutiveCleanupFailures = 0;
      logger.info(
        { userId, staleCount },
        'NotificationRouter: removed stale push tokens',
      );
    }
  }

  private async sendTelegraphSystemMsg(notification: NotificationRow, userId: string): Promise<void> {
    try {
      // Find the telegraph thread for this user (if sourceId is a threadId)
      const threadId = notification.sourceId;
      if (!threadId) {
        await this.logAttempt(notification.id, userId, 'telegraph', 'suppressed', 'no thread id');
        return;
      }

      // Insert a system message into the thread
      await this.db.from('messages').insert({
        thread_id:  threadId,
        sender_id:  userId, // system message attributed to recipient
        body:       notification.body,
        msg_type:   'system',
        subtype:    notification.eventType,
      });

      await this.logAttempt(notification.id, userId, 'telegraph', 'sent');
    } catch (err) {
      logger.warn({ err, notificationId: notification.id }, 'NotificationRouter: telegraph msg failed');
      await this.logAttempt(notification.id, userId, 'telegraph', 'failed', String(err));
    }
  }

  private async logAttempt(
    notificationId: string,
    userId: string,
    channel: string,
    status: 'pending' | 'sent' | 'delivered' | 'failed' | 'suppressed',
    errorMessage?: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.logAttemptReturnId(notificationId, userId, channel, status, errorMessage, metadata);
  }

  /**
   * Insert a delivery attempt row and return its generated UUID.
   * Returns null if the insert fails so callers can degrade gracefully.
   */
  private async logAttemptReturnId(
    notificationId: string,
    userId: string,
    channel: string,
    status: 'pending' | 'sent' | 'delivered' | 'failed' | 'suppressed',
    errorMessage?: string,
    metadata: Record<string, unknown> = {},
  ): Promise<string | null> {
    try {
      const { data, error } = await this.db
        .from('notification_delivery_attempts')
        .insert({
          notification_id: notificationId,
          user_id:         userId,
          channel,
          status,
          error_message:   errorMessage ?? null,
          metadata,
        })
        .select('id')
        .single();

      if (error) {
        logger.warn({ err: error }, 'NotificationRouter: failed to log delivery attempt');
        return null;
      }

      return (data as any)?.id ?? null;
    } catch (err) {
      logger.warn({ err }, 'NotificationRouter: failed to log delivery attempt');
      return null;
    }
  }
}
