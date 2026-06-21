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

const RETENTION_DAYS = (() => {
  const raw = process.env.DAILY_BRIEF_RETENTION_DAYS;
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
})();

const CLEANUP_INTERVAL_HOURS = (() => {
  const raw = process.env.DAILY_BRIEF_CLEANUP_INTERVAL_HOURS;
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
})();
const INTERVAL_MS = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1_000;
const STARTUP_DELAY_MS = 30 * 1_000;

async function purgeOldBriefs(): Promise<void> {
  if (!isServiceClientReady) {
    logger.warn("dailyBriefCleanup: service client not ready — skipping purge");
    return;
  }

  const client = getServiceClient()!;

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  try {
    const { error, count } = await client
      .from("daily_briefs")
      .delete({ count: "exact" })
      .lt("brief_date", cutoffDate);

    if (error) {
      logger.error({ err: error }, "dailyBriefCleanup: purge query failed");
    } else {
      logger.info({ deleted: count ?? 0, cutoffDate }, "dailyBriefCleanup: purged old briefs");
    }
  } catch (err) {
    logger.error({ err }, "dailyBriefCleanup: unexpected error during purge");
  }
}

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
