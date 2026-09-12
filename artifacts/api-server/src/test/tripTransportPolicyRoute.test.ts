/**
 * Trips spec §7.4 route availability THROUGH the product (census-trips TR137):
 * PUT /trips/:tripId/transport-policy and GET /trips/:tripId/feasibility.
 *
 *   the owner sets the policy (200, the row as stored); a crew member is
 *   refused with TRIP_AUTH_NOT_OWNER; a mode the vocabulary does not know is
 *   400; with the gate off the write is refused and names the flag;
 *   feasibility with a policy that disallows drive and transit, on a hop that
 *   fits only by road: routeAvailability POLICY_BLOCKED, the hop carries
 *   TRIP_SPATIAL_ROUTE_UNAVAILABLE, and the §7.4 consistency report says
 *   INCONSISTENT / ROUTE_ONLY_BY_DISALLOWED_MODE — no permanent UNCHECKABLE;
 *   with no policy row the same hop is AVAILABLE and the report can fold to
 *   CONSISTENT; with the gate off the permanent UNCHECKABLE stands, as before.
 *
 * Run: node --import tsx/esm --test src/test/tripTransportPolicyRoute.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { invalidateTripOperationalProjectionsGate } from "../lib/tripOperationalProjections.js";
import { DRIVE_METRES_PER_SECOND, DRIVE_WAIT_SECONDS } from "../services/trips/TravelTimeProvider.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const TRIP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7";
const PLACE_A = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1";
const PLACE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2";

const EARTH_RADIUS_M = 6_371_008.8;
const ORIGIN = { lat: 48.8566, lng: 2.3522 };
const FAR = 6_000;
const DEST = { lat: ORIGIN.lat + (FAR / EARTH_RADIUS_M) * (180 / Math.PI), lng: ORIGIN.lng };
const driveMin = Math.ceil((FAR / DRIVE_METRES_PER_SECOND + DRIVE_WAIT_SECONDS) / 60);

type Row = Record<string, any>;
function makeClient(tables: Record<string, Row[]>) {
  const db = tables;
  return {
    db,
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token") return { data: { user: { id: OWNER_ID } }, error: null };
        if (token === "member-token") return { data: { user: { id: MEMBER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let pendingUpsert: Row | null = null;
      const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return chain; },
        in: (col: string, vals: any[]) => { filters.push((r) => vals.includes(r[col])); return chain; },
        is: (col: string, val: any) => { filters.push((r) => (r[col] ?? null) === val); return chain; },
        order: () => chain, limit: () => chain, gte: () => chain, gt: () => chain, not: () => chain, or: () => chain,
        upsert: (row: Row, _o?: any) => {
          const list = (db[table] ??= []);
          const i = list.findIndex((r) => r.trip_id === row.trip_id);
          if (i >= 0) list[i] = { ...list[i], ...row }; else list.push({ ...row });
          pendingUpsert = { ...row };
          return chain;
        },
        maybeSingle: async () => ({ data: pendingUpsert ?? rowsNow()[0] ?? null, error: null }),
        single: async () => ({ data: pendingUpsert ?? rowsNow()[0] ?? null, error: null }),
        then: (onF: any, onR: any) => Promise.resolve({ data: pendingUpsert ? [pendingUpsert] : rowsNow(), error: null }).then(onF, onR),
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
    storage: { createBucket: async () => ({ error: null }), from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  };
}

function tables(opts: { gateOn: boolean; policy?: Row | null }): Record<string, Row[]> {
  const t0 = "2026-10-01T09:00:00.000Z";
  const t1 = new Date(Date.parse(t0) + (driveMin + 5) * 60_000).toISOString();
  return {
    trips: [{ id: TRIP_ID, owner_id: OWNER_ID, title: "Kyoto", visibility: "private" }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
      { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
    ],
    feature_flags: opts.gateOn ? [{ flag: "trip_operational_projections_enabled", enabled: true }] : [],
    trip_transport_policies: opts.policy ? [opts.policy] : [],
    places: [{ id: PLACE_A, latitude: ORIGIN.lat, longitude: ORIGIN.lng }, { id: PLACE_B, latitude: DEST.lat, longitude: DEST.lng }],
    trip_stages: [], trip_plan_items: [],
    trip_commitments: [
      { id: "c1", trip_id: TRIP_ID, type: "event", starts_at: t0, required_arrival_at: null, place_id: PLACE_A, lateness_tolerance: null, prep_duration: null },
      { id: "c2", trip_id: TRIP_ID, type: "event", starts_at: t1, required_arrival_at: t1, place_id: PLACE_B, lateness_tolerance: null, prep_duration: null },
    ],
  };
}

let server: Server; let port = 0;
function install(t: Record<string, Row[]>) {
  const c = makeClient(t);
  invalidateTripOperationalProjectionsGate();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
  return c;
}
async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("TR137 — PUT /trips/:tripId/transport-policy and the feasibility route", () => {
  before(() => new Promise<void>((resolve) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); }); }));
  after(() => new Promise<void>((resolve) => { invalidateTripOperationalProjectionsGate(); _setTestClient(null as any, false); _setTestServiceClient(null as any); server.close(() => resolve()); }));

  it("the owner sets the policy; the row comes back as stored, de-duplicated", async () => {
    const c = install(tables({ gateOn: true }));
    const r = await call("PUT", `/trips/${TRIP_ID}/transport-policy`, "owner-token", { disallowedModes: ["drive", "transit", "drive"], note: "walking city" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.transportPolicy.disallowedModes, ["drive", "transit"]);
    assert.equal(r.body.transportPolicy.note, "walking city");
    assert.equal(c.db.trip_transport_policies!.length, 1);
    assert.equal(c.db.trip_transport_policies![0]!.updated_by, OWNER_ID);
  });
  it("a crew member is refused with TRIP_AUTH_NOT_OWNER and nothing is written", async () => {
    const c = install(tables({ gateOn: true }));
    const r = await call("PUT", `/trips/${TRIP_ID}/transport-policy`, "member-token", { disallowedModes: ["drive"] });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.reason, "TRIP_AUTH_NOT_OWNER");
    assert.equal((c.db.trip_transport_policies ?? []).length, 0);
  });
  it("a mode the vocabulary does not know is 400; an unknown key is 400", async () => {
    install(tables({ gateOn: true }));
    assert.equal((await call("PUT", `/trips/${TRIP_ID}/transport-policy`, "owner-token", { disallowedModes: ["taxi"] })).status, 400);
    assert.equal((await call("PUT", `/trips/${TRIP_ID}/transport-policy`, "owner-token", { disallowedModes: [], extra: 1 })).status, 400);
  });
  it("gate off: the write is refused and the refusal names the flag", async () => {
    const c = install(tables({ gateOn: false }));
    const r = await call("PUT", `/trips/${TRIP_ID}/transport-policy`, "owner-token", { disallowedModes: ["drive"] });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.match(String(r.body.message), /trip_operational_projections_enabled/);
    assert.equal((c.db.trip_transport_policies ?? []).length, 0);
  });

  it("feasibility: a hop that fits only by road, policy says no drive/transit → POLICY_BLOCKED, TRIP_SPATIAL_ROUTE_UNAVAILABLE, INCONSISTENT", async () => {
    install(tables({ gateOn: true, policy: { trip_id: TRIP_ID, disallowed_modes: ["drive", "transit"], note: "walking city" } }));
    const r = await call("GET", `/trips/${TRIP_ID}/feasibility`, "owner-token");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verdict, "FEASIBLE_UNVERIFIED", "the temporal engine, with the fastest mode, still says it fits");
    assert.deepEqual(r.body.transportPolicy.disallowedModes, ["drive", "transit"]);
    assert.equal(r.body.routeAvailability.verdict, "POLICY_BLOCKED");
    assert.equal(r.body.routeAvailability.hops[0].reasonCode, "TRIP_SPATIAL_ROUTE_UNAVAILABLE");
    assert.equal(r.body.routeAvailability.hops[0].fitsOnlyByDisallowed, "drive");
    const route = r.body.consistency.findings.filter((f: any) => f.check === "ROUTE_AVAILABILITY");
    assert.equal(route.length, 1);
    assert.equal(route[0].verdict, "INCONSISTENT"); assert.equal(route[0].reason, "ROUTE_ONLY_BY_DISALLOWED_MODE");
    assert.deepEqual(route[0].planIds, ["c1", "c2"]);
    assert.equal(r.body.consistency.verdict, "INCONSISTENT");
  });
  it("feasibility with no policy row: AVAILABLE by drive, no ROUTE_AVAILABILITY finding, and the fold reaches CONSISTENT", async () => {
    install(tables({ gateOn: true }));
    const r = await call("GET", `/trips/${TRIP_ID}/feasibility`, "owner-token");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.transportPolicy, { disallowedModes: [], note: null });
    assert.equal(r.body.routeAvailability.verdict, "AVAILABLE");
    assert.equal(r.body.routeAvailability.hops[0].fitsByAllowed, "drive");
    assert.equal(r.body.consistency.findings.filter((f: any) => f.check === "ROUTE_AVAILABILITY").length, 0);
    assert.equal(r.body.consistency.verdict, "CONSISTENT");
  });
  it("feasibility with the gate off: no policy read, UNCHECKABLE, and the permanent finding stands as before", async () => {
    install(tables({ gateOn: false, policy: { trip_id: TRIP_ID, disallowed_modes: ["drive"], note: null } }));
    const r = await call("GET", `/trips/${TRIP_ID}/feasibility`, "owner-token");
    assert.equal(r.status, 200);
    assert.equal(r.body.transportPolicy, null);
    assert.equal(r.body.routeAvailability.verdict, "UNCHECKABLE");
    assert.match(r.body.routeAvailability.reading, /trip_operational_projections_enabled is off/);
    const route = r.body.consistency.findings.filter((f: any) => f.check === "ROUTE_AVAILABILITY");
    assert.equal(route[0].reason, "NO_TRANSPORT_MODE_POLICY");
  });
});
