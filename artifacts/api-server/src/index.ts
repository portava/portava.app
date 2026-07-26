import app from "./app";
import { logger } from "./lib/logger";
import { startDailyBriefCleanup, queryCleanupHealth } from "./lib/dailyBriefCleanup";
import { startSuggestionSeenCleanup } from "./lib/suggestionSeenCleanup";
import { startWeatherCacheCleanup } from "./lib/weatherCacheCleanup";
import { initTelegraphBroadcast } from "./lib/telegraphBroadcast";
import { startSafeReturnScheduler } from "./lib/safeReturnScheduler";
import { startTripCrewLiveShareScheduler } from "./lib/tripCrewLiveShareScheduler";
import { startDelayedPostPublisher } from "./lib/delayedPostPublisher";
import { startCompassAbuseScanScheduler } from "./lib/compassAbuseScanScheduler";
import { startCompassSenseScheduler } from "./lib/compassSenseScheduler";
import { startDiscoveryCacheWarmer } from "./lib/discoveryWarmup";
import { startPushRetryWorker, queryPushRetryHealth } from "./lib/pushRetryWorker";
import { startZombieTokenSweeper } from "./lib/zombieTokenSweeper";
import { startEventWaitlistSweeper } from "./lib/eventWaitlistSweeper";
import { startCallSweepScheduler } from "./lib/callSweepScheduler";
import { startTripReminderScheduler } from "./lib/tripReminderScheduler";
import { startIntelligenceGraphScheduler } from "./lib/intelligenceGraphScheduler";
import { startInviteSlotReconciler } from "./lib/inviteSlotReconciler";
import { startInviteSlotSweeper } from "./lib/inviteSlotSweeper";
import { getServiceClient } from "./lib/supabase";
import { initCityTimezonePersistence } from "./compass/CompassGraphEngine.js";
import { assertRequiredEnv } from "./lib/envValidation";
import { startWorkerLoop, queryStampWorkerHealth, startHealthMonitorLoop } from "./lib/stamps/generationWorker";
import { startVisualGenerationWorker } from "./lib/visuals/generationWorker";
import { startFxRefreshLoop } from "./lib/fxRefreshScheduler";
import { startXXCatalogSweeper } from "./lib/stamps/xxCatalogRepair";
import { startCorrectionSweep } from "./lib/stamps/countryGeocoder";
import { runSchemaDriftCheck } from "./lib/schemaDriftCheck";
import { startCreatorActivityScoreScheduler } from "./lib/creatorActivityScoreScheduler";

assertRequiredEnv(logger);

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startDailyBriefCleanup();
  startSuggestionSeenCleanup();
  startWeatherCacheCleanup();
  initTelegraphBroadcast();
  startSafeReturnScheduler();
  startTripCrewLiveShareScheduler();
  startDelayedPostPublisher();
  startCompassAbuseScanScheduler();
  // Periodic Compass Sense evaluator: delivers nudges to opted-in
  // (aware/active) users even when the app is closed. Passive users are
  // never evaluated; all runSense gates (permissions, quiet hours, dedupe,
  // daily caps) apply unchanged.
  startCompassSenseScheduler();
  startPushRetryWorker();
  startZombieTokenSweeper();
  startEventWaitlistSweeper();
  startCallSweepScheduler();
  startTripReminderScheduler();
  startIntelligenceGraphScheduler();
  startInviteSlotReconciler();
  startInviteSlotSweeper();
  // Reload coordinate-learned city timezones so a restart doesn't reset
  // brand-new cities to UTC. Fail-soft: errors leave the in-memory resolver
  // fully functional, just non-durable.
  void initCityTimezonePersistence(getServiceClient()).then((loaded) => {
    logger.info({ loaded }, "City timezone persistence initialized");
  });
  // startDiscoveryCacheWarmer calls warmUpDiscoveryCache immediately on startup
  // then repeats hourly so the Postgres L2 cache stays warm across restarts.
  startDiscoveryCacheWarmer(port);

  // Stamp generation worker — only when explicitly enabled via env var
  if (process.env.STAMP_WORKER_ENABLED === "true") {
    const intervalMs = Number(process.env.STAMP_WORKER_INTERVAL_MS) || 30_000;
    startWorkerLoop(intervalMs);
  }

  // Visual generation worker — polls generated_visuals for queued jobs,
  // applies exponential-backoff retries, and emits structured analytics.
  // Unconditionally started: it is a low-overhead poller; jobs are only
  // created when generation is explicitly requested via the API.
  startVisualGenerationWorker();

  // FX daily refresh — only when FX_REFRESH_ENABLED=true. Pulls ECB reference
  // rates (frankfurter.dev) into fx_rates once a day so budget conversions stay
  // current without the manual re-run. Best-effort; never blocks startup.
  if (process.env.FX_REFRESH_ENABLED === "true") {
    startFxRefreshLoop(() => getServiceClient(), logger);
  }

  // Periodic XX-catalog sweep: re-keys/merges catalog entries whose country
  // becomes resolvable (static lookup or geocoding for less-known cities).
  // Disable with STAMP_COUNTRY_SWEEP_ENABLED=false.
  startXXCatalogSweeper(() => getServiceClient());

  // Background correction sweep: evicts in-memory geocode entries that were
  // admin-corrected on another instance (corrected_at updated in the DB) so
  // corrections propagate to instances that haven't seen a recent request for
  // the affected city — without waiting for the full 30-day TTL.
  startCorrectionSweep();

  // Creator Activity Score recalculation job — processes stale scores every
  // 4 hours in batches of 500, stale-first. Pure background work; never on
  // the hot path of a live feed request.
  startCreatorActivityScoreScheduler();

  // Startup stamp-worker health summary — log pending queue depth and any
  // jobs stuck in `generating` past their lock (a crashed worker never
  // released them) so operators see queue state immediately on deploy.
  queryStampWorkerHealth().then((health) => {
    if (!health) return; // service client not configured — skip
    logger.info(
      {
        worker_enabled: health.worker_enabled,
        last_success_at: health.last_success_at,
        queue_depth: health.queue_depth,
        stuck_jobs: health.stuck_jobs.length,
      },
      "startup: stamp generation worker health",
    );
    if (health.stuck_jobs.length > 0) {
      logger.warn(
        { stuck_jobs: health.stuck_jobs },
        "startup: stamp generation jobs stuck in 'generating' past lock expiry — worker may have crashed",
      );
    }
    const pending =
      (health.queue_depth["queued"] ?? 0) + (health.queue_depth["generating"] ?? 0);
    if (pending > 0 && !health.worker_enabled) {
      logger.warn(
        { pending },
        "startup: stamp generation queue has pending jobs but STAMP_WORKER_ENABLED is not 'true' — artwork will not be generated",
      );
    }
  }).catch((startupErr) => {
    logger.warn({ err: startupErr }, "startup: could not query stamp worker health");
  });

  // Periodic stamp-worker health monitor — re-checks queue health every
  // 15 minutes so a mid-run stall (stuck jobs, growing backlog) is warned
  // about while the app runs, not only at startup. Warnings are rate-limited
  // to one per type per hour inside the monitor.
  startHealthMonitorLoop(logger);

  // Startup schema-drift check: probes every declared critical column and
  // SQL function against the live schema and logs one consolidated warning
  // naming everything that is missing plus the migration to apply.  See
  // src/lib/schemaDriftCheck.ts for the declared list.
  (async () => {
    const sc = getServiceClient();
    if (!sc) return; // service client not configured — skip
    await runSchemaDriftCheck(sc, logger);
  })().catch((e) =>
    logger.warn({ err: e }, "startup: schema drift check failed to run"),
  );

  // Startup health check — warn if the cleanup job hasn't run recently.
  // Queries the persistent job_health table so the check is accurate across
  // server restarts (not just for the current process lifecycle).
  queryCleanupHealth().then(({ cleanupStatus, lastRunAt }) => {
    if (cleanupStatus === "critical") {
      logger.error(
        { lastRunAt },
        "startup: cleanup job is critically overdue — check job_health table",
      );
    } else if (cleanupStatus === "overdue") {
      logger.warn(
        { lastRunAt },
        "startup: cleanup job has not run within the expected window — check job_health table",
      );
    }
  }).catch((startupErr) => {
    logger.warn({ err: startupErr }, "startup: could not query cleanup job health");
  });

  // Startup push retry health check — warn if rows have been stuck in the
  // queue for more than 10 minutes, which suggests the worker may be stalled.
  queryPushRetryHealth().then((health) => {
    if (!health) return; // service client not yet available — skip
    if (health.queued_count > 0 && health.oldest_queued_at) {
      const ageMs = Date.now() - new Date(health.oldest_queued_at).getTime();
      if (ageMs > 10 * 60 * 1_000) {
        logger.warn(
          { queued_count: health.queued_count, oldest_queued_at: health.oldest_queued_at },
          "startup: push_retry_queue has rows older than 10 minutes — worker may be stalled",
        );
      }
    }
    if (health.failed_count > 0) {
      logger.warn(
        { failed_count: health.failed_count },
        "startup: push_retry_queue has failed rows — some push notifications were not delivered",
      );
    }
  }).catch((startupErr) => {
    logger.warn({ err: startupErr }, "startup: could not query push retry queue health");
  });
});
