/**
 * LAYOVER 165, lane B1-R1 — the certified action universe (Discovery's Layover
 * mode, census §39's per-candidate ask) now evaluates §8's formula with ROUTED
 * terms rather than only reading a risk flag off the way back.
 *
 *   L65  a candidate whose caller stated its activity but not its journey is
 *        ADMITTED on the routed outbound + the CONSERVATIVE routed return, and
 *        BLOCKED when that conservative return no longer fits — through the
 *        universe's own `candidateFits`;
 *   L60  each candidate's way back is asked for ITS instant (window start + its
 *        way out + its dwell), not one instant for all;
 *   L260 a candidate the straight-line envelope proves unreachable is never
 *        asked, and at most six are routed per universe;
 *   L66  the universe publishes the routed union.
 *
 * The snapshot is the real `certifiedLayoverSnapshot` over the house fake; the
 * corridor port is a double answering well-formed corridors (the Google parse
 * is pinned in layoverRoutedProviderContract.test.ts).
 *
 * Run: node --import tsx/esm --test src/test/layoverRoutedUniverse.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { certifiedActionUniverse, certifiedLayoverSnapshot, LAYOVER_DISCOVERY_MODE_FLAG } from "../services/airport/LayoverSnapshot.js";
import {
  bothDirections,
  independentRouteCount,
  measured,
  unmeasured,
  type CorridorQuery,
  type RouteCorridorProvider,
  type RouteOption,
} from "../lib/providers/routeCorridorProvider.js";
import { refuse } from "../lib/providers/providerRefusal.js";

const USER = "user-1";
const AIRPORT = { lat: 25.0797, lng: 121.2342 };
const east = (km: number) => ({ lat: AIRPORT.lat, lng: AIRPORT.lng + km / (111.32 * Math.cos((AIRPORT.lat * Math.PI) / 180)) });
const isAirport = (p: { lat: number; lng: number } | null) => !!p && p.lat === AIRPORT.lat && p.lng === AIRPORT.lng;

async function liveSnapshot() {
  const now = Date.now();
  const r = await certifiedLayoverSnapshot(makeLayoverDb({
    feature_flags: [{ flag: LAYOVER_DISCOVERY_MODE_FLAG, enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      id: "session-1", user_id: USER, trip_id: null, immigration_required: false,
      arrival_time: new Date(now - 20 * 60_000).toISOString(), departure_time: new Date(now + 9 * 3_600_000).toISOString(),
      layover_minutes: 560, wants_to_leave: true, status: "active",
    })],
    layover_plan_stops: [], layover_events: [],
  }), USER);
  assert.ok(r.ok && r.snapshot.envelope && r.snapshot.landsideStatus !== "closed", "positive control: a live layover with landside not closed");
  return r.snapshot;
}

/** A corridor double: `back(minutes)` per candidate longitude, three independent drives each way. */
function corridors(backMinutes: (lng: number) => number, outMinutes = 20) {
  const asked: CorridorQuery[] = [];
  const route = (m: number): RouteOption => ({ legs: [{ mode: "drive", minutes: m, distanceMeters: 1, interruptibility: "interruptible", transferPointId: null }], totalMinutes: m, transferCount: 0 });
  const p: RouteCorridorProvider & { asked: CorridorQuery[] } = {
    id: "double", routed: true, asked,
    async corridor(q) {
      asked.push(q);
      const m = isAirport(q.to) ? backMinutes(q.from!.lng) : outMinutes;
      const routes = [route(m), route(m + 3), route(m + 6)];
      return { ok: true, value: {
        from: q.from!, to: q.to!, departAt: q.departAt.toISOString(), routes, independentRouteCount: independentRouteCount(routes),
        reliability: measured({ spreadMinutes: 6, optionCount: 3 }, "LIVE", "MEDIUM", ["d"]),
        queueFriction: unmeasured("x"), weather: unmeasured("x"), airportReentryMinutes: unmeasured("x"),
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        sourceClass: "LIVE", confidence: "MEDIUM", sourceRefs: ["d"],
      } };
    },
    async bidirectional(q) { return bothDirections(p, q); },
  };
  return p;
}

describe("L65 on the Discovery path — the universe certifies with routed terms", () => {
  it("U1. stated activity, no stated journey: ADMITTED on routed out + conservative return; BLOCKED once the conservative return no longer fits", async () => {
    const snap = await liveSnapshot();
    const W = snap.usableMinutes;
    const near = east(10), edge = east(11);
    const dwell = 60;
    // `edge`'s way back is sized to fit raw and NOT once it is held back 25% (the record is LOW).
    const fitsRaw = W - 20 - dwell - 1;
    const p = corridors((lng) => (lng === edge.lng ? fitsRaw : 25));
    const u = await certifiedActionUniverse(snap, [
      { id: "near", lat: near.lat, lng: near.lng, activityTimeMin: dwell },
      { id: "edge", lat: edge.lat, lng: edge.lng, activityTimeMin: dwell },
    ], undefined, p);
    assert.ok(u.admittedIds.includes("near"), JSON.stringify(u.actions.find((a) => a.id === "near")));
    const e = u.actions.find((a) => a.id === "edge")!;
    assert.equal(e.state, "BLOCKED", "20 + 60 + the conservative return overflows the certified window");
    assert.deepEqual(u.universe.feasibleCandidateIds, ["near"], "the §11.1 universe's own candidateFits agrees");
    const nearRouted = u.routed!.find((r) => r.key === "near")!;
    assert.equal(nearRouted.terms!.outboundMinutes, 20);
    assert.equal(nearRouted.terms!.conservativeReturnMinutes, Math.ceil(25 * 1.25));
  });

  it("U2. before routing existed the same candidate was UNMEASURED: no journey term, no admission (the routed provider refusing gives exactly that)", async () => {
    const snap = await liveSnapshot();
    const near = east(10);
    const refusing: RouteCorridorProvider = { id: "off", routed: true, async corridor() { return refuse("off", "PROVIDER_NOT_ENABLED", "off"); }, async bidirectional() { return refuse("off", "PROVIDER_NOT_ENABLED", "off"); } };
    const u = await certifiedActionUniverse(snap, [{ id: "near", lat: near.lat, lng: near.lng, activityTimeMin: 60 }], undefined, refusing);
    assert.deepEqual(u.unmeasuredIds, ["near"]);
    assert.equal(u.actions[0]!.reason, "nobody has measured how long this takes, so it cannot be certified against your window");
  });
});

describe("L60 / L260 / L66 on the universe", () => {
  it("U3. each way back is asked for its own candidate's instant: window start + its way out + its dwell", async () => {
    const snap = await liveSnapshot();
    const p = corridors(() => 25);
    const a = east(8), b = east(9);
    await certifiedActionUniverse(snap, [
      { id: "a", lat: a.lat, lng: a.lng, travelTimeMin: 18, activityTimeMin: 30 },
      { id: "b", lat: b.lat, lng: b.lng, travelTimeMin: 18, activityTimeMin: 90 },
    ], undefined, p);
    const start = Math.max(snap.certifiedRecord.inputs.nowMs, snap.certifiedRecord.envelope.earliestOutTime.getTime());
    const back = (lng: number) => p.asked.find((q) => isAirport(q.to) && q.from!.lng === lng)!.departAt.getTime();
    assert.equal(back(a.lng), start + (18 + 30) * 60_000);
    assert.equal(back(b.lng), start + (18 + 90) * 60_000);
    assert.notEqual(back(a.lng), back(b.lng), "not one instant for every candidate");
  });

  it("U4. a candidate the straight-line envelope proves unreachable is never asked; at most six are routed", async () => {
    const snap = await liveSnapshot();
    const p = corridors(() => 25);
    const far = east(900);
    const many = Array.from({ length: 8 }, (_, i) => { const pt = east(3 + i); return { id: `c${i}`, lat: pt.lat, lng: pt.lng, activityTimeMin: 30 }; });
    const u = await certifiedActionUniverse(snap, [{ id: "far", lat: far.lat, lng: far.lng, activityTimeMin: 30 }, ...many], undefined, p);
    assert.ok(!p.asked.some((q) => q.from!.lng === far.lng || q.to!.lng === far.lng), "the proved-unreachable place was asked of the router");
    const askedAbout = new Set(p.asked.map((q) => (isAirport(q.to) ? q.from!.lng : q.to!.lng)));
    assert.equal(askedAbout.size, 6);
    assert.equal(u.actions.find((a) => a.id === "far")!.state, "BLOCKED");
    assert.deepEqual(u.routed!.filter((r) => r.prefilter === "candidate_cap").map((r) => r.key).sort(), ["c6", "c7"]);
  });

  it("U5. the universe publishes §8's routed union over what it routed", async () => {
    const snap = await liveSnapshot();
    const a = east(5);
    const u = await certifiedActionUniverse(snap, [{ id: "a", lat: a.lat, lng: a.lng, activityTimeMin: 30 }], undefined, corridors(() => 25));
    assert.equal(u.routedEnvelope?.basis, "routed_union");
    assert.deepEqual(u.routedEnvelope!.members.map((m) => m.key), ["a"]);
  });
});
