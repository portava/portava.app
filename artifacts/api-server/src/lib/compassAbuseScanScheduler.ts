/**
 * Compass Abuse Scan Scheduler
 *
 * Runs CompassAbuseDefenseEngine.runScan() on a 1-hour interval.
 * Also exports `triggerOnDemandScan(userId)` so report-confirmation
 * routes can trigger a scoped per-user scan immediately.
 *
 * Follows the same pattern as dailyBriefCleanup.ts:
 *   - Initial run 60 s after server start (lets Supabase client finish init)
 *   - Hourly thereafter via setInterval
 *   - Errors are swallowed — scanner must never crash the server
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";
import { runScan } from "../compass/CompassAbuseDefenseEngine.js";

const logger = rootLogger.child({ service: "CompassAbuseScanner" });

const STARTUP_DELAY_MS = 60_000;         // 1 minute
const SCAN_INTERVAL_MS = 60 * 60_000;   // 1 hour

/** Exported so scheduler tests can assert call counts. */
export let _scanCallCount = 0;

/** Run a global scan (no userId scope). */
async function runGlobalScan(): Promise<void> {
  _scanCallCount++;
  const db = isServiceClientReady ? getServiceClient() : null;
  try {
    const { flagsWritten, status, failedDetectors } = await runScan(db, null);
    if (status === "incomplete") {
      // "completed" with flagsWritten: 0 was the operator-facing half of the
      // same fabrication: an hourly line saying the abuse scan had run and
      // found nothing, emitted by a scan that had read nothing.
      logger.error(
        { flagsWritten, failedDetectors },
        "CompassAbuseScanner: global scan INCOMPLETE — detectors could not read; no clean result implied",
      );
      return;
    }
    logger.info({ flagsWritten }, "CompassAbuseScanner: global scan completed");
  } catch (err) {
    logger.error({ err }, "CompassAbuseScanner: global scan failed");
  }
}

/**
 * Trigger an on-demand scan scoped to a single user.
 * Called by report-confirmation routes when a report transitions to confirmed.
 * Fire-and-forget — never awaited by the route handler.
 */
export function triggerOnDemandScan(userId: string): void {
  const db = isServiceClientReady ? getServiceClient() : null;
  runScan(db, userId).then(
    ({ flagsWritten, status, failedDetectors }) => {
      if (status === "incomplete") {
        logger.error(
          { userId, flagsWritten, failedDetectors },
          "CompassAbuseScanner: on-demand scan INCOMPLETE — detectors could not read; no clean result implied",
        );
        return;
      }
      logger.info({ userId, flagsWritten }, "CompassAbuseScanner: on-demand scan completed");
    },
    (err) => {
      logger.warn({ err, userId }, "CompassAbuseScanner: on-demand scan failed");
    },
  );
}

/**
 * Start the hourly background abuse scan scheduler.
 * Returns the interval handle so callers can cancel it in tests.
 */
export function startCompassAbuseScanScheduler(): ReturnType<typeof setInterval> {
  const startupTimer = setTimeout(() => {
    runGlobalScan().catch(() => {});
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    runGlobalScan().catch(() => {});
  }, SCAN_INTERVAL_MS);

  interval.unref();
  if (typeof startupTimer.unref === "function") startupTimer.unref();

  logger.info(
    { intervalHours: SCAN_INTERVAL_MS / 3_600_000 },
    "CompassAbuseScanner: hourly scheduler started",
  );

  return interval;
}
