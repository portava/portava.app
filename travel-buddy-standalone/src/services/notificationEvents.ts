/**
 * In-app notification event bus.
 *
 * The SSE notification stream (useNotificationStream) emits every parsed
 * `notification.created` payload here so interested surfaces (e.g. the
 * Compass Live card) can react in the moment instead of waiting for their
 * next poll tick. Purely in-process; no network, no persistence.
 */

export interface NotificationCreatedEvent {
  id?: string;
  category?: string;
  eventType?: string;
  title?: string;
  body?: string;
  actionUrl?: string | null;
  createdAt?: string;
}

type Listener = (event: NotificationCreatedEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to notification.created events. Returns an unsubscribe fn. */
export function subscribeNotificationEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Emit a notification.created event to all subscribers (errors swallowed). */
export function emitNotificationEvent(event: NotificationCreatedEvent): void {
  for (const listener of Array.from(listeners)) {
    try { listener(event); } catch { /* listener errors must not break the stream */ }
  }
}
