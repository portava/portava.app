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
import { getLiveShareSweepStatus } from "../lib/tripCrewLiveShareScheduler.js";
import { getNotificationMaintenanceStatus } from "../lib/notificationMaintenanceScheduler.js";

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
type JobHealth = "healthy" | "failing" | "never_ran" | "unknown";

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
  consecutiveFailures?: number;
  lastOutcome?: string | null;
  /** false when the job keeps no run timestamp at all. */
  tracksLastRun?: boolean;
}): JobHealth {
  if ((o.consecutiveFailures ?? 0) > 0) return "failing";
  if (o.lastOutcome === "error") return "failing";
  if (o.tracksLastRun === false) return "unknown";
  if (!o.lastRunAt) return "never_ran";
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
  const neverRan = jobs.filter((j) => j.status === "never_ran");
  const unknown = jobs.filter((j) => j.status === "unknown");

  // Vacuity guard: an aggregate that reports on nothing is a green light that
  // means nothing. If the report list is ever empty, that is itself a failure.
  if (jobs.length === 0) {
    res.status(503).json({ overall: "failing", jobs: [], error: "no scheduler reported" });
    return;
  }

  const overall: JobHealth =
    failing.length > 0 ? "failing" : neverRan.length > 0 ? "never_ran" : "healthy";

  if (failing.length > 0) {
    logger.error(
      { failing: failing.map((j) => ({ job: j.job, consecutiveFailures: j.consecutiveFailures })) },
      "schedulerHealthCheck: background jobs are failing repeatedly",
    );
  }

  res.status(failing.length > 0 ? 503 : 200).json({
    overall,
    jobCount: jobs.length,
    failingCount: failing.length,
    neverRanCount: neverRan.length,
    unknownCount: unknown.length,
    jobs,
  });
});

export default router;
