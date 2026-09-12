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
  "TRIP_RISK_REALISED", "SAFETY_NEEDS_HELP", "TRIP_DISRUPTION_ACTIVE",
  "TRIP_TEMPORAL_CONFLICT", "TRIP_RISK_OPEN_HIGH", "FEASIBILITY_INFEASIBLE",
  "TRIP_RISK_OPEN_ELEVATED", "FEASIBILITY_UNKNOWN",
  // §11.3 "Return / regroup" (2794): an open regroup checkpoint with someone
  // still expected is location coordination — §17.2's SAFETY_EVENT priority.
  "REGROUP_OPEN",
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

/** A row of trip_disruptions (2785, §17.2). Only `state = 'active'` rows count. */
export interface DisruptionForHealth {
  id: string;
  kind: string;
  /** 'minor' | 'major' | 'critical' — the 2785 CHECK. */
  severity: string;
  state: string;
}

export interface RegroupForHealth {
  id: string;
  label: string;
  purpose: "regroup" | "planned" | "safety";
  /** Participants not yet arrived (pending, en_route, late). */
  pendingIds: readonly string[];
  expected: number;
}

export interface HealthInputs {
  conflicts: readonly TemporalConflict[];
  risks: readonly RiskForHealth[];
  /** §17.2: the disruption register. Omitted = not read (the pre-2785 callers); [] = read and empty. */
  disruptions?: readonly DisruptionForHealth[];
  /** Crew members whose §17.4 state is NEEDS_HELP (visible to this viewer). */
  needsHelpMemberIds: readonly string[];
  /** §11.3 / §10.4 (2794): open regroup or safety checkpoints. Omitted = not read; [] = read and none. */
  openRegroups?: readonly RegroupForHealth[];
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
  for (const d of inputs.disruptions ?? []) {
    if (d.state !== "active") continue;
    const level: HealthReason["level"] = d.severity === "critical" ? "DISRUPTED" : d.severity === "major" ? "AT_RISK" : "ATTENTION";
    reasons.push({ code: "TRIP_DISRUPTION_ACTIVE", level, subjectIds: [d.id], detail: `active ${d.severity} ${d.kind} disruption ${d.id}` });
  }
  for (const id of inputs.needsHelpMemberIds) {
    reasons.push({ code: "SAFETY_NEEDS_HELP", level: "DISRUPTED", subjectIds: [id], detail: "a crew member's Safe Return is in NEEDS_HELP" });
  }
  for (const g of inputs.openRegroups ?? []) {
    if (g.purpose === "planned" || g.pendingIds.length === 0) continue;
    reasons.push({
      code: "REGROUP_OPEN", level: g.purpose === "safety" ? "AT_RISK" : "ATTENTION", subjectIds: [...g.pendingIds],
      detail: `${g.purpose} checkpoint "${g.label}" is open: ${g.pendingIds.length} of ${g.expected} not yet arrived (§11.3)`,
    });
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

// ── §17.2 Disruption priority switch ─────────────────────────────────────────
//
//   NORMAL:        discovery / execution / social
//   AT_RISK:       logistics / affected commitments / recovery
//   SAFETY_EVENT:  safety / official help / location coordination
//
// "Commercial recommendations and entertainment discovery are suppressed when
// a severe operational or safety state requires the user's attention."
// (census-trips TR319). The switch is a function of the health that was
// already derived: SAFETY_EVENT when any reason is a safety one, AT_RISK when
// health is AT_RISK or worse, NORMAL otherwise. The suppression it returns is
// the reason code the suppressed surfaces carry — TRIP_DISRUPTION_SUPPRESSED,
// declared in lib/tripReasonCodes.ts since §38 and emitted from here.

export const PRIORITY_MODES = ["NORMAL", "AT_RISK", "SAFETY_EVENT"] as const;
export type PriorityMode = (typeof PRIORITY_MODES)[number];

export const PRIORITY_BY_MODE: Readonly<Record<PriorityMode, readonly string[]>> = {
  NORMAL: ["discovery", "execution", "social"],
  AT_RISK: ["logistics", "affected_commitments", "recovery"],
  SAFETY_EVENT: ["safety", "official_help", "location_coordination"],
};

export const SAFETY_REASON_CODES: readonly HealthReasonCode[] = ["SAFETY_NEEDS_HELP", "REGROUP_OPEN"];

export interface PrioritySwitch {
  mode: PriorityMode;
  priority: readonly string[];
  suppression: {
    /** Commercial recommendations (sponsored, affiliate, booking upsell). */
    commercial: boolean;
    /** Entertainment discovery (opportunities, nightlife, "where next"). */
    discovery: boolean;
    reason: "TRIP_DISRUPTION_SUPPRESSED" | null;
    detail: string | null;
  };
}

export function prioritySwitch(health: Pick<TripHealth, "health" | "reasons">): PrioritySwitch {
  const safety = health.reasons.some((r) => SAFETY_REASON_CODES.includes(r.code)
    || (r.code === "TRIP_DISRUPTION_ACTIVE" && /safety|health/.test(r.detail)));
  const mode: PriorityMode = safety ? "SAFETY_EVENT" : RANK[health.health] >= RANK.AT_RISK ? "AT_RISK" : "NORMAL";
  const suppressed = mode !== "NORMAL";
  return {
    mode,
    priority: PRIORITY_BY_MODE[mode],
    suppression: {
      commercial: suppressed,
      discovery: suppressed,
      reason: suppressed ? "TRIP_DISRUPTION_SUPPRESSED" : null,
      detail: suppressed
        ? `${mode === "SAFETY_EVENT" ? "a safety event" : `the trip is ${health.health}`}: commercial recommendations and entertainment discovery are suppressed (§17.2)`
        : null,
    },
  };
}
