/**
 * The layover surface's RETURN-CORRIDOR question — census-layover L60, L68,
 * L69, L70, L71, L72, L282.
 *
 * ── WHAT THIS IS THE MISSING HALF OF ─────────────────────────────────────────
 * `lib/providers/routeCorridorProvider.ts` defines the route-shape port and
 * `lib/providers/returnRouteRisk.ts` turns a corridor into risk terms. Both
 * were complete and neither was called by anything a traveller's request
 * reaches, which on this census's precedent (L276) is NOT BUILT however good
 * the module is. `LayoverSafetyEngine.returnRiskAdjustedAdvice` is the
 * consumer. This file is the step between: it ASKS.
 *
 * ── IT ASKS FOR BOTH DIRECTIONS, AT TWO DIFFERENT INSTANTS (L60 + L72) ───────
 * `LayoverSafetyEngine` models the ride back as `travelTimeMin * 2` — symmetric
 * and time-independent, which is two wrong assumptions in one expression. The
 * correction is not a better multiplier; it is a SECOND QUERY, in the other
 * direction, for the moment the traveller must set off back.
 * `bothDirections` is that query and this file supplies the two instants.
 *
 * `returnDepartAt` is an INPUT here and never a derivation. It is the moment
 * the traveller must leave the candidate to make their deadline — a fact the
 * certified envelope already holds — not `outboundDepartAt + outbound`, which
 * would make the return corridor a function of the outbound one and quietly
 * restore the symmetry the whole exercise exists to remove.
 *
 * ── IT REFUSES A SYMMETRIC ANSWER EVEN IF A PROVIDER GIVES ONE ───────────────
 * `corridorsWereEvaluatedIndependently` exists as a diagnostic for exactly this
 * and is asked here rather than trusted: if the two corridors came back stamped
 * with the SAME departure instant, the provider answered one question twice and
 * the pair is `travelTimeMin * 2` wearing a bidirectional shape. That is
 * refused as `PROVIDER_MALFORMED` rather than assessed, because a risk term
 * read off it would be a measurement of the outbound trip presented as a
 * statement about the way home.
 *
 * ── IT SPENDS NOTHING AND ENABLES NOTHING ────────────────────────────────────
 * `LAYOVER_RETURN_CORRIDOR_PROVIDER` is a module constant for the same reason
 * `LAYOVER_TRAVEL_TIME_PROVIDER` is: wiring belongs in code and under review.
 * The provider it names refuses unless BOTH `LAYOVER_ROUTED_CORRIDOR_ENABLED`
 * is affirmative AND `GOOGLE_MAPS_API_KEY` is present, with the enablement gate
 * asked FIRST and both asked before any request is built — so on every
 * deployment this file's answer is a named refusal and no request is made.
 * `bothDirections` makes TWO billable calls per candidate when it is enabled,
 * against a vendor with no spend ceiling anywhere in this repository. Turning
 * it on is an owner's purchase decision; this file neither defaults it on nor
 * describes it as a deployment step.
 */
import {
  assessBidirectionalReturnRisk,
  corridorsWereEvaluatedIndependently,
  type ReturnRiskPolicy,
} from "../../lib/providers/returnRouteRisk.js";
import { googleRoutesCorridorProvider } from "../../lib/providers/googleRoutesCorridorProvider.js";
import { describeCorridorRefusal } from "../../lib/providers/corridorTravelTimeAdapter.js";
import type {
  BidirectionalQuery,
  BidirectionalResult,
  GeoPoint,
  RouteCorridorProvider,
} from "../../lib/providers/routeCorridorProvider.js";
import type { ProviderRefusalReason } from "../../lib/providers/providerRefusal.js";
import type { ReturnCorridorRisk } from "./LayoverSafetyEngine.js";

/**
 * The corridor provider the layover surface asks. A module constant, NOT an
 * environment lookup — see the header. Refuses on every call today.
 */
export const LAYOVER_RETURN_CORRIDOR_PROVIDER: RouteCorridorProvider = googleRoutesCorridorProvider;

/** Re-exported so a layover consumer names the port through the surface that
 *  asks it, rather than reaching into `lib/providers` for a type. */
export type { RouteCorridorProvider };

/**
 * The answer, as a risk OR as a named absence — never as a silent `null` that a
 * consumer could read as "no risk".
 *
 * Both fields are always present and exactly one of them is populated. A
 * consumer that only looks at `risk` gets the absence as `null` and, because
 * `returnRiskAdjustedAdvice` treats `null` as the identity, changes nothing —
 * which is the correct behaviour for an absent measurement and is why the
 * refusal is carried BESIDE it rather than instead of it.
 */
export interface ReturnCorridorOutcome {
  risk: ReturnCorridorRisk | null;
  /** The refusal's own reason, for an operator to branch on. */
  reason: ProviderRefusalReason | "NO_ROUTES" | null;
  /** One operator-facing line. Never shown to a traveller, never a key value. */
  detail: string | null;
}

export interface LayoverReturnCorridorQuery {
  /** The airport the traveller must get back to. */
  airport: GeoPoint | null;
  /** The place they are considering going to. */
  candidate: GeoPoint | null;
  /** When they would leave the airport. */
  outboundDepartAt: Date;
  /**
   * L72 — when they must set off BACK. An input, not a derivation: the
   * certified envelope already knows this moment, and computing it from the
   * outbound leg is the symmetry assumption this module exists to remove.
   */
  returnDepartAt: Date;
  mode?: BidirectionalQuery["mode"];
}

/**
 * Ask for the round trip and judge the RETURN half.
 *
 * The outbound is deliberately not judged: a fragile outbound corridor costs a
 * traveller an afternoon, a fragile return corridor costs them a flight, and
 * folding both into one signal lets the cheap direction dilute the expensive
 * one. `returnRouteRisk.ts` makes the same argument about the same asymmetry.
 *
 * `nowMs` is an ARGUMENT and this module reads no clock: staleness is decided
 * against the caller's single reading, so a request cannot compare a corridor's
 * expiry with a different moment from the one its deadline was measured
 * against (src/test/splitClockGuard.test.ts).
 */
export async function layoverReturnRisk(
  q: LayoverReturnCorridorQuery,
  nowMs: number,
  provider: RouteCorridorProvider = LAYOVER_RETURN_CORRIDOR_PROVIDER,
  policy?: ReturnRiskPolicy,
): Promise<ReturnCorridorOutcome> {
  // A provider that does not compute routes cannot answer this, and a corridor
  // synthesised from anything else would carry one route and no transfer
  // points — which L68/L69 would read as a MEASURED fragile corridor about a
  // corridor nobody looked at. Asked first, exactly as `landsideLeg` does.
  if (!provider.routed) {
    return {
      risk: null,
      reason: "PROVIDER_UNBOUND",
      detail: `${provider.id} does not compute routes, so no return corridor can be assessed`,
    };
  }

  // THE CATCH IS REACHABLE HERE, unlike the one `LayoverEnvelope.bandCandidate`
  // deliberately does without. That path goes through `estimateTravel`, which
  // already turns a throwing provider into `PROVIDER_UNAVAILABLE`; the corridor
  // port has no such wrapper, so an adapter that rejects would otherwise
  // propagate out of a traveller's request. A failure to reach the provider is
  // an ABSENCE of a risk term, never an absent risk and never an error page.
  let result: BidirectionalResult;
  try {
    result = await provider.bidirectional({
      airport: q.airport,
      candidate: q.candidate,
      outboundDepartAt: q.outboundDepartAt,
      returnDepartAt: q.returnDepartAt,
      mode: q.mode,
    });
  } catch (e) {
    return {
      risk: null,
      reason: "PROVIDER_UNAVAILABLE",
      detail: `${provider.id} threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    };
  }
  if (!result.ok) {
    return { risk: null, reason: result.reason, detail: describeCorridorRefusal(result) };
  }

  // See "IT REFUSES A SYMMETRIC ANSWER" in the header.
  if (!corridorsWereEvaluatedIndependently(result.value)) {
    return {
      risk: null,
      reason: "PROVIDER_MALFORMED",
      detail:
        `${provider.id}: the outbound and return corridors are both stamped ` +
        `${result.value.outbound.departAt}, so the way back was not evaluated at its own instant. ` +
        `That is the travelTimeMin * 2 model in a bidirectional shape (L60, L72) and is not assessed.`,
    };
  }

  const assessment = assessBidirectionalReturnRisk(result.value, nowMs, policy);
  if (assessment === null) {
    // `returnRiskFacts` answers null only for a corridor with no routes. An
    // empty corridor is not a fragile corridor and is not a zero-minute way
    // back; it is the absence of an answer, and it is named as one.
    return {
      risk: null,
      reason: "NO_ROUTES",
      detail: `${provider.id}: the return corridor carried no routes, so there is nothing to judge`,
    };
  }
  return { risk: assessment, reason: null, detail: null };
}
