// Sentry must be the very first import so it can instrument the process before
// any other module loads.  The module is a no-op when SENTRY_DSN is not set.
import { Sentry } from "./lib/sentry.js";

import app from "./app";
import { logger } from "./lib/logger";
import { startDailyBriefCleanup, queryCleanupHealth } from "./lib/dailyBriefCleanup";
import { startSuggestionSeenCleanup } from "./lib/suggestionSeenCleanup";
import { startWeatherCacheCleanup } from "./lib/weatherCacheCleanup";
import { startDiscoveryCacheCleanup } from "./lib/discoveryCacheCleanup";
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
import { startIntelCoverageScheduler } from "./lib/intelCoverageScheduler";
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
import { startRankingFatigueSweeper } from "./lib/rankingFatigueSweeper";
import { startTrustMaintenanceScheduler } from "./lib/trustMaintenanceScheduler";
import { startBuddyRequestSweeper } from "./lib/rentBuddyRequestSweeper";
import { startPostPlaceBackfillWorker } from "./lib/places/postPlaceBackfillWorker";
import { startMediaDedupWorker } from "./lib/media/mediaDedupWorker.js";
import { startPlaceCollectionsWorker } from "./lib/places/placeCollectionsWorker.js";
import { startCompassSearchDecayFlushScheduler } from "./lib/compassSearchDecayFlushScheduler.js";
import { startAccountDeletionScheduler } from "./lib/accountDeletionScheduler.js";
import { startLocationSnapshotPurgeScheduler } from "./lib/locationSnapshotPurgeScheduler.js";
import { startIntelRetentionScheduler } from "./lib/intelRetentionScheduler.js";
import { startIntelProjectionScheduler } from "./lib/intelProjectionScheduler.js";
import { startIntelPromotionScheduler } from "./lib/intelPromotionScheduler.js";
import { startIntelRewardScheduler } from "./lib/intelRewardScheduler.js";
import { startMemoryProjectionScheduler } from "./lib/memoryProjectionScheduler.js";
import { startPlaceDayLifecycleWorker } from "./lib/places/placeDaysWorker.js";

assertRequiredEnv(logger);

// ── Crash backstop for fire-and-forget side effects ──────────────────────────
// ~190 call sites launch best-effort work as `void fn(...)`, and not all of
// those callees swallow their own errors: recordTrustEvent (19 unguarded call
// sites) ends with `if (error) throw new Error(...)` on any trust_events write
// failure. Node's default for an unhandled rejection is to TERMINATE the
// process, so one transient Postgres error on a side effect nobody awaited
// would take down the whole API and every in-flight request with it.
//
// Sentry's OnUnhandledRejection integration registers a listener that masks
// this — but lib/sentry.ts is a no-op unless SENTRY_DSN is set, so the
// protection silently vanishes in exactly the environments least likely to
// have a DSN. This backstop must not depend on the error reporter being
// configured.
//
// These promises are best-effort by contract, so the right response is to log
// loudly and keep serving rather than to die. captureException is safe to call
// unconditionally: without a DSN the SDK is inert.
process.on("unhandledRejection", (reason) => {
  logger.error(
    { err: reason },
    "unhandled promise rejection from fire-and-forget work — request unaffected, side effect lost",
  );
  Sentry.captureException(reason);
});

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
  startDiscoveryCacheCleanup();
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
  // Deletes location_snapshots past expires_at. The table's only reader already
  // filters on expires_at, so purging expired rows changes no result; without
  // this, raw coordinates accumulated permanently. DELETE is irreversible, so it
  // is gated behind `location_snapshot_purge_enabled` and fails closed —
  // starting it here is safe even before the flag is turned on.
  startLocationSnapshotPurgeScheduler();
  // Sweeps expired intel_state_snapshots. Derived and recomputable, and already
  // invisible to readers once expired, so this is hygiene. Ships with the tables
  // it sweeps so they never repeat the location_snapshots defect (expires_at with
  // no cleanup job). Flag-gated and fail-closed; safe to start before enabling.
  startIntelRetentionScheduler();
  startIntelPromotionScheduler();
  startIntelProjectionScheduler();
  // Memory + Experience Intelligence projector (spec §22): projects canonical
  // facts + the Experience Graph into memory_projections and sweeps expired
  // memory. Flag-gated on memory_projection, fail-closed; a no-op until enabled.
  startMemoryProjectionScheduler();
  // IG-08 coverage producer: assembles (zone, claim-family) gap snapshots and
  // (when intel_missions is also on) generates mission candidates. Flag-gated on
  // intel_coverage, fail-closed; a no-op until enabled.
  startIntelCoverageScheduler();
  // IG-10 reward producer: books NON-CASH earned credits to intel_reward_ledger for
  // contributors whose observations reached the served live state. Flag-gated on
  // intel_rewards, fail-closed, idempotent per observation; a no-op until enabled.
  startIntelRewardScheduler();
  // Executes due user_deletion_requests. Irreversible, so it is gated behind
  // the `account_deletion_worker_enabled` feature flag and fails closed —
  // starting it here is safe even before the flag is turned on.
  startAccountDeletionScheduler();
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
  // Post → canonical place backfill: resolves existing posts that have a
  // canonical_location_id but no canonical_place_id to the venue-level
  // places table. Stops automatically when the backlog is exhausted.
  startPostPlaceBackfillWorker();

  // Near-duplicate media collapse worker — groups visually-similar post_media
  // images at the same canonical place using 64-bit pHash difference hashing.
  // Runs every 20 minutes; fail-soft (never affects uploads or post creation).
  startMediaDedupWorker();

  // Place collections precompute worker — maintains place_best_of,
  // place_top_contributors, and place_living_cache so popular destination
  // pages are served from precomputed rows in milliseconds.
  // Gated by PLACE_COLLECTIONS_WORKER_ENABLED=true.
  startPlaceCollectionsWorker();
  startPlaceDayLifecycleWorker();

  // Daily search-decay flush — writes post-decay category_weights back to
  // compass_user_preferences and resets each signal row's search_weight to
  // the new baseline so repeated profile reads don't each recompute decay.
  // No-ops when SEARCH_SIGNAL_DECAY_DAYS is disabled in feature_flags.
  startCompassSearchDecayFlushScheduler();

  // Viewer-creator fatigue row cleanup — deletes rows older than 30 days so
  // the viewer_creator_fatigue table doesn't grow unbounded.
  startRankingFatigueSweeper();
  // Drives the Trust engine. The engine was fully built but had no driver:
  // `recalculateTrustScore` ran only on admin action, so on production
  // trust_events accumulated while trust_profiles stayed EMPTY and
  // last_recalculated_at was NULL for every user — no score was ever computed,
  // while trust_profiles.overall_score already gates event RSVPs and ranks the
  // buddy marketplace and Pulse. This pass also lifts expired trust_caps
  // (time-limited ceilings were previously permanent) and ends probation whose
  // term has run. Gated behind `trust_engine_enabled` and fails closed — the
  // same gate recordTrustEvent uses, so events and scoring can never disagree.
  startTrustMaintenanceScheduler();
  // Drives the three time-based Rent-a-Buddy booking transitions. The logic
  // existed as POST /api/internal/buddy-requests/expire but had NO caller —
  // referenced only from a test. Without it no unanswered request expires, no
  // dispute window closes (so a completed booking never auto-confirms), and no
  // reported no-show ever escalates to a dispute.
  startBuddyRequestSweeper();

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
