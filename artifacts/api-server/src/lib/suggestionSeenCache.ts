/**
 * Per-user suggestion seen-IDs cache.
 *
 * Tracks the profile IDs recently served as suggestions for each user so that
 * the next request can exclude them and surface genuinely fresh faces.
 *
 * Design constraints:
 *   - Hybrid write-through cache: in-process Map (L1) + DB persistence (L2).
 *   - After a server restart the L1 cache is empty; the first getSeenIds() call
 *     loads from the DB so users continue to see fresh faces across deploys.
 *   - DB writes (markAsSeen / clearSeen) are fire-and-forget: the in-memory
 *     state is updated synchronously, then the DB is written asynchronously
 *     so the response path is never blocked.
 *   - Each user entry expires after SEEN_TTL_MS of inactivity (default 168 h / 7 days).
 *   - Seen-set capped at MAX_SEEN_PER_USER to bound memory and DB row size.
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

/* ---------------------------------------------------------------------------
 * DB helpers (fire-and-forget — but NOT silent)
 * ---------------------------------------------------------------------------
 *
 * WHAT A SWALLOWED WRITE HERE ACTUALLY COSTS
 * ------------------------------------------
 * These two writes used to be `await sc.from(…).upsert(…)` with `{ error }`
 * unread inside an empty `catch`. supabase-js RESOLVES on a database error, so
 * the catch was dead code for the failure that matters and the L2 leg could
 * fail on every single request while the process reported nothing. A cache that
 * silently never writes is a performance bug shaped exactly like working code.
 *
 * The cost was measured against the only consumer (routes/follows.ts suggestion
 * strip), not assumed:
 *
 *   NOT a safety bug. Nothing about a PRIVACY decision is cached here — the set
 *   holds profile ids ALREADY SERVED, and the consumer only uses it to
 *   DEPRIORITISE candidates that have gone through the block / already-following
 *   / account-status filters on every request. A stale or oversized set can only
 *   ever remove candidates, never admit one, so serving a stale entry cannot
 *   disclose anything.
 *
 *   NOT an empty strip either. The consumer re-checks in-process: if excluding
 *   the seen ids would empty the pool it calls clearSeen() and uses the full
 *   pool. So a failed `clearSeenFromDb` cannot strand a user with no
 *   suggestions.
 *
 *   IT IS a freshness bug, and a permanent one. L1 is per-process: after a
 *   deploy, a restart, or simply on a second instance, L2 is the only shared
 *   memory of what a user has already been shown. If persistSeenIds never
 *   lands, "genuinely fresh faces" degrades to the same faces after every
 *   restart, for everyone, forever — with no error, no metric and no symptom
 *   anyone can name.
 *
 * So the writes stay fire-and-forget (the response path must never block on
 * them) and stop being silent: every leg binds `error` and reports it.
 */

async function persistSeenIds(userId: string, entry: Entry): Promise<void> {
  try {
    const { getServiceClient } = await import("./supabase.js");
    const { logger } = await import("./logger.js");
    const sc = getServiceClient();
    if (!sc) return;
    const { error } = await sc.from("user_suggestion_seen").upsert(
      {
        user_id: userId,
        seen_ids: Array.from(entry.ids),
        expires_at: new Date(entry.expiresAt).toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) {
      logger.warn(
        { err: error, userId, count: entry.ids.size, code: "suggestion_seen_persist_failed" },
        "suggestionSeenCache: L2 persist failed — seen state will not survive a restart",
      );
    }
  } catch (err) {
    // Reached only by a genuine throw (the dynamic import, not the query).
    const { logger } = await import("./logger.js");
    logger.warn({ err, userId, code: "suggestion_seen_persist_failed" }, "suggestionSeenCache: L2 persist threw");
  }
}

async function clearSeenFromDb(userId: string): Promise<void> {
  try {
    const { getServiceClient } = await import("./supabase.js");
    const { logger } = await import("./logger.js");
    const sc = getServiceClient();
    if (!sc) return;
    const { error } = await sc.from("user_suggestion_seen").delete().eq("user_id", userId);
    if (error) {
      logger.warn(
        { err: error, userId, code: "suggestion_seen_clear_failed" },
        "suggestionSeenCache: L2 clear failed — a stale seen set can be reloaded after a restart",
      );
    }
  } catch (err) {
    const { logger } = await import("./logger.js");
    logger.warn({ err, userId, code: "suggestion_seen_clear_failed" }, "suggestionSeenCache: L2 clear threw");
  }
}

/* ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Return the set of IDs the user has already seen (empty set if none / expired).
 *
 * Checks the in-process L1 cache first; on a miss (e.g. after a server restart)
 * falls back to the DB so seen state survives deploys.
 */
export async function getSeenIds(userId: string): Promise<Set<string>> {
  // L1: in-process cache (fast path — avoids DB round-trip within a session)
  const entry = getEntry(userId);
  if (entry) return entry.ids;

  // L2: DB fallback (first call after a restart, or after TTL expiry)
  try {
    const { getServiceClient } = await import("./supabase.js");
    const sc = getServiceClient();
    if (!sc) return new Set();
    const { data, error } = await sc
      .from("user_suggestion_seen")
      .select("seen_ids, expires_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      // "no row yet" and "the table could not be read" both land on an empty
      // set, and an empty set means the strip stops deduplicating and may
      // repeat faces. Harmless, but it is a DIFFERENT harmless from a first-time
      // user, so say which one this was.
      const { logger } = await import("./logger.js");
      logger.warn(
        { err: error, userId, code: "suggestion_seen_read_failed" },
        "suggestionSeenCache: L2 read failed — treating as no seen state (suggestions may repeat)",
      );
      return new Set();
    }
    if (!data) return new Set();
    const row = data as { seen_ids: string[] | null; expires_at: string };
    const expiresAt = new Date(row.expires_at).getTime();
    if (expiresAt < Date.now()) {
      void clearSeenFromDb(userId);
      return new Set();
    }
    const ids = new Set<string>(row.seen_ids ?? []);
    cache.set(userId, { ids, expiresAt });
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Record a batch of IDs that were just served to the user.
 * Updates the in-memory cache synchronously; persists to DB in the background.
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

  // Persist asynchronously — never block the request path
  void persistSeenIds(userId, entry);
}

/**
 * Clear the seen list for a user.
 * Called automatically when the pool is exhausted so the user always gets results.
 */
export function clearSeen(userId: string): void {
  cache.delete(userId);
  void clearSeenFromDb(userId);
}

/** Test helper — wipe the entire in-memory cache between test cases. */
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
