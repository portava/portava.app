/**
 * Memory deletion redrive — re-runs §21's deletion lifecycle for the deletions
 * that dead-lettered. Census H193 ("dead-lettered on repeated downstream
 * failure" — and a dead letter nothing ever retries is a record, not a queue).
 *
 * WHAT A PASS DOES. Reads the oldest open rows of memory_deletion_dead_letters
 * (3670), at most REDRIVE_BATCH, and for each:
 *   - the Memory is still `deleted`, or its row is gone (account deletion
 *     hard-deletes): re-run runMemoryDeletionLifecycle. The lifecycle itself
 *     resolves the letter when it completes and bumps it when it does not, so
 *     this file writes nothing for that case.
 *   - the Memory exists and is NOT deleted: the letter is MOOT — nothing here
 *     runs a deletion step against a live Memory (step 3 would revoke its
 *     derivatives for good). The letter is closed, and its detail says why.
 *   - the Memory cannot be read: left open for the next pass.
 *
 * GATED. `memory_deletion_redrive_enabled` (3670, seeded FALSE), read on every
 * tick, fail-closed: off, absent or unreadable ⇒ the pass does nothing else.
 * Absent table ⇒ `not_deployed`.
 *
 * THE HOUSE SHAPE (memoryProjectionScheduler): a startup delay, then a
 * self-rescheduling setTimeout that re-arms ONLY while `_timer` is not null (so
 * stop() during a pass ends the loop), unref()'d so it never keeps a process
 * alive, every error logged and swallowed.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { isTableAbsentError } from "./tableAbsence.js";
import { runMemoryDeletionLifecycle } from "../services/memory/memoryDeletionLifecycle.js";

export const REDRIVE_FLAG = "memory_deletion_redrive_enabled";
export const REDRIVE_BATCH = 25;
const STARTUP_DELAY_MS = 7 * 60 * 1000;
const INTERVAL_MS = 60 * 60 * 1000;

let _timer: ReturnType<typeof setTimeout> | null = null;
/**
 * Which loop is current. `_timer !== null` alone is not enough: stop() then
 * start() while a pass is still in flight leaves that pass's `.finally` seeing
 * the NEW loop's non-null timer, and it re-arms the OLD loop beside it — two
 * loops. A pass re-arms only if its own loop is still the current one.
 */
let _generation = 0;

export interface RedriveResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "not_deployed" | "error" | null;
  considered: number;
  /** Re-run and completed: the lifecycle resolved the letter. */
  resolved: number;
  /** Re-run and still failing: the lifecycle bumped the letter. */
  stillFailing: number;
  /** The Memory is not deleted: closed without running a step. */
  moot: number;
  /** The Memory could not be read: left open. */
  unreadable: number;
  /**
   * The letter records that the DELETED step failed and the Memory is still not
   * deleted: the deletion itself did not take. Never closed and never re-run
   * here — an operator's letter. Moved to the back of the queue so it cannot
   * starve the batch.
   */
  needsOperator: number;
}

export async function runMemoryDeletionRedrivePass(
  opts: { client?: any; now?: Date } = {},
): Promise<RedriveResult> {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  const out: RedriveResult = { skipped: true, reason: null, considered: 0, resolved: 0, stillFailing: 0, moot: 0, unreadable: 0, needsOperator: 0 };
  if (!db) return { ...out, reason: "no_client" };
  if (!(await isFlagEnabled(db, REDRIVE_FLAG))) return { ...out, reason: "disabled" };
  const now = opts.now ?? new Date();

  try {
    const { data, error } = await db
      .from("memory_deletion_dead_letters")
      .select("memory_id, owner_id, detail, failed_steps")
      .is("resolved_at", null)
      .order("last_failed_at", { ascending: true })
      .limit(REDRIVE_BATCH);
    if (error) {
      if (isTableAbsentError(error)) return { ...out, reason: "not_deployed" };
      logger.warn({ err: error }, "memory deletion redrive: open letters unreadable");
      return { ...out, reason: "error" };
    }
    const letters = (Array.isArray(data) ? data : []) as Array<{ memory_id: string; owner_id: string; detail: string; failed_steps: string[] | null }>;
    const result: RedriveResult = { ...out, skipped: false, considered: letters.length };

    for (const letter of letters) {
      const { data: row, error: rowErr } = await db
        .from("memories")
        .select("id, owner_id, state, visibility, allowed_user_ids, hidden_user_ids, trip_id")
        .eq("id", letter.memory_id)
        .maybeSingle();
      // An unreadable row is LEFT OPEN: running the lifecycle on a Memory whose
      // state is unknown could revoke a LIVE Memory's derivatives for good.
      if (rowErr) { result.unreadable += 1; continue; }
      // Re-run ONLY when the deletion is still the Memory's state, said positively:
      // `state === "deleted"` (or the row gone). Every other state is not deleted.
      const stillDeleted = row == null || (row as any).state === "deleted";
      if (!stillDeleted) {
        if ((letter.failed_steps ?? []).includes("DELETED")) {
          const { error: bumpErr } = await db
            .from("memory_deletion_dead_letters")
            .update({ last_failed_at: now.toISOString() })
            .eq("memory_id", letter.memory_id)
            .is("resolved_at", null)
            .select("memory_id");
          if (bumpErr) result.unreadable += 1; else result.needsOperator += 1;
          continue;
        }
        const { error: mootErr } = await db
          .from("memory_deletion_dead_letters")
          .update({ resolved_at: now.toISOString(), detail: `${String(letter.detail ?? "")} | moot: the Memory is '${String((row as any).state)}', not deleted — nothing was re-run`.slice(0, 4000) })
          .eq("memory_id", letter.memory_id)
          .is("resolved_at", null)
          .select("memory_id");
        if (mootErr) result.unreadable += 1; else result.moot += 1;
        continue;
      }
      const report = await runMemoryDeletionLifecycle(db, {
        memoryId: letter.memory_id,
        ownerId: letter.owner_id,
        actorUserId: letter.owner_id,
        previous: {
          visibility: (row as any)?.visibility ?? null,
          allowed_user_ids: (row as any)?.allowed_user_ids ?? null,
          hidden_user_ids: (row as any)?.hidden_user_ids ?? null,
          trip_id: (row as any)?.trip_id ?? null,
          state: "published",
        },
        now,
        log: logger,
      });
      if (report.completed) result.resolved += 1; else result.stillFailing += 1;
    }
    if (result.considered > 0) logger.info({ ...result }, "memory deletion redrive pass complete");
    return result;
  } catch (err) {
    logger.warn({ err }, "memory deletion redrive pass threw");
    return { ...out, reason: "error" };
  }
}

export function startMemoryDeletionRedriveScheduler(
  timing: { startupDelayMs?: number; intervalMs?: number } = {},
): void {
  if (_timer !== null) return;
  const startupDelayMs = timing.startupDelayMs ?? STARTUP_DELAY_MS;
  const intervalMs = timing.intervalMs ?? INTERVAL_MS;
  logger.info({ startupDelayMs, intervalMs, flag: REDRIVE_FLAG }, "MemoryDeletionRedriveScheduler scheduled (no-op until the flag is enabled)");
  const generation = ++_generation;
  _timer = setTimeout(function tick() {
    void runMemoryDeletionRedriveTick()
      .catch((err) => logger.warn({ err }, "memory deletion redrive pass failed"))
      .finally(() => { if (_timer !== null && generation === _generation) { _timer = setTimeout(tick, intervalMs); _timer.unref?.(); } });
  }, startupDelayMs); _timer.unref?.();
}

export function stopMemoryDeletionRedriveScheduler(): void {
  _generation += 1;
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}

// ── Observability (census-highlights-memories §AV, H193) ─────────────────────
// Appended so every line the census cites above holds. The redrive must not
// join the jobs whose stopping leaves no trace (lib/schedulerCoverage.ts): it
// reports at GET /healthz/schedulers as REDRIVE_JOB_KEY, and every pass that
// RUNS writes that job_health row — the attempt always, the success only when
// there was one (storyRetention's rule), so a restart cannot launder a pass
// that never succeeded.
//
// A flag-OFF tick writes NOTHING: it stays one flag read a tick (§AF), and the
// row would only say "off" — the in-process status says that, and the health
// detail names the flag. Being OFF is not a failure: 3670 seeds it FALSE.
//
// WHAT IS A FAILURE OF THE JOB (consecutiveFailures + 1, 503 at the endpoint):
// no service client; the letters table absent while the flag is ON; the open
// letters unreadable or the pass throwing; any letter the pass could not read
// or close (`unreadable`). A letter whose deletion step still fails is NOT a
// job failure: the lifecycle bumps that letter and it stays open, durable in
// memory_deletion_dead_letters; the count is in the detail. Making it one would
// hold the endpoint at 503 for as long as one poisoned letter exists, and a
// check that never clears is a check that gets muted.

export const REDRIVE_JOB_KEY = "memoryDeletionRedrive";

export interface MemoryDeletionRedriveStatus {
  /** A tick began. Never evidence that it worked. */
  lastAttemptAt: string | null;
  /** A tick ended with no job failure (a flag-OFF tick included). */
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  /** The most recent tick's job failures, verbatim. */
  lastFailures: string[];
  /** The most recent pass's counts. */
  lastResult: RedriveResult | null;
}

const _redriveStatus: MemoryDeletionRedriveStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastFailures: [],
  lastResult: null,
};

/** Snapshot for /healthz/schedulers. */
export function getMemoryDeletionRedriveStatus(): Readonly<MemoryDeletionRedriveStatus> {
  return {
    ..._redriveStatus,
    lastFailures: [..._redriveStatus.lastFailures],
    lastResult: _redriveStatus.lastResult ? { ..._redriveStatus.lastResult } : null,
  };
}

/** Test seam: reset module state between cases. */
export function _resetMemoryDeletionRedriveStatus(): void {
  _redriveStatus.lastAttemptAt = null;
  _redriveStatus.lastSuccessAt = null;
  _redriveStatus.consecutiveFailures = 0;
  _redriveStatus.lastFailures = [];
  _redriveStatus.lastResult = null;
}

/** The job failures one pass's result carries; empty = the pass succeeded. */
export function redriveFailuresOf(r: RedriveResult): string[] {
  const failures: string[] = [];
  if (r.reason === "no_client") failures.push("no service client — the redrive pass did not run");
  else if (r.reason === "not_deployed") failures.push(`memory_deletion_dead_letters is absent while ${REDRIVE_FLAG} is ON — is 3670 applied?`);
  else if (r.reason === "error") failures.push("the open letters could not be read, or the pass threw — nothing was retried");
  if (r.unreadable > 0) failures.push(`${r.unreadable} letter(s) could not be read or closed — left open for the next pass`);
  return failures;
}

/** The health detail line: what the last pass did, or that the flag is OFF. */
export function redriveHealthDetail(s: Readonly<MemoryDeletionRedriveStatus>): string | undefined {
  const parts: string[] = [];
  if (s.lastFailures.length > 0) parts.push(`last failures: ${s.lastFailures.join("; ")}`);
  const r = s.lastResult;
  if (r?.reason === "disabled") parts.push(`${REDRIVE_FLAG} is OFF (3670 seeds it FALSE): no dead letter is retried`);
  else if (r && !r.skipped) parts.push(`last pass: considered ${r.considered}, resolved ${r.resolved}, still failing ${r.stillFailing}, moot ${r.moot}, needs an operator ${r.needsOperator}, unreadable ${r.unreadable}`);
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/** One tick: the pass, its status, and (when the pass ran) the job_health row. Never throws. */
export async function runMemoryDeletionRedriveTick(
  opts: { client?: any; now?: Date } = {},
): Promise<Readonly<MemoryDeletionRedriveStatus>> {
  const attemptAt = (opts.now ?? new Date()).toISOString();
  _redriveStatus.lastAttemptAt = attemptAt;
  let result: RedriveResult;
  try {
    result = await runMemoryDeletionRedrivePass(opts);
  } catch (err) {
    logger.warn({ err }, "memory deletion redrive pass threw");
    result = { skipped: true, reason: "error", considered: 0, resolved: 0, stillFailing: 0, moot: 0, unreadable: 0, needsOperator: 0 };
  }
  const failures = redriveFailuresOf(result);
  const succeeded = failures.length === 0;
  _redriveStatus.lastResult = result;
  _redriveStatus.lastFailures = failures;
  if (succeeded) {
    _redriveStatus.consecutiveFailures = 0;
    _redriveStatus.lastSuccessAt = attemptAt;
  } else {
    _redriveStatus.consecutiveFailures += 1;
  }

  if (result.reason !== "disabled" && result.reason !== "no_client") {
    const db = opts.client !== undefined ? opts.client : getServiceClient();
    if (db) {
      const row: Record<string, unknown> = { job: REDRIVE_JOB_KEY, last_run_at: attemptAt };
      if (succeeded) row["last_success_at"] = attemptAt;
      try {
        const { error: healthErr } = await db.from("job_health").upsert(row, { onConflict: "job" });
        if (healthErr) logger.warn({ job: REDRIVE_JOB_KEY, err: healthErr }, "memory deletion redrive: could not persist job health");
      } catch (err) {
        logger.warn({ job: REDRIVE_JOB_KEY, err }, "memory deletion redrive: could not persist job health");
      }
    }
  }

  if (!succeeded) {
    logger.error(
      { job: REDRIVE_JOB_KEY, failures, ...result, consecutiveFailures: _redriveStatus.consecutiveFailures },
      "memory deletion redrive: pass did NOT succeed — dead letters are not being retried",
    );
  }
  return getMemoryDeletionRedriveStatus();
}
