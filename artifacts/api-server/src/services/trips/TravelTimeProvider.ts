/**
 * Trips §7 — the travel-time PORT, and the only two adapters this tree can
 * honestly supply.
 *
 * WHAT THE REPOSITORY ACTUALLY HAS (measured 2026-09-09, whole tree)
 * =================================================================
 * There is no routing provider anywhere. No OSRM, Valhalla, GraphHopper,
 * OpenRouteService, Google Directions, Mapbox Directions or isochrone client
 * exists in either tree. What exists is geocoding (`services/geocodingService`,
 * `lib/geocodeForward`), POI search (`lib/foursquarePlaces`), tile rendering
 * (`EXPO_PUBLIC_MAPTILER_KEY`, client-side), and three separate straight-line
 * duration models that all label themselves approximate:
 *
 *   services/routeOptimizer.ts        haversine / 1.25 m·s⁻¹ walk, 8.33 drive
 *                                     `isApproximated: true` on every leg
 *   compass/CompassAutopilotEngine.ts haversine / 4.5 km·h⁻¹, floor 10 min
 *   compass/CompassLiveConstraints.ts haversine / 5 km·h⁻¹
 *
 * `services/airport/LayoverSafetyEngine.ts` already names the seam: its
 * TRAVEL_TIME_SOURCES includes "measured", TRAVEL_TIME_SOURCE_IS_ROUTED
 * classifies it, and its own comment records that measured HAS NO PRODUCER on
 * this tree. This file is the Trips-side statement of the same fact.
 *
 * SO THE PORT HAS A THIRD ANSWER, AND IT IS NOT ZERO
 * ==================================================
 * `TravelTimeResult` is estimate | unknown. There is deliberately no variant
 * that means "no travel time, treat as none": an absent route rendered as zero
 * minutes makes every schedule feasible, which is the precise failure §7 exists
 * to prevent. A consumer that cannot get an estimate gets UNKNOWN and must
 * carry it; TripFeasibilityEngine turns UNKNOWN travel into an UNKNOWN verdict
 * and never into a FEASIBLE one.
 */
import {
  pointTravelEstimate,
  type TravelEstimate,
} from "../../lib/travelEstimate.js";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export const TRAVEL_MODES = ["walk", "drive", "transit", "unknown"] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

export interface TravelTimeQuery {
  from: GeoPoint | null;
  to: GeoPoint | null;
  /** When the traveller would set off. A routed provider needs it; the
   *  straight-line one ignores it, and says so rather than pretending. */
  departAt: Date;
  mode?: TravelMode;
}

/**
 * Why no estimate could be produced. Each is DISTINCT because they call for
 * different things: a missing coordinate is a data problem the product can fix,
 * a provider failure is an outage, and a stale value is a freshness policy
 * decision. Collapsing them into one "unavailable" would lose all of that.
 */
export const TRAVEL_UNKNOWN_REASONS = [
  /** One or both endpoints have no coordinates. */
  "NO_COORDINATES",
  /** No routed provider is configured in this deployment. */
  "NO_ROUTED_PROVIDER",
  /** The provider was called and failed, timed out, or returned nothing. */
  "PROVIDER_UNAVAILABLE",
  /** A value was found and is past its expiresAt. */
  "ESTIMATE_STALE",
  /** The provider answered with something this code cannot interpret. */
  "PROVIDER_MALFORMED",
] as const;
export type TravelUnknownReason = (typeof TRAVEL_UNKNOWN_REASONS)[number];

export type TravelTimeResult =
  | { kind: "estimate"; estimate: TravelEstimate }
  | { kind: "unknown"; reason: TravelUnknownReason; detail?: string };

export interface TravelTimeProvider {
  readonly id: string;
  /** True only if this provider computes an actual route. */
  readonly routed: boolean;
  estimate(q: TravelTimeQuery): Promise<TravelTimeResult>;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle metres. The same formula routeOptimizer and the two Compass
 *  engines each carry their own copy of. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The speeds are routeOptimizer.ts's, deliberately, so two straight-line
 * answers about the same pair of points do not differ by which module was
 * asked. If those change, this must change with them — pinned by
 * src/test/tripFeasibilityStraightLine.test.ts.
 */
export const WALK_METRES_PER_SECOND = 1.25;
export const DRIVE_METRES_PER_SECOND = 8.33;
export const DRIVE_WAIT_SECONDS = 180;
/** Above this, walking is not the answer — routeOptimizer's own threshold. */
export const WALK_MAX_METRES = 2000;

/**
 * The straight-line adapter. NOT a route, and it says so in every field it
 * returns: sourceClass STATIC_DEFAULT, confidence LOW, fallbackLevel 3, and
 * isRoutedSourceClass(STATIC_DEFAULT) is false.
 *
 * It exists because a straight line is a genuine LOWER BOUND on travel time —
 * no road is shorter than the great circle — and a lower bound is exactly what
 * an infeasibility proof needs. If the schedule fails even at this optimistic
 * number, no routed provider can rescue it. That is the ONLY claim it supports,
 * and TripFeasibilityEngine is built around that asymmetry: a straight-line
 * INFEASIBLE is a real verdict; a straight-line FEASIBLE is not, and comes back
 * as FEASIBLE_UNVERIFIED.
 *
 * THE MODE IS THE FASTEST ONE, NOT THE LIKELIEST ONE (corrected 2026-09-12)
 * =========================================================================
 * Until census-trips §40.3 this adapter chose WALK for any hop under
 * WALK_MAX_METRES and DRIVE above it — routeOptimizer's planning heuristic,
 * which answers "how would a person probably go", not "how fast could they
 * possibly get there". A 1.9 km hop came back as 26 minutes on foot when a
 * taxi covers it in 7, so for every hop under two kilometres the number was
 * NOT a lower bound and "a straight-line INFEASIBLE is a real verdict" was
 * false there. It was found by the §22.4 property test in
 * src/test/tripFreedomEngine.test.ts: inserting a commitment could make free
 * time GROW, because a 2001 m drive was "faster" than a 2000 m walk.
 *
 * When no mode is asked for, the bound is now the MINIMUM over the modes this
 * adapter knows — walking below ~250 m, driving above — which is monotone in
 * distance and subadditive (a detour is never faster than the direct line),
 * the two properties a lower bound needs. An explicitly requested mode is
 * honoured as before: a caller that says "walk" is stating a policy, and the
 * number is then that mode's time, not a bound over modes. WALK_MAX_METRES
 * stays exported for routeOptimizer parity and is no longer consulted here.
 */
export const straightLineTravelTimeProvider: TravelTimeProvider = {
  id: "straight-line",
  routed: false,
  async estimate(q: TravelTimeQuery): Promise<TravelTimeResult> {
    if (!q.from || !q.to) return { kind: "unknown", reason: "NO_COORDINATES" };
    if (![q.from.lat, q.from.lng, q.to.lat, q.to.lng].every(Number.isFinite)) {
      return { kind: "unknown", reason: "PROVIDER_MALFORMED", detail: "non-finite coordinate" };
    }
    const metres = haversineMeters(q.from, q.to);
    const walkSeconds = metres / WALK_METRES_PER_SECOND;
    const driveSeconds = metres / DRIVE_METRES_PER_SECOND + DRIVE_WAIT_SECONDS;
    const requested: TravelMode = q.mode && q.mode !== "unknown" ? q.mode : "unknown";
    // No mode asked for: the fastest of the modes this adapter knows. See the
    // header for why the old "walk under 2 km" rule was not a lower bound.
    const seconds = requested === "walk" ? walkSeconds
      : requested === "drive" || requested === "transit" ? driveSeconds
      : Math.min(walkSeconds, driveSeconds);
    return {
      kind: "estimate",
      estimate: pointTravelEstimate(
        Math.ceil(seconds / 60),
        "STATIC_DEFAULT",
        "LOW",
        3,
        ["services/trips/TravelTimeProvider.ts#straightLineTravelTimeProvider"],
      ),
    };
  },
};

/**
 * The routed provider this deployment does not have.
 *
 * It is a real object rather than a null so that the ABSENCE is a value the
 * type system carries: every consumer already handles `unknown`, so wiring a
 * real provider later changes one line and no branch. Returning null here would
 * have pushed an `if (!provider)` into every call site, and one of them would
 * eventually treat it as zero.
 */
export const noRoutedProvider: TravelTimeProvider = {
  id: "none-configured",
  routed: true,
  async estimate(): Promise<TravelTimeResult> {
    return { kind: "unknown", reason: "NO_ROUTED_PROVIDER" };
  },
};

/**
 * Reject an estimate that has expired. Freshness is a policy the CALLER owns —
 * §10.2's rule that stale must never be drawn as current is about presentation,
 * and this is where a feasibility consumer applies it.
 */
export function rejectStaleEstimate(r: TravelTimeResult, now: Date): TravelTimeResult {
  if (r.kind !== "estimate") return r;
  const exp = r.estimate.expiresAt;
  if (exp === null) return r;               // constants do not expire
  const t = Date.parse(exp);
  if (!Number.isFinite(t)) {
    return { kind: "unknown", reason: "PROVIDER_MALFORMED", detail: "unparseable expiresAt" };
  }
  return t <= now.getTime() ? { kind: "unknown", reason: "ESTIMATE_STALE" } : r;
}

/**
 * Call a provider without letting it throw into the caller. A provider that
 * rejects is PROVIDER_UNAVAILABLE, never an absent term — the try/catch exists
 * so a network failure cannot be silently read as "no travel needed".
 */
export async function estimateTravel(
  provider: TravelTimeProvider,
  q: TravelTimeQuery,
  now: Date = new Date(),
): Promise<TravelTimeResult> {
  let r: TravelTimeResult;
  try {
    r = await provider.estimate(q);
  } catch (err) {
    return {
      kind: "unknown",
      reason: "PROVIDER_UNAVAILABLE",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!r || (r.kind !== "estimate" && r.kind !== "unknown")) {
    return { kind: "unknown", reason: "PROVIDER_MALFORMED" };
  }
  return rejectStaleEstimate(r, now);
}
