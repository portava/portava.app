/**
 * Weather Cache Cleanup
 *
 * Purges weather_cache rows older than WEATHER_CACHE_RETENTION_HOURS (default 48)
 * hours so the table does not grow unbounded. Runs once on startup (after a short
 * delay) and then every 24 hours.
 *
 * Only rows outside the active cache TTL window are deleted — rows that would
 * still be served from cache are always younger than the 6-hour TTL, so the
 * 48-hour retention window leaves plenty of headroom.
 *
 * Failures are logged and swallowed — the cleanup is best-effort and must
 * never crash the server.
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger } from "./logger.js";

// ─── Configuration ────────────────────────────────────────────────────────────

/** Parse WEATHER_CACHE_RETENTION_HOURS. Returns 48 (default) when missing/invalid. */
export function parseRetentionHours(raw: string | undefined): number {
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 48;
}

const RETENTION_HOURS = parseRetentionHours(process.env.WEATHER_CACHE_RETENTION_HOURS);

/** How long between cleanup runs (ms). Exported for unit tests. */
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Initial delay before the first run (ms). Slightly after the brief cleanup. */
export const STARTUP_DELAY_MS = 35 * 1_000;

// ─── Purge logic ─────────────────────────────────────────────────────────────

/**
 * Delete weather_cache rows whose cached_at is older than `retentionHours`.
 *
 * Accepts optional overrides so unit tests can inject a fake Supabase client
 * and a custom retention window without touching env vars.
 *
 * Returns { deleted, error } — never throws.
 */
export async function purgeOldWeatherCache(opts?: {
  client?: any;
  retentionHours?: number;
}): Promise<{ deleted: number | null; error: unknown }> {
  const client = opts?.client ?? (isServiceClientReady ? getServiceClient() : null);
  const retentionHours = opts?.retentionHours ?? RETENTION_HOURS;

  if (!client) {
    logger.warn("weatherCacheCleanup: service client not ready — skipping purge");
    return { deleted: null, error: null };
  }

  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1_000).toISOString();

  try {
    const { error, count } = await client
      .from("weather_cache")
      .delete({ count: "exact" })
      .lt("fetched_at", cutoff);

    if (error) {
      logger.error({ err: error }, "weatherCacheCleanup: purge failed");
      return { deleted: null, error };
    }

    const deleted = count ?? 0;
    logger.info({ deleted, cutoff, retentionHours }, "weatherCacheCleanup: purged stale weather cache rows");
    return { deleted, error: null };
  } catch (err) {
    logger.error({ err }, "weatherCacheCleanup: purge threw unexpectedly");
    return { deleted: null, error: err };
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Start the background weather cache cleanup scheduler.
 * Returns the interval handle so callers can cancel it in tests if needed.
 */
export function startWeatherCacheCleanup(): ReturnType<typeof setInterval> {
  const initialTimer = setTimeout(() => {
    purgeOldWeatherCache().catch(() => {});
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    purgeOldWeatherCache().catch(() => {});
  }, CLEANUP_INTERVAL_MS);

  interval.unref();

  if (typeof initialTimer.unref === "function") {
    initialTimer.unref();
  }

  logger.info(
    { retentionHours: RETENTION_HOURS, intervalHours: CLEANUP_INTERVAL_MS / 3_600_000 },
    "weatherCacheCleanup: scheduler started",
  );

  return interval;
}
