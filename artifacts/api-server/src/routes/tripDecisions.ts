/**
 * Trips §8 — the decision surface.
 *
 * GET /trips/:tripId/decisions
 *
 * WHY THIS ROUTE, AND WHY IT READS SIX TABLES
 * ===========================================
 * §8's whole point is the CHAIN: a goal produces a decision task, the task
 * attracts proposals, proposals are judged against constraints, §7 feasibility
 * and the risk register, and a recommendation comes out. Serving any one of
 * those tables alone reproduces the state this replaces — six filing cabinets
 * measured 2026-09-09 with no reader between them. The join IS the feature.
 *
 * WHERE THE JUDGEMENT LIVES
 * =========================
 * In services/trips/TripDecisionEngine.ts, which is pure and has 31 tests. This
 * route reads, shapes and refuses; it does not decide. In particular it does
 * not soften anything the engine says: an INSUFFICIENT_BASIS is served as
 * INSUFFICIENT_BASIS, because the alternative — falling back to "no objection
 * found" — is the exact conversion of a missing input into a favourable one
 * that the engine is arranged to prevent.
 *
 * FEASIBILITY IS READ, NOT ASSUMED
 * ================================
 * A proposal's schedule verdict comes from its payload's own
 * `feasibility_verdict` key when one is recorded, and is NULL otherwise. Null
 * is not optimism: the engine treats it exactly like UNKNOWN and disqualifies
 * the option. Guessing a verdict here — for instance defaulting to
 * FEASIBLE_UNVERIFIED because the trip has no commitments — would let an
 * unevaluated option be recommended.
 *
 * §9.3 GOVERNANCE STATE COMES WITH EACH PROPOSAL
 * ==============================================
 * A proposal without its tally is half an object: whether it can be accepted
 * is the whole of what a reader wants, and the rules — MAJORITY is strictly
 * more than half the ELECTORATE, UNANIMOUS needs every elector to have voted —
 * are exactly the kind of arithmetic each client would get wrong differently.
 * So `public.trip_proposal_tally` is called per proposal and its answer is
 * passed through untouched.
 *
 * A tally that CANNOT BE COMPUTED is `null`, and null is not "no votes". A
 * client showing 0/0 for a proposal whose electorate could not be counted
 * would be inventing a governance state. The count of failures is reported
 * alongside so the absence is visible rather than inferred from a null.
 *
 * FAIL-CLOSED, TABLE BY TABLE
 * ===========================
 * Six reads, six bound errors, and NO partial answer. A recommendation
 * computed with the risk register missing is not a weaker recommendation, it
 * is a different one — an option blocked by a HIGH risk becomes the winner the
 * moment the risks cannot be read. So any read that fails refuses the whole
 * response with 503, and the message names which input was missing.
 */
import { Router } from "express";

import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  recommendAll, propagateRisks,
  type Goal, type DecisionTask, type Proposal, type Risk,
} from "../services/trips/TripDecisionEngine.js";

const router = Router();
const log = logger.child({ mod: "tripDecisions" });
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** The §7 verdicts a proposal payload may legitimately carry. */
const FEASIBILITY_VERDICTS = new Set(["INFEASIBLE", "UNKNOWN", "FEASIBLE_UNVERIFIED", "FEASIBLE"]);

/** A string array out of an unconstrained jsonb value, or []. Never throws,
 *  and never turns a non-array into a one-element array — a malformed trigger
 *  should reach nothing, not something arbitrary. */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

router.get("/trips/:tripId/decisions", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }

  /** Read one table, or refuse the WHOLE response. See the header on why there
   *  is no partial answer here. */
  let failedInput: string | null = null;
  async function readAll(table: string, cols: string): Promise<any[]> {
    if (failedInput) return [];
    const { data, error } = await sc!.from(table).select(cols).eq("trip_id", tripId);
    if (error) {
      log.warn({ err: error.message, tripId, table }, "decisions: input read failed");
      failedInput = table;
      return [];
    }
    return (data ?? []) as any[];
  }

  const goalRows = await readAll("trip_goals", "id, type, priority, status, evidence_json");
  const taskRows = await readAll("trip_decision_tasks", "id, type, deadline_at, consequence, assigned_user_id, status");
  const riskRows = await readAll("trip_risks", "id, likelihood, impact, status, trigger_json, mitigation_json");
  const propRows = await readAll("trip_proposals", "id, proposal_type, payload_json, status, expires_at, decision_rule, proposed_by");

  if (failedInput) {
    sendError(res, "degraded_unavailable",
      `Could not read this trip's ${String(failedInput).replace("trip_", "").replace(/_/g, " ")}, so no recommendation can be made`);
    return;
  }

  const goals: Goal[] = goalRows.map((g) => ({
    id: g.id, type: g.type, priority: g.priority, status: g.status,
  }));

  const tasks: DecisionTask[] = taskRows.map((t) => ({
    id: t.id, type: t.type, deadlineAt: t.deadline_at ?? null,
    consequence: t.consequence ?? null, assignedUserId: t.assigned_user_id ?? null,
    status: t.status,
  }));

  const risks: Risk[] = riskRows.map((r) => {
    const trigger = (r.trigger_json ?? {}) as Record<string, unknown>;
    return {
      id: r.id, likelihood: r.likelihood, impact: r.impact, status: r.status,
      // Only these two keys are read. A trigger carrying others is inert
      // rather than mysteriously influential.
      affects: stringArray(trigger.affects),
      goalTypes: stringArray(trigger.goalTypes ?? trigger.goal_types),
    };
  });

  const proposals: Proposal[] = propRows.map((p) => {
    const payload = (p.payload_json ?? {}) as Record<string, unknown>;
    const verdict = payload.feasibility_verdict;
    return {
      id: p.id,
      decisionTaskId: typeof payload.decision_task_id === "string" ? payload.decision_task_id : null,
      status: p.status,
      servesGoalIds: stringArray(payload.serves_goal_ids),
      // §9.3's documented `affectedObjects` key, under either spelling.
      affectsElementIds: stringArray(payload.affected_objects ?? payload.affectedObjects),
      // NULL when unrecorded or unrecognised. Both are "no basis", and the
      // engine disqualifies on that — it does not default to optimism.
      feasibility: typeof verdict === "string" && FEASIBILITY_VERDICTS.has(verdict)
        ? verdict as Proposal["feasibility"]
        : null,
    };
  });

  /**
   * §9.3 tallies, one RPC per proposal.
   *
   * `null` means the tally could not be computed — NOT that no votes exist.
   * The difference decides whether a reader may show a vote count at all.
   */
  const tallies: Record<string, unknown | null> = {};
  let tallyFailures = 0;
  for (const p of propRows) {
    const { data, error } = await sc.rpc("trip_proposal_tally", { p_proposal_id: p.id });
    if (error || data === null || typeof data !== "object") {
      if (error) log.warn({ err: error.message, tripId, proposalId: p.id }, "proposal tally unavailable");
      tallies[p.id] = null;
      tallyFailures += 1;
      continue;
    }
    tallies[p.id] = data;
  }

  const now = new Date();
  const recommendations = recommendAll(tasks, proposals, goals, risks, now);
  const elementRisks = propagateRisks(risks);

  res.json({
    tripId,
    asOf: now.toISOString(),
    goals: goalRows.map((g) => ({
      id: g.id, type: g.type, priority: g.priority, status: g.status,
      evidence: g.evidence_json ?? {},
    })),
    decisionTasks: taskRows.map((t) => ({
      id: t.id, type: t.type, deadlineAt: t.deadline_at ?? null,
      consequence: t.consequence ?? null, assignedUserId: t.assigned_user_id ?? null,
      status: t.status,
    })),
    risks: riskRows.map((r) => ({
      id: r.id, likelihood: r.likelihood, impact: r.impact, status: r.status,
      trigger: r.trigger_json ?? {}, mitigation: r.mitigation_json ?? {},
    })),
    proposals: propRows.map((p) => ({
      id: p.id, type: p.proposal_type, status: p.status,
      decisionRule: p.decision_rule, proposedBy: p.proposed_by,
      expiresAt: p.expires_at ?? null, payload: p.payload_json ?? {},
      /** §9.3 counts and whether each rule is met, straight from
       *  trip_proposal_tally. NULL means the tally could not be computed —
       *  never render it as zero votes. */
      tally: tallies[p.id] ?? null,
    })),
    /** How many tallies could not be computed. Present so a null tally is a
     *  visible absence rather than something a reader has to infer. */
    tallyFailures,
    /** §8's output. One per PENDING decision task; never a silent omission. */
    recommendations,
    /**
     * §8.4 (census TR144). Plan elements that inherit an OPEN risk, with the
     * worst impact and the worst likelihood kept SEPARATE — a high-impact
     * unlikely risk and a low-impact certain one are different situations and
     * one combined number would erase the difference.
     */
    elementRisks: [...elementRisks.values()],
  });
}));

export default router;
