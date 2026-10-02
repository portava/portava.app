/**
 * The adapter between the two travel PORTS — census-layover L60, L68, L69,
 * L70, L71, L282.
 *
 * ── WHY AN ADAPTER HAD TO EXIST AT ALL ───────────────────────────────────────
 * `services/airport/LayoverTravelTime.ts`'s header said the remaining obstacle
 * was that "no routed provider exists to wire". A routed provider now exists —
 * `googleRoutesCorridorProvider` — and the sentence was still not one line away
 * from being false, because the two ports are NOT the same port:
 *
 *   TravelTimeProvider     estimate(q: TravelTimeQuery) -> TravelTimeResult
 *                          one scalar duration, one direction, one departure.
 *   RouteCorridorProvider  corridor(q: CorridorQuery)   -> CorridorResult
 *                          bidirectional(q)             -> BidirectionalResult
 *                          a SET of routes with legs, transfers and expiry.
 *
 * There is no assignment that makes one the other. A corridor answers a
 * strictly larger question, so the reduction is lossy and the loss has to be
 * written down rather than implied — which is what this file is.
 *
 * ── THE BOUND STAYS THE BOUND (this is the load-bearing decision) ────────────
 * `TravelTimeProvider`'s contract is explicit that `estimate.minutes` is the
 * FREE-FLOW LOWER BOUND every feasibility proof rests on, and that an
 * assumption "rides beside it with its own factor" rather than being folded in.
 * A corridor carries BOTH numbers already, and they are not the same number:
 *
 *   RouteLeg.minutes       `staticDuration` per step — FREE FLOW. Summing the
 *                          legs of a route gives the bound.
 *   RouteOption.totalMinutes  the route's own `duration` — TRAFFIC-AWARE for a
 *                          DRIVE corridor, which is a prediction about a
 *                          moment and is therefore NOT a lower bound: traffic
 *                          can clear, and then the real journey is shorter.
 *
 * So `totalMinutes` does NOT go in `estimate.minutes`. It goes in
 * `expectedMinutes`, the channel the port already has for exactly this, and
 * `assumption` is `null` because a ROUTED provider answered for the departure
 * instant it was given — the contract's own words for when there is nothing to
 * assume. Putting the traffic-aware figure in `minutes` would have silently
 * redefined the bound that `TripFeasibilityEngine` and `LayoverPlanFit` both
 * reason with, and nothing downstream would have noticed.
 *
 * ── WHAT THAT COSTS THE CONSUMER, AND WHO PAYS IT ────────────────────────────
 * A layover card's `travelTimeMin` is doubled into a round trip and can produce
 * `"safe"`, which is a CERTIFICATION. A lower bound may never certify — the
 * whole reason `LayoverTravelTime.ts` refuses `straightLineTravelTimeProvider`.
 * So `landsideLeg` reads the EXPECTED figure when the chain supplies one and
 * falls back to the bound only when it does not. Both numbers come out of this
 * file, correctly labelled, and the consumer chooses; this file does not
 * choose for it and does not overwrite one with the other.
 *
 * `expectedMinutes` is never below `estimate.minutes`, as the contract
 * requires. Per-leg minutes are ceiled individually, so a two-leg route can sum
 * to one minute more than its own ceiled total; the `Math.max` below absorbs
 * that rounding rather than letting an "expected" fall under its own bound.
 *
 * ── A ROUTE THAT REPORTS NO LEGS ─────────────────────────────────────────────
 * The field mask asks for steps, but a provider that returns a route body with
 * no readable step leaves no free-flow figure to sum. The route's own total is
 * then used as the bound. That is conservative in the only direction that
 * matters: a traffic-aware total is never BELOW free flow, so a "bound" set
 * from it can only refuse a journey that would have been allowed — never
 * certify one that should have been refused.
 *
 * ── NINE REFUSALS, FIVE UNKNOWNS, AND NOTHING LOST ───────────────────────────
 * `ProviderRefusalReason` has nine members; `TravelUnknownReason` has five, and
 * widening it is not this lane's to do — it is the Trips §7 port's vocabulary
 * and `TripFeasibilityEngine` branches on it. So the map below is a TOTAL,
 * EXHAUSTIVE `Record`: adding a refusal reason breaks this file at compile
 * time rather than defaulting into whichever unknown was nearest.
 *
 * The three facts the port's own header says must not collapse stay apart —
 * a missing coordinate (`NO_COORDINATES`), a provider that was called and
 * failed (`PROVIDER_UNAVAILABLE`) and a deployment with no usable routed
 * provider (`NO_ROUTED_PROVIDER`) are three different reasons. What the port's
 * vocabulary cannot separate — an unset credential from an empty one from an
 * un-opted-in spend gate, all three of which mean "there is no routed provider
 * HERE" — is separated in `detail`, which ALWAYS begins with the refusal's own
 * reason token. No two refusal shapes are indistinguishable to a consumer that
 * reads both fields, and `LandsideLeg.detail` carries that token to the layover
 * surface rather than dropping it at this boundary.
 *
 * ── THIS FILE ENABLES NOTHING ────────────────────────────────────────────────
 * It reads no environment variable, holds no default and names no credential.
 * Whether the corridor provider it wraps answers is entirely that provider's
 * two gates (`LAYOVER_ROUTED_CORRIDOR_ENABLED` and `GOOGLE_MAPS_API_KEY`),
 * neither of which is satisfied on any deployment, and both of which refuse
 * BEFORE any request is built. Wiring is a code change; enabling is a spend
 * decision and is not one this file can take part in.
 */
import {
  rejectStaleEstimate,
  type GeoPoint,
  type TravelTimeProvider,
  type TravelTimeQuery,
  type TravelTimeResult,
  type TravelUnknownReason,
} from "../../domain/trips/contracts/TravelTimeProvider.js";
import { pointTravelEstimate } from "../travelEstimate.js";
import type { ProviderRefusal, ProviderRefusalReason } from "./providerRefusal.js";
import {
  corridorConfidence,
  corridorIsStale,
  type RouteCorridor,
  type RouteCorridorProvider,
  type RouteOption,
} from "./routeCorridorProvider.js";

/**
 * Every refusal shape, mapped onto the scalar port's vocabulary. EXHAUSTIVE by
 * construction: a new `ProviderRefusalReason` fails to compile here.
 *
 * The four that share `NO_ROUTED_PROVIDER` are the four that mean the same
 * thing to a TRAVELLER — nothing in this deployment can route — and four
 * different things to an OPERATOR, which is what `detail` and the refusal's own
 * `envVar` are for. They are NOT collapsed into `PROVIDER_UNAVAILABLE`, which
 * would report a configuration choice as an outage and send somebody to look
 * at a healthy vendor.
 */
export const CORRIDOR_REFUSAL_TO_TRAVEL_UNKNOWN: Record<
  ProviderRefusalReason,
  TravelUnknownReason
> = {
  /** Nothing was asked, because there was nothing to ask about. */
  REQUEST_INCOMPLETE: "NO_COORDINATES",
  /** Four ways for a deployment to have no routed provider. */
  CREDENTIAL_ABSENT: "NO_ROUTED_PROVIDER",
  CREDENTIAL_EMPTY: "NO_ROUTED_PROVIDER",
  PROVIDER_NOT_ENABLED: "NO_ROUTED_PROVIDER",
  PROVIDER_UNBOUND: "NO_ROUTED_PROVIDER",
  /** Called, and it did not work. `PROVIDER_REJECTED` (401/403/429) is here
   *  rather than under NO_ROUTED_PROVIDER because the provider ANSWERED: the
   *  request reached it and it declined, which is a fact about the call and not
   *  about this deployment's configuration. The distinction survives in
   *  `detail`, which names PROVIDER_REJECTED and its envVar. */
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_REJECTED: "PROVIDER_UNAVAILABLE",
  /** It answered with something unreadable. */
  PROVIDER_MALFORMED: "PROVIDER_MALFORMED",
  /** It answered about a moment that has passed. */
  ANSWER_STALE: "ESTIMATE_STALE",
};

/**
 * The refusal, rendered so that nothing is lost at this boundary.
 *
 * ALWAYS starts with the refusal's own reason token. A consumer that stores or
 * shows only `reason` still has five distinct answers; a consumer that reads
 * `detail` recovers all nine. The provider id and the env var NAME travel with
 * it — never a value; `providerRefusal.ts` holds that line and this does not
 * cross it.
 */
export function describeCorridorRefusal(r: ProviderRefusal): string {
  const where = r.envVar ? ` (${r.envVar})` : "";
  return `${r.reason}${where} — ${r.provider}: ${r.detail}`;
}

function unknownFrom(r: ProviderRefusal): TravelTimeResult {
  return {
    kind: "unknown",
    reason: CORRIDOR_REFUSAL_TO_TRAVEL_UNKNOWN[r.reason],
    detail: describeCorridorRefusal(r),
  };
}

/**
 * The FREE-FLOW bound for one route, or `null` when the route reported no
 * readable leg. See the header for why this is not `totalMinutes`.
 */
export function freeFlowBoundMinutes(route: RouteOption): number | null {
  if (route.legs.length === 0) return null;
  let total = 0;
  for (const leg of route.legs) {
    if (!Number.isFinite(leg.minutes) || leg.minutes < 0) return null;
    total += leg.minutes;
  }
  return total;
}

export interface CorridorTravelTimeOptions {
  /**
   * The clock, injected so a test proves staleness without waiting and so this
   * module takes ONE reading per answer. `corridorIsStale` takes a number for
   * the same reason: a function that reads the clock twice can compare two
   * different moments (src/test/splitClockGuard.test.ts).
   */
  now?: () => number;
  /**
   * Ask the corridor provider for alternatives. TRUE by default and it is not
   * a tuning knob: without alternatives every corridor comes back with one
   * route, which L68/L69 read as a measured FRAGILE CORRIDOR — a fabricated
   * risk signal about a corridor nobody looked at. A caller that turns this off
   * is asking for a cheaper request and giving up L68 with it.
   */
  wantAlternatives?: boolean;
}

/**
 * Reduce ONE corridor to the scalar port's answer.
 *
 * Exported separately from the provider so a consumer that already holds a
 * corridor — a cache, or `LayoverReturnCorridor` holding both directions —
 * gets the same reduction rather than a second, drifting copy of it.
 */
export function corridorToTravelTimeResult(
  c: RouteCorridor,
  nowMs: number,
  providerId: string,
): TravelTimeResult {
  // An "answer" with no routes is not a corridor with zero routes. L69 would
  // read zero routes as maximally fragile and `landsideLeg` would read a zero
  // duration as a journey that takes no time; both are claims about a corridor
  // nobody measured. The adapters refuse rather than produce this, so reaching
  // it means the answer is unreadable — which is what PROVIDER_MALFORMED says.
  if (!Array.isArray(c.routes) || c.routes.length === 0) {
    return {
      kind: "unknown",
      reason: "PROVIDER_MALFORMED",
      detail: `${providerId}: the corridor carried no routes. An empty corridor is not zero minutes and is not a fragile corridor; it is an unreadable answer.`,
    };
  }
  // L73. A traffic-aware corridor is a statement about a moment, and ten
  // minutes later it is a claim about the past. Asked once, against one clock
  // reading taken by the caller.
  if (corridorIsStale(c, nowMs)) {
    return {
      kind: "unknown",
      reason: "ESTIMATE_STALE",
      detail: `${providerId}: the corridor expired at ${c.expiresAt} and is no longer a statement about now.`,
    };
  }

  // Best-first, and the adapters sort ascending by total. Read rather than
  // re-sorted, so this cannot disagree with the corridor about which route is
  // the best one when the risk terms are read off the same object.
  const best = c.routes[0]!;
  const total = Number(best.totalMinutes);
  if (!Number.isFinite(total) || total <= 0) {
    return {
      kind: "unknown",
      reason: "PROVIDER_MALFORMED",
      detail: `${providerId}: the best route's total is ${String(best.totalMinutes)}, which is not a journey. A zero-minute landside leg reads as an ABSENCE downstream and would be indistinguishable from one nobody measured.`,
    };
  }

  const freeFlow = freeFlowBoundMinutes(best);
  // See "A ROUTE THAT REPORTS NO LEGS" in the header for why the total stands
  // in as the bound, and why that direction of error is the safe one.
  const bound = freeFlow ?? total;
  // "Never below the bound" is the contract's requirement, not a guess: per-leg
  // ceiling can push the free-flow sum a minute above the route's own total.
  const expected = Math.max(total, bound);

  return {
    kind: "estimate",
    estimate: pointTravelEstimate(
      bound,
      c.sourceClass,
      // The corridor's confidence folded with its measured signals — never
      // better than the weakest of them. `corridorConfidence` owns that rule.
      corridorConfidence(c),
      // A routed measurement for this pair of points at this instant. Level 0
      // is what `TRAVEL_TIME_SOURCE_IS_ROUTED["measured"]` is about.
      0,
      [...c.sourceRefs, "lib/providers/corridorTravelTimeAdapter.ts#corridorToTravelTimeResult"],
      c.observedAt,
      // Carried, not invented. A consumer applying `rejectStaleEstimate` with
      // the DEPARTURE instant as its `now` is asking "will this still be true
      // when they set off?", which for a five-minute corridor and a departure
      // hours away is correctly answered "no" — that is the honest answer, not
      // a defect: nobody can pre-compute a traffic-aware corridor for a moment
      // that far off and call it fresh.
      c.expiresAt,
    ),
    // NULL, not absent: a ROUTED provider answered FOR the departure instant it
    // was given, so there is no assumption riding over the bound. The port's
    // own words for this case.
    assumption: null,
    // The traffic-aware figure. See "THE BOUND STAYS THE BOUND".
    expectedMinutes: expected,
  };
}

/**
 * A `TravelTimeProvider` over a `RouteCorridorProvider`.
 *
 * `routed` is taken FROM THE WRAPPED PROVIDER and is never asserted here. An
 * adapter that hard-coded `routed: true` would let a stand-in be laundered into
 * a routed answer by being wrapped, and `landsideLeg`'s first guard — which
 * exists to refuse exactly that — would pass it through.
 */
export function corridorTravelTimeProvider(
  corridorProvider: RouteCorridorProvider,
  opts: CorridorTravelTimeOptions = {},
): TravelTimeProvider {
  const now = opts.now ?? (() => Date.now());
  const wantAlternatives = opts.wantAlternatives !== false;
  const id = `corridor:${corridorProvider.id}`;

  return {
    id,
    routed: corridorProvider.routed,
    async estimate(q: TravelTimeQuery): Promise<TravelTimeResult> {
      // ONE reading, threaded. Never a second `Date.now()` and never a no-arg
      // `new Date()` beside it.
      const nowMs = now();
      const from: GeoPoint | null = q.from;
      const to: GeoPoint | null = q.to;
      const result = await corridorProvider.corridor({
        from,
        to,
        departAt: q.departAt,
        mode: q.mode,
        wantAlternatives,
      });
      if (!result.ok) return unknownFrom(result);
      const reduced = corridorToTravelTimeResult(result.value, nowMs, id);
      // The port's own freshness pass, applied against the SAME reading rather
      // than a second one. Belt and braces with `corridorIsStale` above, and
      // deliberately so: the corridor's expiry and the estimate's are the same
      // instant, so the two checks can never disagree, and if a future adapter
      // sets them apart the stricter one wins.
      return rejectStaleEstimate(reduced, new Date(nowMs));
    },
  };
}
