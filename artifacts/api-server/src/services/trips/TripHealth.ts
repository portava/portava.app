/**
 * Trips spec §17.1 — trip health, a SUMMARY projection, PURE.
 *
 *   HEALTHY → ATTENTION → AT_RISK → DISRUPTED
 *   Health is a summary projection. It does not replace concrete
 *   risks/reason codes.
 *
 * WHAT EXISTED
 * ============
 * census-trips TR314: `lib/tripReadiness.ts`'s score plus a four-value
 * ReadinessStatus is "a four-value health-shaped summary — of PREPARATION,
 * not of the journey, with no DISRUPTED state and no runtime input." This is
 * the journey's: its inputs are the §7.2 conflicts the freedom engine
 * detects, the §5.1 risk register (`trip_risks`, 2762), the §17.4 Safe
 * Return operational states, and the feasibility hops that could not be
 * judged. Readiness is deliberately NOT an input — it is a different
 * question (are we prepared) behind its own flag, and folding it in would
 * make "AT_RISK" mean two things.
 *
 * THE SECOND SENTENCE IS THE DESIGN
 * ================================
 * Every answer carries `reasons[]` — each a concrete code, the object it is
 * about and a severity — and the health is nothing more than the worst
 * severity present. A consumer that shows the word without the reasons is
 * showing the thing §17.1 says health must not replace.
 *
 * THE LADDER
 * ==========
 *   DISRUPTED   a realised risk, or a crew member in NEEDS_HELP
 *   AT_RISK     a temporal conflict, an open risk that is high on both axes,
 *               or an INFEASIBLE hop
 *   ATTENTION   an open risk that is high on one axis, or a hop that could
 *               not be judged (UNKNOWN is never safe — TripFeasibilityEngine)
 *   HEALTHY     none of the above
 */
import type { TemporalConflict } from "./TripFreedomEngine.js";

export const TRIP_HEALTH_LEVELS = ["HEALTHY", "ATTENTION", "AT_RISK", "DISRUPTED"] as const;
export type TripHealthLevel = (typeof TRIP_HEALTH_LEVELS)[number];

export const HEALTH_REASON_CODES = [
  "TRIP_RISK_REALISED", "SAFETY_NEEDS_HELP",
  "TRIP_TEMPORAL_CONFLICT", "TRIP_RISK_OPEN_HIGH", "FEASIBILITY_INFEASIBLE",
  "TRIP_RISK_OPEN_ELEVATED", "FEASIBILITY_UNKNOWN",
] as const;
export type HealthReasonCode = (typeof HEALTH_REASON_CODES)[number];

export interface HealthReason {
  code: HealthReasonCode;
  /** The level this reason alone would set. */
  level: Exclude<TripHealthLevel, "HEALTHY">;
  /** What it is about: a risk id, a commitment pair, a member id. */
  subjectIds: string[];
  detail: string;
}

export interface RiskForHealth {
  id: string;
  likelihood: string;
  impact: string;
  status: string;
}

export interface HealthInputs {
  conflicts: readonly TemporalConflict[];
  risks: readonly RiskForHealth[];
  /** Crew members whose §17.4 state is NEEDS_HELP (visible to this viewer). */
  needsHelpMemberIds: readonly string[];
  /** Feasibility hops by verdict, from the same computation that produced the conflicts. */
  hops: { infeasible: number; unknown: number };
}

export interface TripHealth {
  health: TripHealthLevel;
  reasons: HealthReason[];
  /** §17.1's ladder, so a consumer can order without knowing it. */
  ladder: readonly TripHealthLevel[];
}

const RANK: Record<TripHealthLevel, number> = { HEALTHY: 0, ATTENTION: 1, AT_RISK: 2, DISRUPTED: 3 };

export function deriveTripHealth(inputs: HealthInputs): TripHealth {
  const reasons: HealthReason[] = [];

  for (const r of inputs.risks) {
    if (r.status === "realised") {
      reasons.push({ code: "TRIP_RISK_REALISED", level: "DISRUPTED", subjectIds: [r.id], detail: `risk ${r.id} has been realised` });
    } else if (r.status === "open") {
      const high = (v: string) => v === "high";
      if (high(r.likelihood) && high(r.impact)) {
        reasons.push({ code: "TRIP_RISK_OPEN_HIGH", level: "AT_RISK", subjectIds: [r.id], detail: `open risk ${r.id}: high likelihood, high impact` });
      } else if (high(r.likelihood) || high(r.impact)) {
        reasons.push({ code: "TRIP_RISK_OPEN_ELEVATED", level: "ATTENTION", subjectIds: [r.id], detail: `open risk ${r.id}: ${r.likelihood} likelihood, ${r.impact} impact` });
      }
    }
  }
  for (const id of inputs.needsHelpMemberIds) {
    reasons.push({ code: "SAFETY_NEEDS_HELP", level: "DISRUPTED", subjectIds: [id], detail: "a crew member's Safe Return is in NEEDS_HELP" });
  }
  for (const c of inputs.conflicts) {
    reasons.push({ code: "TRIP_TEMPORAL_CONFLICT", level: "AT_RISK", subjectIds: [...c.commitmentIds, ...c.planIds], detail: `${c.kind}: ${c.detail}` });
  }
  if (inputs.hops.infeasible > 0) {
    reasons.push({ code: "FEASIBILITY_INFEASIBLE", level: "AT_RISK", subjectIds: [], detail: `${inputs.hops.infeasible} hop(s) cannot be made against a lower-bound travel time` });
  }
  if (inputs.hops.unknown > 0) {
    reasons.push({ code: "FEASIBILITY_UNKNOWN", level: "ATTENTION", subjectIds: [], detail: `${inputs.hops.unknown} hop(s) could not be judged; unknown is not safe` });
  }

  let health: TripHealthLevel = "HEALTHY";
  for (const r of reasons) if (RANK[r.level] > RANK[health]) health = r.level;
  reasons.sort((a, b) => RANK[b.level] - RANK[a.level]);
  return { health, reasons, ladder: TRIP_HEALTH_LEVELS };
}

/**
 * §17.2 "AT_RISK priority: logistics / affected commitments / recovery"
 * (census-trips TR317). The order a surface should present things in once
 * health is AT_RISK or worse; empty otherwise, so a HEALTHY trip does not
 * carry a recovery ordering it has no use for.
 */
export function surfacePriority(health: TripHealthLevel): readonly string[] {
  return RANK[health] >= RANK.AT_RISK ? ["logistics", "affected_commitments", "recovery"] : [];
}
