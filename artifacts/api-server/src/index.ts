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
import { warmUpDiscoveryCache } from "./lib/discoveryWarmup";
import { startPushRetryWorker, queryPushRetryHealth } from "./lib/pushRetryWorker";
import { startZombieTokenSweeper } from "./lib/zombieTokenSweeper";
import { startEventWaitlistSweeper } from "./lib/eventWaitlistSweeper";
import { startTripReminderScheduler } from "./lib/tripReminderScheduler";
import { startInviteSlotReconciler } from "./lib/inviteSlotReconciler";
import { startInviteSlotSweeper } from "./lib/inviteSlotSweeper";
import { getServiceClient } from "./lib/supabase";

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
  startPushRetryWorker();
  startZombieTokenSweeper();
  startEventWaitlistSweeper();
  startTripReminderScheduler();
  startInviteSlotReconciler();
  startInviteSlotSweeper();
  warmUpDiscoveryCache(port).catch((e) =>
    logger.warn({ err: e }, "discovery warm-up: unhandled error"),
  );

  // Startup check: verify the toggle_feature_flag_with_audit SQL function
  // exists (introduced by migration 0119).  If it is missing the PATCH
  // /admin/feature-flags/:flag route will return a db_error with no clear
  // explanation.  We probe by calling the function with a sentinel flag that
  // will never exist; a P0002 (no_data_found) response confirms the function
  // is present.  A 42883 (undefined_function) response means the migration
  // has not been applied to this database.
  (async () => {
    const sc = getServiceClient();
    if (!sc) return; // service client not configured — skip
    const { error } = await sc.rpc("toggle_feature_flag_with_audit", {
      p_flag:          "__startup_probe__",
      p_new_enabled:   false,
      p_changed_by_id: "00000000-0000-0000-0000-000000000000",
    });
    if (error?.code === "42883") {
      logger.warn(
        "startup: toggle_feature_flag_with_audit SQL function is missing — " +
        "apply migration 0119 to the database or PATCH /admin/feature-flags/:flag will return 503",
      );
    }
  })().catch((e) =>
    logger.warn({ err: e }, "startup: could not probe toggle_feature_flag_with_audit"),
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
