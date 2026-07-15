/**
 * savedPostsCache — lightweight in-memory cache of post save (bookmark) state.
 *
 * Tracks which posts the current user has explicitly saved or unsaved during
 * the current session. Feed rows read from this cache to immediately show the
 * correct bookmark indicator on re-mount — even before the fresh feed data
 * arrives from the API — eliminating the stale-bookmark flicker and the round-
 * trip cost of re-checking save status for posts the user has already
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
 *   • Mirrors likedPostsCache.ts — same shape, same contract.
 */

const _store = new Map<string, Map<string, boolean>>();

/**
 * Record that the given user saved or unsaved a post.
 * Called optimistically before the API round-trip so re-mounts reflect the
 * user's intent immediately.
 */
export function setSaved(userId: string, postId: string, saved: boolean): void {
  let userMap = _store.get(userId);
  if (!userMap) {
    userMap = new Map<string, boolean>();
    _store.set(userId, userMap);
  }
  userMap.set(postId, saved);
}

/**
 * Returns the cached save state for a post, or `undefined` if the user has
 * not interacted with this post in the current session.
 *
 * `undefined` means "no data — fall back to the prop from the feed API".
 */
export function getSaved(userId: string, postId: string): boolean | undefined {
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
 * Bulk-seed the cache from an API preload (e.g. fetched on sign-in).
 *
 * Only sets entries that are NOT already in the cache so in-session explicit
 * save/unsave actions are never overwritten by a late-arriving preload response.
 * Posts not in `postIds` are left untouched — the caller provides the saved set,
 * not the full universe; absent posts fall back to the feed-data prop as before.
 */
export function primeSaved(userId: string, postIds: string[]): void {
  let userMap = _store.get(userId);
  if (!userMap) {
    userMap = new Map<string, boolean>();
    _store.set(userId, userMap);
  }
  for (const postId of postIds) {
    if (!userMap.has(postId)) {
      userMap.set(postId, true);
    }
  }
}

/**
 * Remove all cache entries for all users.
 * Useful for testing or a full app reset.
 */
export function clearAll(): void {
  _store.clear();
}
