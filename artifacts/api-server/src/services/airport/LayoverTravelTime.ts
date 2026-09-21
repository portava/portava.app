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
 * THE COLUMN HALF OF THAT OBLIGATION IS NOW DISCHARGED — the provider half is
 * not, and the line above is unchanged and still `noRoutedProvider`.
 *
 * Migration 2745 adds `layover_recommendations.travel_time_source`, nullable,
 * defaultless and un-backfilled, and `persistedTravelTimeSource` now READS it
 * instead of inferring `category_default` from the sign of an integer. So the
 * hazard the header above describes — "a routed provider appear[ing] in
 * production with the read path still inferring 'category_default' for every
 * row it wrote" — no longer exists on the READ side. What remains is that no
 * routed provider exists to wire, and no straight-line stand-in will do: a
 * lower bound is evidence of INFEASIBILITY only, for the reason stated above.
 */
export type { TravelTimeProvider };

/**
 * Which provenances a `layover_recommendations` row can recover from its OWN
 * columns, and which have to be written down.
 *
 * `inside_airport` and `unmeasured` are both readable from `inside_airport` +
 * `travel_time_min` alone (airside 0 is a fact by construction; a landside 0 is
 * the absence the NOT NULL DEFAULT 0 column forces an absence to be stored as).
 * Everything else is a CLAIM the row cannot reconstruct, and a claim nobody
 * wrote down reads back as `unknown_provenance` — never as itself.
 */
const ROW_FACTS_RECOVER: Record<TravelTimeSource, boolean> = {
  inside_airport:      true,
  unmeasured:          true,
  category_default:    false,
  measured:            false,
  traveller_stated:    false,
  straight_line_bound: false,
  // Recording "we do not know" adds nothing a NULL does not already say.
  unknown_provenance:  true,
};

/**
 * The provenance columns to merge into a `layover_recommendations` write — and
 * `{}` for everything the row already expresses.
 *
 * WHY IT IS CONDITIONAL AND NOT ALWAYS WRITTEN. supabase-js sends every key in
 * the payload, so a column the database has not got fails the whole insert —
 * the hazard 2410's header documents. On this tree every landside leg is
 * `unmeasured` and every airside one is `inside_airport`, so this returns `{}`
 * for every row written today and no write can break on a database that lags
 * 2745. The day a routed provider is assigned to the constant above, the key
 * appears and the figure's provenance travels with it onto the row.
 */
export function travelTimeProvenanceColumn(
  source: TravelTimeSource,
): { travel_time_source?: TravelTimeSource } {
  return ROW_FACTS_RECOVER[source] ? {} : { travel_time_source: source };
}

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
