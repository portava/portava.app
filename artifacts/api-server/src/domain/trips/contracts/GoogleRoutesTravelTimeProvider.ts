/**
 * Google Routes API v2 adapter for the §7 TravelTimeProvider port.
 *
 * PREPARED, NOT WIRED. Nothing imports this yet, and this file changes no
 * behaviour on any deployment. The four wiring seams stay exactly where they
 * are:
 *
 *   routes/tripFeasibility.ts:111                const PROVIDER = straightLineTravelTimeProvider;
 *   domain/trips/projections/TripFreedomProjection.ts:44     const BOUND_PROVIDER = straightLineTravelTimeProvider;
 *   domain/trips/projections/TripRouteChainProjection.ts:42  const BOUND_PROVIDER = straightLineTravelTimeProvider;
 *   services/airport/LayoverTravelTime.ts:83     export const LAYOVER_TRAVEL_TIME_PROVIDER = noRoutedProvider;
 *
 * Each is a module constant rather than an env lookup ON PURPOSE, so that
 * turning a routed provider on is a reviewed code change and not a deploy-time
 * surprise. Wiring this one costs money per call (see COST below); that is the
 * owner's decision, not this file's.
 *
 * WHY THIS PROVIDER
 * =================
 * Measured, not assumed: this repository already holds a live, billed Google
 * Maps Platform relationship. `GOOGLE_MAPS_API_KEY` is read today by
 * routes/places.ts (autocomplete, details, text search, photo media),
 * lib/discoveryPlacePhotoStore.ts and scripts/backfillPlacePhotos.ts, and
 * docs/places/google-legacy-places-api-returns-nothing.md records a production
 * probe following a photo URL end to end to HTTP 200, image/jpeg, 135,854 bytes,
 * concluding the key is "present, valid, and authorised for at least one Google
 * Places product", with Places API (New) enablement having been "blocked on
 * billing activation and cleared shortly before these measurements".
 *
 * So the Routes API is the SAME Cloud project, the SAME credential and the SAME
 * billing account. Using it is an API-enablement change, not a new vendor.
 * (Per-API enablement is genuinely granular there — the legacy Places API is
 * NOT enabled on that project while Places API (New) is — so Routes API still
 * has to be switched on deliberately.)
 *
 * COST, stated so nobody has to guess
 * ==================================
 * Charges are per request. This adapter makes ONE request per estimate() call
 * and there is no batching layer in this tree, so cost scales with call sites:
 * routes/discovery.ts's layover gate calls the port once per candidate, which is
 * free against noRoutedProvider and billable against this one. Read the current
 * per-1000 rate off the Cloud console before enabling — published prices change
 * and this file must not carry a stale number as if it were fact. What this file
 * CAN promise is that the volume is one call per estimate, that `cacheKeyFor`
 * below makes a route-shaped cache possible, and that there is no spend ceiling
 * anywhere in this repository yet (lib/rateLimit.ts limits clients, not spend).
 *
 * THE HAZARD THIS FILE IS BUILT AROUND
 * ====================================
 * `routed: true` is load-bearing. TripDepartureAssumptions' wrapper passes its
 * static PEAK/SHOULDER/OFF_PEAK band through untouched when
 * `provider.routed === true`, because a band stacked on a live traffic-aware
 * route would double-count congestion. A routed provider that forgot to set the
 * flag would silently inflate every number. It is set here, and the test asserts
 * it.
 *
 * WHAT THIS ADAPTER DOES NOT CLAIM
 * ================================
 * Routes API answers with ONE duration, not a distribution. This adapter
 * therefore leaves p50 = p75 = p90 = the returned duration rather than inventing
 * a spread. §6.2 wants a conservative percentile for safety-critical work and
 * FEASIBILITY_PERCENTILE is p90; against this provider that resolves to the
 * point value. That is a real limitation and is recorded here rather than
 * papered over with a made-up multiplier — a fabricated p90 would be worse than
 * an honest point estimate, because it would look like a distribution.
 */
import {
  pointTravelEstimate,
  type TravelSourceClass,
} from "../../../lib/travelEstimate.js";
import {
  haversineMeters,
  straightLineTravelTimeProvider,
  type GeoPoint,
  type TravelMode,
  type TravelTimeProvider,
  type TravelTimeQuery,
  type TravelTimeResult,
} from "./TravelTimeProvider.js";

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

/** Only the fields we read are requested; Routes API bills partly on the field
 *  mask, and asking for the whole route body would pay for a polyline nothing
 *  here draws. */
const FIELD_MASK = "routes.duration,routes.staticDuration,routes.distanceMeters";

const REQUEST_TIMEOUT_MS = 4_000;

/** A traffic-aware answer is about a moment. Ten minutes later it is a guess
 *  about the past, and rejectStaleEstimate exists to catch exactly that. */
export const ROUTED_ESTIMATE_TTL_MS = 5 * 60 * 1000;

/** Below this, walking is plausibly the fastest mode, so a drive-only routed
 *  answer is not a lower bound over modes. See `estimate` for what happens. */
const WALK_COMPETITIVE_METRES = 1_200;

function travelModeFor(mode: TravelMode | undefined): "DRIVE" | "WALK" | "TRANSIT" {
  switch (mode) {
    case "walk":
      return "WALK";
    case "transit":
      return "TRANSIT";
    default:
      return "DRIVE";
  }
}

/**
 * A route-shaped cache key. Every cache in this tree today is keyed by place,
 * query or city; a routed answer depends on BOTH endpoints, the mode and the
 * departure moment, so none of them fit. Coordinates are rounded to ~11 m and
 * the departure to a 5-minute bucket: finer than that and the key never hits,
 * coarser and the traffic answer stops being about the departure asked for.
 */
export function cacheKeyFor(q: TravelTimeQuery): string | null {
  if (!q.from || !q.to) return null;
  const r = (n: number) => n.toFixed(4);
  const bucket = Math.floor(q.departAt.getTime() / ROUTED_ESTIMATE_TTL_MS);
  return [
    "groutes",
    r(q.from.lat), r(q.from.lng),
    r(q.to.lat), r(q.to.lng),
    q.mode ?? "unknown",
    String(bucket),
  ].join(":");
}

/** ISO 8601 seconds, e.g. "1234s" — Routes API's duration encoding. */
function parseDurationSeconds(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export interface GoogleRoutesProviderOptions {
  /** Injected so the test does not reach the network and so a caller can wrap
   *  this in lib/inflightDedup + a cache without this file knowing about them. */
  fetchImpl?: typeof fetch;
  apiKey?: string | undefined;
  now?: () => Date;
}

/**
 * Build the adapter. Absent a key it degrades to exactly what this deployment
 * has today — NO_ROUTED_PROVIDER — rather than throwing, so that wiring it in a
 * deployment that has not enabled the API changes nothing except the id.
 */
export function createGoogleRoutesTravelTimeProvider(
  opts: GoogleRoutesProviderOptions = {},
): TravelTimeProvider {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => new Date());
  // `in`, not `!== undefined`: a caller passing `apiKey: undefined` is SAYING
  // "there is no key", and must not silently inherit the process environment.
  // Found by the test — the first cut used `!== undefined` and a deployment
  // that happened to export GOOGLE_MAPS_API_KEY would have made a billable call
  // on a code path written to make none.
  const apiKey = "apiKey" in opts ? opts.apiKey : process.env["GOOGLE_MAPS_API_KEY"];

  return {
    id: "google-routes-v2",
    // Load-bearing. See THE HAZARD in the header.
    routed: true,

    async estimate(q: TravelTimeQuery): Promise<TravelTimeResult> {
      if (!q.from || !q.to) return { kind: "unknown", reason: "NO_COORDINATES" };
      const coords = [q.from.lat, q.from.lng, q.to.lat, q.to.lng];
      if (!coords.every(Number.isFinite)) {
        return { kind: "unknown", reason: "PROVIDER_MALFORMED", detail: "non-finite coordinate" };
      }
      if (!apiKey) {
        // Not an outage: this deployment simply has no routed provider, which
        // is the state every consumer already handles.
        return { kind: "unknown", reason: "NO_ROUTED_PROVIDER" };
      }
      if (typeof doFetch !== "function") {
        return { kind: "unknown", reason: "PROVIDER_UNAVAILABLE", detail: "no fetch implementation" };
      }

      const googleMode = travelModeFor(q.mode);
      // departAt is the whole of TR267: a traffic-aware answer is about a
      // moment. Routes API rejects a departureTime in the past, so a query for
      // a moment already gone is asked for now instead, and that is not a
      // silent substitution — it is the only departure the API will price.
      const departMs = Math.max(q.departAt.getTime(), now().getTime() + 1_000);

      const body = {
        origin: { location: { latLng: { latitude: q.from.lat, longitude: q.from.lng } } },
        destination: { location: { latLng: { latitude: q.to.lat, longitude: q.to.lng } } },
        travelMode: googleMode,
        // TRAFFIC_AWARE is only valid for DRIVE; the others reject it.
        ...(googleMode === "DRIVE"
          ? { routingPreference: "TRAFFIC_AWARE", departureTime: new Date(departMs).toISOString() }
          : googleMode === "TRANSIT"
            ? { departureTime: new Date(departMs).toISOString() }
            : {}),
      };

      let res: Response;
      try {
        res = await doFetch(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": FIELD_MASK,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        return {
          kind: "unknown",
          reason: "PROVIDER_UNAVAILABLE",
          detail: e instanceof Error ? e.name : "fetch failed",
        };
      }

      if (!res.ok) {
        return { kind: "unknown", reason: "PROVIDER_UNAVAILABLE", detail: `HTTP ${res.status}` };
      }

      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        return { kind: "unknown", reason: "PROVIDER_MALFORMED", detail: "body is not JSON" };
      }

      const routes = (parsed as { routes?: unknown })?.routes;
      if (!Array.isArray(routes) || routes.length === 0) {
        // A 200 with no route is "there is no route", not a crash. It is still
        // an absence of an answer, and absence is never zero.
        return { kind: "unknown", reason: "PROVIDER_UNAVAILABLE", detail: "no route returned" };
      }
      const first = routes[0] as { duration?: unknown; staticDuration?: unknown };
      const seconds =
        parseDurationSeconds(first.duration) ?? parseDurationSeconds(first.staticDuration);
      if (seconds === null) {
        return { kind: "unknown", reason: "PROVIDER_MALFORMED", detail: "unreadable duration" };
      }

      let minutes = Math.ceil(seconds / 60);
      let sourceClass: TravelSourceClass = googleMode === "DRIVE" ? "LIVE" : "HISTORICAL";
      const sourceRefs = [
        "domain/trips/contracts/GoogleRoutesTravelTimeProvider.ts#createGoogleRoutesTravelTimeProvider",
        `google:routes.v2:${googleMode}`,
      ];

      // THE LOWER-BOUND RULE, kept intact.
      //
      // When the caller names no mode, the port's contract is a bound over the
      // modes available, not "however a person would probably go" — the same
      // correction census-trips §40.3 forced on the straight-line adapter when
      // a 1.9 km hop came back as a 26-minute walk. A DRIVE route is not a
      // lower bound on a short hop where walking wins, so for those we compare
      // against the straight-line WALK bound and keep the smaller.
      //
      // If the walk bound is the binding term, the answer is NOT routed, and it
      // is stamped STATIC_DEFAULT accordingly. Stamping LIVE on a number that
      // came from a great circle is precisely the lie isRoutedSourceClass
      // exists to prevent.
      if ((q.mode === undefined || q.mode === "unknown") &&
          haversineMeters(q.from, q.to) <= WALK_COMPETITIVE_METRES) {
        const walk = await straightLineTravelTimeProvider.estimate({ ...q, mode: "walk" });
        if (walk.kind === "estimate" && walk.estimate.minutes < minutes) {
          minutes = walk.estimate.minutes;
          sourceClass = "STATIC_DEFAULT";
          sourceRefs.push("bound:straight-line-walk-was-faster");
        }
      }

      const observedAt = now().toISOString();
      const expiresAt = new Date(now().getTime() + ROUTED_ESTIMATE_TTL_MS).toISOString();

      return {
        kind: "estimate",
        estimate: pointTravelEstimate(
          minutes,
          sourceClass,
          // Routes API gives one number with no distribution, so MEDIUM, not
          // HIGH: the value is measured, the spread is unknown.
          sourceClass === "STATIC_DEFAULT" ? "LOW" : "MEDIUM",
          sourceClass === "STATIC_DEFAULT" ? 3 : 0,
          sourceRefs,
          observedAt,
          expiresAt,
        ),
        // A routed provider answered for the departure time it was given, so
        // there is nothing to assume. The wrapper reads this as "do not stack a
        // band on me".
        assumption: null,
      };
    },
  };
}

/** Convenience singleton for a future wiring change. Still imported by nothing. */
export const googleRoutesTravelTimeProvider: TravelTimeProvider =
  createGoogleRoutesTravelTimeProvider();

export function _testOnlyGeoPoint(lat: number, lng: number): GeoPoint {
  return { lat, lng };
}
