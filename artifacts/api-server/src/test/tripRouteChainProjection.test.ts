/**
 * Trips spec §14.2 / §25 — the trip's route chain as a projection of its own
 * plan (census-trips TR437, TR266), and a route plan on a trip as a VIEW
 * over that plan under the gate.
 *
 *   1. the builder on the health fixture's Paris trip: placed plan items in
 *      start order, one hop with the bound and the assumption, the crew as
 *      party size, 2782's segment matched by label with cost and reliability,
 *      the unplaced named by reason, a §21.2 decision recorded;
 *   2. the segments read failing softly; the gate closed refusing;
 *   3. GET /trips/:id/route-chain through the real app — member, non-member,
 *      gate closed; the Compass tool get_route_chain;
 *   4. POST /route-plans with a tripId under the gate refuses a stop that is
 *      not one of the trip's plan items (TRIP_IDENTITY_STOP_NOT_IN_PLAN), and
 *      lets plan-item stops through to the insert.
 *
 * Run: node --import tsx/esm --test src/test/tripRouteChainProjection.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import routePlanRouter from "../routes/routePlan.js";
import { buildTripRouteChainProjection } from "../domain/trips/projections/TripRouteChainProjection.js";
import { readTripDecision } from "../domain/trips/services/TripDecisionLedger.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import type { CompassProfile } from "../compass/types.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NOW = new Date("2026-09-13T09:00:00.000Z");
const A = "cccccccc-cccc-cccc-cccc-ccccccccccc1"; const B = "cccccccc-cccc-cccc-cccc-ccccccccccc2";
const C = "cccccccc-cccc-cccc-cccc-ccccccccccc3"; const D = "cccccccc-cccc-cccc-cccc-ccccccccccc4";
const item = (id: string, o: Record<string, any>) => ({ id, trip_id: TRIP_ID, title: id, category: "activity", status: "planned", starts_at: null, ends_at: null, day_date: "2026-09-13", lat: null, lng: null, location_name: null, removed_at: null, ...o });

function tables(opts: { gate?: boolean; segment?: boolean } = {}) {
  const t = base();
  t.feature_flags = [{ flag: "trip_operational_projections_enabled", enabled: opts.gate ?? true }];
  t.trip_plan_items = [
    item(B, { starts_at: "2026-09-13T13:00:00.000Z", lat: 48.9466, lng: 2.3522, location_name: "B place" }),
    item(A, { starts_at: "2026-09-13T10:00:00.000Z", ends_at: "2026-09-13T11:00:00.000Z", lat: 48.8566, lng: 2.3522, location_name: "A place" }),
    item(C, { lat: 48.8, lng: 2.3 }),
    item(D, { starts_at: "2026-09-13T15:00:00.000Z" }),
  ];
  t.trip_transport_segments = opts.segment === false ? [] : [
    { id: "seg-1", trip_id: TRIP_ID, mode: "transit", state: "planned", from_label: "A place", to_label: "B place", planned_departure_at: null, planned_arrival_at: null, party_size: null, reliability: null, cost_minor: 250, currency: "EUR", fallback_of: null },
  ];
  return t;
}

describe("the route chain is the trip's plan, in order, with what §14.2 says a chain carries", () => {
  it("two placed items, one hop: departure from A's end, the bound and the assumption, party size 2, the segment's cost and reliability; C and D unplaced by reason", async () => {
    const r = await buildTripRouteChainProjection(makeClient(tables()) as any, TRIP_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const p = r.projection;
    assert.deepEqual(p.stops.map((s) => s.planItemId), [A, B], "start order, not row order");
    assert.deepEqual(p.unplaced, [{ planItemId: C, reason: "NO_TIME" }, { planItemId: D, reason: "NO_POINT" }]);
    assert.equal(p.hops.length, 1);
    const h = p.hops[0]!;
    assert.equal(h.fromPlanItemId, A); assert.equal(h.toPlanItemId, B);
    assert.equal(h.departAt, "2026-09-13T11:00:00.000Z", "leaves when A ends");
    assert.ok(h.travel.boundMinutes! > 0); assert.ok(h.travel.expectedMinutes! >= h.travel.boundMinutes!);
    assert.equal(h.travel.routed, false); assert.equal(h.travel.sourceClass, "STATIC_DEFAULT");
    assert.equal(h.travel.assumption!.timezone, "Europe/Paris"); assert.equal(h.travel.assumption!.localHour, 13);
    assert.ok(Date.parse(h.expectedArrivalAt!) >= Date.parse(h.arrivalAtBound!));
    assert.equal(h.partySize, 2, "owner + accepted member");
    assert.ok(h.segment); assert.equal(h.segment!.costMinor, 250); assert.equal(h.segment!.currency, "EUR");
    assert.equal(h.segment!.reliability.basis, "estimated"); assert.ok(h.segment!.reliability.value > 0 && h.segment!.reliability.value <= 1);
    assert.deepEqual(p.segments, { status: "ok", reason: null, count: 1 });
    assert.equal(p.provider.id, "straight-line"); assert.equal(p.provider.routed, false);
    const d = readTripDecision(p.decisionId)!;
    assert.equal(d.type, "route_chain"); assert.equal(d.result.hops, 1); assert.equal(d.result.withSegment, 1);
    assert.match(p.reading, /no stop exists that is not a plan item/);
  });
  it("no segment for the hop: cost, reliability and fallback are null and the chain still exists", async () => {
    const r = await buildTripRouteChainProjection(makeClient(tables({ segment: false })) as any, TRIP_ID, { now: NOW });
    assert.ok(r.ok); assert.equal(r.projection.hops[0]!.segment, null); assert.equal(r.projection.segments.count, 0);
  });
  it("segments unreadable (2782 absent): read softly — status unread with the reason, hops without a segment, projection served", async () => {
    const r = await buildTripRouteChainProjection(makeClient(tables(), ["trip_transport_segments"]) as any, TRIP_ID, { now: NOW });
    assert.ok(r.ok); assert.equal(r.projection.segments.status, "unread"); assert.match(r.projection.segments.reason!, /2782/);
    assert.equal(r.projection.hops.length, 1); assert.equal(r.projection.hops[0]!.segment, null);
  });
  it("gate closed → FEATURE_DISABLED; plan unreadable → refused, never an empty chain", async () => {
    let r = await buildTripRouteChainProjection(makeClient(tables({ gate: false })) as any, TRIP_ID, { now: NOW });
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, "FEATURE_DISABLED");
    r = await buildTripRouteChainProjection(makeClient(tables(), ["trip_plan_items"]) as any, TRIP_ID, { now: NOW });
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, "TRIP_PROJECTION_UNAVAILABLE");
  });
});

describe("GET /trips/:tripId/route-chain and the Compass tool", () => {
  let server: Server; let port = 0;
  after(() => server?.close());
  async function get(token: string) {
    if (!server) await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
    const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/route-chain`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() as any };
  }
  it("a member reads the chain; a non-member is refused with TRIP_AUTH_NOT_CREW; the gate closed answers feature_disabled", async () => {
    const c = makeClient(tables()); _setTestClient(c as any, true); _setTestServiceClient(c as any);
    let r = await get("owner-token");
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.hops.length, 1); assert.equal(r.body.tripId, TRIP_ID);
    r = await get("other-token");
    assert.equal(r.status, 403); assert.equal(r.body.reason, "TRIP_AUTH_NOT_CREW");
    const off = makeClient(tables({ gate: false })); _setTestClient(off as any, true); _setTestServiceClient(off as any);
    r = await get("owner-token");
    assert.equal(r.body.error, "feature_disabled");
  });
  it("get_route_chain hands the conversation the hops, briefly", async () => {
    const profile = { userId: OWNER_ID, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
    const r: any = await executeCompassTool(makeClient(tables()) as any, OWNER_ID, profile, "get_route_chain", { tripId: TRIP_ID });
    assert.equal(r.chain.tripId, TRIP_ID); assert.equal(r.chain.hops.length, 1);
    assert.equal(r.chain.hops[0].from, A); assert.equal(r.chain.hops[0].to, B);
    assert.ok(r.chain.hops[0].expectedArrivalAt);
    const denied: any = await executeCompassTool(makeClient(tables()) as any, "33333333-3333-3333-3333-333333333333", profile, "get_route_chain", { tripId: TRIP_ID });
    assert.equal(denied.chain, null); assert.match(denied.info, /not a member/);
  });
  it("the sanitizer keeps a camelCase `…At` time: get_route_chain's expectedArrivalAt and get_commitments' requiredArrivalAt reach the conversation (they did not before §62)", async () => {
    const profile = { userId: OWNER_ID, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
    const chain: any = await executeCompassTool(makeClient(tables()) as any, OWNER_ID, profile, "get_route_chain", { tripId: TRIP_ID });
    assert.ok("expectedArrivalAt" in chain.chain.hops[0], "expectedArrivalAt is on the wire");
    const commitments: any = await executeCompassTool(makeClient(tables()) as any, OWNER_ID, profile, "get_commitments", { tripId: TRIP_ID });
    const b = commitments.commitments.find((c: any) => c.requiredArrivalAt !== null && c.requiredArrivalAt !== undefined);
    assert.ok(b, `a commitment with requiredArrivalAt on the wire: ${JSON.stringify(commitments).slice(0, 300)}`);
    assert.equal(b.requiredArrivalAt, "2026-09-13T16:00:00.000Z");
  });
});

describe("POST /route-plans on a trip is a VIEW over the trip's plan under the gate (TR437)", () => {
  let server: Server; let port = 0;
  after(() => server?.close());
  function withAuth(c: any) {
    c.auth = { getUser: async (token: string) => token === "owner-token" ? { data: { user: { id: OWNER_ID } }, error: null } : { data: { user: null }, error: { message: "invalid" } } };
    const from = c.from.bind(c);
    c.from = (table: string) => { const b = from(table); b.insert = () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "fixture: no insert" } }), maybeSingle: async () => ({ data: null, error: { message: "fixture: no insert" } }) }) }); return b; };
    return c;
  }
  async function post(body: unknown) {
    if (!server) {
      const ex = express(); ex.use(express.json()); ex.use((req: any, _res, next) => { req.log = { info() {}, warn() {}, error() {} }; next(); }); ex.use("/api", routePlanRouter);
      await new Promise<void>((r) => { server = createServer(ex); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/route-plans`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner-token" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  }
  const stops = (sourceType: string, sourceId: string | undefined) => [
    { title: "one", lat: 48.85, lng: 2.35, sourceType, sourceId },
    { title: "two", lat: 48.86, lng: 2.36, sourceType: "plan_item", sourceId: B },
  ];
  it("a discovery stop on a trip route plan is refused with TRIP_IDENTITY_STOP_NOT_IN_PLAN; plan-item stops pass the check", async () => {
    _setTestClient(withAuth(makeClient(tables())) as any, true);
    let r = await post({ tripId: TRIP_ID, stops: stops("discovery", "d-1") });
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.reason, "TRIP_IDENTITY_STOP_NOT_IN_PLAN");
    r = await post({ tripId: TRIP_ID, stops: stops("plan_item", "not-a-plan-item") });
    assert.equal(r.status, 409); assert.equal(r.body.reason, "TRIP_IDENTITY_STOP_NOT_IN_PLAN");
    r = await post({ tripId: TRIP_ID, stops: stops("plan_item", A) });
    assert.notEqual(r.body.reason, "TRIP_IDENTITY_STOP_NOT_IN_PLAN", "reaches the insert (the fixture has none, so the route answers db_error)");
    assert.notEqual(r.status, 409);
  });
  it("gate closed: today's behaviour — nothing is refused for its source", async () => {
    _setTestClient(withAuth(makeClient(tables({ gate: false }))) as any, true);
    const r = await post({ tripId: TRIP_ID, stops: stops("discovery", "d-1") });
    assert.notEqual(r.status, 409); assert.notEqual(r.body.reason, "TRIP_IDENTITY_STOP_NOT_IN_PLAN");
  });
});
