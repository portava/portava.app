/**
 * The ROUTE-SHAPE port — census-layover L60, L62, L68, L69, L70, L71, L72, L73.
 *
 * ── WHY A SECOND PORT, WHEN TravelTimeProvider ALREADY EXISTS ────────────────
 * `domain/trips/contracts/TravelTimeProvider.ts` answers ONE QUESTION: how many
 * minutes, one way, one departure. That is the whole of §7's travel term and it
 * is the right shape for it. Every requirement in this file's title asks a
 * question that a single duration cannot answer, and no amount of wrapping a
 * scalar produces them:
 *
 *   L60  reachability in BOTH directions, with the return evaluated under the
 *        conditions at the RETURN time. `LayoverSafetyEngine.ts:97` models the
 *        return as `travelTimeMin * 2` — explicitly symmetric and explicitly
 *        time-independent, which is two separate wrong assumptions.
 *   L72  "Return traffic forecast → use future-time estimate, not outbound
 *        time". Directly contradicted by that same `* 2`.
 *   L68  "Multiple independent return routes → increase robustness". Needs a
 *        COUNT of routes and a notion of independence between them.
 *   L69  "Single fragile corridor → increase risk penalty". The complement.
 *   L70  "Non-interruptible transport/activity → increase risk penalty". Needs
 *        per-leg interruptibility. A scalar has no legs.
 *   L71  "Transfer count → increase plan complexity/uncertainty". Likewise.
 *   L73  "Offline risk → require cached route + deadline before departure".
 *        Needs the answer to be a serialisable VALUE with its own expiry, not a
 *        number recomputed per call.
 *   L62  five named signals, of which route alternatives is one.
 *
 * So the shape is the deliverable. A duration is recoverable from it
 * (`totalMinutes`); none of the above is recoverable from a duration.
 *
 * ── WHAT THIS FILE REFUSES TO INVENT ─────────────────────────────────────────
 * L62 names five signals: transport reliability, route alternatives, queue
 * friction, weather, and airport re-entry cost. A routing provider measures
 * exactly ONE of them (alternatives) and supports a second (reliability, from
 * the spread between alternatives and the provider's own transit confidence).
 * The other three have no feed anywhere in this tree.
 *
 * They are therefore represented as NAMED ABSENCES — `UnmeasuredSignal`, each
 * carrying the exact capability whose absence blocks it — and not as zero, not
 * as a default constant, and not as an optional field left undefined. A
 * consumer folding these terms can see that three of five are unmeasured and
 * degrade its confidence accordingly; it cannot mistake "no queue friction
 * measured" for "the queue is fine", which is the whole failure mode. `0` is
 * the most dangerous value on this page, because `traffic_extra_min` already
 * proved it: a single admin-set integer defaulting to 20 has stood in for all
 * five signals since migration 0127.
 *
 * ── THE CORRIDOR IS THE UNIT, NOT THE ROUTE ──────────────────────────────────
 * §8's question is not "how long is the best route" but "how badly can this go
 * wrong on the way back". That is a property of the SET of routes between two
 * points, so the unit here is a corridor: the best route, its alternatives, and
 * how independent they are of each other. A corridor with one route is fragile
 * however fast that route is (L69); a corridor with three routes that all funnel
 * through the same interchange is ALSO one route wearing three hats, which is
 * why `independentRouteCount` is computed from shared interior transfer points
 * rather than taken as `routes.length`.
 *
 * ── EVERY ANSWER CARRIES ITS OWN EXPIRY (L73) ────────────────────────────────
 * A traffic-aware corridor is a statement about a moment. Ten minutes later it
 * is a claim about the past. So `observedAt` and `expiresAt` are required, not
 * optional, and `corridorIsStale` is the one place that decides. A cached
 * corridor whose expiry has passed is refused as `ANSWER_STALE` — it is not
 * silently served, and it is not silently discarded either, because L73's whole
 * point is that a traveller who has gone offline is better served by a route
 * they can see is old than by no route at all. The refusal names the staleness
 * so the consumer can make that choice; this file does not make it for them.
 */
import {
  haversineMeters,
  type GeoPoint,
  type TravelMode,
} from "../../domain/trips/contracts/TravelTimeProvider.js";
import {
  worstTravelConfidence,
  type TravelConfidence,
  type TravelSourceClass,
} from "../travelEstimate.js";
import { refuse, type ProviderRefusal, type ProviderResult } from "./providerRefusal.js";

export type { GeoPoint, TravelMode };

/**
 * A signal §8 asks for that nothing in this deployment can measure.
 *
 * The `blockedBy` string is the point of the type. `layoverObservability.ts`
 * uses the same device for its UNPRODUCIBLE metrics, for the same reason: a
 * blocked thing that does not name what blocks it becomes indistinguishable
 * from a thing nobody got round to, and then from a thing that is fine.
 */
export interface UnmeasuredSignal {
  measured: false;
  /** The exact capability whose absence blocks this signal. Never a vague "n/a". */
  blockedBy: string;
}

export interface MeasuredSignal<T> {
  measured: true;
  value: T;
  sourceClass: TravelSourceClass;
  confidence: TravelConfidence;
  sourceRefs: string[];
}

export type Signal<T> = MeasuredSignal<T> | UnmeasuredSignal;

export function unmeasured(blockedBy: string): UnmeasuredSignal {
  return { measured: false, blockedBy };
}

export function measured<T>(
  value: T,
  sourceClass: TravelSourceClass,
  confidence: TravelConfidence,
  sourceRefs: string[],
): MeasuredSignal<T> {
  return { measured: true, value, sourceClass, confidence, sourceRefs };
}

/**
 * Whether a traveller can abandon a leg part-way and turn back — L70.
 *
 *   interruptible      walking, or driving oneself: stop, turn round, return.
 *   committed          aboard a vehicle that will not stop where you want it
 *                      to. A 40-minute express with no intermediate stop is 40
 *                      minutes during which the return deadline cannot be acted
 *                      on, whatever the clock says.
 *   unknown            the provider did not say, and this code will not guess.
 *
 * `unknown` is NOT folded to either side. L70 asks for a risk PENALTY on
 * non-interruptible transport; defaulting the unknown to `interruptible` would
 * silently withhold that penalty on every leg a provider is vague about, and
 * defaulting it to `committed` would penalise a walk. It stays unknown and the
 * consumer degrades confidence, which is the only honest third answer.
 */
export const LEG_INTERRUPTIBILITIES = ["interruptible", "committed", "unknown"] as const;
export type LegInterruptibility = (typeof LEG_INTERRUPTIBILITIES)[number];

/**
 * Interruptibility that follows from the MODE alone, where the mode settles it.
 *
 * Walking and driving are interruptible by construction — the traveller is the
 * vehicle's controller. Transit is NOT: `unknown` rather than `committed`,
 * because a tram with a stop every 400 m is interruptible and an airport
 * express is not, and the difference is a property of the service, not of the
 * word "transit". Only a provider that describes the leg can settle it.
 */
export function interruptibilityFromMode(mode: TravelMode): LegInterruptibility {
  switch (mode) {
    case "walk":
    case "drive":
      return "interruptible";
    case "transit":
    case "unknown":
    default:
      return "unknown";
  }
}

export interface RouteLeg {
  mode: TravelMode;
  minutes: number;
  distanceMeters: number | null;
  interruptibility: LegInterruptibility;
  /**
   * An opaque, non-positional identifier for where this leg ENDS, when the leg
   * ends somewhere a route could share with another route — a station, an
   * interchange. `null` for a leg that ends at the destination or at no named
   * place.
   *
   * THIS IS NOT A COORDINATE AND MUST NOT BECOME ONE. Independence between
   * routes is a question about whether they share a failure point, which a
   * stable identifier answers. A lat/lng would answer it too and would also be
   * a position, on a code path that runs for a traveller whose location
   * permission this product has deliberately never requested (L164).
   */
  transferPointId: string | null;
}

/** One route through the corridor. */
export interface RouteOption {
  legs: RouteLeg[];
  totalMinutes: number;
  /**
   * L71. Changes of vehicle, which is `legs.length - 1` only when every leg is
   * a vehicle; a walk to a station and the train are one transfer, a walk that
   * IS the whole route is none. Computed by `transferCountOf`, never by the
   * caller, so two call sites cannot disagree about what a transfer is.
   */
  transferCount: number;
}

/** L71 — changes of conveyance, not leg boundaries. */
export function transferCountOf(legs: readonly RouteLeg[]): number {
  // A leg the traveller walks is not a conveyance they transfer between; the
  // transfer is between the vehicles on either side of it. So count boundaries
  // between NON-WALK legs, which is the number of times a traveller must be
  // somewhere specific at a specific moment or the plan breaks.
  const rides = legs.filter((l) => l.mode !== "walk");
  return Math.max(0, rides.length - 1);
}

/**
 * L70 for a whole route: the weakest link.
 *
 * Any committed leg makes the route committed — a route is only as
 * interruptible as its least interruptible segment, because that segment is
 * where the traveller is stuck when the deadline moves. An unknown leg with no
 * committed leg makes the route unknown. Only an all-interruptible route is
 * interruptible.
 */
export function routeInterruptibility(legs: readonly RouteLeg[]): LegInterruptibility {
  if (legs.length === 0) return "unknown";
  if (legs.some((l) => l.interruptibility === "committed")) return "committed";
  if (legs.some((l) => l.interruptibility === "unknown")) return "unknown";
  return "interruptible";
}

/**
 * A corridor between two points, in ONE direction, at ONE departure instant.
 *
 * "At one departure instant" is load-bearing and is the whole of L72: a
 * corridor computed for 14:00 is not a corridor for 19:00, and the outbound
 * corridor is not the return corridor reversed.
 */
export interface RouteCorridor {
  from: GeoPoint;
  to: GeoPoint;
  /** The instant this corridor was computed FOR — not the instant it was computed AT. */
  departAt: string;
  /** Best-first. At least one when the corridor is an answer at all. */
  routes: RouteOption[];
  /**
   * L68 — how many of `routes` fail independently.
   *
   * Two routes that share an interior transfer point share its failure, so they
   * are one route for robustness purposes. Computed by
   * `independentRouteCount`, never taken as `routes.length`.
   */
  independentRouteCount: number;
  /** L62 — the four signals a router does not measure, each naming its blocker. */
  reliability: Signal<RouteReliability>;
  queueFriction: Signal<number>;
  weather: Signal<string>;
  airportReentryMinutes: Signal<number>;
  /** When the underlying measurement was made. */
  observedAt: string;
  /** When it stops being a statement about now. Required — see the header, L73. */
  expiresAt: string;
  sourceClass: TravelSourceClass;
  confidence: TravelConfidence;
  sourceRefs: string[];
}

/**
 * L62's "transport reliability", in the only terms a routing provider can
 * actually support.
 *
 * `spreadMinutes` is the gap between the fastest and slowest ALTERNATIVE the
 * provider returned for the same query. It is a real measurement of how much
 * the corridor's answer depends on which way you go — not a variance over
 * observations, which this tree has none of. Named `spreadMinutes` rather than
 * anything percentile-shaped precisely so it is not mistaken for a
 * distribution; `travelEstimate.ts` makes the same point about its degenerate
 * p50/p75/p90 at length.
 */
export interface RouteReliability {
  spreadMinutes: number;
  /** Routes offered, before the independence reduction. */
  optionCount: number;
}

/**
 * L60 + L72 — reachability in both directions, each under its own conditions.
 *
 * The two corridors are computed for two DIFFERENT instants and are not
 * required to be each other's mirror. `returnCorridor.departAt` is the moment
 * the traveller would set off back, which is the correction L72 asks for.
 */
export interface BidirectionalCorridor {
  outbound: RouteCorridor;
  returnLeg: RouteCorridor;
}

export type CorridorResult = ProviderResult<RouteCorridor>;
export type BidirectionalResult = ProviderResult<BidirectionalCorridor>;

export interface CorridorQuery {
  from: GeoPoint | null;
  to: GeoPoint | null;
  /** The instant the traveller would set off. Required — a corridor is about a moment. */
  departAt: Date;
  mode?: TravelMode;
  /** How many alternatives to ask for. Bounded by the adapter. */
  wantAlternatives?: boolean;
}

export interface BidirectionalQuery {
  airport: GeoPoint | null;
  candidate: GeoPoint | null;
  /** When the traveller leaves the airport. */
  outboundDepartAt: Date;
  /**
   * When the traveller sets off BACK. L72's whole content: this is not
   * `outboundDepartAt + outboundMinutes`, it is the moment they must leave the
   * candidate to make their deadline, and it is an input, not a derivation.
   */
  returnDepartAt: Date;
  mode?: TravelMode;
}

export interface RouteCorridorProvider {
  readonly id: string;
  /** True only if this provider computes actual routes. Never set on a stand-in. */
  readonly routed: boolean;
  corridor(q: CorridorQuery): Promise<CorridorResult>;
  /**
   * Both directions, each at its own instant.
   *
   * A DEFAULT IMPLEMENTATION IS DELIBERATELY NOT PROVIDED on the interface. The
   * obvious one — call `corridor` twice — is correct, and `bothDirections`
   * below is exactly that; making it a default method would let an adapter
   * inherit it silently while a cheaper, wrong one (reverse the outbound) sat
   * one edit away. It is a free function so that every adapter's binding of it
   * is visible in the adapter.
   */
  bidirectional(q: BidirectionalQuery): Promise<BidirectionalResult>;
}

/**
 * L68 — routes that share an interior transfer point are not independent.
 *
 * Greedy and deliberately conservative: a route counts as independent only if
 * it shares NO interior transfer point with any route already counted. A route
 * with no transfer points at all (a single walk or drive) is always independent
 * — it has no shared failure point by construction.
 *
 * Conservative in the direction that matters: under-counting independence
 * increases the fragility a consumer sees (L69), and over-counting it would
 * tell a traveller they have a fallback they do not have.
 */
export function independentRouteCount(routes: readonly RouteOption[]): number {
  const claimed = new Set<string>();
  let independent = 0;
  for (const r of routes) {
    const points = r.legs
      .map((l) => l.transferPointId)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    if (points.length === 0) {
      independent += 1;
      continue;
    }
    if (points.some((p) => claimed.has(p))) continue;
    independent += 1;
    for (const p of points) claimed.add(p);
  }
  return independent;
}

/** L73 — has this corridor stopped being a statement about now? */
export function corridorIsStale(c: RouteCorridor, nowMs: number): boolean {
  const expiry = Date.parse(c.expiresAt);
  // An unparseable expiry is STALE, not fresh. A corridor whose own freshness
  // cannot be read is not evidence that it is fresh.
  if (!Number.isFinite(expiry)) return true;
  return expiry <= nowMs;
}

/**
 * L73 — a corridor a traveller can carry offline.
 *
 * The key is route-shaped because a corridor depends on BOTH endpoints, the
 * mode and the departure moment; every cache in this tree is keyed by place,
 * query or city and none of them fit. Coordinates round to ~11 m and the
 * departure to a five-minute bucket: finer and the key never hits, coarser and
 * the answer stops being about the departure asked for. The same reasoning and
 * the same constants as `GoogleRoutesTravelTimeProvider.cacheKeyFor`, stated
 * here because this key has a different shape and must not drift into being
 * "the other one, probably".
 */
export const CORRIDOR_BUCKET_MS = 5 * 60 * 1000;

export function corridorCacheKey(q: CorridorQuery): string | null {
  if (!q.from || !q.to) return null;
  const coords = [q.from.lat, q.from.lng, q.to.lat, q.to.lng];
  if (!coords.every(Number.isFinite)) return null;
  const r = (n: number) => n.toFixed(4);
  const bucket = Math.floor(q.departAt.getTime() / CORRIDOR_BUCKET_MS);
  return [
    "corridor",
    r(q.from.lat), r(q.from.lng),
    r(q.to.lat), r(q.to.lng),
    q.mode ?? "unknown",
    String(bucket),
  ].join(":");
}

/**
 * The two directions, each asked for at its own instant.
 *
 * A refusal in EITHER direction refuses the pair. A half-answered
 * bidirectional corridor is the shape L60 exists to forbid: the outbound is the
 * cheap direction to get right and the return is the one a traveller's flight
 * depends on, so "we know the way there" must never be served as "the round
 * trip works".
 */
export async function bothDirections(
  provider: Pick<RouteCorridorProvider, "id" | "corridor">,
  q: BidirectionalQuery,
): Promise<BidirectionalResult> {
  if (!q.airport || !q.candidate) {
    return refuse(
      provider.id,
      "REQUEST_INCOMPLETE",
      "bidirectional reachability needs coordinates for both the airport and the candidate",
    );
  }
  const outbound = await provider.corridor({
    from: q.airport,
    to: q.candidate,
    departAt: q.outboundDepartAt,
    mode: q.mode,
    wantAlternatives: true,
  });
  if (!outbound.ok) return outbound;

  // NOT the outbound reversed, and NOT the outbound doubled. A separate query,
  // for the return instant, in the return direction. This line is L60 and L72.
  const returnLeg = await provider.corridor({
    from: q.candidate,
    to: q.airport,
    departAt: q.returnDepartAt,
    mode: q.mode,
    wantAlternatives: true,
  });
  if (!returnLeg.ok) return returnLeg;

  return { ok: true, value: { outbound: outbound.value, returnLeg: returnLeg.value } };
}

/**
 * Weakest confidence over a corridor's own confidence and its measured signals.
 *
 * A fold can only LOSE confidence, which is `worstTravelConfidence`'s contract
 * and the reason this does not average. An unmeasured signal does not lower the
 * confidence of what WAS measured — it is absent, not uncertain — so it is
 * skipped here and reported separately by `unmeasuredSignals`.
 */
export function corridorConfidence(c: RouteCorridor): TravelConfidence {
  let worst = c.confidence;
  for (const s of [c.reliability, c.queueFriction, c.weather, c.airportReentryMinutes]) {
    if (s.measured) worst = worstTravelConfidence(worst, s.confidence);
  }
  return worst;
}

/** Which of L62's five signals this corridor could not measure, and what blocks each. */
export function unmeasuredSignals(c: RouteCorridor): Array<{ signal: string; blockedBy: string }> {
  const out: Array<{ signal: string; blockedBy: string }> = [];
  const pairs: Array<[string, Signal<unknown>]> = [
    ["reliability", c.reliability],
    ["queueFriction", c.queueFriction],
    ["weather", c.weather],
    ["airportReentryMinutes", c.airportReentryMinutes],
  ];
  for (const [name, s] of pairs) if (!s.measured) out.push({ signal: name, blockedBy: s.blockedBy });
  return out;
}

/**
 * The provider every deployment has today.
 *
 * It answers NOTHING. Not a straight-line stand-in, not a constant, not an
 * empty corridor — a named refusal, every time. `services/airport/
 * LayoverTravelTime.ts` makes the same choice for the scalar port and states
 * why: a great-circle lower bound is evidence of INFEASIBILITY only, and a
 * corridor built from one would carry `routes.length === 1`, which L69 reads as
 * a fragile corridor — a fabricated risk signal about a corridor nobody looked
 * at. Refusing is the only answer that cannot be mistaken for a measurement.
 */
export const NO_ROUTE_CORRIDOR_PROVIDER: RouteCorridorProvider = {
  id: "no-route-corridor-provider",
  routed: false,
  async corridor(): Promise<CorridorResult> {
    return refuse(
      "no-route-corridor-provider",
      "PROVIDER_UNBOUND",
      "no routed corridor provider is bound in this deployment. There is deliberately no " +
        "straight-line fallback: a corridor synthesised from a great circle would carry one " +
        "route and no transfer points, which L68/L69 read as a measured fragile corridor.",
    );
  },
  async bidirectional(): Promise<BidirectionalResult> {
    return refuse(
      "no-route-corridor-provider",
      "PROVIDER_UNBOUND",
      "no routed corridor provider is bound in this deployment",
    );
  },
};

/**
 * A guard for adapters: the cheap rejections every one of them shares, in one
 * place, so that an adapter cannot forget one and send a request with a NaN in
 * it. Returns a refusal or null.
 */
export function corridorQueryRefusal(providerId: string, q: CorridorQuery): ProviderRefusal | null {
  if (!q.from || !q.to) {
    return refuse(providerId, "REQUEST_INCOMPLETE", "both endpoints need coordinates");
  }
  if (![q.from.lat, q.from.lng, q.to.lat, q.to.lng].every(Number.isFinite)) {
    return refuse(providerId, "REQUEST_INCOMPLETE", "a coordinate is not a finite number");
  }
  if (!Number.isFinite(q.departAt.getTime())) {
    return refuse(providerId, "REQUEST_INCOMPLETE", "departAt is not a valid instant");
  }
  return null;
}

/** Metres between the endpoints of a query, or null when it has none. */
export function corridorSpanMeters(q: CorridorQuery): number | null {
  if (!q.from || !q.to) return null;
  return haversineMeters(q.from, q.to);
}
