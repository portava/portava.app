/**
 * CompassFlags — reads Compass feature flags from the feature_flags table
 * with a short in-memory TTL cache (30 seconds).
 *
 * All Compass services call `isEnabled()` before executing logic.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const CACHE_TTL_MS = 30_000; // 30 seconds

interface CacheEntry {
  flags: Record<string, boolean>;
  cachedAt: number;
}

let _cache: CacheEntry | null = null;

/** Invalidate the in-memory cache (useful after flag writes in tests). */
export function invalidateFlagsCache(): void {
  _cache = null;
}

/** Load all feature_flags rows and return as a Record<flag, enabled>. */
async function loadFlags(db: SupabaseClient): Promise<Record<string, boolean>> {
  try {
    const { data } = await db
      .from("feature_flags")
      .select("flag, enabled")
      .like("flag", "COMPASS_%");
    const out: Record<string, boolean> = {};
    for (const row of (data as any[]) ?? []) {
      out[row.flag] = Boolean(row.enabled);
    }
    return out;
  } catch {
    return {};
  }
}

/** Return all Compass flags, using cache when fresh. */
async function getFlags(db: SupabaseClient): Promise<Record<string, boolean>> {
  if (_cache && Date.now() - _cache.cachedAt < CACHE_TTL_MS) {
    return _cache.flags;
  }
  const flags = await loadFlags(db);
  _cache = { flags, cachedAt: Date.now() };
  return flags;
}

/** Check whether a specific Compass feature flag is enabled. */
export async function isEnabled(db: SupabaseClient, flag: string): Promise<boolean> {
  const flags = await getFlags(db);
  return flags[flag] ?? false;
}

/** Check whether the master COMPASS_ENABLED flag is on. */
export async function isCompassEnabled(db: SupabaseClient): Promise<boolean> {
  return isEnabled(db, "COMPASS_ENABLED");
}
