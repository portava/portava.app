/**
 * Trips §8 — the decision engine, as BEHAVIOUR.
 *
 * WHAT §8 ASKS FOR, AND WHAT EXISTED BEFORE THIS FILE
 * ==================================================
 * §8 describes a chain: a GOAL produces a DECISION TASK; the task attracts
 * PROPOSALS; proposals are judged against CONSTRAINTS and against §7
 * FEASIBILITY; the RISK REGISTER records what could go wrong; a RECOMMENDATION
 * comes out; accepting it updates the plan through the kernel and the change
 * lands in an event and a snapshot.
 *
 * Before this file, three tables existed (trip_goals, trip_decision_tasks,
 * trip_risks, migration 2762) and nine kernel commands wrote them (2766). No
 * code anywhere read any of them, and nothing joined a proposal to a decision
 * task, a risk to the plan element it endangers, or a feasibility verdict to
 * the proposal it should disqualify. The rows were a filing cabinet.
 *
 * THE ONE RULE THIS FILE IS BUILT AROUND
 * =====================================
 * A recommendation is advice a person will act on, so an input that could not
 * be established must not be silently treated as favourable. Every function
 * here is total over three outcomes, not two:
 *
 *   RECOMMEND      this option is the best of the ones that survived, and the
 *                  reasons are enumerated
 *   DO_NOT_RECOMMEND  an option is disqualified, with the disqualifying fact
 *   INSUFFICIENT_BASIS  the engine declines. NOT a weak recommendation, not a
 *                  tie, not "no objection found" — an ANSWER that says the
 *                  question was not answerable on what was available.
 *
 * The forbidden shape, stated so it can be checked for: a proposal whose
 * feasibility is UNKNOWN must never be recommended on the grounds that nothing
 * ruled it out. "Nothing ruled it out" and "it was checked and it is fine" are
 * the same sentence to a reader and opposite facts.
 *
 * §8.4 RISK PROPAGATION (census TR144)
 * ====================================
 * A risk register nothing propagates from is a list. `propagateRisks` maps each
 * OPEN risk onto the plan elements its trigger names, so a plan item inherits
 * the worst severity of the risks that reach it. The propagation is explicit
 * and one hop: a risk names elements, an element carries the risks that name
 * it. It does not invent transitive reach, because a chain nobody declared is
 * a guess, and the honest version of a guess is not making it.
 *
 * PURE ON PURPOSE
 * ===============
 * Nothing here reads a database or a clock it was not given. Every input is a
 * parameter, so the whole chain is testable without a Supabase double, and the
 * route that does the reading is where the fail-closed rules live.
 */

// ── vocabulary ──────────────────────────────────────────────────────────────

/** §8 goal types, from 2762's `trip_goals_type_known`. */
export const GOAL_TYPES = ["rest", "budget", "experience", "social", "logistics", "safety", "other"] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const GOAL_PRIORITIES = ["low", "normal", "high"] as const;
export type GoalPriority = (typeof GOAL_PRIORITIES)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Ordered worst-last, so a max is an index comparison rather than a table. */
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/**
 * The three outcomes. INSUFFICIENT_BASIS is deliberately not last: it is the
 * DEFAULT, and the ordering is a reminder that it has to be argued out of.
 */
export const RECOMMENDATION_KINDS = [
  "INSUFFICIENT_BASIS", "DO_NOT_RECOMMEND", "RECOMMEND",
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

/**
 * Why an option was disqualified or why the engine declined. Each is a
 * DISTINCT fact a reader can act on differently — "we could not check" sends
 * someone to fix a data gap, "it does not fit" sends them to change the plan.
 */
export const DECISION_REASONS = [
  /** §7 says this option's schedule cannot be met. Proven, disqualifying. */
  "INFEASIBLE_SCHEDULE",
  /** §7 could not evaluate it. NOT a pass — the basis is missing. */
  "FEASIBILITY_UNKNOWN",
  /** An open HIGH-impact risk names this option or its plan element. */
  "BLOCKED_BY_HIGH_RISK",
  /** The decision's deadline has passed. */
  "DEADLINE_PASSED",
  /** Nothing was proposed. */
  "NO_PROPOSALS",
  /** Every proposal was disqualified. */
  "ALL_OPTIONS_DISQUALIFIED",
  /** Two or more options are indistinguishable on the evidence available. */
  "TIED_ON_AVAILABLE_EVIDENCE",
  /** The option's own governance has not concluded. */
  "PROPOSAL_NOT_DECIDED",
  /** It survived every check, and at least one goal is served. */
  "SERVES_GOAL",
  /** It survived every check and no goal speaks to it either way. */
  "NO_OBJECTION_AND_NO_GOAL",
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

// ── inputs ──────────────────────────────────────────────────────────────────

export interface Goal {
  id: string;
  type: GoalType | string;
  priority: GoalPriority | string;
  /** 'open' | 'met' | 'abandoned'. Only 'open' goals steer a recommendation. */
  status: string;
}

export interface DecisionTask {
  id: string;
  type: string;
  /** Null means no deadline, which is NOT the same as a deadline in the past. */
  deadlineAt: string | null;
  consequence: string | null;
  assignedUserId: string | null;
  /** 'pending' | 'done' | 'expired' | 'waived'. */
  status: string;
}

export interface Risk {
  id: string;
  likelihood: RiskLevel | string;
  impact: RiskLevel | string;
  /** 'open' | 'mitigated' | 'realised' | 'closed'. */
  status: string;
  /**
   * What this risk endangers. Read from trip_risks.trigger_json; the engine
   * looks at `affects` (ids) and `goalTypes` and nothing else, so a trigger
   * carrying other keys is inert rather than mysteriously influential.
   */
  affects: string[];
  goalTypes: string[];
}

export interface Proposal {
  id: string;
  /** Which decision task this proposal answers. Null = unattached. */
  decisionTaskId: string | null;
  /** 'pending' | 'accepted' | 'rejected' | 'superseded'. */
  status: string;
  /** Which goals this option claims to serve. */
  servesGoalIds: string[];
  /** The plan elements it would create, move or cancel. */
  affectsElementIds: string[];
  /** §7's verdict for the schedule this option implies, when one was computed. */
  feasibility: "INFEASIBLE" | "UNKNOWN" | "FEASIBLE_UNVERIFIED" | "FEASIBLE" | null;
}

// ── outputs ─────────────────────────────────────────────────────────────────

export interface OptionAssessment {
  proposalId: string;
  /** RECOMMEND is never set on an option; only the task carries a winner. */
  eligible: boolean;
  /** Every reason that applied, in the order they were checked. */
  reasons: DecisionReason[];
  /** Goals this option serves that are still open. */
  servedOpenGoalIds: string[];
  /** Worst impact among open risks reaching this option. Null = none reach it. */
  worstRiskImpact: RiskLevel | null;
}

export interface Recommendation {
  decisionTaskId: string;
  kind: RecommendationKind;
  /** Set only when kind is RECOMMEND. */
  proposalId: string | null;
  /** The reasons behind `kind`, never empty. */
  reasons: DecisionReason[];
  /** Every option that was considered, with why it did or did not survive. */
  options: OptionAssessment[];
}

export interface PlanElementRisk {
  elementId: string;
  riskIds: string[];
  /** The worst IMPACT among the risks that reach it. */
  worstImpact: RiskLevel;
  /** The worst LIKELIHOOD among them. Kept separate: a high-impact unlikely
   *  risk and a low-impact certain one are different situations and a single
   *  "severity" number would erase the difference. */
  worstLikelihood: RiskLevel;
}

// ── the engine ──────────────────────────────────────────────────────────────

function isRiskLevel(v: string): v is RiskLevel {
  return v === "low" || v === "medium" || v === "high";
}

/** The worse of two levels. An unrecognised level is treated as the WORST,
 *  because a severity this code cannot read is not a mild one. */
function worseLevel(a: RiskLevel | null, b: string): RiskLevel {
  const bl: RiskLevel = isRiskLevel(b) ? b : "high";
  if (a === null) return bl;
  return RISK_ORDER[bl] > RISK_ORDER[a] ? bl : a;
}

/**
 * §8.4. Map every OPEN risk onto the plan elements its trigger names.
 *
 * Only `open` risks propagate. A `mitigated` or `closed` risk is a record of
 * something handled, and carrying it forward would make every plan element
 * look permanently endangered; a `realised` risk has already happened and
 * belongs to the outcome log, not the forecast.
 */
export function propagateRisks(risks: Risk[]): Map<string, PlanElementRisk> {
  const out = new Map<string, PlanElementRisk>();
  for (const risk of risks) {
    if (risk.status !== "open") continue;
    for (const elementId of risk.affects) {
      if (!elementId) continue;
      const cur = out.get(elementId);
      if (cur) {
        cur.riskIds.push(risk.id);
        cur.worstImpact = worseLevel(cur.worstImpact, risk.impact);
        cur.worstLikelihood = worseLevel(cur.worstLikelihood, risk.likelihood);
      } else {
        out.set(elementId, {
          elementId,
          riskIds: [risk.id],
          worstImpact: worseLevel(null, risk.impact),
          worstLikelihood: worseLevel(null, risk.likelihood),
        });
      }
    }
  }
  return out;
}

/**
 * Assess ONE option against the constraints, feasibility and risks.
 *
 * The order of the checks is the order of the reasons, and it is deliberate:
 * a proposal can be disqualified for more than one thing and a reader deserves
 * all of them, not the first.
 */
export function assessOption(
  proposal: Proposal,
  ctx: {
    openGoalIds: Set<string>;
    elementRisks: Map<string, PlanElementRisk>;
  },
): OptionAssessment {
  const reasons: DecisionReason[] = [];
  let eligible = true;

  // 1. §7. INFEASIBLE is a proof and disqualifies. UNKNOWN does NOT pass:
  //    "nothing ruled it out" is not "it was checked and it is fine", and the
  //    two are the same sentence to a reader.
  if (proposal.feasibility === "INFEASIBLE") {
    reasons.push("INFEASIBLE_SCHEDULE");
    eligible = false;
  } else if (proposal.feasibility === null || proposal.feasibility === "UNKNOWN") {
    reasons.push("FEASIBILITY_UNKNOWN");
    eligible = false;
  }

  // 2. Governance. An option whose own vote has not concluded is not a
  //    candidate; recommending it would pre-empt the decision rule.
  if (proposal.status !== "pending" && proposal.status !== "accepted") {
    reasons.push("PROPOSAL_NOT_DECIDED");
    eligible = false;
  }

  // 3. §8.4 risk. A HIGH-impact open risk on any element this option touches
  //    disqualifies it. Lower impacts are recorded and do not.
  let worstRiskImpact: RiskLevel | null = null;
  for (const elementId of proposal.affectsElementIds) {
    const hit = ctx.elementRisks.get(elementId);
    if (!hit) continue;
    worstRiskImpact = worseLevel(worstRiskImpact, hit.worstImpact);
  }
  if (worstRiskImpact === "high") {
    reasons.push("BLOCKED_BY_HIGH_RISK");
    eligible = false;
  }

  const servedOpenGoalIds = proposal.servesGoalIds.filter((g) => ctx.openGoalIds.has(g));
  if (eligible) {
    reasons.push(servedOpenGoalIds.length > 0 ? "SERVES_GOAL" : "NO_OBJECTION_AND_NO_GOAL");
  }

  return { proposalId: proposal.id, eligible, reasons, servedOpenGoalIds, worstRiskImpact };
}

/**
 * Recommend for ONE decision task.
 *
 * `now` is a parameter rather than a call to Date.now(), so the deadline rule
 * is testable at its boundary rather than approximately.
 */
export function recommend(
  task: DecisionTask,
  proposals: Proposal[],
  goals: Goal[],
  risks: Risk[],
  now: Date,
): Recommendation {
  const openGoalIds = new Set(goals.filter((g) => g.status === "open").map((g) => g.id));
  const elementRisks = propagateRisks(risks);

  const mine = proposals.filter((p) => p.decisionTaskId === task.id);
  const options = mine.map((p) => assessOption(p, { openGoalIds, elementRisks }));

  // A passed deadline does not disqualify the OPTIONS — they may still be the
  // right thing to do — but it does mean no recommendation is on offer, since
  // the decision the task represents can no longer be made in time.
  if (task.deadlineAt !== null) {
    const t = Date.parse(task.deadlineAt);
    if (Number.isFinite(t) && t <= now.getTime()) {
      return {
        decisionTaskId: task.id, kind: "INSUFFICIENT_BASIS", proposalId: null,
        reasons: ["DEADLINE_PASSED"], options,
      };
    }
  }

  if (mine.length === 0) {
    return {
      decisionTaskId: task.id, kind: "INSUFFICIENT_BASIS", proposalId: null,
      reasons: ["NO_PROPOSALS"], options,
    };
  }

  const eligible = options.filter((o) => o.eligible);
  if (eligible.length === 0) {
    // DO_NOT_RECOMMEND rather than INSUFFICIENT_BASIS: the engine DID reach a
    // conclusion, and it is that none of these should be done.
    return {
      decisionTaskId: task.id, kind: "DO_NOT_RECOMMEND", proposalId: null,
      reasons: ["ALL_OPTIONS_DISQUALIFIED"], options,
    };
  }

  // Rank by open goals served, weighted by goal priority. A tie is a TIE and
  // is reported as one — picking arbitrarily and calling it a recommendation
  // is the failure this whole file is arranged against.
  const priorityOf = new Map(goals.map((g) => [g.id, g.priority]));
  const weight = (o: OptionAssessment): number =>
    o.servedOpenGoalIds.reduce((n, id) => {
      const p = priorityOf.get(id);
      return n + (p === "high" ? 3 : p === "normal" ? 2 : 1);
    }, 0);

  const scored = eligible.map((o) => ({ o, w: weight(o) }));
  const best = Math.max(...scored.map((x) => x.w));
  const winners = scored.filter((x) => x.w === best);

  if (winners.length > 1) {
    return {
      decisionTaskId: task.id, kind: "INSUFFICIENT_BASIS", proposalId: null,
      reasons: ["TIED_ON_AVAILABLE_EVIDENCE"], options,
    };
  }

  const winner = winners[0]!.o;
  return {
    decisionTaskId: task.id,
    kind: "RECOMMEND",
    proposalId: winner.proposalId,
    reasons: winner.reasons,
    options,
  };
}

/** Recommend across a whole trip. Tasks that are not `pending` are skipped —
 *  a done or waived decision has no recommendation to make. */
export function recommendAll(
  tasks: DecisionTask[],
  proposals: Proposal[],
  goals: Goal[],
  risks: Risk[],
  now: Date,
): Recommendation[] {
  return tasks
    .filter((t) => t.status === "pending")
    .map((t) => recommend(t, proposals, goals, risks, now));
}
