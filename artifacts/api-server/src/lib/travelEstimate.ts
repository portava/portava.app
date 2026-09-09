/**
 * The canonical travel-time estimate vocabulary.
 *
 * WHY THIS FILE EXISTS RATHER THAN A SECOND VOCABULARY
 * ====================================================
 * `services/airport/LayoverFeasibility.ts` already defines exactly this —
 * ESTIMATE_SOURCE_CLASSES, ESTIMATE_CONFIDENCES, EstimateFallbackLevel — for
 * the §6.2 airport estimate. Trips §7 needs the same three concepts, and a
 * second set of strings for one concept is how two surfaces come to disagree
 * about what LOW means.
 *
 * The arrays are DECLARED here and pinned to Layover's by
 * src/test/travelEstimateVocabularyIsShared.test.ts, which fails if either side
 * gains, loses or reorders a value. Declaring rather than re-exporting keeps
 * Trips from importing a 545-line airport safety module for three string
 * arrays; pinning keeps that from being a fork.
 *
 * (Re-exporting would have been simpler and was rejected: LayoverFeasibility is
 * safety-critical and already carries a certification/replay contract of its
 * own. Making Trips a compile-time dependent of it means any Trips change that
 * touches these types has to be reasoned about against that contract too.)
 */

/**
 * Where a number came from. Ordered weakest-first is NOT implied — use
 * ESTIMATE_FALLBACK_LEVEL for ordering.
 *
 *   STATIC_DEFAULT   a constant in code. No measurement of anything.
 *   AIRPORT_PROFILE  a curated per-airport row.
 *   HISTORICAL       an aggregate over past observations.
 *   LIVE             a routed measurement made for this query.
 *   USER_DECLARED    the traveller asserted it.
 */
export const TRAVEL_SOURCE_CLASSES = [
  "STATIC_DEFAULT",
  "AIRPORT_PROFILE",
  "HISTORICAL",
  "LIVE",
  "USER_DECLARED",
] as const;
export type TravelSourceClass = (typeof TRAVEL_SOURCE_CLASSES)[number];

/** Ordered weakest-first, so a fold over several terms can take the minimum. */
export const TRAVEL_CONFIDENCES = ["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"] as const;
export type TravelConfidence = (typeof TRAVEL_CONFIDENCES)[number];

/**
 * How far the value fell back from a live measurement. Lower is better.
 * 0 live · 1 historical aggregate · 2 curated row · 3 code constant.
 */
export type TravelFallbackLevel = 0 | 1 | 2 | 3;

/**
 * Which source classes are an actual ROUTE rather than a stand-in.
 *
 * This is the single fact §7 turns on. A straight-line distance divided by an
 * assumed speed is not a route; presenting a schedule as feasible on the
 * strength of one is the failure mode §7 exists to prevent. Fail-closed: a
 * class not listed here is NOT routed.
 */
const ROUTED: ReadonlySet<string> = new Set<string>(["LIVE", "HISTORICAL"]);

export function isRoutedSourceClass(c: TravelSourceClass | string | null | undefined): boolean {
  return typeof c === "string" && ROUTED.has(c);
}

/** Weakest of two confidences. Folding several terms can only lose confidence. */
export function worstTravelConfidence(a: TravelConfidence, b: TravelConfidence): TravelConfidence {
  return TRAVEL_CONFIDENCES.indexOf(a) <= TRAVEL_CONFIDENCES.indexOf(b) ? a : b;
}

/**
 * One travel-time estimate.
 *
 * THE PERCENTILES ARE DEGENERATE FOR EVERY ESTIMATE THIS TREE CAN BUILD, for
 * the reason LayoverFeasibility's `Estimate` gives at length: there is no
 * observation set to take a percentile OF. p50 === p75 === p90 === minutes.
 * Manufacturing a spread would put a number in front of a traveller that no
 * measurement supports. The shape is here so a routed provider can fill it in
 * without a type change; `confidence` and `fallbackLevel` are what tell a
 * consumer the distribution is flat.
 */
export interface TravelEstimate {
  minutes: number;
  p50Minutes: number;
  p75Minutes: number;
  p90Minutes: number;
  confidence: TravelConfidence;
  sourceClass: TravelSourceClass;
  /** Instant the underlying observation was made. `null` — nothing was observed. */
  observedAt: string | null;
  /** Instant the value stops being usable. `null` — constants do not expire. */
  expiresAt: string | null;
  fallbackLevel: TravelFallbackLevel;
  /** What to read to see where the number came from. */
  sourceRefs: string[];
}

export type TravelPercentile = "p50" | "p75" | "p90";

/**
 * §6.2: "Safety-critical calculations should use a configurable conservative
 * percentile … Do not collapse all estimates to a single average." Feasibility
 * is safety-critical in the §7 sense — being wrong means a traveller misses a
 * flight — so it takes the highest the spec names.
 */
export const FEASIBILITY_PERCENTILE: TravelPercentile = "p90";

/** A term at the chosen percentile, never below its own point value. */
export function travelMinutesAt(e: TravelEstimate, percentile: TravelPercentile): number {
  const at = percentile === "p50" ? e.p50Minutes : percentile === "p75" ? e.p75Minutes : e.p90Minutes;
  return Math.max(e.minutes, at);
}

/** Build a degenerate (single-point) estimate — the only kind available today. */
export function pointTravelEstimate(
  minutes: number,
  sourceClass: TravelSourceClass,
  confidence: TravelConfidence,
  fallbackLevel: TravelFallbackLevel,
  sourceRefs: string[],
  observedAt: string | null = null,
  expiresAt: string | null = null,
): TravelEstimate {
  const m = Math.max(0, minutes);
  return {
    minutes: m, p50Minutes: m, p75Minutes: m, p90Minutes: m,
    confidence, sourceClass, observedAt, expiresAt, fallbackLevel, sourceRefs,
  };
}
