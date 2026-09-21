/**
 * CompassFlags — reads Compass feature flags from the feature_flags table
 * with a short in-memory TTL cache (30 seconds).
 *
 * All Compass services call `isEnabled()` before executing logic.
 *
 * ── ONE FAILURE POLICY FOR ALL THREE COMPASS FLAG LOADERS ──────────────────
 * Compass loaded `LIKE 'COMPASS_%'` in THREE places — here, CompassPipeline
 * and CompassFrontLoadEngine — each with its own copy of the query and its own
 * idea of what an unreadable table means. All three ignored `.error` (supabase
 * RESOLVES on a database error, so their `try/catch` blocks were dead code) and
 * all three answered the same empty map. `fetchCompassFlags` below is now the
 * single loader; the other two call it, so there is one answer to argue about
 * instead of three that happened to coincide.
 *
 * ── WHY "ALL FLAGS OFF" IS NOT A SAFE DEFAULT HERE ─────────────────────────
 * The COMPASS_% population is MIXED POLARITY, which is exactly the case
 * scripts/check-flag-polarity.mjs exists to keep straight:
 *
 *   CAPABILITY (`COMPASS_ENABLED`, `COMPASS_FEED_ENABLED`, `COMPASS_TELEGRAPH`,
 *     `COMPASS_<TYPE>_ENABLED`, …): `true` means "available". Reading them as
 *     false during an outage turns the feature off, which is the safe default.
 *
 *   STOP (`COMPASS_<TYPE>_SAFETY_BLOCK`): `true` means "stop showing this
 *     content type". Reading them as false during an outage DISENGAGES the
 *     emergency stop at the moment an operator is most likely to be reaching
 *     for it. CompassSafetyFilter rule 15 asks `preloadedFlags[typeBlockFlag]`
 *     and CompassFallbackFeedBuilder passes this module's own `getFlags()`
 *     output into that same filter, so the empty map lifted the block on every
 *     content type in both the normal and the degraded feed.
 *
 * That second half is the fail-OPEN, and it is what `FAILSAFE_COMPASS_FLAGS`
 * closes: a read failure yields a map with every `_SAFETY_BLOCK` ENGAGED and
 * nothing else set, so capability gates still read off and the stops still read
 * on. It is a latent defect rather than a live one — no `_SAFETY_BLOCK` row is
 * seeded by any migration today — but "the switch works only while the database
 * is healthy" is not a property to leave undocumented until the day it matters.
 *
 * NOT engaged on failure, deliberately: `COMPASS_LAUNCH_CONTROL_ENABLED`,
 * `COMPASS_COUNTRY_LAUNCH_REQUIRED` and `COMPASS_CITY_LAUNCH_REQUIRED`. They
 * enable a containment rather than being one, they are `_ENABLED`/`_REQUIRED`
 * (CAPABILITY by this repo's naming rule), CompassEligibilityEngine's own
 * comment calls its country gate "ELIGIBILITY-level (fail-open)" by design —
 * and engaging them without the readable per-region allowlist they depend on
 * would deny every item with a country, turning one unreadable table into a
 * total discovery blackout. Engaging the stops is targeted; engaging these
 * would not be.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../lib/logger.js";
import type { CompassItemType } from "./types.js";

const logger = rootLogger.child({ service: "CompassFlags" });

const CACHE_TTL_MS = 30_000; // 30 seconds

/** The wildcard every Compass flag loader selects on. */
export const COMPASS_FLAG_PREFIX = "COMPASS_%";

/**
 * Every `CompassItemType`, as VALUES.
 *
 * Typed as `Record<CompassItemType, true>` so tsc fails this file the day a new
 * item type is added to types.ts without a matching entry — the fail-safe map
 * below must cover the whole type vocabulary or it quietly stops protecting the
 * new one.
 */
const COMPASS_ITEM_TYPES: Readonly<Record<CompassItemType, true>> = Object.freeze({
  event: true, post: true, user: true, buddy: true, trip: true, stamp: true,
  notification: true, suggestion: true, place: true, hidden_gem: true, traveler: true,
});

/**
 * The flag map assumed when `feature_flags` cannot be read: every per-type
 * safety stop ENGAGED, every capability absent (and therefore falsy).
 *
 * Built once and frozen — it is handed out by reference to every caller of a
 * failed read.
 */
export const FAILSAFE_COMPASS_FLAGS: Readonly<Record<string, boolean>> = Object.freeze(
  Object.fromEntries(
    Object.keys(COMPASS_ITEM_TYPES).map((t) => [`COMPASS_${t.toUpperCase()}_SAFETY_BLOCK`, true]),
  ),
);

export interface CompassFlagLoad {
  /** Flag name → enabled. On failure this is `FAILSAFE_COMPASS_FLAGS`. */
  flags: Record<string, boolean>;
  /** False when the read failed — the map is the fail-safe one, not live state. */
  ok: boolean;
  /** The resolved PostgREST error, when `ok` is false. */
  error?: unknown;
}

interface CacheEntry {
  flags: Record<string, boolean>;
  cachedAt: number;
}

let _cache: CacheEntry | null = null;

/** Invalidate the in-memory cache (useful after flag writes in tests). */
export function invalidateFlagsCache(): void {
  _cache = null;
}

/**
 * THE Compass flag read. Uncached, and the only place the query lives.
 *
 * `.error` is the failure signal: supabase-js resolves on a database error, so
 * `data` is null for an unreadable table exactly as it is for an empty one.
 */
export async function fetchCompassFlags(db: SupabaseClient | null): Promise<CompassFlagLoad> {
  if (!db) return { flags: {}, ok: true };
  try {
    const { data, error } = await db
      .from("feature_flags")
      .select("flag, enabled")
      .like("flag", COMPASS_FLAG_PREFIX);
    if (error) {
      logger.error(
        { err: error },
        "Compass: COMPASS_% feature flag load FAILED — capability gates read off and every " +
          "COMPASS_<TYPE>_SAFETY_BLOCK reads ENGAGED (see FAILSAFE_COMPASS_FLAGS)",
      );
      return { flags: FAILSAFE_COMPASS_FLAGS, ok: false, error };
    }
    const out: Record<string, boolean> = {};
    for (const row of (data as any[]) ?? []) {
      out[row.flag] = Boolean(row.enabled);
    }
    return { flags: out, ok: true };
  } catch (err) {
    // A THROW here is NOT a database failure, and is deliberately NOT answered
    // with the fail-safe map.
    //
    // Measured against @supabase/supabase-js 2.108.2 against an unreachable
    // host: a network failure RESOLVES `{ data: null, error: { message:
    // "TypeError: fetch failed", code: "" }, status: 0 }`. postgrest-js catches
    // fetch errors itself, so every real database or network fault — the whole
    // population FAILSAFE_COMPASS_FLAGS exists for — arrives at the `.error`
    // branch above. What is left for this catch is a `db` that is not a
    // PostgREST builder at all: a wiring bug or a test double, in which case
    // every other Compass read is broken too. Engaging every content type's
    // safety stop in response to that would blank the feed and hide the bug
    // behind it, so this path keeps the historical empty map and says loudly
    // what happened.
    logger.error(
      { err },
      "Compass: the COMPASS_% flag read THREW — this is not a database error (those resolve); " +
        "the client is not a PostgREST builder. Flags read as empty",
    );
    return { flags: {}, ok: false, error: err };
  }
}

/**
 * Return all Compass flags, using cache when fresh.
 *
 * A FAILED load is never cached. Caching it would hold the fail-safe map for a
 * further 30 seconds after the database recovered, extending one unhealthy
 * request into an unhealthy half-minute.
 */
export async function getFlags(db: SupabaseClient): Promise<Record<string, boolean>> {
  if (_cache && Date.now() - _cache.cachedAt < CACHE_TTL_MS) {
    return _cache.flags;
  }
  const load = await fetchCompassFlags(db);
  if (load.ok) _cache = { flags: load.flags, cachedAt: Date.now() };
  return load.flags;
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
