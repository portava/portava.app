/**
 * Per-user suggestion seen-IDs cache.
 *
 * Tracks the profile IDs recently served as suggestions for each user so that
 * the next request can exclude them and surface genuinely fresh faces.
 *
 * Design constraints:
 *   - Single in-process Map; no external dependency (no Redis required).
 *   - Each user entry expires after SEEN_TTL_MS of inactivity (default 24 h).
 *   - Seen-set capped at MAX_SEEN_PER_USER to bound memory.
 *   - When the full fallback pool is smaller than the exclusion list the cache
 *     is cleared automatically so the user never sees an empty list.
 */

const SEEN_TTL_MS =
  parseInt(process.env.SUGGESTION_SEEN_TTL_HOURS ?? "24", 10) * 60 * 60 * 1000;

const MAX_SEEN_PER_USER =
  parseInt(process.env.SUGGESTION_SEEN_MAX ?? "200", 10);

interface Entry {
  ids: Set<string>;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

function getEntry(userId: string): Entry | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(userId);
    return null;
  }
  return entry;
}

/**
 * Return the set of IDs the user has already seen (empty set if none / expired).
 */
export function getSeenIds(userId: string): Set<string> {
  return getEntry(userId)?.ids ?? new Set();
}

/**
 * Record a batch of IDs that were just served to the user.
 * Resets the TTL window.
 */
export function markAsSeen(userId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const entry = getEntry(userId) ?? { ids: new Set<string>(), expiresAt: 0 };

  for (const id of ids) {
    entry.ids.add(id);
  }

  // Cap at MAX_SEEN_PER_USER (drop oldest by converting to array and trimming)
  if (entry.ids.size > MAX_SEEN_PER_USER) {
    const arr = Array.from(entry.ids);
    entry.ids = new Set(arr.slice(arr.length - MAX_SEEN_PER_USER));
  }

  entry.expiresAt = Date.now() + SEEN_TTL_MS;
  cache.set(userId, entry);
}

/**
 * Clear the seen list for a user.
 * Called automatically when the pool is exhausted so the user always gets results.
 */
export function clearSeen(userId: string): void {
  cache.delete(userId);
}

/** Test helper — wipe the entire cache between test cases. */
export function _clearAllSeen(): void {
  cache.clear();
}
