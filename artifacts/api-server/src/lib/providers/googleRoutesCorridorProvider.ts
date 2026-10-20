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
import { dbRoutesSpendGate, type RoutesSpendGate } from "../../domain/trips/contracts/RoutesSpendGate.js";
import { currentRoutesRequestBudget } from "../../domain/trips/contracts/RoutesRequestBudget.js";
import { getServiceClient } from "../supabase.js";

const PROVIDER_ID = "google-routes-v2-corridor";
const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

/** The credential. Shared with Places across this project's one Cloud account. */
export const CREDENTIAL_ENV = "GOOGLE_MAPS_API_KEY";
/** The spend gate. Its ONLY meaning is "an operator decided to spend here". */
export const ENABLEMENT_ENV = "LAYOVER_ROUTED_CORRIDOR_ENABLED";

/**
 * Routes API bills partly on the field mask, so only the fields actually read
 * below are requested. The BASIC GeoJSON polyline is read for L270's Google-map-only route display (never persisted:
 * providerMapGeometry.ts); traffic-on-polyline and toll fields are Enterprise triggers and are never asked for.
 *
 * Every entry earns its place against a census row:
 *   routes.duration / distanceMeters            the corridor's own numbers
 *   legs.steps.travelMode / staticDuration      per-leg shape (L70, L71)
 *   legs.steps.transitDetails.stopCount         interruptibility (L70)
 *   legs.steps.transitDetails.stopDetails       transfer points (L68, L71); legs.steps.navigationInstruction.maneuver: a FERRY / FERRY_TRAIN step is a non-interruptible leg (L70); fallbackInfo: a TRAFFIC_UNAWARE fallback is not a forecast (L60). Neither is a Pro/Enterprise trigger (SKU page, read 2026-10-18), so the SKU is unchanged.
 */
const FIELD_MASK = [
  "routes.duration",
  "routes.staticDuration",
  "routes.distanceMeters", "routes.polyline.geoJsonLinestring",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.transitDetails.stopCount",
  "routes.legs.steps.transitDetails.stopDetails.arrivalStop.name",
  "routes.legs.steps.transitDetails.stopDetails.departureStop.name", "routes.legs.steps.navigationInstruction.maneuver", "fallbackInfo",
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
    mode === "transit" ? transitInterruptibility(transit?.stopCount) : isFerryStep(step) ? "committed" : interruptibilityFromMode(mode); // L70: a car ferry inside a DRIVE route cannot be left part-way

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
  const legs = conveyanceLegs(steps, stepToLeg); // one leg per CONVEYANCE, not per turn instruction — see conveyanceLegs at the foot

  return {
    legs,
    // The ROUTE's own duration, not the sum of the steps. The steps carry
    // staticDuration (free-flow); the route carries the traffic-aware total,
    // and summing free-flow steps would quietly discard the traffic the request
    // paid for.
    totalMinutes: Math.ceil(totalSeconds / 60),
    transferCount: transferCountOf(legs), ...(googleRouteGeometry(route?.polyline?.geoJsonLinestring) ? { geometry: googleRouteGeometry(route?.polyline?.geoJsonLinestring) } : {}),
  };
}

export interface GoogleRoutesCorridorOptions {
  /** Injected so tests never reach the network and a caller can wrap this in a cache. */
  fetchImpl?: typeof fetch;
  /** Injected so a test proves all three credential states without mutating process.env. */
  readEnv?: (name: string) => string | undefined;
  now?: () => Date;
  /**
   * Lead ruling D-7 (the owner's Routes caps: $10/day, 500/day, 5 per person,
   * 3 per trip): EVERY Google Routes call is charged through the same spend
   * gate the Trips seams use (domain/trips/contracts/RoutesSpendGate.ts, 3971 +
   * 3973). Default: that gate, on the service client.
   */
  spendGate?: RoutesSpendGate; /** Owner decision R5 (2026-10-18): a LAYOVER read (its budget names a layover session) is charged through the layover gate — per session and per person, sharing only the day's quota and budget with Trips. Default: services/airport/layoverRoutesSpendGate.ts on the service client. */ layoverSpendGate?: LayoverRoutesSpendGate; /** The memo of identical corridors (R5(b)): ON for the production singleton below; a provider built elsewhere (a test, a one-off) asks per call unless it opts in. */ memo?: boolean;
  /**
   * Who the call is charged to. Default: the read's own scope
   * (withRoutesRequestBudget). No user AND trip → no call: the owner's caps are
   * per person and per trip, and an uncharged call is an uncapped one.
   */
  spendScope?: () => { userId: string | null; tripId: string | null; layoverSessionId?: string | null } | null;
}

/** The Trips gate, built once on first use (no client is read at import). */
let defaultSpendGate: RoutesSpendGate | null = null;
function tripSpendGate(): RoutesSpendGate {
  defaultSpendGate ??= dbRoutesSpendGate({ client: () => getServiceClient() });
  return defaultSpendGate;
}

export function createGoogleRoutesCorridorProvider(
  opts: GoogleRoutesCorridorOptions = {},
): RouteCorridorProvider {
  const doFetch = opts.fetchImpl ?? globalThis.fetch; const providerOpts = opts; // read inside `corridorUncached`, which picks the gate a scope is charged through
  const now = opts.now ?? (() => new Date());
  const readEnv = opts.readEnv ?? ((name: string) => process.env[name]);
  const spendScope = opts.spendScope ?? (() => {
    const b = currentRoutesRequestBudget();
    return b ? { userId: b.userId, tripId: b.tripId, layoverSessionId: b.layoverSessionId ?? null } : null;
  });

  async function corridorUncached(q: CorridorQuery): Promise<CorridorResult> {
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

    // Lead ruling D-7: the owner's caps bound this call too. The read's own hop
    // cap first (counted before the first await, as the Trips seam does), then
    // one unit of the shared daily quota, budget, person share and trip share,
    // taken atomically by 3973's function. Anything but "granted" is no call.
    const budget = currentRoutesRequestBudget();
    if (budget && (budget.counter.attempts >= budget.maxCalls || routesReadTimeSpent(budget, now))) {
      return refuse(PROVIDER_ID, "PROVIDER_REJECTED", budget.counter.attempts >= budget.maxCalls ? "the Routes API calls this read may make are spent (request_hop_cap)" : "the Routes API time this read may spend is spent (request_time_budget)");
    }
    const scope = spendScope();
    if (!scope?.userId || (!scope?.tripId && !scope?.layoverSessionId)) {
      return refuse(PROVIDER_ID, "PROVIDER_REJECTED", "no person and trip to charge this Routes API call to; the owner's caps are per person and per trip (unscoped)");
    }
    if (budget) budget.counter.attempts += 1; const opts = spendGateOptionsFor(providerOpts, scope); // R5: a layover scope is charged through the layover gate (session + person + the shared day); every other scope exactly as before
    const verdict = await (opts.spendGate ?? tripSpendGate()).decide({ userId: scope.userId, tripId: scope.tripId });
    if (verdict !== "granted") {
      return refuse(PROVIDER_ID, "PROVIDER_REJECTED", `the Routes API spend gate answered ${verdict}; nothing was asked of Google`);
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
      travelMode: mode, polylineEncoding: "GEO_JSON_LINESTRING", polylineQuality: "HIGH_QUALITY",
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
        signal: AbortSignal.timeout(routesRequestTimeoutMs(currentRoutesRequestBudget(), now, REQUEST_TIMEOUT_MS)),
      });
    } catch (e) {
      markRoutesReadTimedOut(e, currentRoutesRequestBudget(), now); return refuse(
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
      `google:routes.v2:${mode}`, ...fallbackRefs(parsed),
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
      sourceClass: mode === "DRIVE" && !trafficUnawareFallback(parsed) ? "LIVE" : "HISTORICAL", // a FALLBACK_TRAFFIC_UNAWARE answer to a TRAFFIC_AWARE request is free-flow, not a forecast (L60)
      confidence: mode === "DRIVE" && trafficUnawareFallback(parsed) ? "LOW" : "MEDIUM",
      sourceRefs,
    });
  }
  const corridor = opts.memo === true ? memoisedCorridor(corridorUncached, now, undefined, () => enablementRefusal(PROVIDER_ID, ENABLEMENT_ENV, readEnv) ?? credentialRefusal(PROVIDER_ID, CREDENTIAL_ENV, readEnv)) : corridorUncached; // identical legs inside one 5-minute bucket are asked of Google ONCE (owner decision R5(b)); see memoisedCorridor at the foot
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
  createGoogleRoutesCorridorProvider({ memo: true }); // R5(b): every layover read shares one memo of identical legs

// ═══════════════════════════════════════════════════════════════════════════
// LAYOVER 165, lane B1-R1 (owner decision 2026-10-18: Google Routes is approved
// for Layover). Appended at the TAIL so every cited line above keeps its
// number; ESM hoists the imports.
//
//   conveyanceLegs        one RouteLeg per CONVEYANCE. Google answers a DRIVE
//                         route as a turn-by-turn list of steps, every one of
//                         them `travelMode: DRIVE`. Read one leg per step,
//                         `transferCountOf` counted a 15-turn taxi ride as 14
//                         changes of vehicle, `assessReturnRisk` called EVERY
//                         real drive corridor "requires multiple transfers",
//                         and every candidate would have been refused on a
//                         fabricated L71 signal. Consecutive WALK steps are one
//                         walk and consecutive DRIVE steps one drive; every
//                         TRANSIT step is its own vehicle. Seconds are summed
//                         BEFORE rounding, so a merged leg is not ceiled once
//                         per turn.
//   spendGateOptionsFor   R5(a)/(b): a layover scope is charged through the
//                         layover gate, never a trip's D-7 share.
//   memoisedCorridor      R5(b): identical legs (same endpoints to ~11 m, same
//                         mode, same 5-minute departure bucket, same
//                         alternatives flag) are asked ONCE — concurrent asks
//                         share one request, and an answer is reused until its
//                         own `expiresAt`. A memo hit spends nothing and is not
//                         counted against the read's cap. Only ANSWERS are kept;
//                         a refusal is never replayed.
//   the time budget       a layover read routes up to 12 legs; the corridor
//                         call now honours the read's time budget the way the
//                         Trips seam does (GatedRoutedTravelTimeProvider), and a
//                         request never waits past what the read has left.
//   fallbackInfo          Google may answer a TRAFFIC_AWARE request from its
//                         TRAFFIC_UNAWARE fallback (`SERVER_ERROR`,
//                         `LATENCY_EXCEEDED`). That duration is free-flow and is
//                         NOT a forecast for the return instant, so the corridor
//                         is HISTORICAL / LOW and names the fallback in its
//                         sourceRefs; the layover evaluator refuses to certify
//                         a return on it (it may still refuse a candidate).
// ═══════════════════════════════════════════════════════════════════════════
import type { RoutesRequestBudget } from "../../domain/trips/contracts/RoutesRequestBudget.js";
import { corridorCacheKey } from "./routeCorridorProvider.js";
import { layoverRoutesSpendGate, type LayoverRoutesSpendGate } from "../../services/airport/layoverRoutesSpendGate.js";

/** Google's maneuvers for boarding a ferry. A ferry cannot be left part-way (L70). */
const FERRY_MANEUVERS = new Set(["FERRY", "FERRY_TRAIN"]);

export function isFerryStep(step: any): boolean {
  return FERRY_MANEUVERS.has(String(step?.navigationInstruction?.maneuver ?? "").toUpperCase());
}

/**
 * One RouteLeg per conveyance (see the block header). `single` is the per-step
 * reader above, used unchanged for TRANSIT steps (each is its own vehicle with
 * its own stop count and transfer point).
 */
export function conveyanceLegs(steps: readonly any[], single: (step: any) => RouteLeg | null): RouteLeg[] {
  const out: RouteLeg[] = [];
  type Run = { mode: TravelMode; seconds: number; distance: number | null; committed: boolean; unknown: boolean };
  let run = null as Run | null;
  const flush = () => {
    if (!run) return;
    out.push({
      mode: run.mode,
      minutes: Math.ceil(run.seconds / 60),
      distanceMeters: run.distance,
      interruptibility: run.committed ? "committed" : run.unknown ? "unknown" : interruptibilityFromMode(run.mode),
      transferPointId: null,
    });
    run = null;
  };
  for (const step of steps) {
    const seconds = parseDurationSeconds(step?.staticDuration);
    if (seconds === null) continue;
    const mode = localMode(step?.travelMode);
    if (mode === "transit" || mode === "unknown") {
      flush();
      const leg = single(step);
      if (leg) out.push(leg);
      continue;
    }
    const distance = typeof step?.distanceMeters === "number" ? step.distanceMeters : null;
    if (run && run.mode === mode) {
      run.seconds += seconds;
      run.distance = run.distance === null || distance === null ? null : run.distance + distance;
      run.committed ||= isFerryStep(step);
    } else {
      flush();
      run = { mode, seconds, distance, committed: isFerryStep(step), unknown: false };
    }
  }
  flush();
  return out;
}

/** The scope a call is charged to, as the provider reads it. */
interface ChargeScope { userId: string | null; tripId: string | null; layoverSessionId?: string | null }

/**
 * The spend options for THIS scope. A layover scope gets a gate whose `decide`
 * charges the layover session and person (the trip, if any, is ignored: R5(b));
 * any other scope gets the provider's own options, untouched.
 */
export function spendGateOptionsFor(
  providerOpts: GoogleRoutesCorridorOptions,
  scope: ChargeScope,
): { spendGate?: { decide(s: { userId: string | null; tripId: string | null }): Promise<string> } } {
  if (!scope.layoverSessionId) return providerOpts;
  const layoverSessionId = scope.layoverSessionId;
  const gate = providerOpts.layoverSpendGate ?? layoverRoutesSpendGate();
  return {
    spendGate: {
      async decide(s) {
        const verdict = await gate.decide({ userId: s.userId, layoverSessionId });
        return verdict === "granted" ? "granted" : `layover ${verdict}`;
      },
    },
  };
}

/** Has this read spent its wall-clock budget for routed calls? */
export function routesReadTimeSpent(budget: RoutesRequestBudget, _now?: () => Date): boolean {
  if (budget.counter.timedOut === true) return true;
  // The BUDGET's clock (Date.now, as `withRoutesRequestBudget` stamps `startedAt`), never the provider's
  // injectable `now`, which dates the corridor's own observedAt/expiresAt and may be a fixed test instant.
  return Date.now() - budget.counter.startedAt >= budget.budgetMs;
}

/** How long ONE request may wait: the adapter's own timeout, never past what the read has left. */
export function routesRequestTimeoutMs(budget: RoutesRequestBudget | undefined, now: () => Date, ceiling: number): number {
  if (!budget) return ceiling;
  const left = budget.budgetMs - (Date.now() - budget.counter.startedAt); void now; // the budget's clock (see routesReadTimeSpent)
  return Math.max(1, Math.min(ceiling, left));
}

/** A request abandoned because the read's time ran out spends the rest of the read's time too. */
export function markRoutesReadTimedOut(e: unknown, budget: RoutesRequestBudget | undefined, now: () => Date): void {
  if (!budget || !(e instanceof Error) || e.name !== "TimeoutError") return;
  void now; if (Date.now() - budget.counter.startedAt >= budget.budgetMs - 5) budget.counter.timedOut = true;
}

/** Google answered from its TRAFFIC_UNAWARE fallback: the durations are free-flow, not a forecast. */
export function trafficUnawareFallback(parsed: unknown): boolean {
  const mode = (parsed as { fallbackInfo?: { routingMode?: unknown } })?.fallbackInfo?.routingMode;
  return String(mode ?? "") === "FALLBACK_TRAFFIC_UNAWARE";
}

/** The fallback, named in the corridor's own provenance. Empty when Google used the mode asked for. */
export function fallbackRefs(parsed: unknown): string[] {
  const f = (parsed as { fallbackInfo?: { routingMode?: unknown; reason?: unknown } })?.fallbackInfo;
  if (!f || typeof f !== "object") return [];
  return [`google:routes.v2:fallback:${String(f.routingMode ?? "unspecified")}:${String(f.reason ?? "unspecified")}`];
}

/** The memo's bound. A layover read asks at most 12 legs; 2,000 is many airports' worth of five minutes. */
export const CORRIDOR_MEMO_MAX = 2_000;

/**
 * Identical corridors asked once (R5(b)). Per PROVIDER INSTANCE — the
 * production singleton shares it across every request; a test's private
 * provider has its own — and in memory only: nothing is written anywhere, and
 * an entry dies at the corridor's own `expiresAt` (five minutes).
 */
export function memoisedCorridor(
  inner: (q: CorridorQuery) => Promise<CorridorResult>,
  now: () => Date,
  max?: number,
  /** The provider's own configuration gates, asked BEFORE the memo: a deployment that turned Routes off is not served an answer it remembers. */
  preflight?: () => ProviderRefusal | null,
): (q: CorridorQuery) => Promise<CorridorResult> {
  const answers = new Map<string, { result: CorridorResult; expiresMs: number }>();
  const inFlight = new Map<string, Promise<CorridorResult>>(); const requestAnswers = new WeakMap<RoutesRequestBudget, Map<string, CorridorResult>>();
  return async (q: CorridorQuery): Promise<CorridorResult> => {
    // The key names the mode GOOGLE is asked for: an unspecified mode is asked as DRIVE (googleMode), so it
    // shares the DRIVE entry rather than paying twice for the same request.
    const closed = preflight?.() ?? null;
    if (closed) return closed; if (q.cachePolicy === 'no_store') return inner(q);
    const base = corridorCacheKey({ ...q, mode: localMode(googleMode(q.mode)) });
    if (base === null) return inner(q);
    const key = `${base}:${q.wantAlternatives === false ? "single" : "alternatives"}`;
    const scope = currentRoutesRequestBudget(); const requestHit = scope ? requestAnswers.get(scope)?.get(key) : undefined; if (requestHit?.ok && Date.parse(requestHit.value.expiresAt) > now().getTime()) return requestHit; const hit = answers.get(key);
    if (hit && hit.expiresMs > now().getTime()) return hit.result;
    if (hit) answers.delete(key);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const p = inner(q).then((result) => {
      if (result.ok) {
        const expiresMs = Date.parse(result.value.expiresAt);
        if (Number.isFinite(expiresMs) && expiresMs > now().getTime()) {
          if (answers.size >= (max ?? CORRIDOR_MEMO_MAX)) { // read lazily: the singleton above is built at import, before this module's tail constants exist
            const oldest = answers.keys().next().value;
            if (oldest !== undefined) answers.delete(oldest);
          }
          answers.set(key, { result: withoutProviderMapContent(result), expiresMs }); if (scope) { let transient = requestAnswers.get(scope); if (!transient) { transient = new Map(); requestAnswers.set(scope, transient); } transient.set(key, result); }
        }
      }
      return result;
    }).finally(() => { inFlight.delete(key); });
    inFlight.set(key, p);
    return p;
  };
}

import { googleRouteGeometry, withoutProviderMapContent } from './providerMapGeometry.js';
