/**
 * Per-user suggestion seen-IDs cache.
 *
 * Tracks the profile IDs recently served as suggestions for each user so that
 * the next request can exclude them and surface genuinely fresh faces.
 *
 * Design constraints:
 *   - Single in-process Map; no external dependency (no Redis required).
 *   - Each user entry expires after SEEN_TTL_MS of inactivity (default 168 h / 7 days).
 *   - Seen-set capped at MAX_SEEN_PER_USER to bound memory.
 *   - When the full candidate pool is smaller than the exclusion list the cache
 *     is cleared automatically so the user never sees an empty list.
 *
 * Daily-seed helpers:
 *   - dailySeed(userId) — produces a stable 32-bit seed from the caller's id
 *     and today's UTC date (YYYY-MM-DD). Changes every midnight UTC so the
 *     shuffled pool order rotates without any external scheduler.
 *   - seededShuffle(arr, seed) — deterministic Fisher-Yates using mulberry32
 *     so the same seed always yields the same permutation within a day, while
 *     a different seed (= next day) produces an unrelated ordering.
 */

const SEEN_TTL_MS =
  parseInt(process.env.SUGGESTION_SEEN_TTL_HOURS ?? "168", 10) * 60 * 60 * 1000;

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

/* ===========================================================================
 * Daily-seed helpers
 * ===========================================================================
 * mulberry32 — fast, seedable 32-bit PRNG. Produces a float in [0, 1) like
 * Math.random() but is deterministic given the same seed value.
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive a stable 32-bit unsigned seed from a userId + today's UTC date
 * (YYYY-MM-DD). The seed changes every midnight UTC, so the shuffled pool
 * order rotates daily without any external scheduler or cron job.
 *
 * The djb2-style hash mixes userId with the date string so two different
 * users always get a different permutation of the same pool even on the same
 * calendar day.
 */
export function dailySeed(userId: string): number {
  const dateStr = new Date().toISOString().slice(0, 10);
  const combined = userId + ":" + dateStr;
  let h = 5381;
  for (let i = 0; i < combined.length; i++) {
    h = (Math.imul(h, 33) ^ combined.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * Deterministic Fisher-Yates shuffle driven by mulberry32(seed).
 * Returns a new array — the original is not mutated.
 */
export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = arr.slice();
  const rand = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}
