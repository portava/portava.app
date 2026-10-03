/**
 * Story retention scheduler — the cadence, and the honest status.
 *
 * Owner decision 4, 2026-09-22: "register an hourly, bounded, retryable
 * retention job under the existing scheduler infrastructure. Expose last
 * attempt, last success, backlog, and failures. Never report 'healthy' before a
 * successful run or report a failed purge as zero work."
 *
 * ── WHY THE CADENCE IS THE POINT ─────────────────────────────────────────────
 * The job this one succeeds — `sweepExpiredStories` (routes/stories.ts:973) —
 * was correct code with no caller. Its docblock said "Called from the
 * health/cleanup endpoint"; nothing called it; and for months every Story row
 * stayed `active` and every object stayed in the bucket while the tree read as
 * though expiry worked. `AccountDeletionService.ts:689` then reasoned from it
 * ("sweepExpiredStories already deletes story bytes on EXPIRY"), building a
 * premise on a job that had never run.
 *
 * A retention job that silently stops running is indistinguishable from one
 * that is working, and the difference is a privacy promise. So this file's real
 * job is not the timer — it is making "it has not run" and "it has never
 * succeeded" impossible to confuse with health.
 *
 * ── THE THREE THINGS THAT ARE KEPT APART ─────────────────────────────────────
 *   lastAttemptAt   a tick started AND claimed the job. Says nothing about the
 *                   outcome. Persisted as job_health.last_run_at, which since
 *                   the lease landed is the attempt's START, not its end.
 *   lastSkippedAt   a tick that did nothing because another caller held the
 *                   lease. Neither an attempt nor a failure, and kept apart
 *                   from both so an overlap cannot be read as a missed hour.
 *   lastSuccessAt   a tick finished with an EMPTY failure list. Only this one
 *                   is allowed to make the job healthy, and it is persisted to
 *                   job_health.last_success_at so a restart cannot launder a
 *                   job that has never succeeded into a fresh-looking one.
 *   backlog         ledger entries still outstanding. A pass with failures and
 *                   a growing backlog is the shape of a purge that has quietly
 *                   stopped working, and neither number alone shows it.
 *
 * ── WHY THE CADENCE CANNOT LIVE HERE ALONE ───────────────────────────────────
 * This file's `setInterval` is no longer the schedule, only a fallback. The
 * host is an Autoscale deployment that suspends an idle container, and a
 * suspended container's timers do not fire; production stopped writing every
 * job_health row at 2026-09-30T15:30:36Z and nothing reached the database for
 * the next two days. The cadence now comes from outside the process, through
 * POST /admin/jobs/story-retention, and `claimStoryRetentionLease` below is
 * what makes two callers safe.
 *
 * A pass that throws, or that returns ANY failure — including a configuration
 * divergence — is not a success. In particular, a pass that purged nothing
 * because it could not read the archive reports a failure, never zero work.
 */
import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger } from "./logger.js";
import { runStoryRetention, type RetentionReport } from "../services/stories/storyRetention.js";

export const JOB_KEY = "storyRetention";

/** Hourly, per decision 4. Not env-tunable: the cadence was decided, not configured. */
export const STORY_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;

/** Let the process finish booting before the first pass touches storage. */
export const STORY_RETENTION_STARTUP_DELAY_MS = 90 * 1_000;

/**
 * How long after its last SUCCESS the job stops counting as healthy.
 *
 * THIS IS NOT AN OWNER-APPROVED DURATION. Decision 4 decided the cadence
 * (hourly) and decided that "healthy" may never precede a success. Nobody has
 * decided how many missed hours is an alarm. So this is DERIVED from the
 * decided cadence rather than invented: three intervals tolerates two
 * consecutive misses, which is the smallest window that does not alarm on one
 * late external trigger. It is named here, in one place, so the number that
 * needs deciding is findable rather than buried in a comparison.
 */
export const STORY_RETENTION_STALE_AFTER_MS = 3 * STORY_RETENTION_INTERVAL_MS;

/**
 * How long a claimed pass holds the job before another caller may claim it.
 *
 * Sized to cover a pass, not to space passes out: it exists to stop two passes
 * running AT ONCE, and an extra pass an hour later is not a problem the lease
 * is for. Keeping it well under the cadence means a late external trigger is
 * never silently dropped.
 */
export const STORY_RETENTION_LEASE_MS = 15 * 60 * 1_000;

export interface StoryRetentionStatus {
  /** A tick began. Never evidence that it worked. */
  lastAttemptAt: string | null;
  /** A tick ended with no failures at all. The only thing that means healthy. */
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  /** Outstanding ledger entries after the last pass; null when never measured or unreadable. */
  backlog: number | null;
  /** Failures from the most recent pass, verbatim. */
  lastFailures: string[];
  /**
   * The most recent tick that did no work because another caller held the
   * lease. Kept apart from both attempt and failure: a skip is neither.
   */
  lastSkippedAt: string | null;
  /** Counts from the most recent pass, for an operator reading one line. */
  lastReport: Pick<
    RetentionReport,
    | "enqueuedArchive"
    | "enqueuedDeleted"
    | "completed"
    // The four outcomes the owner asked to be kept apart. `completed` alone
    // cannot answer "were the bytes deleted", so it is never reported alone.
    | "objectsDeleted"
    | "retained"
    | "external"
    | "deferred"
    | "engagementStoriesPurged"
  > | null;
}

const _status: StoryRetentionStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  backlog: null,
  lastFailures: [],
  lastSkippedAt: null,
  lastReport: null,
};

/** Snapshot for /healthz/schedulers. */
export function getStoryRetentionStatus(): Readonly<StoryRetentionStatus> {
  return { ..._status, lastFailures: [..._status.lastFailures] };
}

/** Test seam: reset module state between cases. */
export function _resetStoryRetentionStatus(): void {
  _status.lastAttemptAt = null;
  _status.lastSuccessAt = null;
  _status.consecutiveFailures = 0;
  _status.backlog = null;
  _status.lastFailures = [];
  _status.lastSkippedAt = null;
  _status.lastReport = null;
}

/**
 * Load the persisted success timestamp so a freshly started process does not
 * report a job that has never succeeded as merely "not run yet". Called once at
 * startup; a read failure leaves the timestamp null, which is the pessimistic
 * reading and the correct one.
 */
export async function hydrateStoryRetentionStatus(db?: any): Promise<void> {
  const client = db ?? (isServiceClientReady ? getServiceClient() : null);
  if (!client) return;
  const { data, error } = await client
    .from("job_health")
    .select("last_run_at, last_success_at")
    .eq("job", JOB_KEY)
    .maybeSingle();
  if (error || !data) return;
  _status.lastAttemptAt = (data as any).last_run_at ?? null;
  _status.lastSuccessAt = (data as any).last_success_at ?? null;
}

export type LeaseOutcome = "acquired" | "held";

/**
 * Claim the job before any work happens, so two callers cannot purge at once.
 *
 * WHY A LEASE EXISTS NOW. The cadence used to live in exactly one place, this
 * file's `setInterval`. It cannot any more: `.replit` declares
 * `deploymentTarget = "autoscale"`, an Autoscale host suspends a container
 * that has served no request for fifteen minutes, and a suspended container's
 * event loop does not advance — so an in-process hourly timer is not a
 * schedule, it is a timer that fires if traffic happens to keep the instance
 * awake for a whole hour. Production proved it: every scheduler on this host
 * stopped writing at 2026-09-30T15:30:36Z and nothing has reached the database
 * since. The cadence therefore has to come from outside the process (see
 * POST /admin/jobs/story-retention), and the moment a second caller exists,
 * two passes can overlap. Scale-up makes it worse: every instance runs its own
 * copy of the timer.
 *
 * WHY `last_run_at` IS THE LEASE. There is no lock column, and adding one is a
 * migration — which on this project is a manual production step an owner has
 * to perform, so a design that needs one does not ship this week. `job_health`
 * already carries a row per job with a timestamp, and PostgREST compiles a
 * filtered UPDATE into one statement, so `set last_run_at = $now where job = $k
 * and last_run_at < $cutoff` is atomic: of N concurrent callers exactly one
 * gets a row back. The cost, stated because `last_success_at` is compared
 * against it: `last_run_at` now means the most recent attempt STARTED, where it
 * used to mean the most recent attempt ended.
 *
 * WHAT THE LEASE IS NOT. It is not what makes a duplicate pass safe — that is
 * `story_purge_queue` and its read-backs, which are idempotent by design. The
 * lease only stops the wasted concurrent work. Which is exactly why failing to
 * claim is a SKIP and never a failure: an ordinary overlap reported as a
 * failure would make a working purge look broken, and a retention job that
 * cries wolf is a retention job nobody reads.
 *
 * FAILING OPEN IS DELIBERATE HERE, and it is the opposite of the choice the
 * purge itself makes. A purge that cannot establish whether media is still
 * referenced must not delete it. A scheduler that cannot read its own lease
 * must still run, because the alternative is a retention job that stops
 * retaining because its bookkeeping broke. The duplicate work is absorbed by
 * the ledger; a skipped hour is not absorbed by anything.
 */
export async function claimStoryRetentionLease(
  client: any,
  attemptAt: string,
  leaseMs: number = STORY_RETENTION_LEASE_MS,
): Promise<LeaseOutcome> {
  const cutoff = new Date(Date.parse(attemptAt) - leaseMs).toISOString();

  const { data, error } = await client
    .from("job_health")
    .update({ last_run_at: attemptAt })
    .eq("job", JOB_KEY)
    .lt("last_run_at", cutoff)
    .select("job");
  if (error) {
    logger.warn({ job: JOB_KEY, err: error }, "storyRetention: could not claim the lease; running anyway");
    return "acquired";
  }
  if ((data?.length ?? 0) > 0) return "acquired";

  // No row came back, which is either "someone claimed it recently" or "this
  // job has no row at all yet". Those are opposite answers, so they are not
  // guessed at.
  const { data: existing, error: readErr } = await client
    .from("job_health")
    .select("job")
    .eq("job", JOB_KEY)
    .maybeSingle();
  if (readErr) {
    logger.warn({ job: JOB_KEY, err: readErr }, "storyRetention: could not read the lease row; running anyway");
    return "acquired";
  }
  if (existing) return "held";

  // First ever run. `ignoreDuplicates` makes this ON CONFLICT DO NOTHING, so
  // of N racing first-runs exactly one row is inserted; reading it back says
  // whether the insert was ours.
  const { error: insErr } = await client
    .from("job_health")
    .upsert({ job: JOB_KEY, last_run_at: attemptAt }, { onConflict: "job", ignoreDuplicates: true });
  if (insErr) {
    logger.warn({ job: JOB_KEY, err: insErr }, "storyRetention: could not create the lease row; running anyway");
    return "acquired";
  }
  // Bound with `error` and acted on, because supabase-js RESOLVES on a database
  // error: `const { data } = await …` would turn a failed read into an empty
  // result, and an empty result here reads as "our insert did not win" — which
  // would make an unreadable row look like a held lease and skip the pass. The
  // whole point of this function failing open is that a skipped hour is
  // absorbed by nothing.
  const { data: after, error: afterErr } = await client
    .from("job_health")
    .select("last_run_at")
    .eq("job", JOB_KEY)
    .maybeSingle();
  if (afterErr) {
    logger.warn(
      { job: JOB_KEY, err: afterErr },
      "storyRetention: could not read the lease row back after inserting it; running anyway",
    );
    return "acquired";
  }
  return (after as any)?.last_run_at === attemptAt ? "acquired" : "held";
}

/**
 * One tick. Never throws: a scheduler that dies on a bad pass stops retaining
 * anything at all, which is worse than the bad pass. The outcome goes into the
 * status object and the log instead, and the next tick retries.
 *
 * `lease: false` runs without claiming, for tests that drive the pass directly.
 */
export async function runStoryRetentionTick(
  db?: any,
  opts: { lease?: boolean } = {},
): Promise<StoryRetentionStatus> {
  const client = db ?? (isServiceClientReady ? getServiceClient() : null);
  const attemptAt = new Date().toISOString();

  if (!client) {
    _status.lastAttemptAt = attemptAt;
    _status.consecutiveFailures += 1;
    _status.lastFailures = ["no service client — the retention pass did not run"];
    logger.error({ job: JOB_KEY }, "storyRetention: no service client; nothing was purged");
    return getStoryRetentionStatus();
  }

  if (opts.lease !== false) {
    const lease = await claimStoryRetentionLease(client, attemptAt);
    if (lease === "held") {
      // Not an attempt and not a failure. The status object keeps it as its own
      // third thing so an operator reading "no attempt since" is not told a
      // skipped overlap was a missed hour.
      _status.lastSkippedAt = attemptAt;
      logger.info({ job: JOB_KEY }, "storyRetention: another pass holds the lease; this tick did no work");
      return getStoryRetentionStatus();
    }
  }

  _status.lastAttemptAt = attemptAt;

  let report: RetentionReport | null = null;
  let threw: string | null = null;
  try {
    report = await runStoryRetention(client);
  } catch (err) {
    threw = (err as any)?.message ?? String(err);
  }

  const failures = threw ? [`retention pass threw: ${threw}`] : (report?.failures ?? []);
  const succeeded = failures.length === 0 && report !== null;

  _status.lastFailures = failures;
  _status.backlog = report && report.backlog >= 0 ? report.backlog : null;
  _status.lastReport = report
    ? {
        enqueuedArchive: report.enqueuedArchive,
        enqueuedDeleted: report.enqueuedDeleted,
        completed: report.completed,
        objectsDeleted: report.objectsDeleted,
        retained: report.retained,
        external: report.external,
        deferred: report.deferred,
        engagementStoriesPurged: report.engagementStoriesPurged,
      }
    : null;

  if (succeeded) {
    _status.consecutiveFailures = 0;
    _status.lastSuccessAt = attemptAt;
  } else {
    _status.consecutiveFailures += 1;
  }

  // Persist the attempt always and the success only when there was one. Writing
  // last_success_at unconditionally is precisely the confusion decision 4 rules
  // out, so the column is simply omitted from the upsert on a failed pass.
  const row: Record<string, unknown> = { job: JOB_KEY, last_run_at: attemptAt };
  if (succeeded) row.last_success_at = attemptAt;
  const { error: healthErr } = await client.from("job_health").upsert(row, { onConflict: "job" });
  if (healthErr) {
    logger.warn({ job: JOB_KEY, err: healthErr }, "storyRetention: could not persist job health");
  }

  if (succeeded) {
    logger.info(
      { job: JOB_KEY, ...(_status.lastReport ?? {}), backlog: _status.backlog },
      "storyRetention: pass complete",
    );
  } else {
    logger.error(
      { job: JOB_KEY, failures, backlog: _status.backlog, consecutiveFailures: _status.consecutiveFailures },
      "storyRetention: pass did NOT succeed — retention is not current",
    );
  }

  return getStoryRetentionStatus();
}

let _timer: NodeJS.Timeout | null = null;

/** Start the hourly scheduler. Idempotent; a second call is a no-op. */
export function startStoryRetentionScheduler(): void {
  if (_timer) return;
  setTimeout(() => {
    void hydrateStoryRetentionStatus().then(() => runStoryRetentionTick());
    _timer = setInterval(() => void runStoryRetentionTick(), STORY_RETENTION_INTERVAL_MS);
    if (typeof _timer.unref === "function") _timer.unref();
  }, STORY_RETENTION_STARTUP_DELAY_MS).unref?.();
}

/** Stop the scheduler. For tests and for a clean shutdown. */
export function stopStoryRetentionScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
