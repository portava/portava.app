/**
 * RETURN-ROUTE RISK — the input for census-layover L282
 * (`RETURN_ROUTE_UNRELIABLE`), and the §8 risk terms L68, L69, L70 and L71 ask
 * for.
 *
 * ── WHY THIS FILE IS FACTS FIRST AND A JUDGEMENT SECOND ──────────────────────
 * `LayoverSafetyEngine.ts` declares `RETURN_ROUTE_UNRELIABLE` and, in its own
 * header, lists it among the codes "Declared, never emitted anywhere (no input
 * exists in any shape)". The missing input is a route model, which
 * `routeCorridorProvider.ts` now defines and `googleRoutesCorridorProvider.ts`
 * can fill. This module is the step between them: corridor in, risk terms out.
 *
 * It does NOT decide a verdict. Verdicts belong to the safety engine, which
 * owns the certification and replay contract, and a second module quietly
 * deciding what counts as "unreliable" is how two answers to one question start
 * disagreeing. So:
 *
 *   • `ReturnRiskFacts` are MEASUREMENTS read off the corridor. No thresholds,
 *     no policy, nothing to disagree with.
 *   • `assessReturnRisk` applies a policy to those facts and flags the code.
 *     The policy is an ARGUMENT with an explicit default, so a consumer that
 *     wants different thresholds passes them rather than forking this file, and
 *     the default constants are named and justified below rather than being
 *     magic numbers inside a condition.
 *
 * ── THE THIRD ANSWER, AGAIN ──────────────────────────────────────────────────
 * `returnRouteUnreliable` is `boolean | null`. `null` means the corridor does
 * not support the judgement — not "reliable". This matters more here than
 * almost anywhere else in the layover surface: the code exists to WARN, so
 * resolving an unknown to `false` silently withholds the warning on exactly the
 * itineraries nobody could check, which is the population most likely to need
 * it. Every consumer must branch on all three.
 *
 * ── WHAT IT REFUSES TO SCORE ─────────────────────────────────────────────────
 * Three of §8's five signals have no feed (queue friction, weather, airport
 * re-entry cost). They are carried through as `unmeasured` rather than scored
 * as zero and rather than dropped, so a consumer folding this into a decision
 * can see that the assessment rests on two of five signals. An assessment that
 * hid its own coverage would be worse than none.
 */
import { worstTravelConfidence, type TravelConfidence } from "../travelEstimate.js";
import {
  corridorConfidence,
  corridorIsStale,
  routeInterruptibility,
  unmeasuredSignals,
  type BidirectionalCorridor,
  type LegInterruptibility,
  type RouteCorridor,
} from "./routeCorridorProvider.js";

/**
 * Pure measurements about the RETURN corridor. Nothing here is a threshold.
 */
export interface ReturnRiskFacts {
  /** L68 — how many genuinely independent ways back exist. */
  independentReturnRoutes: number;
  /** Every route offered, before the independence reduction. */
  offeredReturnRoutes: number;
  /**
   * L70 — the best route's interruptibility. `committed` means that once
   * aboard, the traveller cannot act on a deadline that moves.
   */
  bestRouteInterruptibility: LegInterruptibility;
  /** L70 across every offered route — `committed` when EVERY way back is. */
  allRoutesInterruptibility: LegInterruptibility;
  /** L71 — the fewest changes of conveyance any offered route requires. */
  minTransferCount: number;
  /** L71 — the most, so a consumer can see the spread. */
  maxTransferCount: number;
  /**
   * L62 — minutes between the fastest and slowest way back, when the corridor
   * measured reliability. `null` when it could not.
   */
  spreadMinutes: number | null;
  /** The best return route's duration. */
  bestReturnMinutes: number;
  /**
   * L72 — the instant the return corridor was computed FOR.
   *
   * Exposed because it is the whole of L72 and because a consumer must be able
   * to check it against the deadline it is reasoning about.
   * `LayoverSafetyEngine.ts:97` models the return as `travelTimeMin * 2`; a
   * fact that names its own departure instant is what makes that visible as a
   * substitution rather than a calculation.
   */
  returnEvaluatedFor: string;
  /** L73 — whether the corridor has stopped being a statement about now. */
  stale: boolean;
  /** L62 — which signals the corridor could not measure, each naming its blocker. */
  unmeasured: Array<{ signal: string; blockedBy: string }>;
  confidence: TravelConfidence;
}

/**
 * Thresholds. An ARGUMENT, not a constant buried in a condition.
 *
 * Each default is a policy choice and is written down as one. None of them is a
 * measurement and none should ever read as one.
 */
export interface ReturnRiskPolicy {
  /**
   * At or below this many independent ways back, the corridor is fragile (L69).
   *
   * Default 1: one way back means one failure closes the only route. This is
   * the least arbitrary threshold available — it is the boundary between
   * "there is an alternative" and "there is not", rather than a number picked
   * off a scale.
   */
  fragileAtOrBelowIndependentRoutes: number;
  /**
   * Spread between fastest and slowest way back, as a fraction of the fastest,
   * above which the corridor's answer depends heavily on which way you go.
   *
   * Default 0.5: the slowest way back taking half as long again as the fastest
   * means a traveller who picks wrong, or whose first choice fails, loses a
   * material part of their margin. A fraction rather than an absolute so it
   * means the same thing for a 10-minute corridor and a 90-minute one.
   */
  unreliableSpreadRatio: number;
  /**
   * Treat an UNKNOWN interruptibility as committed when judging reliability?
   *
   * Default TRUE, and this is the one place in this directory where an unknown
   * is deliberately folded — in the CAUTIOUS direction, and only for a WARNING
   * rather than for a permission. The asymmetry is the point: this code's whole
   * job is to raise a flag, so resolving the unknown towards the flag risks a
   * warning a traveller did not need, while resolving it away risks silence on
   * a corridor nobody could check. The fact itself stays `unknown` in
   * `ReturnRiskFacts`; only the judgement folds it, and only because a consumer
   * asked for a judgement.
   */
  treatUnknownInterruptibilityAsCommitted: boolean;
}

export const DEFAULT_RETURN_RISK_POLICY: ReturnRiskPolicy = Object.freeze({
  fragileAtOrBelowIndependentRoutes: 1,
  unreliableSpreadRatio: 0.5,
  treatUnknownInterruptibilityAsCommitted: true,
});

/** Read the facts off a return corridor. No thresholds are applied here. */
export function returnRiskFacts(returnCorridor: RouteCorridor, nowMs: number): ReturnRiskFacts | null {
  const routes = returnCorridor.routes;
  // A corridor with no routes is not a fact about a fragile corridor — it is
  // the absence of a corridor, and the adapters refuse rather than produce one.
  // Guarded anyway: reading `routes[0]` off an empty array here would produce
  // an assessment built on undefined.
  if (routes.length === 0) return null;

  const best = routes[0]!;
  const transfers = routes.map((r) => r.transferCount);
  const reliability = returnCorridor.reliability;

  // `allRoutesInterruptibility` over the CONCATENATION of every route's legs:
  // routeInterruptibility already takes the weakest link, so the weakest link
  // across all routes is the weakest link of all their legs together.
  const everyLeg = routes.flatMap((r) => r.legs);

  return {
    independentReturnRoutes: returnCorridor.independentRouteCount,
    offeredReturnRoutes: routes.length,
    bestRouteInterruptibility: routeInterruptibility(best.legs),
    allRoutesInterruptibility: routeInterruptibility(everyLeg),
    minTransferCount: Math.min(...transfers),
    maxTransferCount: Math.max(...transfers),
    spreadMinutes: reliability.measured ? reliability.value.spreadMinutes : null,
    bestReturnMinutes: best.totalMinutes,
    returnEvaluatedFor: returnCorridor.departAt,
    stale: corridorIsStale(returnCorridor, nowMs),
    unmeasured: unmeasuredSignals(returnCorridor),
    confidence: corridorConfidence(returnCorridor),
  };
}

export interface ReturnRiskAssessment {
  facts: ReturnRiskFacts;
  /**
   * L282. `null` means the corridor does not support the judgement — never
   * "reliable". See THE THIRD ANSWER in the header.
   */
  returnRouteUnreliable: boolean | null;
  /** L69. Same three-valued contract. */
  fragileCorridor: boolean | null;
  /**
   * Which conditions fired, by name. Empty when nothing did. These are the
   * strings a consumer shows or logs; the boolean alone says nothing about WHY
   * and would make the warning unactionable.
   */
  contributingFactors: string[];
  /**
   * Confidence in the JUDGEMENT, which is never better than confidence in the
   * corridor it was read off, and is lowered again when the corridor is stale.
   */
  confidence: TravelConfidence;
}

/** Named so a consumer can branch on a factor rather than on prose. */
export const RETURN_RISK_FACTORS = {
  NO_INDEPENDENT_ALTERNATIVE: "no_independent_alternative_route",
  COMMITTED_TRANSPORT: "return_transport_not_interruptible",
  INTERRUPTIBILITY_UNKNOWN: "return_interruptibility_unknown",
  WIDE_SPREAD: "return_options_differ_widely",
  MANY_TRANSFERS: "return_requires_multiple_transfers",
  STALE_CORRIDOR: "return_corridor_is_stale",
} as const;

/**
 * Apply a policy to the facts.
 *
 * The judgement is deliberately a DISJUNCTION of independently sufficient
 * conditions rather than a score. A weighted score would let two mild signals
 * cancel a severe one, and would need a scale nobody has calibrated — this tree
 * has no outcomes to calibrate against, which census L161 records ("there are
 * no outcomes to calibrate against and nowhere to persist them"). A named list
 * of conditions is honest about being a rule rather than a model.
 */
export function assessReturnRisk(
  returnCorridor: RouteCorridor,
  nowMs: number,
  policy: ReturnRiskPolicy = DEFAULT_RETURN_RISK_POLICY,
): ReturnRiskAssessment | null {
  const facts = returnRiskFacts(returnCorridor, nowMs);
  if (facts === null) return null;

  const factors: string[] = [];

  const fragile = facts.independentReturnRoutes <= policy.fragileAtOrBelowIndependentRoutes;
  if (fragile) factors.push(RETURN_RISK_FACTORS.NO_INDEPENDENT_ALTERNATIVE);

  if (facts.bestRouteInterruptibility === "committed") {
    factors.push(RETURN_RISK_FACTORS.COMMITTED_TRANSPORT);
  } else if (facts.bestRouteInterruptibility === "unknown") {
    // Recorded whether or not the policy folds it, so a consumer can always see
    // that the unknown was present rather than only its consequence.
    factors.push(RETURN_RISK_FACTORS.INTERRUPTIBILITY_UNKNOWN);
  }

  if (
    facts.spreadMinutes !== null &&
    facts.bestReturnMinutes > 0 &&
    facts.spreadMinutes / facts.bestReturnMinutes > policy.unreliableSpreadRatio
  ) {
    factors.push(RETURN_RISK_FACTORS.WIDE_SPREAD);
  }

  if (facts.minTransferCount >= 2) factors.push(RETURN_RISK_FACTORS.MANY_TRANSFERS);
  if (facts.stale) factors.push(RETURN_RISK_FACTORS.STALE_CORRIDOR);

  const committedForJudgement =
    facts.bestRouteInterruptibility === "committed" ||
    (policy.treatUnknownInterruptibilityAsCommitted && facts.bestRouteInterruptibility === "unknown");

  // A STALE corridor cannot support the judgement at all. It is a statement
  // about a moment that has passed, and "the way back was unreliable an hour
  // ago" is not a claim about the way back now — in either direction.
  const unreliable = facts.stale
    ? null
    : factors.some((f) => f === RETURN_RISK_FACTORS.WIDE_SPREAD) ||
      factors.some((f) => f === RETURN_RISK_FACTORS.MANY_TRANSFERS) ||
      (fragile && committedForJudgement);

  let confidence = facts.confidence;
  // Two of §8's five signals at best. Say so by capping the judgement's
  // confidence rather than by inheriting the corridor's, which is confidence in
  // the ROUTE and not in this rule.
  confidence = worstTravelConfidence(confidence, "MEDIUM");
  if (facts.stale) confidence = "INSUFFICIENT";

  return {
    facts,
    returnRouteUnreliable: unreliable,
    fragileCorridor: facts.stale ? null : fragile,
    contributingFactors: factors,
    confidence,
  };
}

/**
 * The bidirectional convenience: assess the RETURN half.
 *
 * The outbound is not assessed and that is not an oversight. L282 is about the
 * way BACK — a fragile outbound corridor costs a traveller a nice afternoon, a
 * fragile return corridor costs them a flight, and folding both into one signal
 * would let the cheap direction dilute the expensive one.
 */
export function assessBidirectionalReturnRisk(
  c: BidirectionalCorridor,
  nowMs: number,
  policy: ReturnRiskPolicy = DEFAULT_RETURN_RISK_POLICY,
): ReturnRiskAssessment | null {
  return assessReturnRisk(c.returnLeg, nowMs, policy);
}

/**
 * Whether the outbound and return corridors actually differ.
 *
 * A diagnostic for the L60/L72 correction, not a risk term. If a consumer ever
 * reintroduces symmetry — the `travelTimeMin * 2` model — this answers `true`
 * and a test can catch it. It compares the DEPARTURE INSTANTS as well as the
 * durations, because two corridors that happen to take the same time at
 * different instants are a legitimate coincidence, while two computed for the
 * same instant are a symmetry assumption wearing a bidirectional shape.
 */
export function corridorsWereEvaluatedIndependently(c: BidirectionalCorridor): boolean {
  return c.outbound.departAt !== c.returnLeg.departAt;
}
