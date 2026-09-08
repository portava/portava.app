/**
 * The planned executor: plan, refuse, delegate, verify.
 *
 * ── IT REFUSES, IT DOES NOT SKIP ────────────────────────────────────────────
 * If the plan contains a table with no decided fate - an UNRESOLVED item, and
 * in particular one the graph classified OWNER_REQUIRED - this function writes
 * NOTHING and returns a refusal naming every blocking table. It does not run
 * "the resolved part" and report success.
 *
 * That is the whole reason it exists. A deletion that quietly leaves rows
 * behind while reporting success is the exact defect class this codebase has
 * spent the session removing: the receipt says the account was erased, the
 * policy says the same to the user, and 225 tables of their behaviour are still
 * joinable by uuid. Partial execution under a complete-sounding result is how
 * that state was reached; refusing is how it stops being reachable.
 *
 * Today every refusal path fires, because D6 is unanswered and `UNSET_POLICY`
 * names no table. That is the correct behaviour, not a bug to work around: the
 * existing `executeAccountDeletion` remains the shipped path for the fates that
 * ARE decided, and this planner-driven executor becomes usable the moment the
 * policy is filled in - configuration, not another rewrite.
 *
 * ── WHAT IT DELEGATES ───────────────────────────────────────────────────────
 * The actual removals stay in AccountDeletionService. This module does not open
 * a second implementation of "delete a user's content": that would be two
 * cascades to keep in step, which is the drift the service's own header warns
 * about. It plans, it gates, it calls the one implementation, and it verifies.
 */
import { executeAccountDeletion, type DeletionOutcome, type ExecuteOptions } from "./AccountDeletionService.js";
import { buildDeletionPlan, type DeletionPlan } from "./DeletionPlanner.js";
import type { DeletionPolicy } from "./policy.js";
import { verifyDeletion, type VerificationReport } from "./verification.js";
import type { DeletionGraphNode } from "../../lib/deletion/types.js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "PlannedDeletionExecutor" });

export interface BlockingTable {
  table: string;
  reason: string;
  candidate: string;
  ownerRequired: boolean;
}

export interface PlannedDeletionResult {
  ok: boolean;
  refused: boolean;
  refusalReasons: string[];
  /** Every table that blocks the run, named. Never truncated to a count. */
  blockingTables: BlockingTable[];
  plan: DeletionPlan;
  outcome?: DeletionOutcome;
  verification?: VerificationReport;
}

export interface PlannedDeletionInput extends ExecuteOptions {
  userId: string;
  policy: DeletionPolicy;
  /** Injectable graph, for tests. Defaults to the graph built from the baseline. */
  graph?: readonly DeletionGraphNode[];
  /** Injectable executor, for tests. Defaults to the shipped AccountDeletionService. */
  execute?: typeof executeAccountDeletion;
  /** Injectable verifier, for tests. */
  verify?: typeof verifyDeletion;
  /** Skip the post-execution verification read. Off by default, and it should stay off. */
  skipVerification?: boolean;
}

/**
 * Everything that makes a plan unrunnable, in one place so a caller cannot
 * satisfy one gate and assume the rest.
 */
export function planRefusals(plan: DeletionPlan): { reasons: string[]; blocking: BlockingTable[] } {
  const reasons: string[] = [];
  const blocking: BlockingTable[] = [];

  if (plan.actions.length === 0) {
    reasons.push("the plan contains no actions at all - an empty plan cannot be a complete deletion");
  }

  if (plan.unresolved.length > 0) {
    const owner = plan.unresolved.filter((u) => u.ownerRequired);
    reasons.push(
      `${plan.unresolved.length} table(s) have NO DECIDED FATE (${owner.length} of them OWNER_REQUIRED). ` +
        "Executing would leave their rows in place while reporting a completed deletion, so this run is refused.",
    );
    for (const u of plan.unresolved) {
      blocking.push({ table: u.table, reason: u.reason, candidate: u.candidate, ownerRequired: u.ownerRequired });
    }
  }

  for (const v of plan.boundaryViolations) {
    reasons.push(`legal-retention boundary: ${v.table} (${v.fate}) - ${v.rule}`);
    blocking.push({ table: v.table, reason: `${v.rule}: ${v.detail}`, candidate: "BOUNDARY", ownerRequired: false });
  }

  for (const p of plan.policyProblems) {
    reasons.push(`policy problem: ${p.table} - ${p.problem}`);
    blocking.push({ table: p.table, reason: p.problem, candidate: "POLICY", ownerRequired: false });
  }

  for (const h of plan.unmetStorageHooks) {
    reasons.push(
      `${h.table} is planned for deletion and holds storage reference(s) ${h.columns.join(", ")} with no cleanup hook - ` +
        "the rows would go and the bytes would stay",
    );
    blocking.push({ table: h.table, reason: `no storage cleanup hook for ${h.columns.join(", ")}`, candidate: "STORAGE_HOOK", ownerRequired: false });
  }

  if (plan.cycles.length > 0) {
    reasons.push(`${plan.cycles.length} dependency cycle(s) in the plan: ${plan.cycles.map((c) => c.join(" -> ")).join(" | ")}`);
  }

  return { reasons, blocking };
}

export async function executePlannedDeletion(
  sc: any,
  input: PlannedDeletionInput,
): Promise<PlannedDeletionResult> {
  const plan = buildDeletionPlan({ userId: input.userId, policy: input.policy, graph: input.graph });
  const { reasons, blocking } = planRefusals(plan);

  if (reasons.length > 0) {
    logger.warn(
      { userId: input.userId, policyVersion: plan.policyVersion, unresolved: plan.summary.unresolvedCount, ownerRequired: plan.summary.ownerRequiredUnresolved },
      "executePlannedDeletion: REFUSED - the plan is not complete; nothing was written",
    );
    return { ok: false, refused: true, refusalReasons: reasons, blockingTables: blocking, plan };
  }

  const run = input.execute ?? executeAccountDeletion;
  const outcome = await run(sc, input.userId, { actorId: input.actorId, reason: input.reason, contentOnly: input.contentOnly });

  if (input.skipVerification) {
    return { ok: outcome.ok, refused: false, refusalReasons: [], blockingTables: [], plan, outcome };
  }

  const verify = input.verify ?? verifyDeletion;
  const verification = await verify(sc, plan);

  return {
    ok: outcome.ok && verification.ok,
    refused: false,
    refusalReasons: verification.ok ? [] : verification.failures,
    blockingTables: [],
    plan,
    outcome,
    verification,
  };
}
