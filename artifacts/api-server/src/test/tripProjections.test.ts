/**
 * Trips spec §19.2 — the projection endpoints, and the §19.1 envelope on
 * every one of them.
 *
 *   GET /trips/:id/timeline   TR357, TR373
 *   GET /trips/:id/map        TR358, TR371 (alias of /map-projection; same body)
 *   GET /trips/:id/crew       TR359, TR372
 *   GET /trips/:id/context    TR360, TR369 — and Compass CONSUMES it (TR202)
 *   GET /trips/:id/safety     TR361
 *
 * What is pinned, per endpoint: the four envelope fields (TR364-TR367), the
 * gate and its Appendix B reason, and the refusal a failed read produces —
 * because a projection assembled from a failed read is the claim nobody made.
 * And for Compass: that the assistant reads the SAME object the client can
 * fetch, through the same consumer rule, and that a refused projection is
 * said to be refused rather than served as an empty plan.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { toolGetCurrentTrip } from "../compass/CompassTools.js";
import { readTripMetric, _resetTripMetrics } from "../lib/tripMetrics.js";
import { acceptTripDiscoveryProjections } from "../lib/discoveryTripProjectionConsumer.js";
import { TRIP_PROJECTION_SCHEMA_VERSION } from "../services/trips/TripProjectionEnvelope.js";

const OWNER_ID   = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID  = "22222222-2222-2222-2222-222222222222";
const INVITED_ID = "44444444-4444-4444-4444-444444444444";
const OTHER_ID   = "33333333-3333-3333-3333-333333333333";
const TRIP_ID    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type Row = Record<string, any>;

function makeClient(tables: Record<string, Row[]>, errorOn: string[] = []) {
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token")   return { data: { user: { id: OWNER_ID } }, error: null };
        if (token === "member-token")  return { data: { user: { id: MEMBER_ID } }, error: null };
        if (token === "invited-token") return { data: { user: { id: INVITED_ID } }, error: null };
        if (token === "other-token")   return { data: { user: { id: OTHER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from(table: string) {
      if (errorOn.includes(table)) {
        const f: any = {
          select: () => f, eq: () => f, in: () => f, is: () => f, or: () => f, gt: () => f, neq: () => f,
          order: () => f, limit: () => f,
          maybeSingle: async () => ({ data: null, error: { message: `${table} unavailable` } }),
          then: (onF: any, onR: any) => Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(onF, onR),
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
        neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        gt: (c: string, v: any) => { filters.push((r) => String(r[c]) > String(v)); return chain; },
        or: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => { single = true; return settle(); },
        single: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      return chain;
    },
  };
}

const base = (): Record<string, Row[]> => ({
  trips: [{ id: TRIP_ID, owner_id: OWNER_ID, version: 7, title: "Lisbon", destination_city: "Lisbon",
            destination_country: "PT", start_date: "2026-09-12", end_date: "2026-09-14", status: "active",
            plan_edit_permission: "all_members" }],
  trip_members: [
    { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
    { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
    { trip_id: TRIP_ID, user_id: INVITED_ID, role: "invited", status: "invited" },
  ],
  trip_plan_items: [], meetups: [], feature_flags: [], blocks: [], profiles: [],
  trip_crew_location_preferences: [], user_location_state: [], location_preferences: [],
  plan_checkins: [], safe_return_sessions: [], trip_crew_location_sessions: [],
  trip_stages: [], trip_commitments: [], trip_saved_places: [], places: [], route_plans: [], route_stops: [],
});

const planItem = (o: Row = {}) => ({
  id: "pi1", trip_id: TRIP_ID, creator_id: OWNER_ID, title: "Dinner", category: "activity", status: "planned",
  source_type: "manual", source_id: null, day_date: "2026-09-13", starts_at: null, ends_at: null,
  location_name: null, notes: null, sort_order: 0, visibility: "crew", lock_type: "flexible",
  location_is_private: false, lat: 38.72, lng: -9.14, removed_at: null,
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...o,
});

let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); });
  });
}
after(() => { server?.close(); });

async function get(path: string, token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function install(tables: Record<string, Row[]> = {}, errorOn: string[] = []) {
  const c = makeClient({ ...base(), ...tables }, errorOn);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
  return c;
}
function assertEnvelope(body: any, version: number | null) {
  assert.equal(body.projectionSchemaVersion, TRIP_PROJECTION_SCHEMA_VERSION);
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)), "generatedAt is an instant");
  assert.equal(body.sourceTripVersion, version);
  assert.equal(body.freshness, version === null ? "unattributable" : "live");
}

beforeEach(async () => { if (!server) await start(); _resetTripMetrics(); });

describe("§19.1 — every §19.2 projection carries the envelope", () => {
  it("timeline, map, crew, context, safety: schema version, generatedAt, sourceTripVersion, freshness", async () => {
    install({ feature_flags: [{ flag: "trip_crew_map_enabled", enabled: true }] });
    for (const path of ["timeline", "map", "crew", "context", "safety"]) {
      const r = await get(path);
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
      assertEnvelope(r.body, 7);
      assert.equal(r.body.tripId, TRIP_ID, path);
    }
  });
  it("the old paths still answer, and /map is the same body as /map-projection", async () => {
    install({ trip_plan_items: [planItem()] });
    const a = await get("map"); const b = await get("map-projection");
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const strip = (x: any) => { const { generatedAt: _g, ...rest } = x; return rest; };
    assert.deepEqual(strip(a.body), strip(b.body));
    assert.equal(a.body.activePlans.items.length, 1);
    assert.equal((await get("plan")).status, 200);
    assert.equal((await get("plan/map")).status, 200);
  });
  it("an unauthenticated caller gets 401 on all five", async () => {
    install();
    for (const path of ["timeline", "map", "crew", "context", "safety"]) {
      assert.equal((await get(path, "bad-token")).status, 401, path);
    }
  });
});

describe("GET /trips/:id/timeline — TripTimelineProjection", () => {
  it("groups the plan into the trip's days on the server, keeps /plan's item shape, and states the undated", async () => {
    install({ trip_plan_items: [
      planItem({ id: "a", day_date: "2026-09-13", sort_order: 0 }),
      planItem({ id: "b", day_date: "2026-09-13", sort_order: 1 }),
      planItem({ id: "c", day_date: null }),
      planItem({ id: "gone", removed_at: "2026-09-02T00:00:00Z" }),
    ] });
    const r = await get("timeline");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.days.map((d: any) => [d.iso, d.dateSub, d.items.length]),
      [["2026-09-12", "Day 1", 0], ["2026-09-13", "Day 2", 2], ["2026-09-14", "Day 3", 0]]);
    assert.equal(r.body.days[1].items[0].dayDate, "2026-09-13", "the item is /plan's camelCase shape");
    assert.deepEqual(r.body.days[1].items[0].warnings, []);
    assert.deepEqual(r.body.undated.map((i: any) => i.id), ["c"]);
    assert.equal(r.body.itemCount, 3, "the removed item is not counted");
    assert.equal(r.body.tripDayCount, 3);
    assert.equal(r.body.canEdit, true);
    assert.equal(r.body.tripStartDate, "2026-09-12");
  });
  it("an item outside the trip's dates carries /plan's outside_trip_dates warning under its own day", async () => {
    install({ trip_plan_items: [planItem({ id: "x", day_date: "2026-09-20" })] });
    const r = await get("timeline");
    const day = r.body.days.find((d: any) => d.iso === "2026-09-20");
    assert.ok(day); assert.equal(day.dateSub, "After trip");
    assert.ok(day.items[0].warnings.includes("outside_trip_dates"), JSON.stringify(day.items[0].warnings));
  });
  it("a non-member is refused with TRIP_AUTH_NOT_CREW; an invitee is not accepted crew", async () => {
    install();
    const r = await get("timeline", "other-token");
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "TRIP_AUTH_NOT_CREW");
    assert.equal((await get("timeline", "invited-token")).status, 403);
    assert.equal((await get("timeline", "member-token")).status, 200);
  });
  it("an unreadable plan is REFUSED with TRIP_PROJECTION_UNAVAILABLE — not served as an empty timeline", async () => {
    install({}, ["trip_plan_items"]);
    const r = await get("timeline");
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, "TRIP_PROJECTION_UNAVAILABLE");
    assert.equal(r.body.retryable, true);
  });
  it("an unreadable source meetup is refused too, as /plan refuses it", async () => {
    install({ trip_plan_items: [planItem({ source_type: "meetup", source_id: "m1" })] }, ["meetups"]);
    const r = await get("timeline");
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, "TRIP_PROJECTION_UNAVAILABLE");
  });
});

describe("GET /trips/:id/crew — TripCrewProjection", () => {
  it("flag off: visibly degraded, envelope present and UNATTRIBUTABLE because nothing was read", async () => {
    install();
    const r = await get("crew");
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, false);
    assert.deepEqual(r.body.members, []);
    assertEnvelope(r.body, null);
  });
  it("flag on: the crew map's cards under the envelope; an invitee may look", async () => {
    install({
      feature_flags: [{ flag: "trip_crew_map_enabled", enabled: true }],
      profiles: [{ id: MEMBER_ID, name: "Mia", username: "mia" }, { id: OWNER_ID, name: "Own", username: "own" }, { id: INVITED_ID, name: "Inv", username: "inv" }],
    });
    const r = await get("crew");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.featureEnabled, true);
    assertEnvelope(r.body, 7);
    assert.equal(r.body.totalCount, 2, "owner sees the member and the invitee, not themself");
    assert.ok(r.body.members.every((m: any) => typeof m.userId === "string" && "areaLabel" in m && "freshness" in m));
    assert.equal((await get("crew", "invited-token")).status, 200);
    const other = await get("crew", "other-token");
    assert.equal(other.status, 403); assert.equal(other.body.reason, "TRIP_AUTH_NOT_CREW");
  });
  it("an unreadable roster is refused (503, retryable), as /crew/map refuses it", async () => {
    install({ feature_flags: [{ flag: "trip_crew_map_enabled", enabled: true }] }, ["safe_return_sessions"]);
    const r = await get("crew");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });
});

describe("GET /trips/:id/context — TripCompassProjection", () => {
  it("the trip summary and a three-valued plan layer; version from the SAME row as the summary", async () => {
    install({ trip_plan_items: [planItem({ id: "a" }), planItem({ id: "b", day_date: "2026-09-14" })] });
    const r = await get("context");
    assert.equal(r.status, 200);
    assertEnvelope(r.body, 7);
    assert.deepEqual(r.body.trip, { id: TRIP_ID, title: "Lisbon", destinationCity: "Lisbon", destinationCountry: "PT",
      startDate: "2026-09-12", endDate: "2026-09-14", status: "active" });
    assert.equal(r.body.planItems.status, "ok");
    assert.deepEqual(r.body.planItems.items.map((i: any) => i.id), ["a", "b"]);
    assert.equal(r.body.planItemsTruncated, false);
  });
  it("more items than the cap: the list is cut and SAYS so", async () => {
    install({ trip_plan_items: Array.from({ length: 12 }, (_, i) => planItem({ id: `p${i}` })) });
    const r = await get("context");
    assert.equal(r.body.planItems.items.length, 10);
    assert.equal(r.body.planItemsTruncated, true);
  });
  it("an unreadable plan is an `unread` layer, never an empty one; an unreadable trip is refused", async () => {
    install({}, ["trip_plan_items"]);
    const r = await get("context");
    assert.equal(r.status, 200);
    assert.equal(r.body.planItems.status, "unread");
    // requireTripMember answers from trip_members alone for a member row, so
    // the projection's own trips read is what fails here.
    install({}, ["trips"]);
    const m = await get("context", "member-token");
    assert.equal(m.status, 503);
    assert.equal(m.body.reason, "TRIP_PROJECTION_UNAVAILABLE");
  });
  it("crew only", async () => {
    install();
    const r = await get("context", "other-token");
    assert.equal(r.status, 403); assert.equal(r.body.reason, "TRIP_AUTH_NOT_CREW");
  });
});

describe("Compass consumes the context projection (TR202/TR360)", () => {
  it("get_current_trip reads the plan from the projection through the §19.1 rule and records projection_lag_seconds", async () => {
    const c = install({ trip_plan_items: [planItem({ id: "a", title: "Dinner" })] });
    const out: any = await toolGetCurrentTrip(c as any, OWNER_ID);
    assert.equal(out.trip.id, TRIP_ID);
    assert.deepEqual(out.planItems.map((i: any) => i.day_date), ["2026-09-13"]);
    assert.match(out.planItems[0].title, /Dinner/);
    assert.deepEqual(out.projection, { generatedAt: out.projection.generatedAt, sourceTripVersion: 7, freshness: "live" });
    const lag = readTripMetric("projection_lag_seconds");
    assert.equal(lag.length, 1);
    assert.deepEqual(lag[0]!.labels, { projection: "TripCompassProjection" });
    assert.equal(lag[0]!.count, 1);
  });
  it("§12.1 getTripContext(tripId): a named trip is served from the same projection, and only to its crew", async () => {
    const c = install({ trip_plan_items: [planItem({ id: "a" })] });
    const named: any = await toolGetCurrentTrip(c as any, MEMBER_ID, TRIP_ID);
    assert.equal(named.trip.id, TRIP_ID);
    assert.equal(named.planItems.length, 1);
    assert.equal(named.projection.sourceTripVersion, 7);
    const stranger: any = await toolGetCurrentTrip(c as any, OTHER_ID, TRIP_ID);
    assert.equal(stranger.trip, null);
    assert.match(stranger.info, /not a member/);
    const missing: any = await toolGetCurrentTrip(c as any, OWNER_ID, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    assert.equal(missing.trip, null);
  });
  it("an unreadable plan is SAID to be unreadable — not handed to the assistant as an empty plan", async () => {
    const c = install({}, ["trip_plan_items"]);
    const out: any = await toolGetCurrentTrip(c as any, OWNER_ID);
    assert.equal(out.trip.id, TRIP_ID);
    assert.deepEqual(out.planItems, []);
    assert.match(out.info, /could not be read/);
  });
});

describe("GET /trips/:id/safety — TripSafetyProjection", () => {
  const session = (o: Row = {}) => ({
    id: "s1", user_id: MEMBER_ID, trip_id: TRIP_ID, status: "active", escalation_level: 0,
    timer_start_at: "2026-09-12T20:00:00Z", timer_end_at: "2026-09-12T23:00:00Z",
    notify_trip_crew_enabled: false, closed_at: null, updated_at: "2026-09-12T20:00:00Z", ...o,
  });
  it("a member's active session is RETURNING to a crew viewer only when opted in; otherwise counted as withheld", async () => {
    install({ safe_return_sessions: [session()] });
    let r = await get("safety");
    assert.equal(r.status, 200);
    assertEnvelope(r.body, 7);
    assert.deepEqual(r.body.members, []);
    assert.equal(r.body.withheld, 1);

    install({ safe_return_sessions: [session()],
      trip_crew_location_preferences: [{ trip_id: TRIP_ID, user_id: MEMBER_ID, share_safe_return_status: true }] });
    r = await get("safety");
    assert.equal(r.body.members.length, 1);
    assert.equal(r.body.members[0].state, "RETURNING");
    assert.equal(r.body.members[0].userId, MEMBER_ID);
    assert.equal(r.body.withheld, 0);
  });
  it("the member always sees their own; escalation is NEEDS_HELP", async () => {
    install({ safe_return_sessions: [session({ escalation_level: 2 })] });
    const r = await get("safety", "member-token");
    assert.equal(r.body.members[0].state, "NEEDS_HELP");
    assert.equal(r.body.needsHelpCount, 1);
  });
  it("unreadable sessions are REFUSED — 'nobody is walking home' is not a fallback", async () => {
    install({}, ["safe_return_sessions"]);
    const r = await get("safety");
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, "TRIP_PROJECTION_UNAVAILABLE");
  });
  it("crew only; an invitee is not crew here", async () => {
    install();
    assert.equal((await get("safety", "other-token")).status, 403);
    assert.equal((await get("safety", "invited-token")).status, 403);
  });
});

describe("the discovery consumer decides through the same rule (TR368)", () => {
  it("rejects a schema it does not read and names the reason", () => {
    const p = (v: number) => ({ projectionSchemaVersion: v, generatedAt: new Date().toISOString(), sourceTripVersion: 1, freshness: "live" } as any);
    const out = acceptTripDiscoveryProjections([p(1), p(2), p(1)]);
    assert.equal(out.accepted.length, 2);
    assert.equal(out.rejected, 1);
    assert.deepEqual(out.reasons, { TRIP_PROJECTION_SCHEMA_MISMATCH: 1 });
    assert.equal(readTripMetric("projection_lag_seconds").find((s) => s.labels.projection === "TripDiscoveryProjection")!.count, 2);
  });
});
