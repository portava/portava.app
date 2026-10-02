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
 *   lastAttemptAt   a tick started. Says nothing about the outcome.
 *   lastSuccessAt   a tick finished with an EMPTY failure list. Only this one
 *                   is allowed to make the job healthy, and it is persisted to
 *                   job_health.last_success_at so a restart cannot launder a
 *                   job that has never succeeded into a fresh-looking one.
 *   backlog         ledger entries still outstanding. A pass with failures and
 *                   a growing backlog is the shape of a purge that has quietly
 *                   stopped working, and neither number alone shows it.
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
  /** Counts from the most recent pass, for an operator reading one line. */
  lastReport: Pick<
    RetentionReport,
    "enqueuedArchive" | "enqueuedDeleted" | "completed" | "retained" | "deferred" | "engagementStoriesPurged"
  > | null;
}

const _status: StoryRetentionStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  backlog: null,
  lastFailures: [],
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

/**
 * One tick. Never throws: a scheduler that dies on a bad pass stops retaining
 * anything at all, which is worse than the bad pass. The outcome goes into the
 * status object and the log instead, and the next tick retries.
 */
export async function runStoryRetentionTick(db?: any): Promise<StoryRetentionStatus> {
  const client = db ?? (isServiceClientReady ? getServiceClient() : null);
  const attemptAt = new Date().toISOString();
  _status.lastAttemptAt = attemptAt;

  if (!client) {
    _status.consecutiveFailures += 1;
    _status.lastFailures = ["no service client — the retention pass did not run"];
    logger.error({ job: JOB_KEY }, "storyRetention: no service client; nothing was purged");
    return getStoryRetentionStatus();
  }

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
        retained: report.retained,
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
