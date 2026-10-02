import { Router, type IRouter } from "express";
import { HealthCheckResponse, CleanupHealthCheckResponse } from "@workspace/api-zod";
import { getCleanupStatus, queryCleanupHealth } from "../lib/dailyBriefCleanup.js";
import { getSuggestionSeenStatus } from "../lib/suggestionSeenCleanup.js";
import { queryPublisherHealth } from "../lib/delayedPostPublisher.js";
import { callPurgeOldWeatherCache } from "../lib/weatherCacheCleanup.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { safeSecretEquals } from "../lib/http.js";

// ── Scheduler health sources ─────────────────────────────────────────────────
// Every one of these getters existed and had NO CALLER. Each job maintained
// `consecutiveFailures` on every tick and dropped it on the floor: the jobs
// could fail on every tick, for days, and the only trace was a log line. Two
// of them (`getSweepStatus`) share a name across three modules, which is part
// of why nothing ever aggregated them.
import { getReconcileStatus } from "../lib/inviteSlotReconciler.js";
import { getSweepStatus as getZombieTokenSweepStatus } from "../lib/zombieTokenSweeper.js";
import { getSweepStatus as getEventWaitlistSweepStatus } from "../lib/eventWaitlistSweeper.js";
import { getSweepStatus as getBuddyRequestSweepStatus } from "../lib/rentBuddyRequestSweeper.js";
import { getSweeperStatus as getInviteSlotSweeperStatus } from "../lib/inviteSlotSweeper.js";
import { callSweepFailureState } from "../lib/callSweepScheduler.js";
import { getLiveShareSweepStatus } from "../server/trips/projectionWorkers/tripCrewLiveShareScheduler.js";
import { getNotificationMaintenanceStatus } from "../lib/notificationMaintenanceScheduler.js";
import { getServiceClient } from "../lib/supabase.js";
import { sweepExpiredStories } from "./stories.js";
import {
  getStoryRetentionStatus,
  hydrateStoryRetentionStatus,
  runStoryRetentionTick,
  STORY_RETENTION_STALE_AFTER_MS,
} from "../lib/storyRetentionScheduler.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/healthz/cleanup", asyncHandler(async (_req, res) => {
  const inMem = getCleanupStatus();

  // DB-backed check: persists across restarts and is the source of truth for
  // cleanupStatus / lastRunAt. Falls back gracefully if the table is missing.
  const { cleanupStatus, lastRunAt } = await queryCleanupHealth();

  if (cleanupStatus === "critical") {
    logger.error(
      { lastRunAt, consecutiveFailures: inMem.consecutiveFailures },
      "cleanupHealthCheck: cleanup job is critically overdue — immediate attention required",
    );
  } else if (cleanupStatus === "overdue") {
    logger.warn(
      { lastRunAt, consecutiveFailures: inMem.consecutiveFailures },
      "cleanupHealthCheck: cleanup job has not run within the expected window",
    );
  }

  const seen = getSuggestionSeenStatus();

  const data = CleanupHealthCheckResponse.parse({
    cleanupStatus,
    lastRunAt,
    lastOutcome: inMem.lastOutcome,
    lastDeletedCount: inMem.lastDeletedCount,
    consecutiveFailures: inMem.consecutiveFailures,
    lastSeenDeletedCount: seen.lastDeletedCount,
  });
  res.json(data);
}));

router.get("/healthz/delayed-publish", asyncHandler(async (_req, res) => {
  const { publisherStatus, lastRunAt } = await queryPublisherHealth();

  if (publisherStatus === "critical") {
    logger.error(
      { lastRunAt },
      "delayedPublishHealthCheck: publisher job is critically overdue",
    );
  } else if (publisherStatus === "overdue") {
    logger.warn(
      { lastRunAt },
      "delayedPublishHealthCheck: publisher job has not run within the expected window",
    );
  }

  res.json({ publisherStatus, lastRunAt });
}));

/**
 * POST /admin/cleanup/weather-cache
 *
 * Internal endpoint — triggers an immediate weather cache purge and returns
 * the number of rows deleted. No external auth required; intended for
 * server-side or scheduled invocation only (not exposed to mobile clients).
 */
router.post("/admin/cleanup/weather-cache", asyncHandler(async (req, res) => {
  const secret = process.env.CLEANUP_ADMIN_SECRET;
  if (!secret) {
    logger.error("admin/cleanup/weather-cache: CLEANUP_ADMIN_SECRET is not configured — refusing to run");
    res.status(500).json({ error: "cleanup_secret_not_configured" });
    return;
  }
  const provided = req.headers["x-cleanup-secret"];
  // Constant-time compare — a plain !== leaks how many leading characters
  // matched through response timing. See safeSecretEquals in lib/http.ts.
  if (!safeSecretEquals(provided, secret)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { deleted, error } = await callPurgeOldWeatherCache();
  if (error) {
    logger.error({ err: error }, "admin/cleanup/weather-cache: purge failed");
    res.status(500).json({ error: "purge_failed" });
    return;
  }
  res.json({ deleted: deleted ?? 0 });
}));

/**
 * POST /admin/cleanup/expired-stories
 *
 * Runs sweepExpiredStories: flips `active` stories past their expires_at to
 * `expired` and deletes the storage objects behind them.
 *
 * WHY THIS ENDPOINT EXISTS. sweepExpiredStories has lived in routes/stories.ts
 * with a docblock reading "Called from the health/cleanup endpoint" and NO
 * CALLER ANYWHERE except a test. So the 24-hour story was ephemeral in the
 * product copy and permanent in the database: no row ever left `active`, and
 * no object was ever removed.
 *
 * Two things about the blast radius, stated rather than left to be assumed.
 * The severity is NOT "story media is publicly fetchable forever" -- that was
 * the sweep's own comment and it is out of date, because lib/mediaAccess.ts
 * branch 3d checks expires_at and denies expired story media on the serving
 * path. What actually accumulates is rows that never leave `active` and storage
 * objects nothing will ever delete. And AccountDeletionService reasons FROM
 * this sweep in a comment ("sweepExpiredStories already deletes story bytes on
 * EXPIRY, but only for..."), which is a premise built on a job that never ran.
 *
 * WHY AN OPERATOR ENDPOINT AND NOT A SCHEDULER. A scheduler needs a cadence,
 * and a cadence for content expiry is a product decision, not a wiring detail.
 * This mirrors POST /admin/cleanup/weather-cache exactly -- same secret, same
 * constant-time compare, same shape -- so the capability becomes REACHABLE
 * without anyone deciding how often it should run. Wiring it to a schedule is
 * the next step and belongs to whoever owns that cadence.
 */
router.post("/admin/cleanup/expired-stories", asyncHandler(async (req, res) => {
  const secret = process.env.CLEANUP_ADMIN_SECRET;
  if (!secret) {
    logger.error("admin/cleanup/expired-stories: CLEANUP_ADMIN_SECRET is not configured — refusing to run");
    res.status(500).json({ error: "cleanup_secret_not_configured" });
    return;
  }
  const provided = req.headers["x-cleanup-secret"];
  // Constant-time compare — a plain !== leaks how many leading characters
  // matched through response timing. See safeSecretEquals in lib/http.ts.
  if (!safeSecretEquals(provided, secret)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const sc = getServiceClient();
  if (!sc) {
    logger.error("admin/cleanup/expired-stories: no service client — refusing to run");
    res.status(503).json({ error: "degraded_unavailable" });
    return;
  }
  try {
    const expired = await sweepExpiredStories(sc);
    res.json({ expired });
  } catch (err) {
    // sweepExpiredStories THROWS on a read/update error rather than resolving
    // with a count, so this catch is live code, unlike a catch around a bare
    // supabase read. A failed sweep must not answer 200 with a fabricated 0.
    logger.error({ err }, "admin/cleanup/expired-stories: sweep failed");
    res.status(500).json({ error: "sweep_failed" });
  }
}));

// ── POST /admin/jobs/story-retention ────────────────────────────────────────
/**
 * Run one story-retention pass now, for a schedule that lives outside this
 * process.
 *
 * WHY THIS EXISTS AND THE TIMER DOES NOT SUFFICE. `.replit` declares
 * `deploymentTarget = "autoscale"`. An Autoscale host suspends a container
 * that has served no request for fifteen minutes, and a suspended container's
 * event loop does not advance, so `setInterval(…, 1h)` in
 * lib/storyRetentionScheduler.ts only fires when traffic happens to keep one
 * instance awake across a whole hour. This is measured, not feared: every
 * job_health row on production froze at 2026-09-30T15:30:36Z, the last
 * job_health upsert before that returned 200, and no request from the app
 * reached the database for the following two days. The purge did not fail, it
 * did not run.
 *
 * A request is the one thing that reliably wakes an Autoscale container, which
 * makes an authenticated POST the natural shape: the thing that triggers the
 * pass is also the thing that makes the pass possible.
 *
 * WHY IT DOES NOT REUSE /admin/cleanup/expired-stories. That route runs
 * `sweepExpiredStories`, which is EXPIRY (active → expired, 24-hour window)
 * and writes no job_health row at all. This route runs the RETENTION purge,
 * which is the 365/30/30-day deletion. They are different jobs on different
 * clocks and a schedule needs both; collapsing them would mean a caller could
 * not tell which one failed.
 *
 * THE STATUS CODE IS THE VERDICT, because the caller is a cron job that can
 * only act on an exit status:
 *   200  the pass ran and had no failures at all.
 *   409  another pass holds the lease. Not an error — the work is in hand.
 *   500  the pass ran and did not succeed. The failure list is in the body.
 *   503  no service client, so nothing was attempted.
 * A pass that purged nothing because it could not read the archive answers
 * 500, never 200 with a zero count: per decision 4, a failed purge is never
 * reported as zero work.
 *
 * Same secret and the same constant-time compare as the two cleanup routes.
 */
router.post("/admin/jobs/story-retention", asyncHandler(async (req, res) => {
  const secret = process.env.CLEANUP_ADMIN_SECRET;
  if (!secret) {
    logger.error("admin/jobs/story-retention: CLEANUP_ADMIN_SECRET is not configured — refusing to run");
    res.status(500).json({ error: "cleanup_secret_not_configured" });
    return;
  }
  if (!safeSecretEquals(req.headers["x-cleanup-secret"], secret)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const sc = getServiceClient();
  if (!sc) {
    logger.error("admin/jobs/story-retention: no service client — refusing to run");
    res.status(503).json({ error: "degraded_unavailable" });
    return;
  }

  // A cold-started container has an empty status object, and the external
  // schedule means a cold start is the NORMAL case here rather than the rare
  // one. Without this read the response would report a job that has never
  // succeeded as merely not having run yet — the precise confusion decision 4
  // exists to prevent.
  const before = getStoryRetentionStatus();
  await hydrateStoryRetentionStatus(sc);

  const status = await runStoryRetentionTick(sc);
  const skipped = status.lastSkippedAt !== null && status.lastSkippedAt !== before.lastSkippedAt;

  if (skipped) {
    res.status(409).json({
      ran: false,
      reason: "another pass holds the lease",
      lastSuccessAt: status.lastSuccessAt,
    });
    return;
  }

  const succeeded = status.lastFailures.length === 0 && status.lastSuccessAt === status.lastAttemptAt;
  res.status(succeeded ? 200 : 500).json({
    ran: true,
    succeeded,
    lastAttemptAt: status.lastAttemptAt,
    lastSuccessAt: status.lastSuccessAt,
    consecutiveFailures: status.consecutiveFailures,
    backlog: status.backlog,
    failures: status.lastFailures,
    report: status.lastReport,
  });
}));

// ── GET /healthz/schedulers ──────────────────────────────────────────────────
/**
 * One readable verdict for every background job whose health was computed and
 * then thrown away.
 *
 * WHY THIS EXISTS. Ten schedulers keep a status object. Two of them were
 * reachable (`/healthz/cleanup`). The other eight were not reachable at all —
 * `getReconcileStatus`, three separate `getSweepStatus`, `getSweeperStatus`,
 * `callSweepFailureState`, `getLiveShareSweepStatus` and
 * `getNotificationMaintenanceStatus` had zero callers in the tree. A job that
 * fails repeatedly and reports nothing an operator can read is indistinguishable
 * from a job that is working, and that is the whole defect.
 *
 * THREE STATES, KEPT APART, because collapsing any two of them is how this
 * surface would lie:
 *
 *   "healthy"    the job has run AND its last pass did not fail.
 *   "failing"    consecutiveFailures > 0, or the last outcome was an error.
 *                Not "it failed once long ago": every job resets the counter
 *                to 0 on a pass that genuinely succeeded, so a non-zero
 *                counter means it is failing NOW, repeatedly.
 *   "never_ran"  the job tracks a run timestamp and has none. A fresh process
 *                is legitimately here; a process that has been up for hours is
 *                not, and the operator can tell the difference from uptime.
 *   "unknown"    the job exposes NO run timestamp, so "it ran and was fine"
 *                cannot be told from "it never started". Only callSweepScheduler
 *                is in this state today; it is reported honestly rather than
 *                being counted as healthy, and giving it a lastRunAt is a
 *                one-line change in a file this pass does not own.
 *
 * THE STATUS CODE IS THE VERDICT. 503 when anything is failing — an operator's
 * probe must not have to parse the body to learn that eight sweepers are down.
 * `never_ran` stays 200 on purpose: it is the correct state for the first
 * minute of a process's life, and a check that flaps on every deploy is a check
 * that gets muted.
 *
 * Unauthenticated, like the other /healthz routes. The body carries counters
 * and timestamps only — no user data, no identifiers.
 */
type JobHealth = "healthy" | "failing" | "stale" | "never_ran" | "unknown";

interface JobReport {
  job: string;
  status: JobHealth;
  lastRunAt: string | null;
  /** When the job distinguishes "attempted" from "succeeded"; null when it does not. */
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  detail?: string;
}

function classify(o: {
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  consecutiveFailures?: number;
  lastOutcome?: string | null;
  /** false when the job keeps no run timestamp at all. */
  tracksLastRun?: boolean;
  /**
   * True for a job that distinguishes an ATTEMPT from a SUCCESS. For those,
   * `lastRunAt` alone can never make the job healthy: a job that has attempted
   * a hundred times and succeeded never would otherwise read exactly like one
   * that is working. Jobs that do not track success are unaffected and keep
   * their previous classification.
   */
  requiresSuccess?: boolean;
  /**
   * How old the newest success may be before the job stops being healthy.
   * Omitted for every job whose timestamps live only in this process's memory,
   * because there a restart legitimately resets them to null and the answer is
   * `never_ran`, not `stale`. Set it only where the timestamp is PERSISTED and
   * re-read at startup, so the comparison survives the restart it is meant to
   * see through.
   */
  staleAfterMs?: number;
  /** Clock seam. Tests pass a fixed now; production never passes it. */
  now?: number;
}): JobHealth {
  if ((o.consecutiveFailures ?? 0) > 0) return "failing";
  if (o.lastOutcome === "error") return "failing";
  if (o.tracksLastRun === false) return "unknown";
  if (o.requiresSuccess && !o.lastSuccessAt) return "never_ran";
  if (!o.lastRunAt) return "never_ran";

  // STALENESS. Everything above this line asks the job how it feels, and a job
  // that is not running cannot answer: `consecutiveFailures` is a counter in a
  // process, so a process that stopped ticking — or that was replaced by one
  // that never ticked — carries a zero. That is how a two-day-old success read
  // as "healthy" while production had purged nothing since 2026-09-30. The only
  // signal a stopped job cannot launder is the clock, so the clock is consulted
  // last and against the PERSISTED success.
  if (o.staleAfterMs !== undefined) {
    const anchor = o.requiresSuccess ? o.lastSuccessAt : o.lastRunAt;
    const at = anchor ? Date.parse(anchor) : Number.NaN;
    // An unparseable timestamp is not a recent one. Per CONTRIBUTING.md:33-66 a
    // check that cannot establish its result does not get to pass.
    if (!Number.isFinite(at)) return "never_ran";
    if ((o.now ?? Date.now()) - at > o.staleAfterMs) return "stale";
  }
  return "healthy";
}

function schedulerReports(): JobReport[] {
  const reports: JobReport[] = [];

  const reconcile = getReconcileStatus();
  reports.push({
    job: "inviteSlotReconciler",
    status: classify(reconcile),
    lastRunAt: reconcile.lastRunAt,
    lastSuccessAt: null,
    consecutiveFailures: reconcile.consecutiveFailures,
  });

  const zombie = getZombieTokenSweepStatus();
  reports.push({
    job: "zombieTokenSweeper",
    status: classify(zombie),
    lastRunAt: zombie.lastRunAt,
    lastSuccessAt: null,
    consecutiveFailures: zombie.consecutiveFailures,
  });

  const waitlist = getEventWaitlistSweepStatus();
  reports.push({
    job: "eventWaitlistSweeper",
    status: classify(waitlist),
    lastRunAt: waitlist.lastRunAt,
    lastSuccessAt: null,
    consecutiveFailures: waitlist.consecutiveFailures,
  });

  const buddy = getBuddyRequestSweepStatus();
  reports.push({
    job: "rentBuddyRequestSweeper",
    status: classify(buddy),
    lastRunAt: buddy.lastRunAt,
    lastSuccessAt: null,
    consecutiveFailures: buddy.consecutiveFailures,
  });

  const slots = getInviteSlotSweeperStatus();
  reports.push({
    job: "inviteSlotSweeper",
    status: classify(slots),
    lastRunAt: slots.lastRunAt,
    lastSuccessAt: null,
    consecutiveFailures: slots.consecutiveFailures,
  });

  const calls = callSweepFailureState();
  reports.push({
    job: "callSweepScheduler",
    // No lastRunAt is exported by this scheduler, so a clean counter proves
    // only "not failing", never "it ran". Reported as `unknown` rather than
    // borrowed optimism.
    status: classify({ consecutiveFailures: calls.consecutiveFailures, tracksLastRun: false }),
    lastRunAt: null,
    lastSuccessAt: null,
    consecutiveFailures: calls.consecutiveFailures,
    detail: calls.lastError
      ? `last error: ${calls.lastError}`
      : "this scheduler exports no run timestamp — a clean counter cannot prove it ticked",
  });

  const liveShare = getLiveShareSweepStatus();
  reports.push({
    job: "tripCrewLiveShareScheduler",
    status: classify(liveShare),
    lastRunAt: liveShare.lastRunAt,
    lastSuccessAt: liveShare.lastSuccessAt,
    consecutiveFailures: liveShare.consecutiveFailures,
    detail: liveShare.lastFailures.length > 0 ? `last failures: ${liveShare.lastFailures.join(", ")}` : undefined,
  });

  const notif = getNotificationMaintenanceStatus();
  reports.push({
    job: "notificationMaintenanceScheduler",
    status: classify(notif),
    lastRunAt: notif.lastRunAt,
    lastSuccessAt: notif.lastSuccessAt,
    consecutiveFailures: notif.consecutiveFailures,
    detail: notif.lastFailures.length > 0
      ? `last failures: ${notif.lastFailures.join(", ")}`
      : (notif.lastSkippedReason ? `last tick skipped: ${notif.lastSkippedReason}` : undefined),
  });

  // Already readable at /healthz/cleanup, repeated here so ONE probe covers the
  // whole class and an operator does not have to know which jobs got lucky.
  const cleanup = getCleanupStatus();
  reports.push({
    job: "dailyBriefCleanup",
    status: classify(cleanup),
    lastRunAt: cleanup.lastRunAt,
    lastSuccessAt: null,
    consecutiveFailures: cleanup.consecutiveFailures,
  });

  // Story retention. The one job on this list whose failure is a privacy
  // promise rather than a stale row, so it is the one job that must never read
  // as healthy on the strength of having been ATTEMPTED — see decision 4 and
  // lib/storyRetentionScheduler.ts. `backlog` is reported separately from the
  // failure list because a pass can succeed while the ledger grows, and that
  // combination is what a purge looks like when it has quietly stopped working.
  const retention = getStoryRetentionStatus();
  reports.push({
    job: "storyRetention",
    status: classify({
      lastRunAt: retention.lastAttemptAt,
      lastSuccessAt: retention.lastSuccessAt,
      consecutiveFailures: retention.consecutiveFailures,
      requiresSuccess: true,
      // The one job on this list whose success timestamp is persisted in
      // job_health and re-read at startup (hydrateStoryRetentionStatus), so it
      // is the one job where an age comparison means something across a
      // restart. Every other job here would report `stale` for every fresh
      // process, which is the flapping the docblock above refuses.
      staleAfterMs: STORY_RETENTION_STALE_AFTER_MS,
    }),
    lastRunAt: retention.lastAttemptAt,
    lastSuccessAt: retention.lastSuccessAt,
    consecutiveFailures: retention.consecutiveFailures,
    detail: [
      retention.backlog === null
        ? "backlog unknown (never measured, or the ledger was unreadable)"
        : `backlog: ${retention.backlog}`,
      retention.lastFailures.length > 0 ? `last failures: ${retention.lastFailures.join("; ")}` : null,
      retention.lastSkippedAt ? `last skipped (another pass held the lease): ${retention.lastSkippedAt}` : null,
      // Every number the owner asked to be kept apart, printed apart. The old
      // line showed `completed` next to `kept-for-reference` and nothing else,
      // so a pass that settled ten entries and deleted no bytes at all read as
      // a successful cleanup.
      retention.lastReport
        ? `last pass: enqueued ${retention.lastReport.enqueuedArchive}+${retention.lastReport.enqueuedDeleted}, settled ${retention.lastReport.completed} (objects deleted ${retention.lastReport.objectsDeleted}+${retention.lastReport.derivedSettled} derived, kept for a live reference ${retention.lastReport.retained}, not ours ${retention.lastReport.external}), deferred ${retention.lastReport.deferred}`
        : null,
    ].filter(Boolean).join(" | "),
  });

  const seen = getSuggestionSeenStatus();
  reports.push({
    job: "suggestionSeenCleanup",
    // Keeps no failure counter; `lastOutcome` is its only failure signal.
    status: classify({ lastRunAt: seen.lastRunAt, lastOutcome: seen.lastOutcome }),
    lastRunAt: seen.lastRunAt,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    detail: seen.lastOutcome ? `last outcome: ${seen.lastOutcome}` : undefined,
  });

  return reports;
}

router.get("/healthz/schedulers", (_req, res) => {
  const jobs = schedulerReports();

  const failing = jobs.filter((j) => j.status === "failing");
  const stale = jobs.filter((j) => j.status === "stale");
  const neverRan = jobs.filter((j) => j.status === "never_ran");
  const unknown = jobs.filter((j) => j.status === "unknown");

  // Vacuity guard: an aggregate that reports on nothing is a green light that
  // means nothing. If the report list is ever empty, that is itself a failure.
  if (jobs.length === 0) {
    res.status(503).json({ overall: "failing", jobs: [], error: "no scheduler reported" });
    return;
  }

  const overall: JobHealth =
    failing.length > 0
      ? "failing"
      : stale.length > 0
        ? "stale"
        : neverRan.length > 0
          ? "never_ran"
          : "healthy";

  if (failing.length > 0) {
    logger.error(
      { failing: failing.map((j) => ({ job: j.job, consecutiveFailures: j.consecutiveFailures })) },
      "schedulerHealthCheck: background jobs are failing repeatedly",
    );
  }
  if (stale.length > 0) {
    logger.error(
      { stale: stale.map((j) => ({ job: j.job, lastSuccessAt: j.lastSuccessAt })) },
      "schedulerHealthCheck: background jobs have not succeeded within their cadence",
    );
  }

  // `stale` answers 503, unlike `never_ran`. The reason never_ran stays 200 is
  // that it is the correct state for the first minute of a process's life, so
  // alarming on it would flap on every deploy and get muted. Staleness cannot
  // flap that way: it is measured against a timestamp read back out of the
  // database at startup, so a fresh process inherits the real age instead of a
  // clean slate. A job that has not succeeded within its own decided cadence is
  // the exact condition an operator's probe exists to catch.
  res.status(failing.length > 0 || stale.length > 0 ? 503 : 200).json({
    overall,
    jobCount: jobs.length,
    failingCount: failing.length,
    staleCount: stale.length,
    neverRanCount: neverRan.length,
    unknownCount: unknown.length,
    jobs,
  });
});

export default router;
