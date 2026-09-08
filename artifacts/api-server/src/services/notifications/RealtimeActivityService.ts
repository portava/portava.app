/**
 * RealtimeActivityService
 *
 * Broadcasts notification creation and read-state changes over the existing
 * SSE (server-sent events) realtime bus.
 *
 * Falls back to centralized polling via GET /api/me/notifications?since=.
 * Individual screens do NOT need their own poll loops.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import type { NotificationRow } from "./NotificationService.js";

const logger = rootLogger.child({ service: "RealtimeActivityService" });

// ── In-process event bus (same pattern as telegraph realtime) ─────────────────
type ActivityEventType = 'notification.created' | 'notification.read' | 'notification.dismissed' | 'unread_count.updated';

interface ActivityBusEvent {
  type: ActivityEventType;
  userId: string;
  payload: Record<string, unknown>;
}

type ActivityListener = (event: ActivityBusEvent) => void;

class ActivityBus {
  private listeners = new Set<ActivityListener>();

  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ActivityBusEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }
}

export const activityBus = new ActivityBus();

export class RealtimeActivityService {
  constructor(private readonly db: SupabaseClient) {}

  /** Emit a new-notification event on the in-process bus. */
  emitCreated(notification: NotificationRow): void {
    activityBus.emit({
      type:   'notification.created',
      userId: notification.userId,
      payload: {
        id:        notification.id,
        category:  notification.category,
        eventType: notification.eventType,
        priority:  notification.priority,
        title:     notification.title,
        body:      notification.body,
        actionUrl: notification.actionUrl,
        createdAt: notification.createdAt,
      },
    });
  }

  /** Emit a read-state change on the in-process bus. */
  emitRead(userId: string, notificationId: string): void {
    activityBus.emit({
      type:    'notification.read',
      userId,
      payload: { id: notificationId },
    });
    void this.emitUnreadUpdate(userId);
  }

  /**
   * Emit a dismissal on the in-process bus.
   *
   * `notification.dismissed` has been a member of ActivityEventType since this
   * file was written and NOTHING EVER EMITTED IT — a declared realtime event
   * that no producer produced, so any client subscribed to it waited forever
   * and the dismissed card stayed on other open sessions until a poll. The
   * dismiss route now calls this.
   */
  emitDismissed(userId: string, notificationId: string): void {
    activityBus.emit({
      type:    'notification.dismissed',
      userId,
      payload: { id: notificationId },
    });
    void this.emitUnreadUpdate(userId);
  }

  /**
   * Emit an unread-count update so client badges refresh.
   *
   * ── A DATABASE ERROR MUST NOT CLEAR THE BADGE ────────────────────────────
   * `const { count } = await …` discarded the error, and supabase-js resolves
   * rather than throws on one, so an unreadable notifications table produced
   * `count === null` and this emitted `unreadCount: 0` — actively telling every
   * connected client that the user had nothing unread. That is worse than
   * emitting nothing: it overwrites a correct badge with a wrong one, and the
   * user stops looking. When the count is unknown we now emit NOTHING and leave
   * the client showing the last value it was told.
   */
  async emitUnreadUpdate(userId: string): Promise<void> {
    try {
      const now = new Date().toISOString();
      const { count, error } = await (this.db
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('read_at', null)
        .is('dismissed_at', null)
        .or(`expires_at.is.null,expires_at.gt.${now}`) as any);

      if (error || count == null) {
        logger.warn({ err: error, userId }, 'RealtimeActivityService: unread count unknown — not emitting (a wrong zero would clear the badge)');
        return;
      }

      activityBus.emit({
        type:    'unread_count.updated',
        userId,
        payload: { unreadCount: count },
      });
    } catch (err) {
      logger.warn({ err, userId }, 'RealtimeActivityService: unread count emit failed');
    }
  }

  /**
   * Register an SSE response stream for a user.
   * Returns a cleanup function to call when the connection closes.
   */
  registerSSEStream(
    userId: string,
    write: (data: string) => void,
    onClose?: () => void,
  ): () => void {
    const unsub = activityBus.subscribe((event) => {
      if (event.userId !== userId) return;
      try {
        // Emit a proper SSE frame: event name line + data line.
        // Clients that don't handle the event: field fall back to parsing
        // the `type` field inside the JSON body.
        write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      } catch {
        // stream closed
      }
    });

    logger.debug({ userId }, 'RealtimeActivityService: SSE stream registered');
    return () => {
      unsub();
      onClose?.();
      logger.debug({ userId }, 'RealtimeActivityService: SSE stream closed');
    };
  }
}
