/**
 * Trips §7 — the Temporal and Spatial Consistency Engine's core invariant.
 *
 * §7.2, verbatim:
 *   previous.end + route(previous.place, next.place, future_departure_time)
 *     + required_buffer(next) <= next.requiredArrivalAt
 *
 * census-trips TR128 records that this "is not computed anywhere" and TR134
 * that the §7.4 travel-feasibility check is absent. This file is that
 * computation. What it can and cannot conclude is decided by ONE fact, stated
 * before anything else:
 *
 * THERE IS NO ROUTING PROVIDER IN THIS REPOSITORY.
 * ===============================================
 * Measured across both trees: no OSRM, Valhalla, GraphHopper, OpenRouteService,
 * Google Directions, Mapbox Directions or isochrone client exists. What exists
 * is three straight-line duration models, each labelling itself approximate.
 * See services/trips/TravelTimeProvider.ts for the measurement.
 *
 * THE ASYMMETRY THAT MAKES THIS USEFUL ANYWAY
 * ===========================================
 * A great-circle distance is a genuine LOWER BOUND on travel time: no road is
 * shorter than the straight line between two points, and no vehicle on it is
 * faster than the speed assumed. So:
 *
 *   straight-line says INFEASIBLE  ->  INFEASIBLE, and it is SOUND. A routed
 *                                      provider can only make the number
 *                                      larger, so it cannot rescue the plan.
 *   straight-line says it fits     ->  FEASIBLE_UNVERIFIED, never FEASIBLE.
 *                                      The real route is longer by an unknown
 *                                      amount and might not fit at all.
 *
 * That asymmetry is the whole design. It lets the engine make the ONE claim
 * that matters for safety — "this cannot work" — without a provider, while
 * refusing to make the claim it has no evidence for.
 *
 * UNKNOWN IS NEVER SAFE
 * =====================
 * A missing coordinate, an absent provider, a provider outage and a stale value
 * all produce UNKNOWN. None of them produces FEASIBLE. The four verdicts are
 * ordered and there is no code path from an absent travel term to a positive
 * answer; `assertNeverSafeOnUnknown` in the test suite is the proof.
 */
import {
  FEASIBILITY_PERCENTILE,
  travelMinutesAt,
  worstTravelConfidence,
  isRoutedSourceClass,
  type TravelConfidence,
  type TravelEstimate,
} from "../../lib/travelEstimate.js";
import {
  estimateTravel,
  type GeoPoint,
  type TravelTimeProvider,
  type TravelTimeResult,
  type TravelUnknownReason,
} from "./TravelTimeProvider.js";

/**
 * Ordered most-negative first. A consumer that wants "is this a problem" tests
 * `verdict !== "FEASIBLE"`, which is true for UNKNOWN — the safe direction.
 */
export const FEASIBILITY_VERDICTS = [
  /** The invariant is violated. Sound: proven with a lower-bound travel time. */
  "INFEASIBLE",
  /** Nothing could be computed. NOT feasible, NOT infeasible, NOT safe. */
  "UNKNOWN",
  /** The invariant holds against a lower bound only. The real route is longer. */
  "FEASIBLE_UNVERIFIED",
  /** The invariant holds against an actual routed measurement. */
  "FEASIBLE",
] as const;
export type FeasibilityVerdict = (typeof FEASIBILITY_VERDICTS)[number];

export interface FeasibilityLeg {
  /** When the traveller is free to leave the previous thing. */
  departFrom: Date;
  fromPlace: GeoPoint | null;
}

export interface FeasibilityTarget {
  toPlace: GeoPoint | null;
  /**
   * §7.1's arrival semantics, DISTINCT from starts_at. A plan that starts at
   * 19:00 and needs you there by 18:45 says so with this field; falling back to
   * starts_at when it is absent is explicit, and reported in `usedStartAsArrival`.
   */
  requiredArrivalAt: Date | null;
  startsAt: Date | null;
  /** §7.1 required_buffer(next): getting ready before setting off. */
  prepMinutes: number;
  /** §7.1 lateness_tolerance: how late is still acceptable. */
  latenessToleranceMinutes: number;
}

export interface FeasibilityResult {
  verdict: FeasibilityVerdict;
  /** Minutes to spare. Negative means late by that much. null when UNKNOWN. */
  slackMinutes: number | null;
  /** The travel term actually used, at FEASIBILITY_PERCENTILE. null when UNKNOWN. */
  travelMinutes: number | null;
  prepMinutes: number;
  latenessToleranceMinutes: number;
  /** The deadline the invariant was tested against. */
  deadline: Date | null;
  /** True when requiredArrivalAt was absent and startsAt stood in for it. */
  usedStartAsArrival: boolean;
  /** Weakest confidence of every term. UNKNOWN results report INSUFFICIENT. */
  confidence: TravelConfidence;
  /** Present only when the verdict is UNKNOWN. */
  unknownReason: TravelUnknownReason | FeasibilityUnknownReason | null;
  /** Whether the travel term came from an actual route. */
  routed: boolean;
  /** What to read to see where each number came from. */
  sourceRefs: string[];
}

/** Reasons the ENGINE could not compute, distinct from the provider's. */
export const FEASIBILITY_UNKNOWN_REASONS = [
  /** Neither requiredArrivalAt nor startsAt is known: there is no deadline. */
  "NO_DEADLINE",
  /** departFrom is not a usable instant. */
  "NO_DEPARTURE_TIME",
  /** A duration was negative or not finite. */
  "MALFORMED_DURATION",
] as const;
export type FeasibilityUnknownReason = (typeof FEASIBILITY_UNKNOWN_REASONS)[number];

const MS_PER_MIN = 60_000;

function unknown(
  reason: TravelUnknownReason | FeasibilityUnknownReason,
  target: FeasibilityTarget,
  routed: boolean,
  sourceRefs: string[],
): FeasibilityResult {
  return {
    verdict: "UNKNOWN",
    slackMinutes: null,
    travelMinutes: null,
    prepMinutes: target.prepMinutes,
    latenessToleranceMinutes: target.latenessToleranceMinutes,
    deadline: null,
    usedStartAsArrival: false,
    // INSUFFICIENT, not LOW. There is no estimate to be slightly unsure about.
    confidence: "INSUFFICIENT",
    unknownReason: reason,
    routed,
    sourceRefs,
  };
}

/**
 * The §7.2 invariant, evaluated once.
 *
 * The comparison is done in MILLISECONDS on absolute instants, never on wall
 * clock components, so a leg that crosses a timezone or a DST boundary is
 * correct without special handling: two Dates are two points on the same line
 * whatever zone produced them. `services/airport/AirportTime.ts` is what turns
 * a wall time in a zone INTO one of those instants, and is the right thing to
 * call before this function — not inside it, because a feasibility engine that
 * parsed zones would be two responsibilities and the tests would not be able to
 * tell which one had failed.
 */
export function evaluateFeasibility(
  leg: FeasibilityLeg,
  target: FeasibilityTarget,
  travel: TravelTimeResult,
): FeasibilityResult {
  const refs: string[] = ["Trips spec §7.2"];

  if (!(leg.departFrom instanceof Date) || !Number.isFinite(leg.departFrom.getTime())) {
    return unknown("NO_DEPARTURE_TIME", target, false, refs);
  }
  for (const [name, v] of [
    ["prepMinutes", target.prepMinutes],
    ["latenessToleranceMinutes", target.latenessToleranceMinutes],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) {
      return unknown("MALFORMED_DURATION", target, false, [...refs, `bad ${name}`]);
    }
  }

  // §7.1: arrival semantics are DISTINCT from start time. Falling back is
  // allowed and is reported, because "we assumed you must be there when it
  // starts" is a different claim from "you told us when you must be there".
  const usedStartAsArrival = target.requiredArrivalAt === null;
  const deadlineBase = target.requiredArrivalAt ?? target.startsAt;
  if (!deadlineBase || !Number.isFinite(deadlineBase.getTime())) {
    return unknown("NO_DEADLINE", target, false, refs);
  }

  if (travel.kind === "unknown") {
    // The whole point. An absent travel term is NOT zero and NOT safe.
    return unknown(travel.reason, target, false, [...refs, "travel term unavailable"]);
  }

  const est: TravelEstimate = travel.estimate;
  const travelMinutes = travelMinutesAt(est, FEASIBILITY_PERCENTILE);
  const routed = isRoutedSourceClass(est.sourceClass);

  // previous.end + travel + prep <= requiredArrivalAt + tolerance
  const arriveAtMs =
    leg.departFrom.getTime() + (travelMinutes + target.prepMinutes) * MS_PER_MIN;
  const deadlineMs =
    deadlineBase.getTime() + target.latenessToleranceMinutes * MS_PER_MIN;
  const slackMinutes = (deadlineMs - arriveAtMs) / MS_PER_MIN;

  const confidence = worstTravelConfidence(est.confidence, routed ? "HIGH" : "LOW");
  const sourceRefs = [...refs, ...est.sourceRefs];

  let verdict: FeasibilityVerdict;
  if (slackMinutes < 0) {
    // Sound whatever the provider was: the travel term is a lower bound, so a
    // real route can only be longer and can only make this worse.
    verdict = "INFEASIBLE";
  } else if (routed) {
    verdict = "FEASIBLE";
  } else {
    // It fits against a lower bound. That is not the same as fitting.
    verdict = "FEASIBLE_UNVERIFIED";
  }

  return {
    verdict,
    slackMinutes,
    travelMinutes,
    prepMinutes: target.prepMinutes,
    latenessToleranceMinutes: target.latenessToleranceMinutes,
    deadline: new Date(deadlineMs),
    usedStartAsArrival,
    confidence,
    unknownReason: null,
    routed,
    sourceRefs,
  };
}

/** Evaluate one leg end to end, calling the provider. */
export async function checkFeasibility(
  provider: TravelTimeProvider,
  leg: FeasibilityLeg,
  target: FeasibilityTarget,
  now: Date = new Date(),
): Promise<FeasibilityResult> {
  const travel = await estimateTravel(
    provider,
    { from: leg.fromPlace, to: target.toPlace, departAt: leg.departFrom },
    now,
  );
  return evaluateFeasibility(leg, target, travel);
}

/**
 * Fold a day's worth of legs into one verdict.
 *
 * The fold takes the WORST verdict, in FEASIBILITY_VERDICTS order, so one
 * impossible hop makes the day impossible and one unknown hop makes the day
 * unknown — an itinerary is not feasible because most of it is. Confidence
 * folds the same way.
 */
export function foldFeasibility(results: readonly FeasibilityResult[]): {
  verdict: FeasibilityVerdict;
  confidence: TravelConfidence;
  worstSlackMinutes: number | null;
  offendingIndex: number | null;
} {
  if (results.length === 0) {
    // An empty itinerary is not "feasible"; there is nothing to have checked.
    return { verdict: "UNKNOWN", confidence: "INSUFFICIENT", worstSlackMinutes: null, offendingIndex: null };
  }
  let worst = results[0];
  let worstIdx = 0;
  for (let i = 1; i < results.length; i += 1) {
    const a = FEASIBILITY_VERDICTS.indexOf(results[i].verdict);
    const b = FEASIBILITY_VERDICTS.indexOf(worst.verdict);
    if (a < b || (a === b && (results[i].slackMinutes ?? Infinity) < (worst.slackMinutes ?? Infinity))) {
      worst = results[i];
      worstIdx = i;
    }
  }
  let confidence: TravelConfidence = results[0].confidence;
  for (const r of results) confidence = worstTravelConfidence(confidence, r.confidence);
  return {
    verdict: worst.verdict,
    confidence,
    worstSlackMinutes: worst.slackMinutes,
    offendingIndex: worst.verdict === "FEASIBLE" ? null : worstIdx,
  };
}
