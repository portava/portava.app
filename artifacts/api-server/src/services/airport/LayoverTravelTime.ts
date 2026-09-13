/**
 * The landside leg of a layover recommendation, asked of the travel-time PORT.
 *
 * WHY THIS FILE EXISTS (census-layover L293a). `LayoverRecommendationService`
 * used to answer "how long does it take to get there?" with
 * `estimateTravelTime(placeType)` — 15 minutes for a cafe, restaurant or shop,
 * 25 for anything else. Its own doc comment admitted the shape of the defect:
 * *"A per-category CONSTANT — 15 or 25 minutes — chosen without a coordinate."*
 * The `discovery_places` SELECT did not even read `lat`/`lng`. That number was
 * then doubled into a round trip by `assess` and turned into `"safe"`, which is
 * a sentence a traveller acts on by leaving an airport.
 *
 * THE SEAM ALREADY EXISTED AND WAS NOT WIRED.
 * `domain/trips/contracts/TravelTimeProvider.ts` is this repository's
 * travel-time port. It was built for the Trips surface with the whole argument
 * already written down — including the one that matters here: *"There is
 * deliberately no variant that means 'no travel time, treat as none': an absent
 * route rendered as zero minutes makes every schedule feasible, which is the
 * precise failure §7 exists to prevent."* Its only routed implementation is
 * `noRoutedProvider`, whose id is literally `"none-configured"` and whose every
 * answer is `{ kind: "unknown", reason: "NO_ROUTED_PROVIDER" }`.
 *
 * So the absence is now PRODUCED by asking, not asserted by a comment. The
 * layover surface asks the port for every landside candidate and gets `null`
 * back, with the port's own reason attached. The day a routed provider is
 * configured, the same call returns a figure and nothing else here changes.
 *
 * ── WHY A NON-ROUTED ESTIMATE IS STILL NOT AN ANSWER ────────────────────────
 * `straightLineTravelTimeProvider` exists and would happily return a number for
 * these coordinates. It is refused here, deliberately, and the refusal is the
 * same argument that module makes about itself: a straight line is a genuine
 * LOWER BOUND, which makes it evidence of INFEASIBILITY and nothing else — *"a
 * straight-line INFEASIBLE is a real verdict; a straight-line FEASIBLE is
 * not."* A recommendation card's `travelTimeMin` is not used as a bound; it is
 * shown to a traveller as "N min away" and doubled into a return trip. Feeding
 * a great-circle distance into that is `estimateTravelTime` again with a
 * prettier derivation. `TRAVEL_TIME_SOURCE_IS_ROUTED` is the table that decides
 * which providers may speak here, so the rule is asked rather than re-spelled.
 */
import {
  estimateTravel,
  noRoutedProvider,
  type GeoPoint,
  type TravelTimeProvider,
  type TravelUnknownReason,
} from "../../domain/trips/contracts/TravelTimeProvider.js";
import {
  TRAVEL_TIME_SOURCE_IS_ROUTED,
  type TravelTimeSource,
} from "./LayoverSafetyEngine.js";

/**
 * A candidate's one-way landside journey, as either a figure or an absence.
 * There is no third shape and no default: `minutes === null` is the answer
 * every consumer on this tree gets, and `reason` says which of the port's
 * distinct unknowns produced it.
 */
export interface LandsideLeg {
  minutes: number | null;
  source: TravelTimeSource;
  /** The port's reason when there is no figure; null when there is one. */
  reason: TravelUnknownReason | null;
}

/** The one answer this deployment can give. Named so tests can assert on it. */
export const UNMEASURED_LEG: LandsideLeg = {
  minutes: null,
  source: "unmeasured",
  reason: "NO_ROUTED_PROVIDER",
};

/**
 * The provider the layover surface asks.
 *
 * A module constant, NOT an environment lookup, on purpose: wiring a real
 * provider must be a code change that lands on the line below, because it also
 * obliges its author to add a provenance column to `layover_recommendations`
 * before a "measured" figure may be persisted (see `persistedTravelTimeSource`
 * for why the read path cannot infer one). An env switch would let a routed
 * provider appear in production with the read path still inferring
 * "category_default" for every row it wrote.
 */
export const LAYOVER_TRAVEL_TIME_PROVIDER: TravelTimeProvider = noRoutedProvider;

/**
 * An airport's coordinates, or `null` when it has none worth using.
 *
 * (0, 0) is the Gulf of Guinea and it is also what `buildFallbackProfile`
 * produces for every airport that is not in `airport_profiles` — measured in
 * production, that is 0 rows verified and the fallback is what real sessions
 * run on (census §4 note 2, and L123, which was the same null-island reading on
 * the map surface). Treating it as a location would make the port answer
 * about a point in the ocean instead of saying it has no coordinates.
 */
export function airportPoint(a: { lat?: number | null; lng?: number | null }): GeoPoint | null {
  const lat = Number(a?.lat);
  const lng = Number(a?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** The same rule for a discovery place. `lat`/`lng` are nullable columns. */
export const placePoint = airportPoint;

/**
 * Ask the port for one landside leg.
 *
 * Fails closed in every direction: no coordinates, no routed provider, a
 * provider that throws, a stale estimate, an answer this code cannot read —
 * each is a DISTINCT reason (the port keeps them apart on purpose) and each
 * produces the same absence rather than a number.
 */
export async function landsideLeg(
  from: GeoPoint | null,
  to: GeoPoint | null,
  departAt: Date,
  provider: TravelTimeProvider = LAYOVER_TRAVEL_TIME_PROVIDER,
): Promise<LandsideLeg> {
  // A provider that does not compute a route cannot produce a card's travel
  // time — see the header. Asked first, so a mis-wired adapter is refused
  // before its number exists rather than after.
  if (!provider.routed) {
    return { minutes: null, source: "unmeasured", reason: "NO_ROUTED_PROVIDER" };
  }
  const r = await estimateTravel(provider, { from, to, departAt }, departAt);
  if (r.kind !== "estimate") {
    return { minutes: null, source: "unmeasured", reason: r.reason };
  }
  const minutes = Number(r.estimate.minutes);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return { minutes: null, source: "unmeasured", reason: "PROVIDER_MALFORMED" };
  }
  // A routed provider answered. `TRAVEL_TIME_SOURCE_IS_ROUTED` is asked rather
  // than the string compared, for the reason that table documents.
  const source: TravelTimeSource = "measured";
  /* c8 ignore next 3 -- unreachable while LAYOVER_TRAVEL_TIME_PROVIDER is noRoutedProvider */
  if (!TRAVEL_TIME_SOURCE_IS_ROUTED[source]) {
    return { minutes: null, source: "unmeasured", reason: "PROVIDER_MALFORMED" };
  }
  return { minutes: Math.ceil(minutes), source, reason: null };
}
