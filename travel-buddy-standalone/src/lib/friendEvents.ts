/**
 * Friend-events bus — a tiny cross-surface signal for friendship changes.
 *
 * When a friendship changes on one surface (e.g. a friend request is
 * auto-accepted from a profile page), other already-mounted surfaces
 * (My Friends list, incoming-request rows, request inbox) subscribe here
 * and reload so they reflect the change without a manual refresh.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe to friendship changes. Returns an unsubscribe function. */
export function onFriendsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Notify all subscribers that friendships / friend requests changed. */
export function emitFriendsChanged(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // One bad subscriber must not block the rest.
    }
  }
}

/** Test helper — number of active subscribers. */
export function _friendListenerCount(): number {
  return listeners.size;
}
