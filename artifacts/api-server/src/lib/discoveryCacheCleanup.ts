/**
 * Discovery L2 cache cleanup.
 *
 * WHY THIS EXISTS (2026-08-28)
 * ----------------------------
 * `discovery_cache` and `discovery_geocode_cache` are the Postgres tier behind
 * the in-process Discovery caches. Both carry `expires_at`, and NOTHING ever
 * deleted an expired row: `readPlacesFromDb` returns stale rows rather than
 * removing them, `readGeocodeFromDb` returns null past `expires_at` but leaves
 * the row, and the only two DELETEs in the module are content-matched
 * invalidations (`invalidateDiscoveryCacheForOsmId` and friends), not
 * expiry-driven ones.
 *
 * Measured on production 2026-08-28: `discovery_cache` held 90 rows of which
 * **86 were expired** — 96% dead, 840 kB, the oldest from 2026-07-21. Rows are
 * upserted by key, so the table is bounded by distinct
 * (destination, category, radius) combinations rather than by time; but every
 * key ever queried and never queried again keeps its payload forever.
 *
 * THE CONSTRAINT THAT SETS THE RETENTION WINDOW
 * ---------------------------------------------
 * Deleting on expiry would be WRONG. `discovery_cache` rows past `expires_at`
 * are still SERVED: routes/discovery.ts checks `dbCacheEntry.isStale` and, when
 * stale, kicks off a background Overpass revalidation and serves the stale rows
 * anyway — that is serve point 3, `L2_stale`. Purging at `expires_at` would turn
 * every stale-but-serviceable hit into a cold fetch against a rate-limited
 * dependency, which is the opposite of what this file is for.
 *
 * So retention is measured PAST expiry, and the default (7 days) is far beyond
 * any window in which a stale row is still worth serving — the places TTL is two
 * hours and the geocode TTL is 24. A row 7 days past expiry is not
 * stale-but-useful; it is abandoned.
 *
 * Best-effort and non-fatal throughout, exactly like weatherCacheCleanup: a
 * cleanup pass that fails must never take the server with it.
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger } from "./logger.js";

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Parse DISCOVERY_CACHE_RETENTION_HOURS. Returns 168 (7 days) when missing or
 * invalid. Non-positive values are rejected rather than honoured: a retention of
 * 0 would delete rows the instant they expire, which is exactly the behaviour
 * the stale-while-revalidate path depends on NOT happening.
 */
export function parseDiscoveryRetentionHours(raw: string | undefined): number {
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 168;
}

const RETENTION_HOURS = parseDiscoveryRetentionHours(process.env.DISCOVERY_CACHE_RETENTION_HOURS);

/** How long between cleanup runs (ms). Exported for unit tests. */
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Initial delay before the first run (ms). After the weather cleanup's 35 s. */
export const STARTUP_DELAY_MS = 45 * 1_000;

/** The two L2 tables, both keyed on `expires_at`. */
export const DISCOVERY_CACHE_TABLES = ["discovery_cache", "discovery_geocode_cache"] as const;

export interface PurgeResult {
  /** Rows removed per table. null for a table whose delete failed. */
  deleted: Record<string, number | null>;
  /** First error encountered, if any. A failure on one table does not stop the other. */
  error: unknown;
}

/**
 * Delete rows whose `expires_at` is older than the retention window.
 *
 * `opts` lets tests inject a client and window without touching env vars.
 * Never throws.
 */
export async function purgeExpiredDiscoveryCache(opts?: {
  client?: any;
  retentionHours?: number;
}): Promise<PurgeResult> {
  // `"client" in opts`, NOT `opts?.client ?? fallback`. With ?? , passing an
  // explicit `client: null` falls THROUGH to the global service client, so a
  // caller asking for "no client" would silently get the real one. Presence of
  // the key is the caller's intent; its value is the answer.
  const client = opts && "client" in opts
    ? opts.client
    : (isServiceClientReady ? getServiceClient() : null);
  const retentionHours = opts?.retentionHours ?? RETENTION_HOURS;
  const deleted: Record<string, number | null> = {};
  let firstError: unknown = null;

  if (!client) {
    logger.warn("discoveryCacheCleanup: service client not ready — skipping purge");
    for (const t of DISCOVERY_CACHE_TABLES) deleted[t] = null;
    return { deleted, error: null };
  }

  // PAST expiry, not at it — see the header. A row is eligible only once it has
  // been expired for the whole retention window.
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1_000).toISOString();

  for (const table of DISCOVERY_CACHE_TABLES) {
    try {
      const { error, count } = await client
        .from(table)
        .delete({ count: "exact" })
        .lt("expires_at", cutoff);

      if (error) {
        logger.error({ err: error, table }, "discoveryCacheCleanup: purge failed");
        deleted[table] = null;
        firstError ??= error;
        continue;
      }
      deleted[table] = count ?? 0;
    } catch (err) {
      // One table failing must not skip the other.
      logger.error({ err, table }, "discoveryCacheCleanup: purge threw unexpectedly");
      deleted[table] = null;
      firstError ??= err;
    }
  }

  logger.info({ deleted, cutoff, retentionHours }, "discoveryCacheCleanup: purged expired discovery cache rows");
  return { deleted, error: firstError };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Start the background discovery cache cleanup scheduler.
 * Returns the interval handle so callers can cancel it in tests.
 */
export function startDiscoveryCacheCleanup(): ReturnType<typeof setInterval> {
  const initialTimer = setTimeout(() => {
    purgeExpiredDiscoveryCache().catch(() => {});
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    purgeExpiredDiscoveryCache().catch(() => {});
  }, CLEANUP_INTERVAL_MS);

  // unref both so a pending cleanup never holds the process open.
  interval.unref();
  if (typeof initialTimer.unref === "function") initialTimer.unref();

  logger.info(
    { retentionHours: RETENTION_HOURS, intervalHours: CLEANUP_INTERVAL_MS / 3_600_000 },
    "discoveryCacheCleanup: scheduler started",
  );

  return interval;
}
