/**
 * Trips spec §11.1 — `TripTodayProjection`; §11.2's five questions; §22.4
 * checked LIVE (a sub-projection ahead of the canonical version is refused);
 * `GET /trips/:id/today`, `GET /trips/:id/health`; Compass `get_today_state`;
 * the timeline's derived AT_RISK plans and plan_at_risk_total.
 * census-trips TR180–TR193, TR203, TR356, TR370, TR416, TR396, TR194.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { buildTripTodayProjection, TODAY_ANSWERS } from "../services/trips/TripTodayProjection.js";
import { toolGetTodayState } from "../compass/CompassTools.js";
import { readTripMetric, _resetTripMetrics } from "../lib/tripMetrics.js";
import { OPERATIONAL_PHASES } from "../services/trips/TripOperationalPhase.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID  = "33333333-3333-3333-3333-333333333333";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
const NOW = new Date(T("12:00"));
type Row = Record<string, any>;

function withStages(tables: Record<string, Row[]>): Record<string, Row[]> {
  return { ...tables, trip_stages: tables.trip_stages ?? [{ id: "st1", trip_id: TRIP_ID, sequence: 1, starts_at: T("00:00", "12"), ends_at: T("23:59", "15") }] };
}

let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
}
after(() => { server?.close(); });
async function get(path: string, token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function install(tables: Record<string, Row[]>, errorOn: string[] = []) {
  const c = makeClient(withStages(tables), errorOn);
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  return c;
}
beforeEach(async () => { if (!server) await start(); _resetTripMetrics(); });

describe("§11.1 buildTripTodayProjection — composed, not re-derived", () => {
  it("carries every §11.1 field, answers §11.2's questions in order, and every layer now has a producer", async () => {
    const r = await buildTripTodayProjection(makeClient(withStages(base())) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const p = r.projection;
    for (const k of ["tripId", "stageId", "nowState", "currentPlan", "nextCommitment", "freeWindows", "crewSummary", "opportunities", "risks", "unresolvedActions", "pulseSignals", "generatedAt", "sourceTripVersion", "freshness"]) {
      assert.ok(k in p, `§11.1 field ${k} is missing`);
    }
    assert.equal(p.stageId, "st1");
    assert.equal(p.nowState.phase, "FREE_TIME");
    assert.equal(p.currentPlan, null);
    assert.ok(p.nextCommitment && p.nextCommitment.id === "B" && p.nextCommitment.mustLeaveBy !== null && p.nextCommitment.windowId === "fw:A:B");
    assert.ok(p.freeWindows.every((w) => Date.parse(w.endsAt) > NOW.getTime()));
    assert.equal(p.crewSummary.total, 2); assert.equal(p.crewSummary.featureEnabled, false); assert.equal(p.crewSummary.liveSharing, null, "not read is null, not zero");
    assert.equal(p.opportunities.status, "ok", "§13: the opportunity projection now produces this layer (empty here: nothing saved)");
    assert.equal(p.pulseSignals.status, "ok", "§16: the Trip Pulse projection now produces this layer");
    assert.equal(p.attention.mode, "NORMAL"); assert.equal(p.attention.suppression.discovery, false);
    assert.deepEqual(p.risks, []); assert.deepEqual(p.unresolvedActions, []);
    assert.equal(p.health, "HEALTHY");
    assert.deepEqual(Object.keys(p.answers), ["now", "next", "who", "canDo", "changed"], "§11.2's order");
    assert.deepEqual(p.answers, TODAY_ANSWERS);
    assert.equal(p.sourceTripVersion, 9); assert.equal(p.freshness, "live");
    assert.deepEqual(p.derivedFrom, { healthSourceTripVersion: 9, freedomSourceTripVersion: 9 });
  });
  it("a conflict becomes an unresolvedAction and AT_RISK health; an unplaced commitment becomes a place_commitment action", async () => {
    const tables = withStages(base());
    tables.trip_commitments = [...tables.trip_commitments, { id: "C", trip_id: TRIP_ID, type: "other", starts_at: null, required_arrival_at: null, place_id: null, lateness_tolerance: null, prep_duration: null, flexibility: "flexible" }];
    tables.trip_commitments[1] = { ...tables.trip_commitments[1], required_arrival_at: T("10:05") };
    const r = await buildTripTodayProjection(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok);
    assert.deepEqual(r.projection.unresolvedActions.map((a) => a.kind).sort(), ["place_commitment", "resolve_conflict"]);
    assert.equal(r.projection.health, "AT_RISK");
    assert.equal(r.projection.nextCommitment, null, "B's deadline is in the past; nothing is next");
  });
  it("§22.4 LIVE: a sub-projection generated against a version AHEAD of the canonical read is refused, not assembled", async () => {
    // The first trips read (the canonical version) answers 9; every later read
    // answers 10 — a command landed in between.
    const tables = withStages(base());
    const inner = makeClient(tables);
    const c: any = { ...inner, from(table: string) {
      const chain = inner.from(table);
      if (table !== "trips") return chain;
      // The builder's canonical read selects exactly "id, version"; the probe
      // and the sub-builders select more. Only the canonical read sees 9.
      let selected = "";
      const sel = chain.select; chain.select = (cols: string) => { selected = cols; return sel(cols); };
      const ms = chain.maybeSingle;
      chain.maybeSingle = async () => { const r = await ms(); return r.data ? { ...r, data: { ...r.data, version: selected === "id, version" ? 9 : 10 } } : r; };
      return chain;
    } };
    const r = await buildTripTodayProjection(c, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(!r.ok && r.reason === "TRIP_PROJECTION_VERSION_AHEAD", JSON.stringify(r));
    assert.match(r.message, /10 exceeds the canonical aggregate version 9/);
  });
  it("crewSummary reads the crew map when its flag is on, and says why the counts are null when it cannot", async () => {
    const tables = withStages(base());
    tables.feature_flags = [...tables.feature_flags, { flag: "trip_crew_map_enabled", enabled: true }];
    Object.assign(tables, { profiles: [{ id: MEMBER_ID, name: "M", username: "m" }], blocks: [], user_location_state: [], location_preferences: [], plan_checkins: [], trip_crew_location_sessions: [] });
    let r = await buildTripTodayProjection(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok); assert.equal(r.projection.crewSummary.featureEnabled, true); assert.equal(r.projection.crewSummary.liveSharing, 0);
    r = await buildTripTodayProjection(makeClient(tables, ["profiles"]) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok); assert.equal(r.projection.crewSummary.liveSharing, null); assert.match(r.projection.crewSummary.detail ?? "", /unavailable: profiles/);
  });
  it("refuses when the stages read fails, and FEATURE_DISABLED when the flag is off", async () => {
    let r = await buildTripTodayProjection(makeClient(withStages(base()), ["trip_stages"]) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(!r.ok && r.reason === "TRIP_PROJECTION_UNAVAILABLE");
    const tables = withStages(base()); tables.feature_flags = [];
    r = await buildTripTodayProjection(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(!r.ok && r.reason === "FEATURE_DISABLED");
  });
});

describe("GET /trips/:id/today and /health — §19.2-style reads, gated", () => {
  it("today: envelope and the five answers; health: level, reasons, phase", async () => {
    install(base());
    const t = await get("today");
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.projectionSchemaVersion, 1); assert.equal(t.body.freshness, "live");
    // The route judges on the REAL clock, so the phase is whichever clause
    // holds today; the builder tests pin each clause with a fixed `now`.
    assert.ok(t.body.nowState.phase === null || OPERATIONAL_PHASES.includes(t.body.nowState.phase), t.body.nowState.phase);
    assert.equal(typeof t.body.nowState.reason, "string");
    assert.equal(t.body.stageId, "st1");
    const h = await get("health");
    assert.equal(h.status, 200);
    assert.equal(h.body.health, "HEALTHY"); assert.deepEqual(h.body.reasons, []);
    assert.equal(h.body.phase.phase, t.body.nowState.phase, "health and today judge the same clause");
    assert.equal(h.body.sourceTripVersion, 9);
  });
  it("crew only, and feature_disabled when the flag is off", async () => {
    install(base());
    for (const path of ["today", "health"]) {
      const r = await get(path, "other-token");
      assert.equal(r.status, 403, path); assert.equal(r.body.reason, "TRIP_AUTH_NOT_CREW");
    }
    const tables = base(); tables.feature_flags = [];
    install(tables);
    for (const path of ["today", "health", "freedom-windows"]) {
      const r = await get(path);
      assert.equal(r.status, 404, path); assert.equal(r.body.error, "feature_disabled");
    }
  });
});

describe("Compass get_today_state consumes the Today projection (TR203)", () => {
  it("returns the projection's answers for the current trip, and nothing for a stranger", async () => {
    const c = install(base());
    const out: any = await toolGetTodayState(c as any, OWNER_ID, {});
    assert.equal(out.today.tripId, TRIP_ID);
    assert.ok(out.today.nowState.phase === null || OPERATIONAL_PHASES.includes(out.today.nowState.phase));
    assert.equal(typeof out.today.nowState.primaryFocus === "string" || out.today.nowState.primaryFocus === null, true);
    assert.deepEqual(Object.keys(out.today.answers), ["now", "next", "who", "canDo", "changed"]);
    assert.equal(out.projection.sourceTripVersion, 9);
    // Resolving the current trip consumes the Compass projection too; Today's
    // own composition consumes Health and Freedom; then Today itself.
    // §16 / §13: Today also composes the Trip Pulse and Opportunity projections now.
    assert.deepEqual(readTripMetric("projection_lag_seconds").map((s) => s.labels.projection).sort(),
      ["TripCompassProjection", "TripFreedomProjection", "TripHealthProjection", "TripOpportunityProjection", "TripPulseProjection", "TripTodayProjection"]);
    const stranger: any = await toolGetTodayState(c as any, OTHER_ID, { tripId: TRIP_ID });
    assert.equal(stranger.today, null);
  });
});

describe("§3.3 AT_RISK is derived on the timeline and counted (TR396)", () => {
  it("a plan item in a conflict is atRisk; plan_at_risk_total counts it per plan", async () => {
    const item = (id: string, s: string, e: string) => ({ id, trip_id: TRIP_ID, creator_id: OWNER_ID, title: id, category: "activity", status: "planned", source_type: "manual", source_id: null, day_date: "2026-09-13", starts_at: T(s), ends_at: T(e), location_name: null, notes: null, sort_order: 0, visibility: "crew", lock_type: "flexible", location_is_private: false, lat: null, lng: null, removed_at: null, created_at: T("00:00"), updated_at: T("00:00") });
    const tables = base(); tables.trip_plan_items = [item("a", "10:00", "12:00"), item("b", "11:00", "13:00"), item("c", "15:00", "16:00")];
    install(tables);
    const r = await get("timeline");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.atRiskPlanIds.sort(), ["a", "b"]);
    assert.match(r.body.atRiskReading, /derived, not stored/);
    assert.deepEqual(readTripMetric("plan_at_risk_total").map((s) => [s.labels.plan, s.count]).sort(), [["a", 1], ["b", 1]]);
  });
});
