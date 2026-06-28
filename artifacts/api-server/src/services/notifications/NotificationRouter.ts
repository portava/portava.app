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

      const tokens = [
        ...((devices ?? []) as any[]).map((d: any) => d.push_token as string),
        (profile as any)?.expo_push_token ?? null,
      ].filter(Boolean);

      if (tokens.length === 0) {
        await this.logAttempt(notification.id, userId, 'push', 'suppressed', 'no push tokens');
        return;
      }

      // Use the stripped payload (private location redacted from body/data)
      const { strippedPayload } = decision;
      const pushPayload = {
        title: strippedPayload.title,
        body:  strippedPayload.body,
        data:  strippedPayload.data ?? {},
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

      // Remove any tokens Expo reports as no longer registered
      const staleTokens = pushResult.errors
        .filter((e) => e.error === "DeviceNotRegistered")
        .map((e) => e.token);

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
   */
  private async cleanupStaleTokens(
    userId: string,
    staleTokens: string[],
    legacyToken: string | null,
  ): Promise<void> {
    try {
      await this.db
        .from('notification_devices')
        .delete()
        .eq('user_id', userId)
        .in('push_token', staleTokens);

      if (legacyToken && staleTokens.includes(legacyToken)) {
        await this.db
          .from('profiles')
          .update({ expo_push_token: null })
          .eq('id', userId);
      }

      logger.info(
        { userId, staleCount: staleTokens.length },
        'NotificationRouter: removed stale push tokens',
      );
    } catch (err) {
      logger.warn({ err, userId }, 'NotificationRouter: failed to clean up stale tokens');
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
