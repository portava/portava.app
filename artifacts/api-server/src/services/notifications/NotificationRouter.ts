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
import { NotificationPreferenceService } from "./NotificationPreferenceService.js";
import { TEMPLATES } from "./NotificationTemplateService.js";
import type { NotificationRow } from "./NotificationService.js";
import type { NotificationPriority, NotificationChannel } from "./NotificationTemplateService.js";

const logger = rootLogger.child({ service: "NotificationRouter" });

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

      await sendPushNotification(tokens, {
        title: notification.title,
        body:  notification.body,
        data:  {
          notificationId: notification.id,
          category:       notification.category,
          eventType:      notification.eventType,
          actionUrl:      notification.actionUrl ?? undefined,
          ...(notification.metadata ?? {}),
        },
      });

      await this.logAttempt(notification.id, userId, 'push', 'sent', undefined, {
        tokenCount: tokens.length,
      });
    } catch (err) {
      logger.warn({ err, notificationId: notification.id }, 'NotificationRouter: push failed');
      await this.logAttempt(notification.id, userId, 'push', 'failed', String(err));
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
    try {
      await this.db.from('notification_delivery_attempts').insert({
        notification_id: notificationId,
        user_id:         userId,
        channel,
        status,
        error_message:   errorMessage ?? null,
        metadata,
      });
    } catch (err) {
      logger.warn({ err }, 'NotificationRouter: failed to log delivery attempt');
    }
  }
}
