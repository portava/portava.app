/**
 * Google Routes API v2 adapter for the ROUTE-SHAPE port.
 *
 * ── PREPARED, NOT WIRED, AND NOT ENABLED ─────────────────────────────────────
 * Nothing imports this yet and it changes no behaviour on any deployment.
 * Wiring it is a code change in `services/airport/` (not this lane's files);
 * ENABLING it is a second, separate act — see THE SPEND GATE below.
 *
 * ── WHY THIS PROVIDER, MEASURED RATHER THAN ASSUMED ──────────────────────────
 * The owner's rule for external providers is to use services and credentials
 * this project already has. This one does:
 *
 *   `GOOGLE_MAPS_API_KEY` is declared in `artifacts/api-server/.env.example`
 *   ("Google geocoding / places") and is read today by `routes/places.ts`,
 *   `lib/discoveryPlacePhotoStore.ts` and `scripts/backfillPlacePhotos.ts`.
 *   `domain/trips/contracts/GoogleRoutesTravelTimeProvider.ts` already took
 *   this decision for the SCALAR port and records the evidence: a production
 *   probe following a photo URL to HTTP 200 / image/jpeg / 135,854 bytes,
 *   concluding the key is "present, valid, and authorised for at least one
 *   Google Places product".
 *
 * So Routes API is the same Cloud project, the same credential and the same
 * billing account — an API-enablement change, not a new vendor. Per-API
 * enablement on that project is genuinely granular (the legacy Places API is
 * NOT enabled there while Places API (New) is), so Routes API still has to be
 * switched on deliberately, and this adapter has never been observed to succeed
 * against that project.
 *
 * THIS ADAPTER IS THE SIBLING OF THAT ONE, NOT A REPLACEMENT. That file answers
 * §7's scalar duration; this one answers §8's corridor shape — alternatives,
 * transfers, interruptibility, both directions at their own instants. They
 * share a vendor and nothing else, and they are separate files because merging
 * them would put a safety-critical corridor and a trip-planning duration behind
 * one set of edits.
 *
 * ── THE SPEND GATE, AND THE NEAR-MISS IT COMES FROM ──────────────────────────
 * Routes API bills per request. This adapter makes ONE request per corridor and
 * `bothDirections` makes two per candidate, so cost scales with call sites, and
 * there is no spend ceiling anywhere in this repository (`lib/rateLimit.ts`
 * limits clients, not spend).
 *
 * A key being present is therefore NOT consent to spend. `GOOGLE_MAPS_API_KEY`
 * is already set wherever Places photos work, and an adapter that treated its
 * presence as "routing is wanted here" would start billing on every such
 * deployment with no code change and no review. The scalar adapter's header
 * records the near-miss: its first cut read the key with `!== undefined` and "a
 * deployment that happened to export GOOGLE_MAPS_API_KEY would have made a
 * billable call on a code path written to make none."
 *
 * So there are TWO gates and both must pass: the credential
 * (`GOOGLE_MAPS_API_KEY`) and an opt-in whose only meaning is "an operator
 * decided to spend here" (`LAYOVER_ROUTED_CORRIDOR_ENABLED`). Each refuses by
 * its own name. Neither can be satisfied by accident.
 *
 * Read the current per-1000 rate off the Cloud console before enabling. This
 * file deliberately carries no price: a stale number in a comment reads as fact.
 *
 * ── WHAT THIS ADAPTER DOES NOT CLAIM ─────────────────────────────────────────
 * Routes API answers with durations, not distributions, so no percentile spread
 * is invented anywhere below. Three of L62's five signals — queue friction,
 * weather, airport re-entry cost — have no feed in this tree and are returned
 * as named absences naming their blocker, never as zero. `reliability` is the
 * one this provider CAN support, and only because alternatives give a real
 * spread between real routes; it is not a variance over observations, because
 * there are no observations.
 */
import {
  answer,
  credentialRefusal,
  enablementRefusal,
  refuse,
  type ProviderRefusal,
} from "./providerRefusal.js";
import {
  corridorQueryRefusal,
  independentRouteCount,
  interruptibilityFromMode,
  measured,
  routeInterruptibility,
  transferCountOf,
  unmeasured,
  bothDirections,
  type BidirectionalQuery,
  type BidirectionalResult,
  type CorridorQuery,
  type CorridorResult,
  type LegInterruptibility,
  type RouteCorridorProvider,
  type RouteLeg,
  type RouteOption,
  type TravelMode,
} from "./routeCorridorProvider.js";

const PROVIDER_ID = "google-routes-v2-corridor";
const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

/** The credential. Shared with Places across this project's one Cloud account. */
export const CREDENTIAL_ENV = "GOOGLE_MAPS_API_KEY";
/** The spend gate. Its ONLY meaning is "an operator decided to spend here". */
export const ENABLEMENT_ENV = "LAYOVER_ROUTED_CORRIDOR_ENABLED";

/**
 * Routes API bills partly on the field mask, so only the fields actually read
 * below are requested. Asking for the route body would pay for a polyline
 * nothing here draws.
 *
 * Every entry earns its place against a census row:
 *   routes.duration / distanceMeters            the corridor's own numbers
 *   legs.steps.travelMode / staticDuration      per-leg shape (L70, L71)
 *   legs.steps.transitDetails.stopCount         interruptibility (L70)
 *   legs.steps.transitDetails.stopDetails       transfer points (L68, L71)
 */
const FIELD_MASK = [
  "routes.duration",
  "routes.staticDuration",
  "routes.distanceMeters",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.transitDetails.stopCount",
  "routes.legs.steps.transitDetails.stopDetails.arrivalStop.name",
  "routes.legs.steps.transitDetails.stopDetails.departureStop.name",
].join(",");

const REQUEST_TIMEOUT_MS = 6_000;

/**
 * A traffic-aware corridor is about a moment; ten minutes later it is a claim
 * about the past. Same five minutes the scalar adapter uses, and the same
 * bucket `corridorCacheKey` rounds to, so a cached corridor and its key expire
 * together rather than one outliving the other.
 */
export const CORRIDOR_TTL_MS = 5 * 60 * 1000;

/** Routes API caps alternatives; asking for more is silently ignored, so state it. */
const MAX_ALTERNATIVES = 3;

function googleMode(mode: TravelMode | undefined): "DRIVE" | "WALK" | "TRANSIT" {
  switch (mode) {
    case "walk":
      return "WALK";
    case "transit":
      return "TRANSIT";
    default:
      return "DRIVE";
  }
}

function localMode(google: unknown): TravelMode {
  switch (String(google ?? "").toUpperCase()) {
    case "WALK":
      return "walk";
    case "DRIVE":
    case "DRIVING":
      return "drive";
    case "TRANSIT":
      return "transit";
    default:
      return "unknown";
  }
}

/** ISO 8601 seconds, e.g. "1234s" — Routes API's duration encoding. */
export function parseDurationSeconds(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * L70, decided from what the provider actually says rather than from the word
 * "transit".
 *
 * Routes API's `transitDetails.stopCount` is the number of stops the vehicle
 * makes on THIS step. A step of one stop is a non-stop hop: once aboard, the
 * traveller cannot act on a moved deadline until it ends, which is exactly the
 * risk L70 asks to be penalised. Two or more stops means there is somewhere to
 * get off.
 *
 * A transit step with NO stopCount stays `unknown`. Guessing either way is the
 * defect: `interruptible` silently withholds L70's penalty on every vague leg,
 * `committed` invents one.
 */
export function transitInterruptibility(stopCount: unknown): LegInterruptibility {
  if (typeof stopCount !== "number" || !Number.isFinite(stopCount)) return "unknown";
  return stopCount >= 2 ? "interruptible" : "committed";
}

function stepToLeg(step: any): RouteLeg | null {
  const seconds = parseDurationSeconds(step?.staticDuration);
  if (seconds === null) return null;
  const mode = localMode(step?.travelMode);
  const transit = step?.transitDetails;
  const distance = typeof step?.distanceMeters === "number" ? step.distanceMeters : null;

  const interruptibility =
    mode === "transit" ? transitInterruptibility(transit?.stopCount) : interruptibilityFromMode(mode);

  // A NAME, not a position. See RouteLeg.transferPointId for why this must
  // never become a coordinate.
  const arrival = transit?.stopDetails?.arrivalStop?.name;
  const transferPointId = typeof arrival === "string" && arrival.trim() !== "" ? arrival.trim() : null;

  return {
    mode,
    minutes: Math.ceil(seconds / 60),
    distanceMeters: distance,
    interruptibility,
    transferPointId,
  };
}

function routeToOption(route: any): RouteOption | null {
  const totalSeconds = parseDurationSeconds(route?.duration) ?? parseDurationSeconds(route?.staticDuration);
  if (totalSeconds === null) return null;

  const steps: any[] = [];
  for (const leg of Array.isArray(route?.legs) ? route.legs : []) {
    for (const s of Array.isArray(leg?.steps) ? leg.steps : []) steps.push(s);
  }
  const legs = steps.map(stepToLeg).filter((l): l is RouteLeg => l !== null);

  return {
    legs,
    // The ROUTE's own duration, not the sum of the steps. The steps carry
    // staticDuration (free-flow); the route carries the traffic-aware total,
    // and summing free-flow steps would quietly discard the traffic the request
    // paid for.
    totalMinutes: Math.ceil(totalSeconds / 60),
    transferCount: transferCountOf(legs),
  };
}

export interface GoogleRoutesCorridorOptions {
  /** Injected so tests never reach the network and a caller can wrap this in a cache. */
  fetchImpl?: typeof fetch;
  /** Injected so a test proves all three credential states without mutating process.env. */
  readEnv?: (name: string) => string | undefined;
  now?: () => Date;
}

export function createGoogleRoutesCorridorProvider(
  opts: GoogleRoutesCorridorOptions = {},
): RouteCorridorProvider {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => new Date());
  const readEnv = opts.readEnv ?? ((name: string) => process.env[name]);

  async function corridor(q: CorridorQuery): Promise<CorridorResult> {
    const bad = corridorQueryRefusal(PROVIDER_ID, q);
    if (bad) return bad;

    // BOTH gates, in this order. Enablement first so a deployment that has the
    // key but has not opted in gets told the truth — "nobody turned this on" —
    // rather than a credential message that sends an operator to fix a secret
    // that is already fine.
    const notEnabled: ProviderRefusal | null = enablementRefusal(PROVIDER_ID, ENABLEMENT_ENV, readEnv);
    if (notEnabled) return notEnabled;
    const noKey: ProviderRefusal | null = credentialRefusal(PROVIDER_ID, CREDENTIAL_ENV, readEnv);
    if (noKey) return noKey;
    const apiKey = readEnv(CREDENTIAL_ENV) as string;

    if (typeof doFetch !== "function") {
      return refuse(PROVIDER_ID, "PROVIDER_UNAVAILABLE", "no fetch implementation is available");
    }

    const mode = googleMode(q.mode);
    // Routes API rejects a departureTime in the past. A query for a moment
    // already gone is asked for now instead — not a silent substitution, it is
    // the only departure the API will price, and the corridor's `departAt`
    // below records what was actually asked.
    const departMs = Math.max(q.departAt.getTime(), now().getTime() + 1_000);
    const departureTime = new Date(departMs).toISOString();

    const body = {
      origin: { location: { latLng: { latitude: q.from!.lat, longitude: q.from!.lng } } },
      destination: { location: { latLng: { latitude: q.to!.lat, longitude: q.to!.lng } } },
      travelMode: mode,
      // L68's input. Without this the API returns one route and every corridor
      // would read as a single fragile corridor (L69) — a fabricated risk
      // signal, which is worse than no signal.
      computeAlternativeRoutes: q.wantAlternatives !== false,
      // TRAFFIC_AWARE is valid for DRIVE only; the others reject it.
      ...(mode === "DRIVE"
        ? { routingPreference: "TRAFFIC_AWARE", departureTime }
        : mode === "TRANSIT"
          ? { departureTime }
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
      return refuse(
        PROVIDER_ID,
        "PROVIDER_UNAVAILABLE",
        e instanceof Error ? `${e.name}: ${e.message}` : "fetch failed",
      );
    }

    if (res.status === 401 || res.status === 403) {
      // The one state `lib/apiKeyState.ts` says is not knowable locally: a key
      // that is present, non-empty and wrong or unauthorised. Distinct from an
      // outage because the fix is an enablement or a key, not a retry.
      return refuse(
        PROVIDER_ID,
        "PROVIDER_REJECTED",
        `HTTP ${res.status} — the credential is set but Routes API rejected it. Most likely ` +
          `Routes API is not enabled on this Cloud project (per-API enablement there is granular), ` +
          `or the key is restricted to other APIs.`,
        CREDENTIAL_ENV,
      );
    }
    if (res.status === 429) {
      return refuse(PROVIDER_ID, "PROVIDER_REJECTED", "HTTP 429 — quota exhausted");
    }
    if (!res.ok) {
      return refuse(PROVIDER_ID, "PROVIDER_UNAVAILABLE", `HTTP ${res.status}`);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return refuse(PROVIDER_ID, "PROVIDER_MALFORMED", "body is not JSON");
    }

    const raw = (parsed as { routes?: unknown })?.routes;
    if (!Array.isArray(raw) || raw.length === 0) {
      // A 200 with no route means there IS no route. That is an absence of an
      // answer and never an empty corridor: an empty corridor would read as
      // "zero routes between these points", which L69 would score as maximally
      // fragile rather than as unknown.
      return refuse(PROVIDER_ID, "PROVIDER_UNAVAILABLE", "the provider returned no route");
    }

    const routes = raw
      .slice(0, MAX_ALTERNATIVES)
      .map(routeToOption)
      .filter((r): r is RouteOption => r !== null);
    if (routes.length === 0) {
      return refuse(PROVIDER_ID, "PROVIDER_MALFORMED", "no route carried a readable duration");
    }
    routes.sort((a, b) => a.totalMinutes - b.totalMinutes);

    const observedAt = now().toISOString();
    const expiresAt = new Date(now().getTime() + CORRIDOR_TTL_MS).toISOString();
    const sourceRefs = [
      "lib/providers/googleRoutesCorridorProvider.ts#createGoogleRoutesCorridorProvider",
      `google:routes.v2:${mode}`,
    ];

    const spreadMinutes = routes[routes.length - 1]!.totalMinutes - routes[0]!.totalMinutes;

    return answer({
      from: q.from!,
      to: q.to!,
      // What was ASKED FOR. When the request was clamped forward because the
      // instant had passed, this still records the instant the caller meant, so
      // a consumer comparing it against `observedAt` can see the clamp.
      departAt: new Date(q.departAt.getTime()).toISOString(),
      routes,
      independentRouteCount: independentRouteCount(routes),
      reliability: measured(
        { spreadMinutes, optionCount: routes.length },
        // The routes are measured; the reliability READ OFF them is an
        // aggregate over this one query, so HISTORICAL is wrong and LIVE
        // overstates it. It is LIVE in the sense travelEstimate defines — a
        // routed measurement made for this query — and MEDIUM because one
        // query's spread is not a distribution.
        "LIVE",
        "MEDIUM",
        sourceRefs,
      ),
      // The three signals §8 names that NOTHING in this tree can measure. Named
      // absences, never zero. A zero here would be read as "no queue", "clear
      // weather", "free re-entry" — three confident claims about an airport
      // nobody looked at.
      queueFriction: unmeasured(
        "no queue or security-wait feed exists in this repository; LayoverAirportTruth's " +
          "SECURITY_WAIT_HIGH has no producer outside tests",
      ),
      weather: unmeasured("no weather provider is configured for the layover surface"),
      airportReentryMinutes: unmeasured(
        "airport re-entry cost is not modelled; `traffic_extra_min` (migration 0127) is a " +
          "single admin-set integer covering all of §8's five signals at once",
      ),
      observedAt,
      expiresAt,
      // DRIVE is traffic-aware for the instant asked; TRANSIT is a published
      // schedule, which is an aggregate over the past, not a measurement of now.
      sourceClass: mode === "DRIVE" ? "LIVE" : "HISTORICAL",
      confidence: "MEDIUM",
      sourceRefs,
    });
  }

  return {
    id: PROVIDER_ID,
    routed: true,
    corridor,
    async bidirectional(q: BidirectionalQuery): Promise<BidirectionalResult> {
      // Bound explicitly rather than inherited, which is why the port declares
      // no default. Two separate queries at two separate instants: L60 and L72.
      return bothDirections({ id: PROVIDER_ID, corridor }, q);
    },
  };
}

/** Convenience singleton. Refuses on every call until BOTH gates are satisfied. */
export const googleRoutesCorridorProvider: RouteCorridorProvider =
  createGoogleRoutesCorridorProvider();
