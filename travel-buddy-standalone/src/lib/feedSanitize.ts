/**
 * Pure feed-hygiene helpers for the Pulse wall hooks (useGlobalFeed /
 * useFollowingFeed). Kept React-free so node:test can cover them directly.
 *
 * Why this exists: the FlatList keyExtractor must always return a non-empty,
 * unique string. Rows with a missing/empty id or duplicate ids cause unstable
 * keys, which manifests as scroll jumps and re-mount jank mid-scroll.
 */

/** Minimal shape shared by every feed row we sanitize. */
export interface FeedRowLike {
  id: string;
}

/**
 * Drop rows with a null/undefined/empty id and de-duplicate by id
 * (first occurrence wins). Guarantees every surviving row has a unique,
 * non-empty string id — safe for FlatList keyExtractor.
 */
export function sanitizeFeedRows<T extends FeedRowLike>(rows: readonly (T | null | undefined)[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (!row) continue;
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

/**
 * Split a freshly-fetched page against the currently displayed list.
 *
 * Returns the fetched rows that are NOT already displayed (`pending`) so the
 * caller can buffer them behind a "N new posts" pill instead of prepending
 * immediately (which would jump the user's scroll position).
 *
 * When the current list is empty there is nothing to disrupt, so everything
 * goes straight to `replace` and `pending` is empty.
 */
export function splitPendingPosts<T extends FeedRowLike>(
  current: readonly T[],
  fetched: readonly T[],
): { pending: T[]; replace: T[] | null } {
  const cleanFetched = sanitizeFeedRows(fetched);
  if (current.length === 0) {
    return { pending: [], replace: cleanFetched };
  }
  const currentIds = new Set(current.map((r) => r.id));
  return { pending: cleanFetched.filter((r) => !currentIds.has(r.id)), replace: null };
}
