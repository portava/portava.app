/**
 * Trips spec §7.3 / §12.1 — `GET /trips/:tripId/freedom-windows` and Compass's
 * `get_freedom_windows`, both consuming ONE builder; §7.2 conflicts on the
 * timeline projection; §21.1 temporal_conflict_total.
 * census-trips TR132, TR133, TR205, TR197, TR129, TR130, TR395.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { toolGetFreedomWindows } from "../compass/CompassTools.js";
import { readTripMetric, _resetTripMetrics } from "../lib/tripMetrics.js";
import { DRIVE_METRES_PER_SECOND, DRIVE_WAIT_SECONDS, WALK_MAX_METRES } from "../services/trips/TravelTimeProvider.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID  = "33333333-3333-3333-3333-333333333333";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PLACE_A   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1";
const PLACE_B   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2";

// Geometry derived from the provider's constants, as tripFeasibilityRouteBehaviour does.
const EARTH_RADIUS_M = 6_371_008.8;
const northOf = (lat: number, lng: number, metres: number) => ({ lat: lat + (metres / EARTH_RADIUS_M) * (180 / Math.PI), lng });
const driveMinutes = (metres: number) => Math.ceil((metres / DRIVE_METRES_PER_SECOND + DRIVE_WAIT_SECONDS) / 60);
const ORIGIN = { lat: 48.8566, lng: 2.3522 };
const SEPARATION_M = WALK_MAX_METRES * 5;
const DEST = northOf(ORIGIN.lat, ORIGIN.lng, SEPARATION_M);
const TRAVEL_MIN = driveMinutes(SEPARATION_M);

type Row = Record<string, any>;
function makeClient(tables: Record<string, Row[]>, errorOn: string[] = []) {
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token")  return { data: { user: { id: OWNER_ID } }, error: null };
        if (token === "member-token") return { data: { user: { id: MEMBER_ID } }, error: null };
        if (token === "other-token")  return { data: { user: { id: OTHER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from(table: string) {
      if (errorOn.includes(table)) {
        const f: any = {
          select: () => f, eq: () => f, in: () => f, is: () => f, or: () => f, gt: () => f, gte: () => f, lte: () => f, order: () => f, limit: () => f,
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
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        gte: (c: string, v: any) => { filters.push((r) => String(r[c]) >= String(v)); return chain; },
        lte: (c: string, v: any) => { filters.push((r) => String(r[c]) <= String(v)); return chain; },
        or: () => chain, gt: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      return chain;
    },
  };
}

const T = (hhmm: string) => `2026-09-13T${hhmm}:00.000Z`;
const commitment = (id: string, o: Row = {}) => ({
  id, trip_id: TRIP_ID, type: "event", starts_at: null, required_arrival_at: null, place_id: null,
  lateness_tolerance: null, prep_duration: null, flexibility: "flexible", ...o,
});
const base = (): Record<string, Row[]> => ({
  trips: [{ id: TRIP_ID, owner_id: OWNER_ID, version: 5, title: "Paris", destination_city: "Paris", start_date: "2026-09-13", end_date: "2026-09-14", status: "active" }],
  trip_members: [
    { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
    { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
  ],
  trip_commitments: [
    commitment("A", { starts_at: T("10:00"), place_id: PLACE_A }),
    commitment("B", { required_arrival_at: T("14:00"), starts_at: T("14:30"), place_id: PLACE_B, prep_duration: "00:10:00" }),
  ],
  places: [{ id: PLACE_A, latitude: ORIGIN.lat, longitude: ORIGIN.lng }, { id: PLACE_B, latitude: DEST.lat, longitude: DEST.lng }],
  trip_plan_items: [], meetups: [],
  feature_flags: [{ flag: "trip_operational_projections_enabled", enabled: true }],
});

let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
}
after(() => { server?.close(); });
async function get(path: string, token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function install(tables: Record<string, Row[]> = {}, errorOn: string[] = []) {
  const c = makeClient({ ...base(), ...tables }, errorOn);
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  return c;
}
beforeEach(async () => { if (!server) await start(); _resetTripMetrics(); });

describe("GET /trips/:id/freedom-windows — §7.3 through the §12.1 read", () => {
  it("serves the windows under the envelope, with the travel term the feasibility engine would use", async () => {
    install();
    const r = await get("freedom-windows");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.projectionSchemaVersion, 1);
    assert.equal(r.body.sourceTripVersion, 5);
    assert.equal(r.body.freshness, "live");
    assert.deepEqual(r.body.windows.map((w: any) => w.position), ["before_first", "between", "after_last"]);
    const w = r.body.windows[1];
    assert.equal(w.beginsAt, T("10:00"));
    assert.equal(w.reservedMinutes, TRAVEL_MIN + 10, "straight-line drive minutes plus prep");
    assert.equal(w.endsAt, new Date(Date.parse(T("14:00")) - (TRAVEL_MIN + 10) * 60_000).toISOString());
    assert.deepEqual(w.participants.sort(), [OWNER_ID, MEMBER_ID]);
    assert.equal(w.certified, false);
    assert.deepEqual(r.body.conflicts, []);
    assert.equal(r.body.commitmentCount, 2);
    assert.deepEqual(r.body.provider, { id: "straight-line", routed: false });
    assert.match(r.body.disclosure, /lower bounds/);
    assert.equal(r.body.tripId, TRIP_ID);
  });

  it("a hop that cannot be made is a conflict beside the windows, and temporal_conflict_total counts it", async () => {
    install({ trip_commitments: [
      commitment("A", { starts_at: T("10:00"), place_id: PLACE_A }),
      commitment("B", { required_arrival_at: T("10:05"), place_id: PLACE_B }),
    ] });
    const r = await get("freedom-windows");
    assert.equal(r.status, 200);
    assert.equal(r.body.conflicts.length, 1);
    assert.equal(r.body.conflicts[0].reason, "TRIP_TEMPORAL_CONFLICT");
    assert.equal(r.body.conflicts[0].kind, "NO_TIME_TO_TRAVEL");
    assert.equal(r.body.conflicts[0].shortfallMinutes, TRAVEL_MIN - 5);
    assert.equal(r.body.conflicts[0].overridden, false);
    assert.ok(!r.body.windows.some((w: any) => w.position === "between"));
    const m = readTripMetric("temporal_conflict_total");
    assert.deepEqual(m.map((s) => [s.labels.kind, s.count]), [["NO_TIME_TO_TRAVEL", 1]]);
  });

  it("an unlocated place is a fact (TRAVEL_UNKNOWN), a failed places read is a refusal", async () => {
    install({ places: [{ id: PLACE_A, latitude: null, longitude: null }, { id: PLACE_B, latitude: DEST.lat, longitude: DEST.lng }] });
    let r = await get("freedom-windows");
    assert.equal(r.status, 200);
    const w = r.body.windows.find((x: any) => x.position === "between");
    assert.ok(w.hardConstraints.some((h: any) => h.kind === "TRAVEL_UNKNOWN"));
    assert.equal(w.confidence, "INSUFFICIENT");
    install({}, ["places"]);
    r = await get("freedom-windows");
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, "TRIP_PROJECTION_UNAVAILABLE");
  });

  it("unreadable commitments are refused — a window over 'no commitments' is the whole trip, the most confident wrong answer", async () => {
    install({}, ["trip_commitments"]);
    const r = await get("freedom-windows");
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, "TRIP_PROJECTION_UNAVAILABLE");
  });

  it("is behind trip_operational_projections_enabled (seeded FALSE): off, the route answers feature_disabled and Compass says not enabled", async () => {
    const c = install({ feature_flags: [] });
    const r = await get("freedom-windows");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
    assert.match(r.body.message, /trip_operational_projections_enabled is off/);
    const out: any = await toolGetFreedomWindows(c as any, OWNER_ID, { tripId: TRIP_ID });
    assert.deepEqual(out.windows, []);
    assert.match(out.info, /not enabled/);
  });
  it("crew only", async () => {
    install();
    const r = await get("freedom-windows", "other-token");
    assert.equal(r.status, 403); assert.equal(r.body.reason, "TRIP_AUTH_NOT_CREW");
    assert.equal((await get("freedom-windows", "member-token")).status, 200);
  });
});

describe("Compass consumes the engine (TR133, TR205, TR197)", () => {
  it("get_freedom_windows returns the same windows, the window containing `at`, and records projection_lag_seconds", async () => {
    const c = install();
    const out: any = await toolGetFreedomWindows(c as any, OWNER_ID, { tripId: TRIP_ID, at: T("11:00") });
    assert.equal(out.tripId, TRIP_ID);
    assert.equal(out.windows.length, 3);
    assert.equal(out.current.position, "between");
    assert.equal(out.current.afterCommitmentId, "A");
    assert.ok(Array.isArray(out.current.hardConstraints));
    assert.deepEqual(out.conflicts, []);
    assert.equal(out.projection.sourceTripVersion, 5);
    const lag = readTripMetric("projection_lag_seconds");
    assert.deepEqual(lag.map((s) => s.labels.projection), ["TripFreedomProjection"]);
    const none: any = await toolGetFreedomWindows(c as any, OWNER_ID, { tripId: TRIP_ID, at: T("09:00") });
    assert.equal(none.current.position, "before_first");
  });
  it("resolves the current trip when none is named; a stranger gets nothing", async () => {
    const c = install();
    const out: any = await toolGetFreedomWindows(c as any, OWNER_ID, {});
    assert.equal(out.tripId, TRIP_ID);
    const stranger: any = await toolGetFreedomWindows(c as any, OTHER_ID, { tripId: TRIP_ID });
    assert.deepEqual(stranger.windows, []);
    assert.match(stranger.info, /not a member/);
  });
  it("a refused build is said to be refused, never an empty list of windows presented as 'all free'", async () => {
    const c = install({}, ["trip_commitments"]);
    const out: any = await toolGetFreedomWindows(c as any, OWNER_ID, { tripId: TRIP_ID });
    assert.deepEqual(out.windows, []);
    assert.match(out.info, /unavailable/);
  });
});

describe("§7.2 on the timeline: overlapping plan items are marked, not rendered as a normal day", () => {
  const item = (id: string, s: string, e: string) => ({
    id, trip_id: TRIP_ID, creator_id: OWNER_ID, title: id, category: "activity", status: "planned", source_type: "manual", source_id: null,
    day_date: "2026-09-13", starts_at: T(s), ends_at: T(e), location_name: null, notes: null, sort_order: 0, visibility: "crew",
    lock_type: "flexible", location_is_private: false, lat: null, lng: null, removed_at: null, created_at: T("00:00"), updated_at: T("00:00"),
  });
  it("names the conflict and the items on their day, and counts it", async () => {
    install({ trip_plan_items: [item("a", "10:00", "12:00"), item("b", "11:00", "13:00"), item("c", "15:00", "16:00")] });
    const r = await get("timeline");
    assert.equal(r.status, 200);
    assert.equal(r.body.conflicts.length, 1);
    assert.equal(r.body.conflicts[0].kind, "PLAN_OVERLAP");
    assert.deepEqual(r.body.conflicts[0].planIds, ["a", "b"]);
    assert.equal(r.body.conflicts[0].shortfallMinutes, 60);
    const day = r.body.days.find((d: any) => d.iso === "2026-09-13");
    assert.deepEqual(day.conflictIds, ["a", "b"]);
    assert.deepEqual(r.body.days.find((d: any) => d.iso === "2026-09-14").conflictIds, []);
    assert.deepEqual(readTripMetric("temporal_conflict_total").map((s) => [s.labels.kind, s.count]), [["PLAN_OVERLAP", 1]]);
  });
});
