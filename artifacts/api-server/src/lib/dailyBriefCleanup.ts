/**
 * Daily Brief Cleanup
 *
 * Purges daily_briefs rows older than DAILY_BRIEF_RETENTION_DAYS (default 60) days so the table does not grow
 * unbounded. Runs once immediately on startup (after a short delay to let
 * the server fully initialise) and then every 24 hours.
 *
 * The delete uses the brief_date index added in migration 0013 so the scan
 * is cheap regardless of table size.
 *
 * Failures are logged and swallowed — the cleanup is best-effort and must
 * never crash the server.
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger } from "./logger.js";

// ─── Exported for unit testing ───────────────────────────────────────────────

/**
 * Parse DAILY_BRIEF_RETENTION_DAYS. Returns 60 (default) when the value is
 * missing, non-numeric, zero, or negative.
 */
export function parseRetentionDays(raw: string | undefined): number {
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

/**
 * Parse DAILY_BRIEF_CLEANUP_INTERVAL_HOURS. Returns 24 (default) when the
 * value is missing, non-numeric, zero, or negative. Accepts fractional values
 * (e.g. 0.5 → every 30 minutes).
 */
export function parseIntervalHours(raw: string | undefined): number {
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

// ─── Module-level constants (resolved once at startup) ───────────────────────

const RETENTION_DAYS = parseRetentionDays(process.env.DAILY_BRIEF_RETENTION_DAYS);
const CLEANUP_INTERVAL_HOURS = parseIntervalHours(process.env.DAILY_BRIEF_CLEANUP_INTERVAL_HOURS);
const INTERVAL_MS = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1_000;
const STARTUP_DELAY_MS = 30 * 1_000;

// ─── Purge logic ─────────────────────────────────────────────────────────────

/**
 * Delete daily_briefs rows whose brief_date is older than `retentionDays`.
 *
 * Accepts optional overrides so unit tests can inject a fake Supabase client
 * and a custom retention window without touching env vars or module state.
 *
 * Returns { deleted, error } so callers (and tests) can inspect the outcome.
 * Never throws — errors are logged and returned.
 */
export async function purgeOldBriefs(opts?: {
  client?: any;
  retentionDays?: number;
}): Promise<{ deleted: number | null; error: unknown }> {
  const client = opts?.client ?? (isServiceClientReady ? getServiceClient() : null);
  const retentionDays = opts?.retentionDays ?? RETENTION_DAYS;

  if (!client) {
    logger.warn("dailyBriefCleanup: service client not ready — skipping purge");
    return { deleted: null, error: null };
  }

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  try {
    const { error, count } = await client
      .from("daily_briefs")
      .delete({ count: "exact" })
      .lt("brief_date", cutoffDate);

    if (error) {
      logger.error({ err: error }, "dailyBriefCleanup: purge query failed");
      return { deleted: null, error };
    }

    logger.info({ deleted: count ?? 0, cutoffDate }, "dailyBriefCleanup: purged old briefs");
    return { deleted: count ?? 0, error: null };
  } catch (err) {
    logger.error({ err }, "dailyBriefCleanup: unexpected error during purge");
    return { deleted: null, error: err };
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Start the background cleanup scheduler.
 * Returns the interval handle so callers can cancel it in tests if needed.
 */
export function startDailyBriefCleanup(): ReturnType<typeof setInterval> {
  const initialTimer = setTimeout(() => {
    purgeOldBriefs().catch(() => {});
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    purgeOldBriefs().catch(() => {});
  }, INTERVAL_MS);

  interval.unref();

  if (typeof initialTimer.unref === "function") {
    initialTimer.unref();
  }

  logger.info(
    { retentionDays: RETENTION_DAYS, intervalHours: INTERVAL_MS / 3_600_000 },
    "dailyBriefCleanup: scheduler started",
  );

  return interval;
}
