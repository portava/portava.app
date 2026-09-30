/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; the round-17 verifier's B10): the Time Machine's accepted-plan
 * layer never answers a read that FAILED as "off" or as "read, nothing predicted". D-W11X2-140's `flag_off` off-state is
 * now only a flag that was READ and is off.
 *
 * The client (forecastUnread.ts) treats `flag_off`, `no_group_key_secret` and `no_zone_model` as the layer being OFF,
 * and a null refusal with `accepted_plan` named as a whole read. The verifier's TPU probes, adapted to the server body:
 *
 *   TPU1  the `map_crowd_flow_enabled` read FAILS → `refusal: "flag_unreadable"` (not an off-state), not named
 *   TPU2  the `route_flow_contribution_consent` read FAILS → `refusal: "read_failed"`, `accepted_plan` not named
 *   TPU0  CONTROL: flag on, cohort consented → published 1, named, no refusal
 *   TPU0b CONTROL: the flag READ and off → `flag_off` (genuinely off), not named
 *   TPU0c CONTROL: consent READ, nobody consented → named, nothing predicted (a whole read)
 *   TPU0d CONTROL: an absent flag row is off (`flag_off`), not unread
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

process.env.INTEL_GROUP_KEY_SECRET = process.env.INTEL_GROUP_KEY_SECRET ?? "time-machine-route-test-secret";

import { _setTestClient } from "../lib/http.js";
import mapProjectionTemporalRouter, { _clearTemporalProtectedZoneCache, _clearTemporalFlowZoneCache } from "../routes/mapProjectionTemporal.js";

const TOKEN = "tm-r18-token";
const USER = "tm-r18-viewer";
const STOP_POINT = { lat: 16.0491234, lng: 108.2013579 };
const ZONE_A = { id: "tm-zone-a", name: "An Thuong", lat: 16.05, lng: 108.2 };
const BBOX = "108.0,15.9,108.4,16.2";
const MIN = 60_000;

type Spec = { rows?: any[]; error?: { message: string; code?: string } };
function buildQuery(table: string, spec: Spec, failFlag: string | null) {
  let rows = [...(spec.rows ?? [])];
  let err = spec.error ?? null;
  const result = () => (err ? { data: null, error: err } : { data: rows, error: null });
  const q: any = {
    select() { return q; }, order() { return q; }, range() { return q; },
    limit(n: number) { rows = rows.slice(0, n); return q; },
    eq(col: string, val: any) { if (table === "feature_flags" && col === "flag" && val === failFlag) err = { message: "canceling statement due to statement timeout", code: "57014" }; rows = rows.filter((r) => r[col] === val); return q; },
    neq(col: string, val: any) { rows = rows.filter((r) => r[col] !== val); return q; },
    in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
    gte(col: string, val: any) { rows = rows.filter((r) => r[col] >= val); return q; },
    lte(col: string, val: any) { rows = rows.filter((r) => r[col] <= val); return q; },
    is(col: string, val: any) { rows = val === null ? rows.filter((r) => r[col] == null) : rows.filter((r) => r[col] === val); return q; },
    not(col: string, op: string, val: any) { if (op === "is" && val === null) rows = rows.filter((r) => r[col] != null); return q; },
    or(expr: string) {
      const parts = expr.split(",").map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.*)$/)).filter(Boolean).map((m) => ({ col: (m as RegExpMatchArray)[1], op: (m as RegExpMatchArray)[2], val: (m as RegExpMatchArray)[3] }));
      rows = rows.filter((r) => parts.some(({ col, op, val }) => (op === "gte" ? r[col] != null && String(r[col]) >= val : op === "lte" ? r[col] != null && String(r[col]) <= val : String(r[col]) === val)));
      return q;
    },
    maybeSingle() { return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }); },
    then(resolve: (v: any) => void, reject?: (e: any) => void) { return Promise.resolve(result()).then(resolve, reject); },
  };
  return q;
}
function makeClient(state: Record<string, Spec | any[]>, failFlag: string | null = null) {
  return {
    auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "Unauthorized" } }) },
    from: (table: string) => { const v = state[table]; return buildQuery(table, Array.isArray(v) ? { rows: v } : (v ?? { rows: [] }), failFlag); },
  };
}
function zoneRow(z: typeof ZONE_A) { return { id: z.id, name: z.name, zone_type: "neighborhood", center_lat: z.lat, center_lng: z.lng, radius_meters: 600, polygon_geojson: null }; }
function planCohort(nowMs: number, count: number) {
  const acceptedAt = new Date(nowMs - 15 * MIN).toISOString();
  const arriveAt = new Date(nowMs + 60 * MIN).toISOString();
  const route_plans: any[] = []; const route_stops: any[] = []; const route_flow_contribution_consent: any[] = [];
  for (let i = 0; i < count; i += 1) {
    const planId = `tm-v17-plan-${i + 1}`; const actorId = `tm-v17-actor-${i + 1}`;
    route_plans.push({ id: planId, trip_id: null, accepted_by_user_id: actorId, accepted_at: acceptedAt, status: "active" });
    route_flow_contribution_consent.push({ user_id: actorId, enabled: true, withdrawn_at: null });
    route_stops.push({ id: `${planId}-stop`, route_plan_id: planId, structured_location: { label: "arrival", ...STOP_POINT }, planned_arrival_time: arriveAt, planned_departure_time: null });
  }
  return { route_plans, route_stops, route_flow_contribution_consent };
}
const crowdOn = [{ flag: "map_projection_enabled", enabled: true }, { flag: "map_crowd_flow_enabled", enabled: true }];
function state(nowMs: number, over: Record<string, Spec | any[]> = {}) {
  return { feature_flags: crowdOn, protected_zones: [], geo_zones: [zoneRow(ZONE_A)], blocks: [], event_roles: [], ...planCohort(nowMs, 15), ...over };
}

let server: http.Server; let base: string;
function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    r.on("error", reject); r.end();
  });
}
before(async () => {
  const app = express(); app.use(express.json()); app.use((req: any, _r, n) => { req.log = { error() {}, warn() {}, info() {} }; n(); }); app.use(mapProjectionTemporalRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { _clearTemporalProtectedZoneCache(); _clearTemporalFlowZoneCache(); });

async function temporal(s: Record<string, Spec | any[]>, failFlag: string | null = null) {
  _setTestClient(makeClient(s, failFlag) as any, true);
  const res = await get(`/map/projection/temporal?bbox=${BBOX}&offsetMinutes=60`);
  return { body: res.body, seen: JSON.stringify({ status: res.status, plan: res.body.forecast?.plan, sources: res.body.sources }) };
}
/** The client's rule (forecastUnread.ts PLAN_OFF_STATES): these three refusals are the layer being OFF. */
const OFF_STATES = new Set(["flag_off", "no_group_key_secret", "no_zone_model"]);

describe("census-discovery §115 (B10): the Time Machine's plan layer over a failed read", () => {
  it("TPU0 CONTROL: flag on, cohort consented → published, named, no refusal", async () => {
    const r = await temporal(state(Date.now()));
    assert.equal(r.body.forecast.plan.refusal, null, r.seen);
    assert.equal(r.body.forecast.plan.published, 1, r.seen);
    assert.ok(r.body.sources.includes("accepted_plan"), r.seen);
  });
  it("TPU0b CONTROL: the flag READ and off → flag_off, not named (genuinely off)", async () => {
    const r = await temporal(state(Date.now(), { feature_flags: [{ flag: "map_projection_enabled", enabled: true }, { flag: "map_crowd_flow_enabled", enabled: false }] }));
    assert.equal(r.body.forecast.plan.refusal, "flag_off", r.seen);
    assert.ok(!r.body.sources.includes("accepted_plan"), r.seen);
  });
  it("TPU0c CONTROL: consent READ, nobody consented → named, nothing predicted (a whole read)", async () => {
    const r = await temporal(state(Date.now(), { route_flow_contribution_consent: [] }));
    assert.equal(r.body.forecast.plan.refusal, null, r.seen);
    assert.equal(r.body.forecast.plan.published, 0, r.seen);
    assert.ok(r.body.sources.includes("accepted_plan"), r.seen);
  });
  it("TPU0d CONTROL: an absent map_crowd_flow_enabled row is off (flag_off), not unread", async () => {
    const r = await temporal(state(Date.now(), { feature_flags: [{ flag: "map_projection_enabled", enabled: true }] }));
    assert.equal(r.body.forecast.plan.refusal, "flag_off", r.seen);
  });
  it("TPU1 the map_crowd_flow_enabled READ FAILS → refusal flag_unreadable (not an off-state), not named", async () => {
    const r = await temporal(state(Date.now()), "map_crowd_flow_enabled");
    assert.equal(r.body.forecast.plan.refusal, "flag_unreadable", `an unread flag answered as off: ${r.seen}`);
    assert.ok(!OFF_STATES.has(r.body.forecast.plan.refusal), r.seen);
    assert.ok(!r.body.sources.includes("accepted_plan"), r.seen);
  });
  it("TPU2 the consent READ FAILS → refusal read_failed, accepted_plan not named", async () => {
    const r = await temporal(state(Date.now(), { route_flow_contribution_consent: { error: { message: "canceling statement due to statement timeout", code: "57014" } } }));
    assert.ok(!r.body.sources.includes("accepted_plan"), `a failed consent read named as a whole plan read: ${r.seen}`);
    assert.equal(r.body.forecast.plan.refusal, "read_failed", r.seen);
    assert.equal(r.body.forecast.plan.published, 0, r.seen);
  });
});
