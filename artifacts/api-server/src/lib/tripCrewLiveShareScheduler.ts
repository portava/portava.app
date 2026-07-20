/**
 * Trip Crew Live-Share Expiry Scheduler
 *
 * Sweeps trip_crew_location_sessions rows where status='active' and
 * expires_at < now() every 5 minutes, marks them 'expired', and writes
 * audit events to trip_crew_location_events.
 *
 * Failures are logged and swallowed — best-effort background job, must
 * never crash the server.
 */
import { getServiceClient } from "./supabase.js";
import { sweepExpiredLiveShares } from "../services/tripCrew/TripCrewLiveShareService.js";
import { logger as rootLogger } from "./logger.js";

const JOB_KEY = "crew_live_share_cleanup";

const logger = rootLogger.child({ job: "tripCrewLiveShareScheduler" });

const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

async function runSweep(): Promise<void> {
  const db = getServiceClient();
  if (!db) {
    logger.warn("tripCrewLiveShareScheduler: service client not ready — skipping sweep");
    return;
  }

  const ranAt = new Date().toISOString();
  try {
    const expired = await sweepExpiredLiveShares(db);
    if (expired > 0) {
      logger.info({ expired }, "tripCrewLiveShareScheduler: swept expired live shares");
    }

    // Record successful sweep in job_health table
    const { error: healthError } = await db.from("job_health").upsert(
      { job: JOB_KEY, last_run_at: ranAt },
      { onConflict: "job" },
    );
    if (healthError) {
      logger.warn({ err: healthError }, "tripCrewLiveShareScheduler: could not persist job health");
    }
  } catch (err) {
    logger.error({ err }, "tripCrewLiveShareScheduler: sweep failed");

    // Still record the attempt time so health check can detect stalled jobs (best effort)
    const { error: healthError } = await db.from("job_health").upsert(
      { job: JOB_KEY, last_run_at: ranAt },
      { onConflict: "job" },
    );
    if (healthError) {
      logger.warn({ err: healthError }, "tripCrewLiveShareScheduler: could not persist job health after failure");
    }
  }
}

/**
 * Start the background live-share expiry sweep.
 * Called once at server startup (after `app.listen`).
 * Returns the interval handle so tests can clear it.
 */
export function startTripCrewLiveShareScheduler(): ReturnType<typeof setInterval> {
  // First sweep after 30 s to let the server fully warm up
  setTimeout(() => { runSweep().catch(() => {}); }, 30_000);

  const interval = setInterval(() => {
    runSweep().catch(() => {});
  }, SWEEP_INTERVAL_MS);

  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, "tripCrewLiveShareScheduler: started");
  return interval;
}
