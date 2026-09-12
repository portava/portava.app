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
 * WHOSE BALLOTS A CALLER SEES, AND WHY IT IS ONLY THEIR OWN
 * =========================================================
 * `trip_proposal_votes` holds one row per crew member per proposal. This route
 * serves the CALLER'S OWN vote and the aggregate tally, and nobody else's
 * ballot.
 *
 * That is not a claim that vote secrecy is the right product answer — it is
 * the NARROWER of the two answers, chosen because whether a crew can see who
 * voted which way is genuinely a product-policy question and this is a privacy
 * default. Widening it later is a one-line change; narrowing it after people
 * have seen each other's ballots is not.
 *
 * The caller's own vote is served unconditionally, because without it the
 * feature is unusable: a crew member cannot tell whether they have voted, and
 * `abstain` and "has not voted" are explicitly different states (2774's column
 * comment). Recorded as VOTE_BALLOT_VISIBILITY in
 * docs/architecture/blocker-ledger.md.
 *
 * FAIL-CLOSED, TABLE BY TABLE
 * ===========================
 * Six reads, six bound errors, and NO partial answer. A recommendation
 * computed with the risk register missing is not a weaker recommendation, it
 * is a different one — an option blocked by a HIGH risk becomes the winner the
 * moment the risks cannot be read. So any read that fails refuses the whole
 * response with 503, and the message names which input was missing.
 */
import { decisionUrgency, byUrgency } from "../services/trips/TripDecisionUrgency.js";
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
  // Takes a BUILT query, not a table name — see the same note in
  // routes/tripStructure.ts. `.from(variable)` is invisible to
  // check:write-path-columns, and these are the newest tables in the schema,
  // so a blind spot here is where a missing column would survive longest.
  let failedInput: string | null = null;
  async function readAll(table: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<any[]> {
    if (failedInput) return [];
    const { data, error } = await q;
    if (error) {
      log.warn({ err: error.message, tripId, table }, "decisions: input read failed");
      failedInput = table;
      return [];
    }
    return (data ?? []) as any[];
  }

  const goalRows = await readAll("trip_goals", sc.from("trip_goals")
    .select("id, type, priority, status, evidence_json").eq("trip_id", tripId));
  const taskRows = await readAll("trip_decision_tasks", sc.from("trip_decision_tasks")
    .select("id, type, deadline_at, consequence, assigned_user_id, status").eq("trip_id", tripId));
  const riskRows = await readAll("trip_risks", sc.from("trip_risks")
    .select("id, likelihood, impact, status, trigger_json, mitigation_json").eq("trip_id", tripId));
  // §8.2's downstream term reads two more tables. They are inputs to the
  // URGENCY, not to the recommendation: unreadable, the term is 0 and
  // `urgencyInputsUnread` says so — the decisions are still served.
  const urgencyInputsUnread: string[] = [];
  const softRead = async (table: string, q: any): Promise<any[]> => {
    const { data, error } = await q;
    if (error) { urgencyInputsUnread.push(table); return []; }
    return (data ?? []) as any[];
  };
  const commitmentRows = await softRead("trip_commitments", sc.from("trip_commitments")
    .select("id, starts_at, required_arrival_at").eq("trip_id", tripId));
  const planRows = (await softRead("trip_plan_items", sc.from("trip_plan_items")
    .select("id, starts_at, removed_at").eq("trip_id", tripId))).filter((p) => p.removed_at == null);
  const propRows = await readAll("trip_proposals", sc.from("trip_proposals")
    .select("id, proposal_type, payload_json, status, expires_at, decision_rule, proposed_by").eq("trip_id", tripId));

  // The caller's OWN ballots, and nobody else's. See the header on why this is
  // the narrow default rather than a settled answer.
  const myVotes = new Map<string, string>();
  if (!failedInput && propRows.length > 0) {
    const { data, error } = await sc
      .from("trip_proposal_votes")
      .select("proposal_id, vote")
      .eq("user_id", user.id)
      .in("proposal_id", propRows.map((p) => p.id as string));
    if (error) {
      log.warn({ err: error.message, tripId }, "decisions: own votes read failed");
      failedInput = "trip_proposal_votes";
    } else {
      for (const v of ((data ?? []) as Array<{ proposal_id: string; vote: string }>)) {
        myVotes.set(v.proposal_id, v.vote);
      }
    }
  }

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
    // §8.2: urgency = f(timeRemaining, availabilityDecay, downstreamImpact,
    // consequence). Downstream is derived: the commitments and plans that
    // start within a day after the task's deadline depend on it being made
    // (trip_decision_tasks records no explicit dependency, and this says so).
    // Availability decay is unknown here and contributes 0, stated on the term.
    decisionTasks: taskRows.map((t) => {
      const dl = t.deadline_at ? Date.parse(t.deadline_at) : NaN;
      const within = (iso: string | null | undefined) => { const x = iso ? Date.parse(iso) : NaN; return Number.isFinite(dl) && Number.isFinite(x) && x >= dl && x <= dl + 24 * 3_600_000; };
      const urgency = decisionUrgency({
        deadlineAt: t.deadline_at ?? null, availabilityDecay: null,
        downstream: { dependentCommitments: commitmentRows.filter((c) => within(c.required_arrival_at ?? c.starts_at)).length, dependentPlans: planRows.filter((pl) => within(pl.starts_at)).length, totalCommitments: commitmentRows.length, totalPlans: planRows.length },
        consequence: t.consequence ?? null,
      }, now.getTime());
      return {
        id: t.id, type: t.type, deadlineAt: t.deadline_at ?? null,
        consequence: t.consequence ?? null, assignedUserId: t.assigned_user_id ?? null,
        status: t.status, urgency,
      };
    }).sort(byUrgency),
    urgencyInputsUnread,
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
      /**
       * The CALLER'S own ballot: 'yes' | 'no' | 'abstain', or null.
       *
       * Null means NOT VOTED, and that is a different state from `abstain` —
       * 2774's column comment is explicit that an abstention is a recorded
       * decision not to decide, while a silence means nobody knows what it
       * means. A client that renders both as "no vote" erases the distinction
       * the unanimous rule turns on.
       */
      myVote: myVotes.get(p.id) ?? null,
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
