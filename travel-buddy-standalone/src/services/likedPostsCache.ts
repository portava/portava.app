/**
 * likedPostsCache — lightweight in-memory cache of post like state.
 *
 * Tracks which posts the current user has explicitly liked or unliked during
 * the current session. Feed rows read from this cache to immediately show the
 * correct heart indicator on re-mount — even before the fresh feed data
 * arrives from the API — eliminating the stale-heart flicker and the round-
 * trip cost of re-checking like status for posts the user has already
 * interacted with.
 *
 * Design notes:
 *   • In-memory only (no AsyncStorage) — intentionally ephemeral per launch.
 *     The cache only covers posts the user has interacted with in this session;
 *     for everything else the component falls back to the prop from the feed.
 *   • Keyed by userId → Map<postId, boolean> so device-sharing / account
 *     switching works correctly without stale entries leaking between users.
 *   • Cleared on sign-out via clearForUser() called from SessionContext.
 *   • Thread-safe by JS single-threaded nature; no locking needed.
 */

const _store = new Map<string, Map<string, boolean>>();

/**
 * Record that the given user liked or unliked a post.
 * Called optimistically before the API round-trip so re-mounts reflect the
 * user's intent immediately.
 */
export function setLiked(userId: string, postId: string, liked: boolean): void {
  let userMap = _store.get(userId);
  if (!userMap) {
    userMap = new Map<string, boolean>();
    _store.set(userId, userMap);
  }
  userMap.set(postId, liked);
}

/**
 * Returns the cached like state for a post, or `undefined` if the user has
 * not interacted with this post in the current session.
 *
 * `undefined` means "no data — fall back to the prop from the feed API".
 */
export function getLiked(userId: string, postId: string): boolean | undefined {
  return _store.get(userId)?.get(postId);
}

/**
 * Remove all cache entries for a user.
 * Call this on sign-out so a subsequent login (same or different account)
 * starts clean.
 */
export function clearForUser(userId: string): void {
  _store.delete(userId);
}

/**
 * Remove all cache entries for all users.
 * Useful for testing or a full app reset.
 */
export function clearAll(): void {
  _store.clear();
}
