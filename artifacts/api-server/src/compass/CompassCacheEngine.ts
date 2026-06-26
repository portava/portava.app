/**
 * CompassCacheEngine — Phase 4 feed caching and invalidation.
 *
 * Per-type TTLs:
 *   'safety'     → 0 ms  — safety data is NEVER served from cache
 *   'booking'    → 30 s
 *   'section'    → 2 min
 *   'feed'       → 5 min
 *   'city_guide' → 4 h
 *
 * Cache invalidation fires immediately (synchronously, within the same
 * request lifecycle) when called from a block/report/suspend/etc. route.
 * Each invalidation is appended to `compass_cache_invalidations` for
 * observability without blocking the caller.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type CacheEntryType = 'feed' | 'section' | 'city_guide' | 'booking' | 'frontload' | 'safety';

/** Per-type TTLs in milliseconds. 'safety' is 0 — always bypasses cache. */
const CACHE_TTL_MS: Record<CacheEntryType, number> = {
  safety:     0,             // never cached — see bypass check in getCachedFeed
  booking:    30_000,
  section:    2 * 60_000,
  feed:       5 * 60_000,
  frontload:  5 * 60_000,   // tier 1–3 preload assembly, same TTL as feed
  city_guide: 4 * 60 * 60_000,
};

export interface CachedFeedEntry<T = unknown> {
  payload:   T;
  cachedAt:  string;
  expiresAt: string;
}

// ── In-process L1 cache (avoids a DB round-trip for hot paths) ─────────────────

interface L1Entry {
  payload:   unknown;
  expiresAt: number;
}

const _l1 = new Map<string, L1Entry>();

function l1Key(userId: string, cacheKey: string): string {
  return `${userId}:${cacheKey}`;
}

function l1Get(userId: string, cacheKey: string): unknown | null {
  const entry = _l1.get(l1Key(userId, cacheKey));
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.payload;
}

function l1Set(userId: string, cacheKey: string, payload: unknown, ttlMs: number): void {
  _l1.set(l1Key(userId, cacheKey), { payload, expiresAt: Date.now() + ttlMs });
}

function l1Delete(userId: string): void {
  for (const key of _l1.keys()) {
    if (key.startsWith(`${userId}:`)) _l1.delete(key);
  }
}

/** Clear the entire L1 cache (useful in tests). */
export function clearL1Cache(): void {
  _l1.clear();
}

// ── getCachedFeed ─────────────────────────────────────────────────────────────

/**
 * Retrieve a cached feed payload for a user.
 *
 * Returns null when:
 *   - `entryType` is 'safety' (safety data is always live — TTL = 0)
 *   - The entry is expired or absent
 *   - The DB lookup fails (fail-open: we just rebuild)
 */
export async function getCachedFeed<T = unknown>(
  db:         SupabaseClient | null,
  userId:     string,
  cacheKey:   string,
  entryType:  CacheEntryType,
): Promise<T | null> {
  // Safety data always bypasses cache — no exception
  if (CACHE_TTL_MS[entryType] === 0) return null;

  // L1 hit
  const l1 = l1Get(userId, cacheKey);
  if (l1 !== null) return l1 as T;

  if (!db) return null;

  try {
    const now = new Date().toISOString();
    const { data } = await db
      .from("compass_feed_cache")
      .select("payload, expires_at")
      .eq("user_id", userId)
      .eq("cache_key", cacheKey)
      .gt("expires_at", now)
      .maybeSingle();

    if (!data) return null;

    const ttlMs = CACHE_TTL_MS[entryType];
    l1Set(userId, cacheKey, (data as any).payload, ttlMs);
    return (data as any).payload as T;
  } catch {
    return null;
  }
}

// ── setCachedFeed ─────────────────────────────────────────────────────────────

/**
 * Store a feed payload in the cache.
 * No-ops silently if the DB is unavailable or the write fails.
 * Safety entries are never written (TTL = 0).
 */
export async function setCachedFeed<T = unknown>(
  db:        SupabaseClient | null,
  userId:    string,
  cacheKey:  string,
  entryType: CacheEntryType,
  payload:   T,
): Promise<void> {
  const ttlMs = CACHE_TTL_MS[entryType];
  if (ttlMs === 0) return;

  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  // Update L1 immediately (even if DB write fails)
  l1Set(userId, cacheKey, payload, ttlMs);

  if (!db) return;

  try {
    await db
      .from("compass_feed_cache")
      .upsert(
        { user_id: userId, cache_key: cacheKey, entry_type: entryType, payload, expires_at: expiresAt },
        { onConflict: "user_id,cache_key" },
      );
  } catch { /* non-fatal */ }
}

// ── invalidate ────────────────────────────────────────────────────────────────

/**
 * Immediately invalidate all cache entries for a user and append an audit row
 * to `compass_cache_invalidations`.
 *
 * Called from: block/unblock, report, admin suspend, buddy revoke, post hide/delete,
 * event cancel, group leave, booking status change, delayed-post privacy change.
 *
 * This function is fire-and-forget safe — it logs but never throws.
 */
export async function invalidate(
  db:     SupabaseClient | null,
  userId: string,
  reason: string,
): Promise<void> {
  // Always evict L1 immediately
  l1Delete(userId);

  if (!db) return;

  try {
    // Collect affected keys for the audit log (best-effort, not guaranteed complete)
    const { data: rows } = await db
      .from("compass_feed_cache")
      .select("cache_key")
      .eq("user_id", userId);

    const affectedKeys: string[] = ((rows as any[]) ?? []).map((r: any) => r.cache_key as string);

    // Delete all cache rows for this user
    await db.from("compass_feed_cache").delete().eq("user_id", userId);

    // Audit log — non-blocking, ignore errors
    await db.from("compass_cache_invalidations").insert({
      user_id:       userId,
      reason,
      affected_keys: affectedKeys,
    });
  } catch { /* non-fatal */ }
}
