/**
 * Trips §14.1 — `GET /trips/:tripId/map-projection`.
 *
 * WHAT THIS CLOSES
 * ================
 * census-trips TR254: "No trip map projection endpoint or type. `GET
 * /trips/:tripId/plan/map` returns plan items with coordinates — a marker
 * list, not a projection with a version and a generated-at."
 *
 * The difference is not cosmetic. A marker list cannot say what state of the
 * trip it is drawing, so two clients rendering the same trip can disagree and
 * neither can notice. §14.1 names `generatedAt` and `sourceTripVersion` for
 * exactly that reason, and this file pins both plus the three properties the
 * projection exists to guarantee:
 *
 *   1. §14.4 — a private lodging anchor NEVER reaches a layer a consumer may
 *      merge into a broad view. Enforced by construction AND re-checked by a
 *      postcondition that THROWS, because the thing being guarded is a coding
 *      mistake in the assembly and a convention cannot catch one of those.
 *   2. Every layer is three-valued. On a map, nothing on the screen looks
 *      exactly like nothing in the world, so a failed read is `unread` and
 *      never an empty layer.
 *   3. A layer with NO PRODUCER is `no_source`, stated rather than omitted —
 *      a projection carrying eight layers must not be read as ten with two
 *      empty.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import {
  assertNoPrivateLeak, layerCensus, coordsOf, isAttributable,
  PROJECTION_LAYERS, PrivateAnchorLeak,
  ok, unread, noSource, type TripMapProjection,
} from "../services/trips/TripMapProjection.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";
const TRIP_ID  = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PLACE_A  = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1";

type Row = Record<string, any>;

function makeClient(tables: Record<string, Row[]>, errorOn: string[] = []) {
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token") return { data: { user: { id: OWNER_ID } }, error: null };
        if (token === "other-token") return { data: { user: { id: OTHER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from(table: string) {
      if (errorOn.includes(table)) {
        const f: any = {
          select: () => f, eq: () => f, in: () => f, is: () => f, order: () => f, limit: () => f,
          maybeSingle: async () => ({ data: null, error: { message: `${table} unavailable` } }),
          then: (onF: any, onR: any) =>
            Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(onF, onR),
        };
        return f;
      }
      const filters: Array<(r: Row) => boolean> = [];
      let single = false;
      const settle = () => {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return { data: single ? rows[0] ?? null : rows, error: null };
      };
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        order: () => chain, limit: () => chain,
        maybeSingle: async () => { single = true; return settle(); },
        single: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      return chain;
    },
  };
}

const crew = [{ trip_id: TRIP_ID, user_id: OWNER_ID, status: "accepted", role: "owner" }];
const empty = {
  trips: [{ id: TRIP_ID, owner_id: OWNER_ID, version: 7 }],
  trip_members: crew,
  trip_stages: [], trip_plan_items: [], trip_commitments: [],
  trip_saved_places: [], places: [], route_plans: [], route_stops: [],
};

const routePlan = (o: Row = {}) => ({
  id: "rp1", trip_id: TRIP_ID, title: "Friday night", status: "active", ...o,
});
const routeStop = (o: Row = {}) => ({
  id: "rs1", route_plan_id: "rp1", title: "Bar",
  structured_location: { label: "Bar", lat: 38.71, lng: -9.13 },
  order_index: 0, checkpoint_status: "pending", ...o,
});

const planItem = (o: Row = {}) => ({
  id: "pi1", trip_id: TRIP_ID, title: "Dinner", category: "activity", status: "planned",
  lat: 38.72, lng: -9.14, location_is_private: false, location_name: null,
  removed_at: null, ...o,
});

let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); });
  });
}
after(() => { server?.close(); });

// `res.json()` is typed `Promise<unknown>`, so without this annotation every
// `r.body.<field>` below is a TS18046 error. The response body of an HTTP
// route genuinely has no static type at the fetch boundary — the assertions
// in this file ARE the shape check. Same annotation as
// src/test/tripPresenceRoute.test.ts:110.
async function get(
  token = "owner-token",
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/map-projection`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function install(tables: Record<string, Row[]>, errorOn: string[] = []) {
  const c = makeClient({ ...empty, ...tables }, errorOn);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
}

beforeEach(async () => { if (!server) await start(); });

describe("§14.1 — the envelope a marker list cannot have", () => {
  it("carries generatedAt and sourceTripVersion", async () => {
    install({});
    const r = await get();
    assert.equal(r.status, 200);
    assert.ok(!Number.isNaN(Date.parse(r.body.generatedAt)));
    assert.equal(r.body.sourceTripVersion, 7, "the kernel aggregate version is what makes this attributable");
  });

  it("an unreadable version is NULL, not 0 — a default would be a version claim", async () => {
    install({}, ["trips"]);
    const r = await get();
    // The trip_members gate uses its own read, so a failed `trips` read does
    // not stop the projection; it makes it unattributable.
    assert.equal(r.body.sourceTripVersion, null);
  });

  it("declares all TEN of §14.1's layers, every time", async () => {
    install({});
    const r = await get();
    for (const key of PROJECTION_LAYERS) {
      assert.ok(r.body[key], `layer ${key} is missing from the projection`);
      assert.ok(["ok", "unread", "no_source"].includes(r.body[key].status), key);
    }
    assert.equal(PROJECTION_LAYERS.length, 10);
  });

  it("says how many layers carry data, so eight is never read as ten", async () => {
    install({ trip_plan_items: [planItem()] });
    const r = await get();
    assert.equal(r.body.census.ok + r.body.census.unread + r.body.census.noSource, 10);
    // §13 gave liveOpportunities a producer (§43) and §17.4 / §7.4 gave safetyPoints one (§45); one layer has none.
    assert.equal(r.body.census.noSource, 1, "the one layer with no producer: crew presence summaries");
    assert.ok(r.body.census.totalPoints >= 1);
  });
});

describe("§14.4 — a private anchor never reaches a broad layer", () => {
  it("a private-flagged plan item goes ONLY to privateAnchors", async () => {
    install({
      trip_plan_items: [
        planItem({ id: "public", location_is_private: false }),
        planItem({ id: "hotel", location_is_private: true }),
      ],
    });
    const r = await get();
    assert.deepEqual(r.body.activePlans.items.map((p: any) => p.id), ["public"]);
    assert.deepEqual(r.body.privateAnchors.items.map((p: any) => p.id), ["hotel"]);
    assert.equal(r.body.privateAnchors.items[0].privateAnchor, true);
  });

  it("a private MEETING POINT is an anchor, not a meetup point", async () => {
    // The category check must not run before the privacy check, or a private
    // lodging labelled 'meeting_point' would land in a shareable layer.
    install({
      trip_plan_items: [planItem({ id: "m", category: "meeting_point", location_is_private: true })],
    });
    const r = await get();
    assert.deepEqual(r.body.meetupPoints.items, []);
    assert.deepEqual(r.body.privateAnchors.items.map((p: any) => p.id), ["m"]);
  });

  it("the postcondition THROWS on a leak rather than filtering it", () => {
    // Filtering would hide the bug and leave it in place. The thing guarded is
    // a coding mistake in the assembly, and the only useful response is to
    // refuse to serve the projection.
    const leaky: TripMapProjection = {
      tripId: TRIP_ID, generatedAt: new Date().toISOString(), sourceTripVersion: 1,
      stage: ok([]),
      privateAnchors: ok([]),
      activePlans: ok([{ id: "hotel", kind: "plan", lat: 1, lng: 1, label: null, privateAnchor: true }]),
      confirmedCommitments: ok([]), savedIdeas: ok([]),
      crewPresenceSummaries: noSource("x"), routeChains: noSource("x"),
      meetupPoints: ok([]), liveOpportunities: noSource("x"), safetyPoints: noSource("x"),
    };
    assert.throws(() => assertNoPrivateLeak(leaky), PrivateAnchorLeak);
    try { assertNoPrivateLeak(leaky); } catch (e: any) {
      assert.equal(e.layer, "activePlans");
      assert.equal(e.pointId, "hotel");
      assert.match(e.message, /§14.4/);
    }
  });

  it("the SAME point in privateAnchors is not a leak", () => {
    const fine: TripMapProjection = {
      tripId: TRIP_ID, generatedAt: new Date().toISOString(), sourceTripVersion: 1,
      stage: ok([]),
      privateAnchors: ok([{ id: "hotel", kind: "private_anchor", lat: 1, lng: 1, label: null, privateAnchor: true }]),
      activePlans: ok([]), confirmedCommitments: ok([]), savedIdeas: ok([]),
      crewPresenceSummaries: noSource("x"), routeChains: noSource("x"),
      meetupPoints: ok([]), liveOpportunities: noSource("x"), safetyPoints: noSource("x"),
    };
    assert.doesNotThrow(() => assertNoPrivateLeak(fine));
  });

  it("an UNREAD layer cannot hide a leak, because it has no items to check", () => {
    const partial: TripMapProjection = {
      tripId: TRIP_ID, generatedAt: new Date().toISOString(), sourceTripVersion: 1,
      stage: unread("x"), privateAnchors: ok([]), activePlans: unread("x"),
      confirmedCommitments: ok([]), savedIdeas: ok([]),
      crewPresenceSummaries: noSource("x"), routeChains: noSource("x"),
      meetupPoints: ok([]), liveOpportunities: noSource("x"), safetyPoints: noSource("x"),
    };
    assert.doesNotThrow(() => assertNoPrivateLeak(partial));
  });
});

describe("§14.1 — a failed read is `unread`, never an empty layer", () => {
  it("unreadable plan items marks its THREE layers unread, not empty", async () => {
    // active plans, private anchors and meetup points come from one read, so
    // one failure must mark all three — three different answers from one
    // failed query would be worse than one.
    install({}, ["trip_plan_items"]);
    const r = await get();
    assert.equal(r.status, 200, "one broken layer must not hide nine working ones");
    for (const key of ["activePlans", "privateAnchors", "meetupPoints"]) {
      assert.equal(r.body[key].status, "unread", key);
      assert.equal(r.body[key].items, undefined, `${key} served items alongside 'unread'`);
    }
  });

  it("unreadable stages is unread; stages with no anchor are simply absent", async () => {
    const withStage = {
      trip_stages: [{ id: "s1", trip_id: TRIP_ID, stage_type: "city", state: "planned", sequence: 1, place_id: null }],
    };
    install(withStage);
    const noAnchor = await get();
    assert.equal(noAnchor.body.stage.status, "ok",
      "a stage with no anchor is not a map object, and that is not a read failure");
    assert.deepEqual(noAnchor.body.stage.items, []);

    install(withStage, ["trip_stages"]);
    const broken = await get();
    assert.equal(broken.body.stage.status, "unread");
  });

  it("stages that read fine with an unreadable PLACES table is unread, not unlocated", async () => {
    install({
      trip_stages: [{ id: "s1", trip_id: TRIP_ID, stage_type: "city", state: "planned", sequence: 1, place_id: PLACE_A }],
    }, ["places"]);
    const r = await get();
    assert.equal(r.body.stage.status, "unread");
    assert.match(r.body.stage.reason, /anchored to/);
  });

  it("unreadable saved places is unread", async () => {
    install({}, ["trip_saved_places"]);
    const r = await get();
    assert.equal(r.body.savedIdeas.status, "unread");
  });
});

describe("§14.2 route chains — the layer that shipped as no_source on a false premise", () => {
  // Its reason string said route_plans is "owner-only by RLS, so a trip's crew
  // cannot read the trip's own route chain", citing census-trips TR261. Both
  // halves are wrong: 0058_trip_flow.sql creates route_plans_member_select,
  // route_stops_member_select and route_legs_member_select, the first of them
  // two lines below the owner-only policy the census cited and stopped at —
  // and this route reads through the service client anyway, which bypasses
  // RLS entirely. A `no_source` is the strongest claim the projection makes
  // about a layer, and it was made from a citation nobody re-read.
  it("route stops with coordinates ARE points", async () => {
    install({ route_plans: [routePlan()], route_stops: [routeStop()] });
    const r = await get();
    assert.equal(r.body.routeChains.status, "ok",
      "the layer is real; no_source claimed nothing produces it");
    assert.equal(r.body.routeChains.items.length, 1);
    assert.equal(r.body.routeChains.items[0].kind, "route_stop");
    assert.equal(r.body.routeChains.items[0].meta.routeTitle, "Friday night");
    assert.equal(r.body.routeChains.items[0].meta.orderIndex, 0);
  });

  it("a stop whose structured_location has no coordinates is not a point", async () => {
    install({
      route_plans: [routePlan()],
      route_stops: [routeStop({ id: "rs-nowhere", structured_location: { label: "Somewhere" } })],
    });
    const r = await get();
    assert.deepEqual(r.body.routeChains.items, []);
    assert.equal(r.body.routeChains.status, "ok", "absent is not unread");
  });

  it("a trip with no route plan is an EMPTY layer, not an unread one", async () => {
    install({});
    const r = await get();
    assert.equal(r.body.routeChains.status, "ok");
    assert.deepEqual(r.body.routeChains.items, []);
  });

  it("unreadable route_plans is unread; unreadable route_stops is too", async () => {
    install({ route_plans: [routePlan()], route_stops: [routeStop()] }, ["route_plans"]);
    const noPlans = await get();
    assert.equal(noPlans.body.routeChains.status, "unread");

    install({ route_plans: [routePlan()], route_stops: [routeStop()] }, ["route_stops"]);
    const noStops = await get();
    assert.equal(noStops.body.routeChains.status, "unread");
    assert.match(noStops.body.routeChains.reason, /route_stops/);
  });

  it("route plans belonging to ANOTHER trip are not in this projection", async () => {
    install({
      route_plans: [routePlan({ id: "rp1" }), routePlan({ id: "rp2", trip_id: "another-trip" })],
      route_stops: [routeStop({ id: "mine", route_plan_id: "rp1" }),
                    routeStop({ id: "theirs", route_plan_id: "rp2" })],
    });
    const r = await get();
    assert.deepEqual(r.body.routeChains.items.map((p: any) => p.id), ["mine"]);
  });
});

describe("§14.1 — the layers with no producer say so", () => {
  it("one layer is no_source, with a reason naming the actual obstacle; live opportunities (§13) and safety / logistics (§17.4, §7.4) have producers now", async () => {
    install({});
    const r = await get();
    for (const key of ["crewPresenceSummaries"]) {
      assert.equal(r.body[key].status, "no_source", key);
      assert.ok(r.body[key].reason.length > 40, `${key}'s reason is not an explanation`);
    }
    assert.equal(r.body.safetyPoints.status, "ok"); assert.equal(typeof r.body.safetyLogisticsReading, "string");
    // And route chains is NOT one of them any more — nor, since §13, live opportunities:
    // here the operational-projections gate is off, so the layer is UNREAD with the reason.
    assert.notEqual(r.body.routeChains.status, "no_source");
    assert.equal(r.body.liveOpportunities.status, "unread");
    assert.match(r.body.liveOpportunities.reason, /opportunity projection unavailable/);
  });

  it("no_source is distinct from unread, because no retry will help", async () => {
    install({ route_plans: [], route_stops: [] }, ["trip_saved_places"]);
    const r = await get();
    assert.equal(r.body.savedIdeas.status, "unread");
    assert.equal(r.body.crewPresenceSummaries.status, "no_source");
    assert.notEqual(r.body.savedIdeas.status, r.body.crewPresenceSummaries.status);
  });
});

describe("§14.1 — points, coordinates and authorization", () => {
  it("an item with no coordinates is not a map object", async () => {
    install({ trip_plan_items: [planItem({ id: "nowhere", lat: null, lng: null })] });
    const r = await get();
    assert.deepEqual(r.body.activePlans.items, []);
  });

  it("a non-finite coordinate is NOT coerced — 0,0 is in the Gulf of Guinea", () => {
    assert.equal(coordsOf(Number.NaN, 1), null);
    assert.equal(coordsOf(1, Number.POSITIVE_INFINITY), null);
    assert.equal(coordsOf("38.7", -9.1), null);
    assert.deepEqual(coordsOf(38.7, -9.1), { lat: 38.7, lng: -9.1 });
    // 0,0 IS a valid coordinate and must not be rejected as falsy.
    assert.deepEqual(coordsOf(0, 0), { lat: 0, lng: 0 });
  });

  it("a cancelled plan is not an active plan", async () => {
    install({
      trip_plan_items: [
        planItem({ id: "live", status: "planned" }),
        planItem({ id: "off", status: "cancelled" }),
      ],
    });
    const r = await get();
    assert.deepEqual(r.body.activePlans.items.map((p: any) => p.id), ["live"]);
  });

  it("says which reading of 'active' it used, rather than leaving it implied", async () => {
    install({});
    const r = await get();
    assert.match(r.body.activePlanReading, /in_progress plans are active/);
  });

  it("a non-member is refused, not given a projection", async () => {
    install({ trip_plan_items: [planItem()] });
    const r = await get("other-token");
    assert.equal(r.status, 403);
    assert.equal(r.body.activePlans, undefined);
  });
});

describe("helpers", () => {
  it("isAttributable is false exactly when the version is null", () => {
    const base = {
      tripId: TRIP_ID, generatedAt: "", stage: ok([]), privateAnchors: ok([]),
      activePlans: ok([]), confirmedCommitments: ok([]), savedIdeas: ok([]),
      crewPresenceSummaries: noSource("x"), routeChains: noSource("x"),
      meetupPoints: ok([]), liveOpportunities: noSource("x"), safetyPoints: noSource("x"),
    };
    assert.equal(isAttributable({ ...base, sourceTripVersion: 0 } as TripMapProjection), true,
      "version 0 is a version");
    assert.equal(isAttributable({ ...base, sourceTripVersion: null } as TripMapProjection), false);
  });

  it("layerCensus counts unread and no_source separately", () => {
    const p: TripMapProjection = {
      tripId: TRIP_ID, generatedAt: "", sourceTripVersion: 1,
      stage: ok([{ id: "a", kind: "stage", lat: 1, lng: 1, label: null }]),
      privateAnchors: ok([]), activePlans: unread("x"), confirmedCommitments: unread("x"),
      savedIdeas: ok([]), crewPresenceSummaries: noSource("x"), routeChains: noSource("x"),
      meetupPoints: ok([]), liveOpportunities: noSource("x"), safetyPoints: noSource("x"),
    };
    assert.deepEqual(layerCensus(p), { ok: 4, unread: 2, noSource: 4, totalPoints: 1 });
  });
});

describe("the route is reachable", () => {
  it("is registered in the router index", () => {
    const index = readFileSync(new URL("../routes/index.ts", import.meta.url), "utf8");
    assert.match(index, /import tripMapProjectionRouter from "\.\/tripMapProjection"/);
    assert.match(index, /router\.use\(tripMapProjectionRouter\)/);
  });

  it("does not read `places` more than once per set of ids", () => {
    // One resolver, shared. The first draft read trip_stages twice and threw
    // the first read away; this is what stops that coming back.
    const route = readFileSync(new URL("../routes/tripMapProjection.ts", import.meta.url), "utf8");
    assert.equal((route.match(/from\("places"\)/g) ?? []).length, 1);
    assert.equal((route.match(/from\("trip_stages"\)/g) ?? []).length, 1);
  });
});

describe("§14.1 safety / logistics points — Safe Return at the plan it guards, transport endpoints under the gate", () => {
  const session = (o: Row = {}) => ({ id: "sr1", user_id: OWNER_ID, trip_id: TRIP_ID, plan_item_id: "p1", status: "active", escalation_level: 1, timer_end_at: "2026-09-13T23:00:00Z", notify_trip_crew_enabled: false, ...o });
  it("the viewer's own active session is a point at its plan; a crew member's only when they notify the crew; a session on a private anchor yields no point; the transport half says why it was not read", async () => {
    install({
      trip_plan_items: [planItem({ id: "p1", lat: 38.71, lng: -9.13 }), planItem({ id: "p2", lat: 38.72, lng: -9.14, location_is_private: true })],
      safe_return_sessions: [
        session(), session({ id: "sr2", user_id: OTHER_ID, plan_item_id: "p1" }), session({ id: "sr3", user_id: OTHER_ID, plan_item_id: "p1", notify_trip_crew_enabled: true }),
        session({ id: "sr4", plan_item_id: "p2" }), session({ id: "sr5", status: "safe" }),
      ],
      feature_flags: [],
    });
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.safetyPoints.status, "ok");
    const ids = r.body.safetyPoints.items.map((p: any) => p.id).sort();
    assert.deepEqual(ids, ["sr1", "sr3"], "own + crew-notified; not the silent other, not the private anchor's, not the closed one");
    const own = r.body.safetyPoints.items.find((p: any) => p.id === "sr1");
    assert.equal(own.kind, "safe_return"); assert.equal(own.meta.own, true); assert.equal(own.meta.escalationLevel, 1); assert.equal(own.lat, 38.71);
    assert.equal(r.body.safetyPoints.items.find((p: any) => p.id === "sr3").meta.own, false);
    assert.match(r.body.safetyLogisticsReading, /transport endpoints not read: trip_operational_projections_enabled is off/);
    assert.ok(!r.body.safetyPoints.items.some((p: any) => p.privateAnchor), "§14.4");
  });
  it("with the gate on, 2782's segments contribute their endpoints through places; a cancelled segment does not", async () => {
    install({
      places: [{ id: "pl-a", latitude: 38.70, longitude: -9.10 }, { id: "pl-b", latitude: 38.75, longitude: -9.20 }],
      trip_transport_segments: [
        { id: "seg1", trip_id: TRIP_ID, mode: "train", state: "booked", from_place_id: "pl-a", to_place_id: "pl-b", from_label: "Santa Apolónia", to_label: "Cascais", planned_departure_at: "2026-09-13T09:00:00Z", planned_arrival_at: "2026-09-13T09:40:00Z" },
        { id: "seg2", trip_id: TRIP_ID, mode: "taxi", state: "cancelled", from_place_id: "pl-a", to_place_id: "pl-b", from_label: null, to_label: null, planned_departure_at: null, planned_arrival_at: null },
      ],
      feature_flags: [{ flag: "trip_operational_projections_enabled", enabled: true }],
    });
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const items = r.body.safetyPoints.items;
    assert.deepEqual(items.map((p: any) => p.id).sort(), ["seg1:from", "seg1:to"]);
    const from = items.find((p: any) => p.id === "seg1:from");
    assert.equal(from.kind, "transport_endpoint"); assert.equal(from.label, "Santa Apolónia"); assert.equal(from.meta.plannedAt, "2026-09-13T09:00:00Z"); assert.equal(from.meta.mode, "train");
    assert.equal(items.find((p: any) => p.id === "seg1:to").meta.plannedAt, "2026-09-13T09:40:00Z");
    assert.match(r.body.safetyLogisticsReading, /endpoints of 1 transport segment/);
  });
  it("an unreadable safe_return_sessions is an unread layer, never an empty one", async () => {
    install({ feature_flags: [] }, ["safe_return_sessions"]);
    const r = await get();
    assert.equal(r.body.safetyPoints.status, "unread"); assert.match(r.body.safetyPoints.reason, /safe_return_sessions/);
    assert.match(r.body.safetyLogisticsReading, /not assembled/);
  });
});
