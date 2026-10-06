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
 *
 * "Hourly" is the ceiling, not the rate. This runs on Replit autoscale, which
 * suspends the process after 15 idle minutes, so an hour (or a night, or a
 * weekend) can pass with no tick at all and nothing is wrong. The three
 * detectors whose windows were narrower than that gap — geotag_farming,
 * hashtag_spam, available_now_abuse — therefore do NOT anchor on `Date.now()`
 * alone any more; they resume from a durable per-detector watermark so a
 * suspended hour is scanned late instead of never. The argument, the per-
 * detector catch-up caps and what bounds a catch-up pass all live next to the
 * detectors, in CompassAbuseDefenseEngine's NARROW_SCANS.
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
    const { flagsWritten, status, failedDetectors, watermarkFailures } = await runScan(db, null);
    // A broken watermark store does not make the scan unclean — every detector
    // still scanned at least its own window — but it does mean the suspended
    // hours were not recovered on this pass, which otherwise looks exactly
    // like a healthy hourly line. Said out loud for that reason.
    if (watermarkFailures.length > 0) {
      logger.warn(
        { watermarkFailures },
        "CompassAbuseScanner: scan watermarks did not complete — missed windows were not recovered on this pass",
      );
    }
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
