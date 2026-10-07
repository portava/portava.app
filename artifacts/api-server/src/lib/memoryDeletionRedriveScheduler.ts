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
    void runMemoryDeletionRedrivePass()
      .catch((err) => logger.warn({ err }, "memory deletion redrive pass failed"))
      .finally(() => { if (_timer !== null && generation === _generation) { _timer = setTimeout(tick, intervalMs); _timer.unref?.(); } });
  }, startupDelayMs); _timer.unref?.();
}

export function stopMemoryDeletionRedriveScheduler(): void {
  _generation += 1;
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
