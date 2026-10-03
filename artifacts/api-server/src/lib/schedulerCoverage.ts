/**
 * Which background schedulers this process starts, and how anyone could tell
 * whether each one is still running.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `index.ts` starts 58 schedulers at boot. Every one is a `setInterval` inside
 * the process, and `.replit` sets `deploymentTarget = "autoscale"`, which
 * suspends a container after fifteen idle minutes; a suspended container's
 * event loop does not advance. On 2026-09-30 15:28 all 58 stopped together and
 * nothing said so for fifty-four hours.
 *
 * `GET /healthz/schedulers` already refuses to launder the jobs it knows about:
 * it keeps "healthy", "failing", "stale", "never_ran" and "unknown" apart, and
 * answers 503 rather than making an operator parse a body. What it could not
 * say was how much it was NOT looking at. It reported eleven jobs out of
 * fifty-eight started, and an aggregate over eleven reads exactly like an
 * aggregate over all of them. That is the same defect one level up: not a job
 * that lies about itself, but a surface that lies about its own scope.
 *
 * So this file is the denominator. It is deliberately a plain list rather than
 * anything clever, because `check:scheduler-coverage` has to be able to compare
 * it against the tree:
 *
 *   `start`       the function `index.ts` calls. The guard asserts this set is
 *                 EXACTLY the set of `start…()` statements in `index.ts`, in
 *                 both directions, so a scheduler added without a row here
 *                 fails the build rather than quietly joining the 45.
 *   `reportedAs`  the job names this scheduler contributes to
 *                 `GET /healthz/schedulers`. The guard asserts each one appears
 *                 as a `job: "…"` literal in `routes/health.ts`, and that every
 *                 such literal is claimed by exactly one row.
 *   `persists`    the `public.job_health` keys it writes. Durable: it survives
 *                 the restart that clears every in-memory counter. The guard
 *                 asserts the owning file really writes `job_health`, and that
 *                 every non-test file writing `job_health` is claimed here.
 *
 * A row with NEITHER field is a job whose stopping leaves no trace anywhere:
 * no row to go stale, no counter to read, nothing an operator or an alert could
 * notice. There are 45 of those, and that number is the point of this file.
 * It was 46 until `startHealthMonitorLoop` began writing its own
 * `stamp_health_monitor` row; the monitor reported to the logger only, and logs
 * on this host are not retained anywhere queryable, so nothing outside the
 * process could establish that it had run at all.
 *
 * ── WHAT THIS FILE IS NOT ────────────────────────────────────────────────────
 * It is not a fix. Knowing that 45 jobs are unobservable does not make them
 * observable, and it does nothing at all about the suspension that stops all
 * 58 — that needs either an always-on host or an external trigger per job, and
 * both are the owner's call, not a default anyone should pick in a registry.
 * Nobody has yet assessed which of the 45 are time-critical.
 *
 * It also does not claim 58 is the number of LOOPS. `startTripProjectionWorkers`
 * starts several workers behind one call, and this list counts the call, which
 * is what `index.ts` can be checked against. Where such a call owns a job that
 * does report, the row says so — `tripCrewLiveShareScheduler` and
 * `crew_live_share_cleanup` both arrive through that one entry.
 */

export interface SchedulerRow {
  /** The `start…()` function `index.ts` calls. */
  start: string;
  /** Job names this scheduler contributes to `GET /healthz/schedulers`. */
  reportedAs?: readonly string[];
  /** `public.job_health` keys it writes, which survive a restart. */
  persists?: readonly string[];
}

/**
 * Every scheduler `index.ts` starts, in the order `start…()` sorts.
 * Kept identical to `index.ts` by `check:scheduler-coverage`.
 */
export const STARTED_SCHEDULERS: readonly SchedulerRow[] = [
  { start: "startAccountDeletionScheduler" },
  { start: "startBuddyRequestSweeper", reportedAs: ["rentBuddyRequestSweeper"] },
  { start: "startCallSweepScheduler", reportedAs: ["callSweepScheduler"] },
  { start: "startCompassAbuseScanScheduler" },
  { start: "startCompassSearchDecayFlushScheduler" },
  { start: "startCompassSenseScheduler" },
  { start: "startCorrectionSweep" },
  { start: "startCreatorActivityScoreScheduler" },
  { start: "startCreatorAttributionScheduler" },
  { start: "startDailyBriefCleanup", reportedAs: ["dailyBriefCleanup"], persists: ["cleanup"] },
  { start: "startDelayedPostPublisher", persists: ["delayed_post_publisher"] },
  { start: "startDiscoveryCacheCleanup" },
  { start: "startDiscoveryCacheWarmer" },
  { start: "startDiscoveryTrendRebuildScheduler" },
  { start: "startEventLifecycleScheduler" },
  { start: "startEventWaitlistSweeper", reportedAs: ["eventWaitlistSweeper"] },
  { start: "startFxRefreshLoop" },
  { start: "startHealthMonitorLoop", persists: ["stamp_health_monitor"] },
  { start: "startIntelAttributionScheduler" },
  { start: "startIntelCalibrationScheduler" },
  { start: "startIntelCoverageScheduler" },
  { start: "startIntelPatternScheduler" },
  { start: "startIntelProjectionScheduler" },
  { start: "startIntelPromotionScheduler" },
  { start: "startIntelRetentionScheduler" },
  { start: "startIntelRewardScheduler" },
  { start: "startIntelligenceGraphScheduler" },
  { start: "startInviteSlotReconciler", reportedAs: ["inviteSlotReconciler"] },
  { start: "startInviteSlotSweeper", reportedAs: ["inviteSlotSweeper"] },
  { start: "startLayoverCrewExpiryScheduler" },
  { start: "startLayoverExternalEventScheduler" },
  { start: "startLocationSnapshotPurgeScheduler" },
  { start: "startMediaDedupWorker" },
  { start: "startMediaProcessingWorker" },
  { start: "startMemoryOutboxScheduler" },
  { start: "startMemoryProjectionScheduler" },
  { start: "startNotificationMaintenanceScheduler", reportedAs: ["notificationMaintenanceScheduler"] },
  { start: "startPendingUploadSweepScheduler" },
  { start: "startPlaceCollectionsWorker" },
  { start: "startPlaceCooccurrenceRebuildScheduler" },
  { start: "startPlaceDayLifecycleWorker" },
  { start: "startPostPlaceBackfillWorker" },
  { start: "startPushRetryWorker" },
  { start: "startRankingFatigueSweeper" },
  { start: "startSafeReturnScheduler" },
  { start: "startSensingPublicationScheduler" },
  { start: "startSensingRetentionScheduler" },
  { start: "startStoryRetentionScheduler", reportedAs: ["storyRetention"], persists: ["storyRetention"] },
  { start: "startSuggestionSeenCleanup", reportedAs: ["suggestionSeenCleanup"] },
  { start: "startTelegraphLifecycleScheduler" },
  { start: "startTripOutboxWorker" },
  { start: "startTripProjectionWorkers", reportedAs: ["tripCrewLiveShareScheduler"], persists: ["crew_live_share_cleanup"] },
  { start: "startTrustMaintenanceScheduler" },
  { start: "startVisualGenerationWorker" },
  { start: "startWeatherCacheCleanup" },
  { start: "startWorkerLoop" },
  { start: "startXXCatalogSweeper" },
  { start: "startZombieTokenSweeper", reportedAs: ["zombieTokenSweeper"] },
] as const;

/** What `GET /healthz/schedulers` can and cannot see, counted from the list above. */
export interface SchedulerCoverage {
  /** Schedulers `index.ts` starts. */
  started: number;
  /** Of those, how many contribute at least one job to this endpoint. */
  reported: number;
  /**
   * Of those, how many write a `public.job_health` row. This is the only count
   * that survives a restart: an in-memory counter comes back cleared, so a
   * missed window is indistinguishable from a fresh process.
   */
  persisted: number;
  /**
   * Schedulers with neither — stopping leaves no trace an operator could read.
   * Named, not just counted, because a number invites rounding and a name
   * invites fixing.
   */
  unobservable: readonly string[];
}

export function schedulerCoverage(
  rows: readonly SchedulerRow[] = STARTED_SCHEDULERS,
): SchedulerCoverage {
  const unobservable = rows
    .filter((r) => (r.reportedAs?.length ?? 0) === 0 && (r.persists?.length ?? 0) === 0)
    .map((r) => r.start);
  return {
    started: rows.length,
    reported: rows.filter((r) => (r.reportedAs?.length ?? 0) > 0).length,
    persisted: rows.filter((r) => (r.persists?.length ?? 0) > 0).length,
    unobservable,
  };
}
