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
  warmUpDiscoveryCache(port).catch((e) =>
    logger.warn({ err: e }, "discovery warm-up: unhandled error"),
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
});
