/**
 * memoryDeletionLifecycle — §21's five states, per Memory, as an observable and
 * retryable pipeline.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Spec v1 §21
 *       "DELETION_REQUESTED → PUBLIC_REVOKED → DERIVATIVES_PURGED →
 *        RAW_EVIDENCE_PURGED → DELETED"
 *       "Deletion must be observable, retryable, and dead-lettered on repeated
 *        downstream failure."
 *
 * CENSUS: H193 (group (a), the group where "correctness moves by typing") reads
 * "per-Memory deletion has no named step, no report and no retry; the
 * account-deletion machinery next door has all three". H190 states the same
 * absence from the §21 side: "§21's five-step deletion lifecycle still does not
 * exist". Before this file, `DELETE /memories/:id` was one UPDATE and a 204.
 *
 * ── THE DESIGN DECISION THIS FILE IS ABOUT ────────────────────────────────
 *
 * TWO OF THE FIVE STORES DO NOT EXIST, AND THAT MUST NOT LOOK LIKE SUCCESS OR
 * LIKE FAILURE. `memory_derivative_registry` is migration 2730, written and
 * unapplied; `memory_evidence` has no migration at all. A pipeline that
 * reported `done` for them would be a decorated green — the exact failure mode
 * this census exists to catch. A pipeline that reported `failed` would retry
 * forever and dead-letter every single deletion, which is a pager that means
 * nothing.
 *
 * So there are THREE outcomes, not two, and which one you get is decided by
 * PostgREST's own missing-object codes (42P01 / 42703 / PGRST205 / PGRST204),
 * never by a heuristic on the message:
 *
 *     done            the step ran and did its work
 *     not_applicable  the store this step targets IS NOT DEPLOYED. Reported
 *                     with the reason, attempted exactly ONCE, and it does not
 *                     dead-letter — a retry cannot conjure a table.
 *     failed          the step could have worked and did not. Retried up to
 *                     MAX_STEP_ATTEMPTS, then dead-lettered.
 *
 * ── WHY EVERY STEP RUNS EVEN AFTER ONE FAILS ──────────────────────────────
 *
 * §21's arrow is a progression, so the honest report of WHERE A DELETION GOT TO
 * is `reachedState`: the furthest state reached without a gap. But stopping the
 * loop at the first failure would mean a transient cache timeout prevents the
 * derivative purge from ever being attempted, and the derivative is the thing
 * that is actually published. So every step is attempted, `reachedState` is the
 * §21 answer, and `completed` is false whenever any step failed.
 *
 * ── THE DEAD LETTER IS NOT DURABLE, AND THE REPORT SAYS SO ────────────────
 *
 * §21 asks for dead-lettering "on repeated downstream failure". A dead letter
 * that only exists in a log line is not a queue: nothing retries it later and
 * nothing counts it. There is no table for one and this lane may not add a
 * migration, so `deadLetterDurable` is a hard `false` on every report. H193
 * stays W on that half, and this file is the reason it is only that half.
 */

import { revokeDerivativesForMemory } from "../memoryProjections/derivativeRegistry.js";
import {
  revokeMemoryAudienceCaches,
  type MemoryAudienceState,
} from "./memoryAudienceRevocation.js";

export const MEMORY_DELETION_LIFECYCLE_VERSION = "memory-deletion@1";

/** §21's states, in §21's order. */
export const MEMORY_DELETION_STEPS = [
  "DELETION_REQUESTED",
  "PUBLIC_REVOKED",
  "DERIVATIVES_PURGED",
  "RAW_EVIDENCE_PURGED",
  "DELETED",
] as const;
export type MemoryDeletionStep = (typeof MEMORY_DELETION_STEPS)[number];

export type StepOutcome = "done" | "not_applicable" | "failed";

/** How many times a RETRYABLE failure is attempted before it dead-letters. */
export const MAX_STEP_ATTEMPTS = 3;

/** §3.6 `memory_evidence` — named here so the absence has a subject. */
export const RAW_EVIDENCE_TABLE = "memory_evidence";

export interface StepReport {
  step: MemoryDeletionStep;
  outcome: StepOutcome;
  attempts: number;
  /** Empty for `done`; the reason for the other two. */
  detail: string;
  /** Whether another attempt could plausibly succeed. Always false for an absent store. */
  retryable: boolean;
  facts: Record<string, unknown>;
}

export interface DeletionReport {
  memoryId: string;
  ownerId: string;
  steps: StepReport[];
  /** The furthest §21 state reached with no gap behind it. */
  reachedState: MemoryDeletionStep | null;
  /** Every step `done` or `not_applicable`. */
  completed: boolean;
  /** At least one step exhausted its retries. */
  deadLettered: boolean;
  /**
   * ALWAYS false. There is no dead-letter table and this lane may not add one;
   * saying so on every report is the difference between a known gap and a
   * silent one.
   */
  deadLetterDurable: false;
  version: string;
}

interface MinimalError { code?: unknown; message?: unknown }

/** A relation or column that is not there. A retry will not conjure it. */
export function isStoreAbsent(err: MinimalError | null | undefined): boolean {
  if (!err) return false;
  const code = String((err as any).code ?? "");
  if (code === "42P01" || code === "42703" || code === "PGRST205" || code === "PGRST204") return true;
  return /does not exist|could not find the table|schema cache/i.test(String((err as any).message ?? ""));
}

/** What one step attempt may answer. */
type Attempt =
  | { outcome: "done"; facts?: Record<string, unknown> }
  | { outcome: "not_applicable"; detail: string; facts?: Record<string, unknown> }
  | { outcome: "failed"; detail: string; retryable: boolean; facts?: Record<string, unknown> };

async function runStep(step: MemoryDeletionStep, fn: () => Promise<Attempt>): Promise<StepReport> {
  let attempts = 0;
  let last: Attempt = { outcome: "failed", detail: "not attempted", retryable: true };
  while (attempts < MAX_STEP_ATTEMPTS) {
    attempts++;
    try {
      last = await fn();
    } catch (err) {
      last = { outcome: "failed", detail: `threw: ${String((err as any)?.message ?? err)}`, retryable: true };
    }
    // `not_applicable` and `done` are both terminal. So is a NON-retryable
    // failure: re-running a step that cannot succeed is how a deletion turns
    // into a retry storm.
    if (last.outcome !== "failed" || !last.retryable) break;
  }
  return {
    step,
    outcome: last.outcome,
    attempts,
    detail: last.outcome === "done" ? "" : (last as any).detail,
    retryable: last.outcome === "failed" ? (last as any).retryable : false,
    facts: last.facts ?? {},
  };
}

export interface DeletionLifecycleOptions {
  /**
   * `Date.now()` at the moment the soft delete committed. Feeds §24's
   * `privacy_revocation_latency`; omitted, the clock starts at the revocation.
   */
  requestedAt?: number | undefined;
  memoryId: string;
  ownerId: string;
  actorUserId: string;
  /** The audience the Memory had before it was deleted, for the revocation. */
  previous: MemoryAudienceState;
  now?: Date;
  log?: { error: (obj: unknown, msg: string) => void; warn?: (obj: unknown, msg: string) => void } | undefined;
}

/**
 * Run §21's five states for one Memory. Never throws: a deletion that has
 * already been written must not be reported to the user as a failure because a
 * downstream cleanup step could not run.
 */
export async function runMemoryDeletionLifecycle(
  sc: any,
  opts: DeletionLifecycleOptions,
): Promise<DeletionReport> {
  const now = opts.now ?? new Date();
  const steps: StepReport[] = [];

  // 1. DELETION_REQUESTED. The caller has already written the soft delete and
  //    crossed the §17 command boundary; this state records the request itself
  //    so a report always has a beginning, even when everything after it fails.
  steps.push(await runStep("DELETION_REQUESTED", async () => ({
    outcome: "done",
    facts: { requestedAt: now.toISOString(), actorUserId: opts.actorUserId },
  })));

  // 2. PUBLIC_REVOKED. The one published derivative production actually holds
  //    is the cached Compass projection. `revokeMemoryAudienceCaches` resolves
  //    which viewers hold it rather than assuming the owner does.
  steps.push(await runStep("PUBLIC_REVOKED", async () => {
    const report = await revokeMemoryAudienceCaches(sc, {
      memoryId: opts.memoryId,
      ownerId: opts.ownerId,
      previous: opts.previous,
      next: { ...opts.previous, state: "deleted" },
      reason: "memory_deleted",
      log: opts.log,
      // §24: the latency a person cares about starts when their delete
      // committed, not when this step got its turn.
      requestedAt: opts.requestedAt,
    });
    const facts = {
      invalidated: report.invalidated,
      targets: report.targets.length,
      unboundedAudience: report.unbounded_audience,
      truncated: report.truncated,
    };
    if (report.degraded.length > 0) {
      return {
        outcome: "failed",
        retryable: true,
        detail: `audience lookup failed for ${report.degraded.map((d) => d.table).join(", ")} — some viewers may still hold this Memory`,
        facts,
      };
    }
    if (report.failed.length > 0) {
      return { outcome: "failed", retryable: true, detail: `${report.failed.length} cache eviction(s) failed`, facts };
    }
    return { outcome: "done", facts };
  }));

  // 3. DERIVATIVES_PURGED. The §18 cleanup graph, walked. Its table is 2730 —
  //    written, unapplied — so on today's database this is `not_applicable`
  //    with that reason attached, once, and the deletion is not dead-lettered
  //    for it.
  steps.push(await runStep("DERIVATIVES_PURGED", async () => {
    const result = await revokeDerivativesForMemory(sc, opts.memoryId, "memory_deleted", now);
    if (result.ok) return { outcome: "done", facts: { revoked: result.value.revoked, scopeKeys: result.value.scope_keys } };
    if (!result.retryable) {
      return { outcome: "not_applicable", detail: `${result.reason}: ${result.detail}`, facts: {} };
    }
    return { outcome: "failed", retryable: true, detail: `${result.reason}: ${result.detail}`, facts: {} };
  }));

  // 4. RAW_EVIDENCE_PURGED. §3.6's `memory_evidence` has no migration anywhere
  //    in this tree, so this is `not_applicable` today — but it is WRITTEN, and
  //    the day the table lands this step starts purging without anybody
  //    remembering that it should.
  steps.push(await runStep("RAW_EVIDENCE_PURGED", async () => {
    const { data, error } = await sc
      .from(RAW_EVIDENCE_TABLE)
      .delete()
      .eq("memory_id", opts.memoryId)
      .select("id");
    if (error) {
      if (isStoreAbsent(error)) {
        return {
          outcome: "not_applicable",
          detail: `${RAW_EVIDENCE_TABLE} is not deployed: ${String((error as any).message ?? "absent")}`,
          facts: {},
        };
      }
      return { outcome: "failed", retryable: true, detail: String((error as any).message ?? "purge failed"), facts: {} };
    }
    return { outcome: "done", facts: { purged: Array.isArray(data) ? data.length : 0 } };
  }));

  // 5. DELETED. Not an announcement — a READ. The soft delete is written by the
  //    caller's command; this step confirms the row is actually in the state
  //    the user was told about. A 204 over a still-published Memory is the
  //    failure `DELETE /memories/:id` already fixed once, and this is the
  //    end-of-pipeline assertion of the same thing.
  steps.push(await runStep("DELETED", async () => {
    const { data, error } = await sc
      .from("memories")
      .select("id, state")
      .eq("id", opts.memoryId)
      .maybeSingle();
    if (error) {
      return { outcome: "failed", retryable: true, detail: `final state unreadable: ${String((error as any).message ?? "")}`, facts: {} };
    }
    if (!data) {
      // Hard-deleted (account deletion sweeps the row). That IS deleted.
      return { outcome: "done", facts: { finalState: null } };
    }
    const state = (data as any).state;
    if (state !== "deleted") {
      return {
        outcome: "failed",
        retryable: false,
        detail: `the Memory is still in state '${String(state)}' after a deletion command`,
        facts: { finalState: state },
      };
    }
    return { outcome: "done", facts: { finalState: state } };
  }));

  let reached: MemoryDeletionStep | null = null;
  for (const s of steps) {
    if (s.outcome === "failed") break;
    reached = s.step;
  }
  const deadLettered = steps.some((s) => s.outcome === "failed" && s.retryable && s.attempts >= MAX_STEP_ATTEMPTS);
  const completed = steps.every((s) => s.outcome !== "failed");

  const report: DeletionReport = {
    memoryId: opts.memoryId,
    ownerId: opts.ownerId,
    steps,
    reachedState: reached,
    completed,
    deadLettered,
    deadLetterDurable: false,
    version: MEMORY_DELETION_LIFECYCLE_VERSION,
  };

  if (!completed) {
    opts.log?.error(
      { report },
      deadLettered
        ? "memories: §21 deletion lifecycle DEAD-LETTERED — and the dead letter is a log line, not a queue"
        : "memories: §21 deletion lifecycle did not complete",
    );
  }
  return report;
}
