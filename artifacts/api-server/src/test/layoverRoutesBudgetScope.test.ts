/**
 * FINDING F1 — no layover reader opened a Routes budget scope.
 *
 * `googleRoutesCorridorProvider` charges every call to a person AND a trip,
 * taken from the enclosing `withRoutesRequestBudget` scope, and refuses a call
 * with none as `unscoped` (googleRoutesCorridorProvider.ts:306). Only the Trips
 * readers opened one, so the day the owner enables Routes every layover leg and
 * corridor call would still have been refused. census-trips §86.2: "the Layover
 * readers that use this provider must open a withRoutesRequestBudget scope".
 *
 * WHAT IS PINNED
 *   1. Each layover path that can reach the provider makes the call and
 *      charges it to the traveller and THEIR LAYOVER SESSION — proved with the
 *      REAL corridor provider (fetch and spend gate injected, nothing reaches
 *      the network): recommendation generation's legs, Discovery's layover
 *      timing, and `certifiedActionUniverse`'s return corridor.
 *   2. OWNER DECISION R5 (2026-10-18, lane B1-R1) superseded the trip-less
 *      absence: a layover read — with or without a trip — is charged to its
 *      layover SESSION and the person (never the trip's D-7 share), and only a
 *      read that names no session is the NAMED absence `routes_unscoped_no_session`.
 *   3. With Routes not live — every deployment today — the wrap changes
 *      nothing: the same answer, byte for byte, as an unwrapped call.
 *
 * NO NETWORK. Every provider is a double or the real adapter over an injected
 * `fetchImpl`. `process.env` is set only inside `withLiveRoutesEnv` (this file
 * runs in its own process), and only to make the TRIP-LESS guard see a live
 * deployment; nothing may be fetched while it is set, and a guard that let a
 * call through would hit a double, never Google.
 *
 * Run: node --import tsx/esm --test src/test/layoverRoutesBudgetScope.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js";
import { certifiedActionUniverse, certifiedLayoverSnapshot, LAYOVER_DISCOVERY_MODE_FLAG } from "../services/airport/LayoverSnapshot.js";
import * as TravelTime from "../services/airport/LayoverTravelTime.js";
import { landsideLeg, LAYOVER_TRAVEL_TIME_PROVIDER } from "../services/airport/LayoverTravelTime.js";
import { discoveryLayoverGate } from "../lib/discoveryLayoverMode.js";
import { corridorTravelTimeProvider } from "../lib/providers/corridorTravelTimeAdapter.js";
import {
  createGoogleRoutesCorridorProvider,
  CREDENTIAL_ENV,
  ENABLEMENT_ENV,
} from "../lib/providers/googleRoutesCorridorProvider.js";
import { refuse } from "../lib/providers/providerRefusal.js";
import type { RouteCorridorProvider } from "../lib/providers/routeCorridorProvider.js";
import type { TravelTimeProvider } from "../domain/trips/contracts/TravelTimeProvider.js";
import { currentRoutesRequestBudget, withRoutesRequestBudget } from "../domain/trips/contracts/RoutesRequestBudget.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const USER = "user-1";
const TRIP = "trip-9";
const LIVE = (n: string) => (n === CREDENTIAL_ENV ? "key" : n === ENABLEMENT_ENV ? "true" : undefined);
const AIRPORT_POINT = { lat: 25.0797, lng: 121.2342 };
const PLACE_POINT = { lat: 25.08, lng: 121.235 };

/** The F1 exports, looked up at run time so this file LOADS on a tree without them and fails per case. */
function f1(): {
  withLayoverRoutesBudget: (s: { userId: string; tripId: string | null; id?: string | null }, fn: () => Promise<any>, o?: { readEnv?: (n: string) => string | undefined }) => Promise<any>;
  layoverRoutesGuardedCorridor: (p: RouteCorridorProvider) => RouteCorridorProvider;
  ROUTES_UNSCOPED_NO_SESSION: string;
} {
  const m = TravelTime as Record<string, any>;
  assert.equal(typeof m.withLayoverRoutesBudget, "function", "LayoverTravelTime exports no withLayoverRoutesBudget");
  assert.equal(typeof m.layoverRoutesGuardedCorridor, "function", "LayoverTravelTime exports no layoverRoutesGuardedCorridor");
  assert.equal(m.ROUTES_UNSCOPED_NO_SESSION, "routes_unscoped_no_session");
  return m as any;
}

/** A Google Routes body the real adapter parses: one 20-minute drive. */
const BODY = { routes: [{ duration: "1200s", legs: [{ steps: [{ travelMode: "DRIVE", staticDuration: "1200s" }] }] }] };

/** The REAL corridor provider over an injected fetch and spend gate, both counting. */
function liveGoogle() {
  const spend = { calls: [] as unknown[], async decide(s: unknown) { spend.calls.push(s); return "granted" as const; } };
  const fetches = { n: 0 };
  const fetchImpl = (async () => { fetches.n += 1; return { ok: true, status: 200, json: async () => BODY } as unknown as Response; }) as unknown as typeof fetch;
  const corridor = createGoogleRoutesCorridorProvider({ fetchImpl, readEnv: LIVE, spendGate: spend, layoverSpendGate: spend as any });
  return { corridor, travel: corridorTravelTimeProvider(corridor), spend, fetches };
}

/** A routed travel-time double that WOULD answer 15 minutes, and counts. */
function routedDouble(): TravelTimeProvider & { calls: number } {
  const d = {
    id: "routed-double", routed: true, calls: 0,
    async estimate() {
      d.calls += 1;
      return {
        kind: "estimate" as const,
        estimate: {
          minutes: 15, p50Minutes: 15, p75Minutes: 15, p90Minutes: 15,
          confidence: "HIGH" as const, sourceClass: "LIVE" as const,
          observedAt: null, expiresAt: null, fallbackLevel: 0 as const, sourceRefs: ["routed-double"],
        },
      };
    },
  };
  return d;
}

/** A routed corridor double that counts, and refuses (so nothing downstream depends on its shape). */
function corridorDouble(): RouteCorridorProvider & { calls: number; budgets: unknown[] } {
  const d: any = {
    id: "corridor-double", routed: true, calls: 0, budgets: [] as unknown[],
    async corridor() { d.calls += 1; return refuse("corridor-double", "PROVIDER_UNAVAILABLE", "double"); },
    async bidirectional() {
      d.calls += 1;
      const b = currentRoutesRequestBudget();
      d.budgets.push(b ? { userId: b.userId, tripId: b.tripId, layoverSessionId: b.layoverSessionId ?? null } : null);
      return refuse("corridor-double", "PROVIDER_UNAVAILABLE", "double");
    },
  };
  return d;
}

/** Make the trip-less guard see a LIVE deployment for the length of `fn`. Restores exactly. */
async function withLiveRoutesEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { e: process.env[ENABLEMENT_ENV], k: process.env[CREDENTIAL_ENV] };
  process.env[ENABLEMENT_ENV] = "true";
  process.env[CREDENTIAL_ENV] = "test-only-not-a-key";
  try { return await fn(); } finally {
    if (saved.e === undefined) delete process.env[ENABLEMENT_ENV]; else process.env[ENABLEMENT_ENV] = saved.e;
    if (saved.k === undefined) delete process.env[CREDENTIAL_ENV]; else process.env[CREDENTIAL_ENV] = saved.k;
  }
}

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: AIRPORT_POINT.lat, lng: AIRPORT_POINT.lng,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

function session(over: Partial<LayoverSession> = {}): LayoverSession {
  const now = Date.now();
  return {
    id: "session-1", userId: USER, airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(now + 5 * 60_000).toISOString(),
    departureTime: new Date(now + 9 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 535,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    ...over,
  } as LayoverSession;
}

const PLACES = [
  { id: "place-1", name: "Night Market", place_type: "attraction", category: "food", neighborhood: "Zhongli", blurb: "Snacks", verified: true, city: "Taoyuan", status: "active", lat: 25.08, lng: 121.235, canonical_location_id: null },
  { id: "place-2", name: "Riverside Cafe", place_type: "cafe", category: "food", neighborhood: null, blurb: "Coffee", verified: false, city: "Taoyuan", status: "active", lat: 25.081, lng: 121.236, canonical_location_id: null },
];

function recTables(): Record<string, any[]> {
  return { discovery_places: PLACES.map((p) => ({ ...p })), layover_recommendations: [], layover_plan_stops: [], layover_events: [] };
}

function snapshotTables(tripId: string | null): Record<string, any[]> {
  const now = Date.now();
  return {
    feature_flags: [{ flag: LAYOVER_DISCOVERY_MODE_FLAG, enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      id: "session-1", user_id: USER, trip_id: tripId, immigration_required: false,
      arrival_time: new Date(now - 20 * 60_000).toISOString(),
      departure_time: new Date(now + 9 * 3_600_000).toISOString(),
      layover_minutes: 560, wants_to_leave: true, status: "active",
    })],
    layover_plan_stops: [],
    layover_events: [],
  };
}

async function liveSnapshot(tripId: string | null) {
  const r = await certifiedLayoverSnapshot(makeLayoverDb(snapshotTables(tripId)), USER);
  assert.ok(r.ok, `positive control: a live layover snapshot (${!r.ok ? r.reason : ""})`);
  assert.ok(r.snapshot.envelope, "positive control: the airport has a coordinate, so the corridor is asked");
  assert.notEqual(r.snapshot.landsideStatus, "closed", "positive control: landside is not closed, so the corridor is asked");
  return r.snapshot;
}

const CANDIDATES = [{ id: "cand-1", lat: PLACE_POINT.lat, lng: PLACE_POINT.lng }];

// ── 1. WITH A TRIP: the call is made, and charged to the traveller and the trip ──

const SESSION_CHARGE = { userId: USER, layoverSessionId: "session-1" };

describe("1. a layover read WITH a trip charges its routed calls to the traveller and the layover SESSION (R5), never the trip", () => {
  it("1a. recommendation generation (LayoverRecommendationService → landsideLeg): one charge per place, measured legs", async () => {
    const g = liveGoogle();
    const r = await generateRecommendations(makeLayoverDb(recTables()), AIRPORT, session({ tripId: TRIP }), Date.now(), { travelTimeProvider: g.travel });
    assert.ok(r.ok);
    assert.deepEqual(g.spend.calls, PLACES.map(() => SESSION_CHARGE), "each place's leg must be charged to this traveller and this layover session");
    assert.equal(g.fetches.n, PLACES.length, "the routed call was made");
    const landside = r.recommendations.filter((c) => !c.insideAirport && c.placeId);
    assert.ok(landside.length > 0 && landside.every((c) => c.travelTimeSource === "measured" && c.travelTimeMin === 20),
      JSON.stringify(landside.map((c) => [c.title, c.travelTimeMin, c.travelTimeSource])));
  });

  it("1b. the return corridor in certifiedActionUniverse: both directions charged to the session", async () => {
    const g = liveGoogle();
    const snap = await liveSnapshot(TRIP);
    await certifiedActionUniverse(snap, CANDIDATES, undefined, g.corridor);
    assert.deepEqual(g.spend.calls, [SESSION_CHARGE, SESSION_CHARGE], "outbound and return, each charged to the session");
    assert.equal(g.fetches.n, 2);
  });

  it("1c. Discovery's layover timing (discoveryLayoverMode → statedLayoverTimings → landsideLeg): charged to the session", async () => {
    const g = liveGoogle();
    const gate = await discoveryLayoverGate(makeLayoverDb(snapshotTables(TRIP)), USER, CANDIDATES, "GET /test", { provider: g.travel });
    assert.ok(gate.ok && gate.active, `positive control: layover mode applies (${JSON.stringify(gate).slice(0, 200)})`);
    assert.ok(g.spend.calls.length >= 1, "the timing leg was never charged — it ran outside any Routes budget");
    for (const c of g.spend.calls) assert.deepEqual(c, SESSION_CHARGE);
  });

  it("1d. nested inside an enclosing read's budget, the layover scope shares its counter", async () => {
    const { withLayoverRoutesBudget } = f1();
    await withRoutesRequestBudget({ userId: USER, tripId: TRIP }, async () => {
      const outer = currentRoutesRequestBudget();
      await withLayoverRoutesBudget({ id: "session-1", userId: USER, tripId: TRIP }, async () => {
        assert.equal(currentRoutesRequestBudget()?.counter, outer?.counter, "one read, one budget");
        assert.equal(currentRoutesRequestBudget()?.layoverSessionId, "session-1", "charged to its own session");
      });
    });
  });
});

// ── 2. R5(a): a trip-less layover is charged to its SESSION; no session → the named absence ──

describe("2. a trip-less layover is charged to its session; a read that names no session is routes_unscoped_no_session", () => {
  it("2a. landsideLeg in a read that names no session: the named absence, zero calls; a missing coordinate keeps its own reason", async () => {
    const { withLayoverRoutesBudget } = f1();
    const d = routedDouble();
    const leg = await withLayoverRoutesBudget({ userId: USER, tripId: null }, () => landsideLeg(AIRPORT_POINT, PLACE_POINT, new Date(), d), { readEnv: LIVE });
    assert.equal(d.calls, 0, "the provider was called for a read nobody can be charged for");
    assert.equal(leg.minutes, null);
    assert.equal(leg.source, "unmeasured");
    assert.equal(leg.reason, "NO_ROUTED_PROVIDER");
    assert.match(String(leg.detail), /^routes_unscoped_no_session/);
    const noPoint = await withLayoverRoutesBudget({ userId: USER, tripId: null }, () => landsideLeg(AIRPORT_POINT, null, new Date(), d), { readEnv: LIVE });
    assert.equal(noPoint.reason, "NO_COORDINATES");
    assert.equal(d.calls, 0);
  });

  it("2b. recommendation generation for a trip-less layover: each place's leg is charged to the traveller and the session", async () => {
    const g = liveGoogle();
    const r = await generateRecommendations(makeLayoverDb(recTables()), AIRPORT, session({ tripId: null }), Date.now(), { travelTimeProvider: g.travel });
    assert.ok(r.ok);
    assert.deepEqual(g.spend.calls, PLACES.map(() => SESSION_CHARGE));
    const landside = r.recommendations.filter((c) => !c.insideAirport && c.placeId);
    assert.ok(landside.length > 0 && landside.every((c) => c.travelTimeSource === "measured"));
  });

  it("2c. the return corridor in certifiedActionUniverse is asked for a trip-less layover, inside its session's budget", async () => {
    const snap = await liveSnapshot(null);
    await withLiveRoutesEnv(async () => {
      const d = corridorDouble();
      await certifiedActionUniverse(snap, CANDIDATES, undefined, d);
      assert.equal(d.calls, 1);
      assert.deepEqual(d.budgets, [{ userId: USER, tripId: null, layoverSessionId: "session-1" }]);
    });
  });

  it("2d. the guarded corridor names the absence for a no-session read in the port's own refusal shape, without calling inner", async () => {
    const { withLayoverRoutesBudget, layoverRoutesGuardedCorridor } = f1();
    const d = corridorDouble();
    const r = await withLayoverRoutesBudget({ userId: USER, tripId: null }, () => layoverRoutesGuardedCorridor(d).bidirectional({
      airport: AIRPORT_POINT, candidate: PLACE_POINT, outboundDepartAt: new Date(), returnDepartAt: new Date(Date.now() + 3_600_000),
    }), { readEnv: LIVE });
    assert.equal(d.calls, 0);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "PROVIDER_NOT_ENABLED");
      assert.match(r.detail, /^routes_unscoped_no_session/);
    }
  });
});

// ── 3. Routes NOT live (every deployment today): exactly today's behaviour ──────

describe("3. with Routes not live the scope changes nothing", () => {
  it("3a. a leg inside the scope, with or without a trip, is byte-identical to the unwrapped leg", async () => {
    const { withLayoverRoutesBudget } = f1();
    const at = new Date();
    const bare = await landsideLeg(AIRPORT_POINT, PLACE_POINT, at, LAYOVER_TRAVEL_TIME_PROVIDER);
    assert.equal(bare.minutes, null, "positive control: Routes is not live in this environment");
    const off = (_: string) => undefined;
    for (const tripId of [TRIP, null]) {
      const wrapped = await withLayoverRoutesBudget({ userId: USER, tripId }, () => landsideLeg(AIRPORT_POINT, PLACE_POINT, at, LAYOVER_TRAVEL_TIME_PROVIDER), { readEnv: off });
      assert.deepEqual(wrapped, bare, `tripId=${tripId}`);
    }
  });

  it("3b. certifiedActionUniverse is the same answer for a trip, no trip, and a snapshot built elsewhere (unscoped)", async () => {
    const withTrip = await certifiedActionUniverse(await liveSnapshot(TRIP), CANDIDATES);
    const noTrip = await certifiedActionUniverse(await liveSnapshot(null), CANDIDATES);
    const snap = await liveSnapshot(TRIP);
    const elsewhere = await certifiedActionUniverse({ ...snap }, CANDIDATES);
    const strip = (u: any) => ({ ...u, snapshotId: "-", certification: "-" });
    assert.deepEqual(strip(withTrip).actions, strip(noTrip).actions);
    assert.deepEqual(strip(elsewhere).actions, strip(withTrip).actions);
    assert.deepEqual(withTrip.admittedIds, noTrip.admittedIds);
  });
});
