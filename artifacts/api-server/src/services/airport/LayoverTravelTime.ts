/**
 * The landside leg of a layover recommendation, asked of the travel-time PORT.
 *
 * WHY THIS FILE EXISTS (census-layover L293a). `LayoverRecommendationService`
 * answered "how long does it take to get there?" with a per-category CONSTANT
 * — 15 minutes for a cafe, restaurant or shop, 25 for anything else — chosen
 * without a coordinate, on a `discovery_places` SELECT that did not even read
 * `lat`/`lng`. `assess` doubled that number into a round trip and turned it
 * into `"safe"`, a sentence a traveller acts on by leaving an airport.
 *
 * THE SEAM IS NOW FILLED, AND STILL ANSWERS NOTHING HERE. The port at
 * `domain/trips/contracts/TravelTimeProvider.ts` carries the argument that
 * matters most: *"There is deliberately no variant that means 'no travel time,
 * treat as none': an absent route rendered as zero minutes makes every schedule
 * feasible, which is the precise failure §7 exists to prevent."*
 *
 * ── WHY A NON-ROUTED ESTIMATE IS STILL NOT AN ANSWER ────────────────────────
 * `straightLineTravelTimeProvider` would return a number for these coordinates
 * and is refused here on its own argument: a straight line is a genuine LOWER
 * BOUND, so it is evidence of INFEASIBILITY and nothing else — *"a
 * straight-line INFEASIBLE is a real verdict; a straight-line FEASIBLE is
 * not."* `TRAVEL_TIME_SOURCE_IS_ROUTED` decides which providers may speak.
 */
import {
  estimateTravel,
  type GeoPoint,
  type TravelTimeProvider,
  type TravelUnknownReason,
} from "../../domain/trips/contracts/TravelTimeProvider.js";
import { corridorTravelTimeProvider } from "../../lib/providers/corridorTravelTimeAdapter.js";
import { googleRoutesCorridorProvider } from "../../lib/providers/googleRoutesCorridorProvider.js";
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
  /**
   * The refusal BENEATH the reason, verbatim, or `null` when there is a figure.
   * The corridor port has NINE refusal shapes and this port has FIVE unknowns,
   * so four different ways to have no routed provider — unset credential, empty
   * credential, spend gate off, nothing bound — share one `reason`, and the
   * detail always names which. Operator-facing, and it carries a variable NAME,
   * never a credential value.
   */
  detail: string | null;
}

/** The one answer this deployment gives. Named so tests can assert on it. */
export const UNMEASURED_LEG: LandsideLeg = {
  minutes: null,
  source: "unmeasured",
  reason: "NO_ROUTED_PROVIDER",
  detail: null,
};

/**
 * The provider the layover surface asks — now a ROUTED one, and still silent.
 *
 * A module constant, NOT an environment lookup: wiring a provider is a code
 * change that lands on the line below. The obligation that made it so is
 * discharged — 2745 added `layover_recommendations.travel_time_source` and
 * `persistedTravelTimeSource` READS it rather than inferring `category_default`
 * from the sign of an integer — so a routed figure's provenance reaches the row.
 *
 * WIRING IS NOT ENABLING. The corridor provider beneath this adapter refuses
 * unless BOTH `LAYOVER_ROUTED_CORRIDOR_ENABLED` is affirmative AND
 * `GOOGLE_MAPS_API_KEY` is present — checked in that order, BEFORE any request
 * is built. Neither holds anywhere, so every answer here is the same named
 * absence it was. Enabling spends per request with no spend ceiling anywhere in
 * this repository: an owner's purchase decision, never a deployment step.
 */
export const LAYOVER_TRAVEL_TIME_PROVIDER: TravelTimeProvider = corridorTravelTimeProvider(googleRoutesCorridorProvider);

/**
 * WHAT CHANGED ON THE LINE ABOVE, AND WHAT DID NOT.
 *
 * It used to read `= noRoutedProvider`, and the paragraph here used to say the
 * obstacle was that "no routed provider exists to wire". That is no longer
 * true: `lib/providers/googleRoutesCorridorProvider.ts` is a real Google Routes
 * v2 adapter for the ROUTE-SHAPE port. But it was never one assignment away,
 * because `RouteCorridorProvider` is NOT a `TravelTimeProvider` — one answers a
 * set of routes with legs, transfers, independence and an expiry, the other a
 * single scalar duration. `corridorTravelTimeAdapter.ts` is the reduction
 * between them, and its header argues the one decision that cost something: the
 * traffic-aware total goes in `expectedMinutes`, NOT in `estimate.minutes`,
 * because `minutes` is the free-flow LOWER BOUND every feasibility proof rests
 * on and a prediction is not a bound.
 *
 * NOTHING A TRAVELLER SEES MOVES. Both of the corridor provider's gates refuse
 * on every deployment, before any request is built, and the enablement gate is
 * asked FIRST — so every landside leg is still `{ minutes: null, source:
 * "unmeasured", reason: "NO_ROUTED_PROVIDER" }`, byte for byte what
 * `noRoutedProvider` produced. What changed is that the absence is now produced
 * by a routed provider declining to spend, and `detail` says which gate.
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
 * produces the same absence rather than a number, with the provider's own
 * words carried in `detail` so the four configuration refusals that share
 * `NO_ROUTED_PROVIDER` stay tellable apart.
 *
 * ── WHY THE EXPECTED FIGURE AND NOT THE BOUND (the card's half of the L60
 *    decision the adapter's header argues from the other side) ───────────────
 * `estimate.minutes` is the FREE-FLOW LOWER BOUND. A card's `travelTimeMin` is
 * not used as a bound: it is shown to a traveller as "N min away", doubled into
 * a return trip by `assess`, and can come back as `"safe"` — a CERTIFICATION.
 * A lower bound may only ever REFUSE, which is the whole argument this file
 * makes against `straightLineTravelTimeProvider`; certifying off one would
 * reintroduce that defect with a routed derivation instead of a great-circle
 * one. So when the chain states an EXPECTED figure beside the bound, that is
 * the figure the card gets. A provider that states no expected figure is read
 * exactly as before — the change can only ever make the leg LONGER, never
 * shorter, and `Math.max` makes that true rather than assumed.
 *
 * `departAt` is passed as the freshness `now` on purpose: the question a card
 * needs answered is "will this estimate still hold when they set off", so an
 * answer that expires first is correctly refused as `ESTIMATE_STALE`.
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
    return {
      minutes: null, source: "unmeasured", reason: "NO_ROUTED_PROVIDER",
      detail: `${provider.id} does not compute routes`,
    };
  }
  const unscoped = layoverRoutesRefusal(); if (unscoped !== null) return { minutes: null, source: "unmeasured", reason: from && to ? "NO_ROUTED_PROVIDER" : "NO_COORDINATES", detail: ROUTES_UNSCOPED_NO_TRIP_DETAIL }; const r = await estimateTravel(provider, { from, to, departAt }, departAt);
  if (r.kind !== "estimate") {
    return { minutes: null, source: "unmeasured", reason: r.reason, detail: r.detail ?? null };
  }
  const bound = Number(r.estimate.minutes);
  // The expected figure when one was stated, and NEVER below the bound. An
  // absent or unreadable `expectedMinutes` falls back to the bound rather than
  // to a zero: `?? bound` and not `?? 0`, because 0 is the value that would
  // make every schedule feasible.
  const stated = Number(r.expectedMinutes);
  const minutes = Math.max(bound, Number.isFinite(stated) && stated > 0 ? stated : bound);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return {
      minutes: null, source: "unmeasured", reason: "PROVIDER_MALFORMED",
      detail: `${provider.id} answered with a non-finite or negative duration`,
    };
  }
  // A routed provider answered. `TRAVEL_TIME_SOURCE_IS_ROUTED` is asked rather
  // than the string compared, for the reason that table documents.
  const source: TravelTimeSource = "measured";
  /* c8 ignore next 6 -- unreachable unless the table is edited to demote "measured" */
  if (!TRAVEL_TIME_SOURCE_IS_ROUTED[source]) {
    return {
      minutes: null, source: "unmeasured", reason: "PROVIDER_MALFORMED",
      detail: "measured is no longer classified as routed",
    };
  }
  return { minutes: Math.ceil(minutes), source, reason: null, detail: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// FINDING F1 — THE ROUTES BUDGET SCOPE (census-trips §86.2, lead ruling D-7).
//
// Appended at the TAIL so no cited line above moves; ESM hoists the imports.
//
// `googleRoutesCorridorProvider` charges every call to a person AND a trip, read
// from the enclosing `withRoutesRequestBudget` scope, and refuses a call with no
// scope as `unscoped` (googleRoutesCorridorProvider.ts:306). Until this block,
// only routes/tripFeasibility.ts, routes/tripOffline.ts and the Trips
// projections opened one — so the day the owner enables Routes, EVERY layover
// leg and corridor call would still have been refused, before the spend gate,
// for want of anybody to charge.
//
// `withLayoverRoutesBudget(session, fn)` is that scope for a layover read:
//
//   a session WITH a trip   `withRoutesRequestBudget({ userId, tripId })`. The
//                           call is made and charged to that person and trip,
//                           under the read's hop cap and time budget. Nested
//                           inside another read's budget, it shares its counter.
//   a session WITH NO trip  a NAMED absence, `routes_unscoped_no_trip`, and the
//                           provider is never called — when Routes is LIVE here.
//                           Whether a trip-less layover may be charged per
//                           person only is the owner's ruling (R5(a)); until
//                           then nothing is spent on one.
//   Routes NOT live         (enablement or credential absent — every deployment
//                           today) `fn` runs exactly as it did before this block:
//                           the provider refuses on its own first gate, byte for
//                           byte the answer it gave, so the decision-diff golden
//                           and every leg's `detail` are unchanged.
//
// The named absence is honoured at the two layover choke points: `landsideLeg`
// (every leg — recommendations and Discovery's timing) and
// `layoverRoutesGuardedCorridor` (the §8 return corridor in
// `certifiedActionUniverse`).
// ═══════════════════════════════════════════════════════════════════════════
import { AsyncLocalStorage } from "node:async_hooks";
import { withRoutesRequestBudget } from "../../domain/trips/contracts/RoutesRequestBudget.js";
import { credentialRefusal, enablementRefusal, refuse } from "../../lib/providers/providerRefusal.js";
import { CREDENTIAL_ENV, ENABLEMENT_ENV } from "../../lib/providers/googleRoutesCorridorProvider.js";
import type { RouteCorridorProvider } from "../../lib/providers/routeCorridorProvider.js";

/** The named absence a trip-less layover gets while R5(a) is open. */
export const ROUTES_UNSCOPED_NO_TRIP = "routes_unscoped_no_trip" as const;

/** Operator-facing; names the ruling, never a credential. */
export const ROUTES_UNSCOPED_NO_TRIP_DETAIL =
  `${ROUTES_UNSCOPED_NO_TRIP}: this layover has no trip, and the owner's Routes caps charge a person AND a trip ` +
  `(lead ruling D-7). Whether a trip-less layover may be charged per person only is the owner's ruling (R5(a)), ` +
  `so nothing was asked of the routing provider.`;

/** Who a layover read's routed calls are charged to. A `LayoverSession` satisfies it. */
export interface LayoverRoutesSession {
  userId: string;
  tripId: string | null;
}

const layoverRoutesScope = new AsyncLocalStorage<{ refusal: typeof ROUTES_UNSCOPED_NO_TRIP | null }>();

/** Inside a trip-less layover read with Routes live: the named absence. Otherwise null. */
export function layoverRoutesRefusal(): typeof ROUTES_UNSCOPED_NO_TRIP | null {
  return layoverRoutesScope.getStore()?.refusal ?? null;
}

/**
 * Is the layover routing provider live in this deployment — BOTH of its own
 * gates open? Asked with the provider's own gate functions and variable names,
 * so this cannot disagree with the provider about what "enabled" means. With no
 * `readEnv` the gate functions read the environment themselves; this module
 * never does (layoverTravelTimeProvenanceColumn.test.ts holds that line).
 */
export function layoverRoutesLive(readEnv?: (name: string) => string | undefined): boolean {
  return enablementRefusal("layover-routes", ENABLEMENT_ENV, readEnv) === null
    && credentialRefusal("layover-routes", CREDENTIAL_ENV, readEnv) === null;
}

/**
 * Run one layover read's routed calls inside the Routes budget scope. See the
 * block header for the three cases. `readEnv` is injectable so a test proves the
 * live case without mutating `process.env`.
 */
export function withLayoverRoutesBudget<T>(
  session: LayoverRoutesSession,
  fn: () => Promise<T>,
  opts: { readEnv?: (name: string) => string | undefined } = {},
): Promise<T> {
  const tripId = session.tripId;
  if (tripId) {
    return layoverRoutesScope.run({ refusal: null }, () => withRoutesRequestBudget({ userId: session.userId, tripId }, fn));
  }
  if (!layoverRoutesLive(opts.readEnv)) return layoverRoutesScope.run({ refusal: null }, fn);
  return layoverRoutesScope.run({ refusal: ROUTES_UNSCOPED_NO_TRIP }, fn);
}

/**
 * The route-shape port, behind the same named absence. Inside a trip-less
 * layover read with Routes live it answers `PROVIDER_NOT_ENABLED` (the
 * corridor→travel-time adapter maps that to `NO_ROUTED_PROVIDER`, the same
 * reason `landsideLeg` gives) WITHOUT calling `inner`; everywhere else it is
 * `inner`, call for call.
 */
export function layoverRoutesGuardedCorridor(inner: RouteCorridorProvider): RouteCorridorProvider {
  const unscoped = () => refuse(inner.id, "PROVIDER_NOT_ENABLED", ROUTES_UNSCOPED_NO_TRIP_DETAIL);
  return {
    id: inner.id,
    routed: inner.routed,
    corridor: (q) => (layoverRoutesRefusal() !== null ? Promise.resolve(unscoped()) : inner.corridor(q)),
    bidirectional: (q) => (layoverRoutesRefusal() !== null ? Promise.resolve(unscoped()) : inner.bidirectional(q)),
  };
}
