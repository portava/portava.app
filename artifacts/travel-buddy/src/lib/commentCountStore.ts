/**
 * commentCountStore — lightweight in-process comment-count override store.
 *
 * The post detail screen emits the live comment count whenever it changes.
 * Feed screens subscribe (or read a snapshot on focus) and apply the override
 * so the feed card shows the correct count immediately on return — without
 * waiting for a full feed reload to complete.
 *
 * Intentionally dependency-free: no React, no state library, no side-effects.
 */

type CountListener = (postId: string, count: number) => void;

const _listeners = new Set<CountListener>();

/** Latest known count per postId, accumulated across the process lifetime. */
const _latest = new Map<string, number>();

/**
 * Emit a new comment count for `postId`.
 * Stores the value and notifies all active subscribers.
 */
export function emitCommentCount(postId: string, count: number): void {
  _latest.set(postId, count);
  _listeners.forEach((fn) => fn(postId, count));
}

/**
 * Subscribe to comment count updates.
 * Returns an unsubscribe function — call it in your cleanup / useEffect return.
 */
export function subscribeCommentCount(fn: CountListener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Returns a snapshot of all known overrides accumulated since process start.
 * Use this to seed the initial state when a screen mounts or regains focus,
 * so overrides that were emitted while the screen was in the background are
 * applied immediately without waiting for the next emission.
 */
export function getCommentCountSnapshot(): ReadonlyMap<string, number> {
  return _latest;
}
