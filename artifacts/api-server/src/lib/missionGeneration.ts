/**
 * Intelligence Gathering — mission generation (IG-08, spec §16 "Mission trigger
 * v1", §16 "Mission safety", §23 "Monetization coupling").
 *
 * Turns a coverage gap into a structured mission CANDIDATE. Pure: no clock, no
 * IO. The service layer persists candidates (append-only, non-cash) and drives
 * dispatch/accept.
 *
 * FINANCIAL BOUNDARY (retained regardless of enablement — spec §23 "Shadow:
 * pay no platform-funded cash"): a mission in this system is NON-CASH. Budget is
 * a committed unit count, never money; `cashAmount` is always 0. Money transfer
 * is a separate switch behind funding/KYC/tax/fraud infrastructure that does not
 * exist yet — it is a financial-control boundary, not a user-count gate.
 */

// ── §16 Mission safety constraints (never negotiable) ─────────────────────────
export const MISSION_SAFETY_CONSTRAINTS = [
  "no confrontation",
  "no covert recording",
  "no illegal access",
  "no unsafe crowd entry",
  "no required purchase beyond approved expenses",
  "negative results are fully valid",
  "contributors may decline or abort unsafe work without conduct penalty",
] as const;

// ── §16 Mission trigger v1 ────────────────────────────────────────────────────
export interface MissionTriggerContext {
  qualifiedDemandEvents6h: number;   // trigger 1
  requiredLiveFamilyMissing: boolean;
  pendingDecisionsAffectedByContradiction: number; // trigger 2
  criticalClaimStale: boolean;       // trigger 3
  criticalClaimInActivePlan: boolean;
  campaignHasExplicitBudget: boolean; // trigger 4
  campaignHasAcceptanceContract: boolean;
}

export const MISSION_TRIGGER_THRESHOLDS = {
  minDemandEvents6h: 10,
  minPendingDecisions: 5,
} as const;

export type MissionTrigger =
  | "demand_spike_missing_family"
  | "material_contradiction"
  | "stale_critical_in_plan"
  | "funded_campaign"
  // ADDITIVE (Media v2 §19 Request-a-View). Produced ONLY by the human-network
  // Request-a-View producer (services/media/MediaViewRequestService), NEVER by
  // evaluateMissionTriggers below — the four auto-generation triggers are
  // unchanged, so demand-driven mission generation behaves byte-identically.
  // This member lets a user-initiated request reuse buildMissionCandidate to
  // create a NON-CASH targeted coverage task in the SAME intel_mission_candidates
  // store, rather than forking a parallel mission system.
  | "request_a_view";

/**
 * Every trigger that fires for this context (§16 mission trigger v1).
 * NOTE: never returns "request_a_view" — that trigger is created by a viewer's
 * explicit request, not by the automated coverage-gap evaluation.
 */
export function evaluateMissionTriggers(ctx: MissionTriggerContext): MissionTrigger[] {
  const fired: MissionTrigger[] = [];
  if (ctx.qualifiedDemandEvents6h >= MISSION_TRIGGER_THRESHOLDS.minDemandEvents6h && ctx.requiredLiveFamilyMissing)
    fired.push("demand_spike_missing_family");
  if (ctx.pendingDecisionsAffectedByContradiction >= MISSION_TRIGGER_THRESHOLDS.minPendingDecisions)
    fired.push("material_contradiction");
  if (ctx.criticalClaimStale && ctx.criticalClaimInActivePlan)
    fired.push("stale_critical_in_plan");
  if (ctx.campaignHasExplicitBudget && ctx.campaignHasAcceptanceContract)
    fired.push("funded_campaign");
  return fired;
}

export function shouldGenerateMission(ctx: MissionTriggerContext): boolean {
  return evaluateMissionTriggers(ctx).length > 0;
}

// ── Mission candidate shape + budget/dispatch rules ───────────────────────────
export type MissionStatus = "candidate" | "dispatched" | "accepted" | "expired" | "aborted";

export interface MissionCandidate {
  city: string;
  zoneId: string | null;
  claimFamily: string;
  trigger: MissionTrigger;
  coverageScore: number;
  question: string;
  budgetUnits: number;      // NON-CASH units
  budgetCommitted: boolean; // must be committed atomically BEFORE dispatch
  cashAmount: number;       // ALWAYS 0 in shadow
  status: MissionStatus;
}

export interface BuildMissionInput {
  city: string;
  zoneId?: string | null;
  claimFamily: string;
  trigger: MissionTrigger;
  coverageScore: number;
  question: string;
  budgetUnits?: number;
}

/** Shape a fresh mission candidate. Never cash; budget starts uncommitted. */
export function buildMissionCandidate(input: BuildMissionInput): MissionCandidate {
  return {
    city: input.city,
    zoneId: input.zoneId ?? null,
    claimFamily: input.claimFamily,
    trigger: input.trigger,
    coverageScore: input.coverageScore,
    question: input.question,
    budgetUnits: Math.max(0, Math.floor(input.budgetUnits ?? 0)),
    budgetCommitted: false,
    cashAmount: 0,
    status: "candidate",
  };
}

/**
 * §16 "Mission budget is committed atomically before dispatch." A candidate may
 * dispatch ONLY once its (non-cash) budget is committed. This is the dispatch
 * rule the acceptance tests exercise; the service performs the commit + status
 * change in one statement so a half-committed mission can never dispatch.
 */
export function canDispatch(m: Pick<MissionCandidate, "status" | "budgetCommitted">): boolean {
  return m.status === "candidate" && m.budgetCommitted === true;
}

/** An accepted commitment is honored even after the mission flag is turned off. */
export function isHonoredCommitment(m: Pick<MissionCandidate, "status">): boolean {
  return m.status === "accepted";
}
