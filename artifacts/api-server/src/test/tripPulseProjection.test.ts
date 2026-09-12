/**
 * Trips spec §16 — the Trip Pulse projection over real reads; §17.2 the
 * disruption register in health and the priority switch; `GET /trips/:id/pulse`;
 * Compass `get_live_conditions`; Today's `pulseSignals` layer.
 * census-trips TR299–TR311, TR319, TR448, TR208.
 *
 * Run: node --import tsx/esm --test src/test/tripPulseProjection.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { buildTripPulseProjection, PULSE_SOURCES } from "../services/trips/TripPulseProjection.js";
import { buildTripHealthProjection } from "../services/trips/TripHealthProjection.js";
import { buildTripTodayProjection } from "../services/trips/TripTodayProjection.js";
import { toolGetLiveConditions } from "../compass/CompassTools.js";
import { readTripDecision } from "../services/trips/TripDecisionLedger.js";
import { _resetTripMetrics } from "../lib/tripMetrics.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const OTHER_ID  = "33333333-3333-3333-3333-333333333333";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VENUE_ID  = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
const NOW = new Date(T("12:00"));
type Row = Record<string, any>;

function withStages(tables: Record<string, Row[]>): Record<string, Row[]> {
  return { ...tables, trip_stages: tables.trip_stages ?? [{ id: "st1", trip_id: TRIP_ID, sequence: 1, starts_at: T("00:00", "12"), ends_at: T("23:59", "15") }] };
}
const snapshot = (claimType: string, value: any, o: Row = {}): Row => ({
  subject_id: VENUE_ID, zone_id: "", claim_type: claimType, value, confidence: 0.8, observed_at: T("11:50"), expires_at: T("13:00"), conflict_state: null, source_count: 2, ...o,
});
const walk = (o: Row = {}): Row => ({ id: "walk", trip_id: TRIP_ID, title: "Walking tour of Montmartre", category: "activity", status: "planned", starts_at: T("15:00"), ends_at: T("17:00"), lat: null, lng: null, location_name: null, removed_at: null, ...o });
const forecast = (o: Row = {}): Row => ({ destination: "Paris", date_key: "2026-09-13:2026-09-15", fetched_at: T("11:00"), forecasts_json: [{ date: "2026-09-13", precipMm: 9, weatherCode: 63, summary: "Rain" }, { date: "2026-09-14", precipMm: 0, weatherCode: 1, summary: "Clear" }], ...o });

let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
}
after(() => { server?.close(); });
async function get(path: string, token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, body: unknown, token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function install(tables: Record<string, Row[]>, errorOn: string[] = []) {
  const c = makeClient(withStages(tables), errorOn);
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  return c;
}
beforeEach(async () => { if (!server) await start(); _resetTripMetrics(); });

describe("§16 buildTripPulseProjection — sources reported by name, nothing fetched", () => {
  it("a trip with nothing to look up: every source is named with its status, no signal, the ledger has the decision", async () => {
    const r = await buildTripPulseProjection(makeClient(withStages(base())) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const p = r.projection;
    assert.equal(p.sourceTripVersion, 9); assert.equal(p.freshness, "live");
    assert.deepEqual(p.sources.map((s) => s.name).sort(), [...PULSE_SOURCES].sort());
    const by = Object.fromEntries(p.sources.map((s) => [s.name, s]));
    assert.equal(by.crew_presence.status, "no_source"); assert.match(by.crew_presence.detail!, /trip_crew_map_enabled is off/);
    assert.equal(by.intel_state_snapshots.status, "ok"); assert.match(by.intel_state_snapshots.detail!, /no saved idea names a canonical place/);
    assert.equal(by.weather_cache.status, "ok"); assert.match(by.weather_cache.detail!, /no cached forecast for Paris/);
    assert.deepEqual(p.signals, []); assert.deepEqual(p.dropped, []);
    assert.equal(p.attention.mode, "NORMAL"); assert.equal(p.attention.suppression.reason, null);
    assert.equal(p.context.stageId, "st1"); assert.equal(p.context.locationBand, null);
    const d = readTripDecision(p.decisionId);
    assert.ok(d && d.type === "pulse_projection"); assert.ok(d.engineVersions.TripSignals && d.engineVersions.TripPulseProjection);
  });
  it("rain in the cached forecast + a weather-sensitive plan that day → a rain_arriving signal with §16.2's estimate; the dry day is dropped with the reason", async () => {
    const tables = base(); tables.trip_plan_items = [walk()]; tables.weather_cache = [forecast()];
    const r = await buildTripPulseProjection(makeClient(withStages(tables)) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const p = r.projection;
    assert.equal(p.signals.length, 1);
    const s = p.signals[0];
    assert.equal(s.kind, "rain_arriving"); assert.equal(s.subjectId, "2026-09-13");
    assert.equal(s.estimate.sourceClass, "imported_owned"); assert.equal(s.estimate.confidence, 0.7); assert.equal(s.estimate.observedAt, T("11:00"));
    assert.equal(s.estimate.fallbackUsed, false); assert.deepEqual(s.estimate.contradictorySources, []);
    assert.deepEqual(s.effects.map((e) => e.kind), ["plan_invalidated", "fallback_opportunity"]);
    assert.deepEqual(s.effects[0].subjectIds, ["walk"]);
    assert.deepEqual(p.dropped, [{ kind: "rain_arriving", subjectId: "2026-09-14", reason: "forecast for 2026-09-14 is not rain (0 mm, code 1)" }]);
    assert.equal(p.sources.find((x) => x.name === "weather_cache")!.observations, 2);
  });
  it("crowd rising at a saved venue from intel snapshots → crowd_rising; two zones that disagree are a listed contradiction that lowers confidence", async () => {
    const tables = base();
    tables.trip_saved_places = [{ id: "s1", trip_id: TRIP_ID, place_id: VENUE_ID, place_name: "Le Bar", place_type: "bar", lat: null, lng: null }];
    tables.intel_state_snapshots = [
      snapshot("crowd.level", { level: "busy" }), snapshot("crowd.trajectory", { trajectory: "building" }),
      snapshot("crowd.level", { level: "dead" }, { zone_id: "z2", confidence: 0.9, observed_at: T("11:40") }),
    ];
    const r = await buildTripPulseProjection(makeClient(withStages(tables)) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const s = r.projection.signals[0];
    assert.ok(s, "a crowd signal"); assert.equal(s.kind, "crowd_rising");
    assert.deepEqual(s.estimate.value, { placeId: VENUE_ID, level: "busy", trajectory: "building" }, "busy and dead tie on support; rank ties; 'busy' < 'dead' lexically — deterministic, not input-ordered");
    assert.equal(s.estimate.contradictorySources.length, 1); assert.equal(s.estimate.contradictorySources[0].value, "dead");
    assert.ok(s.estimate.confidence < 0.8, `confidence ${s.estimate.confidence} lowered by the contradiction`);
    assert.deepEqual(s.effects.map((e) => e.kind), ["saved_idea_better_now", "queue_risk_later"]);
    assert.deepEqual(s.effects[0].subjectIds, ["s1"]);
  });
  it("a source that cannot be read is reported UNREAD, not empty — and the projection is still served", async () => {
    const tables = base(); tables.trip_plan_items = [walk()]; tables.weather_cache = [forecast()];
    const r = await buildTripPulseProjection(makeClient(withStages(tables), ["weather_cache"]) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const wx = r.projection.sources.find((x) => x.name === "weather_cache")!;
    assert.equal(wx.status, "unread"); assert.deepEqual(r.projection.signals, []);
  });
  it("context that cannot be read REFUSES (a pulse over half a trip is the wrong pulse); a stranger's version is not consulted", async () => {
    const r = await buildTripPulseProjection(makeClient(withStages(base()), ["trip_saved_places"]) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(!r.ok && r.reason === "TRIP_PROJECTION_UNAVAILABLE" && /trip_saved_places/.test(r.message));
  });
});

describe("§17.2 the disruption register in health, and the priority switch", () => {
  it("a major active disruption makes the trip AT_RISK with TRIP_DISRUPTION_ACTIVE; the switch suppresses discovery with TRIP_DISRUPTION_SUPPRESSED; the pulse drops crowd signals for it", async () => {
    const tables = base();
    tables.trip_disruptions = [{ id: "d1", trip_id: TRIP_ID, kind: "transport", severity: "major", state: "active" }, { id: "d0", trip_id: TRIP_ID, kind: "venue", severity: "critical", state: "resolved" }];
    tables.trip_saved_places = [{ id: "s1", trip_id: TRIP_ID, place_id: VENUE_ID, place_name: "Le Bar", place_type: "bar", lat: null, lng: null }];
    tables.intel_state_snapshots = [snapshot("crowd.level", { level: "packed" })];
    const h = await buildTripHealthProjection(makeClient(withStages(tables)) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(h.ok);
    assert.equal(h.projection.health, "AT_RISK");
    assert.deepEqual(h.projection.reasons.map((x) => x.code), ["TRIP_DISRUPTION_ACTIVE"]);
    assert.deepEqual(h.projection.reasons[0].subjectIds, ["d1"], "the resolved one is not a reason");
    assert.equal(h.projection.counted.activeDisruptions, 1);
    assert.equal(h.projection.attention.mode, "AT_RISK");
    assert.deepEqual([...h.projection.attention.priority], ["logistics", "affected_commitments", "recovery"]);
    assert.deepEqual(h.projection.attention.suppression, { commercial: true, discovery: true, reason: "TRIP_DISRUPTION_SUPPRESSED", detail: "the trip is AT_RISK: commercial recommendations and entertainment discovery are suppressed (§17.2)" });
    const p = await buildTripPulseProjection(makeClient(withStages(tables)) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(p.ok);
    assert.deepEqual(p.projection.signals, []);
    assert.equal(p.projection.dropped.length, 1); assert.match(p.projection.dropped[0].reason, /^TRIP_DISRUPTION_SUPPRESSED/);
  });
  it("a critical disruption is DISRUPTED; a minor one is ATTENTION and does not switch the mode; a safety-kind disruption is a SAFETY_EVENT", async () => {
    const run = async (severity: string, kind = "transport") => {
      const tables = base(); tables.trip_disruptions = [{ id: "d", trip_id: TRIP_ID, kind, severity, state: "active" }];
      const h = await buildTripHealthProjection(makeClient(withStages(tables)) as any, TRIP_ID, OWNER_ID, { now: NOW });
      assert.ok(h.ok); return h.projection;
    };
    const critical = await run("critical"); assert.equal(critical.health, "DISRUPTED"); assert.equal(critical.attention.mode, "AT_RISK");
    const minor = await run("minor"); assert.equal(minor.health, "ATTENTION"); assert.equal(minor.attention.mode, "NORMAL"); assert.equal(minor.attention.suppression.discovery, false);
    const safety = await run("critical", "safety"); assert.equal(safety.attention.mode, "SAFETY_EVENT");
    assert.deepEqual([...safety.attention.priority], ["safety", "official_help", "location_coordination"]);
  });
  it("an unreadable register refuses the health projection — silence about a disruption is not health", async () => {
    // trip_disruptions is one of the tables the operational-projections gate
    // probes, so the refusal comes from the gate ("schema is unverifiable")
    // before the projection's own read; either way, nothing is served.
    const h = await buildTripHealthProjection(makeClient(withStages(base()), ["trip_disruptions"]) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(!h.ok, "served a health without the disruption register");
    assert.equal(h.reason, "TRIP_PROJECTION_UNAVAILABLE");
    assert.match(h.message, /disruption register|unverifiable/);
  });
});

describe("GET /trips/:id/pulse, Compass get_live_conditions, Today's pulseSignals layer", () => {
  it("serves the projection to a member with the envelope, and refuses a stranger by name", async () => {
    const tables = base(); tables.trip_plan_items = [walk()]; tables.weather_cache = [forecast()];
    install(tables);
    const r = await get("pulse");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sourceTripVersion, 9); assert.equal(r.body.signals.length, 1); assert.equal(r.body.signals[0].kind, "rain_arriving");
    assert.equal(typeof r.body.reading, "string");
    const s = await get("pulse", "other-token");
    assert.equal(s.status, 403); assert.equal(s.body.reason, "TRIP_AUTH_NOT_CREW");
  });
  it("§12.1 getLiveConditions: the tool returns the pulse, accepted, with contradictions counted and effects wrapped; a stranger gets nothing", async () => {
    const tables = base(); tables.trip_plan_items = [walk()]; tables.weather_cache = [forecast()];
    const c = install(tables);
    const out: any = await toolGetLiveConditions(c as any, OWNER_ID, { tripId: TRIP_ID });
    assert.equal(out.pulse.tripId, TRIP_ID); assert.equal(out.pulse.signals.length, 1);
    assert.equal(out.pulse.signals[0].estimate.contradictorySources, 0);
    assert.equal(out.pulse.attention.mode, "NORMAL"); assert.equal(out.projection.sourceTripVersion, 9);
    const stranger: any = await toolGetLiveConditions(c as any, OTHER_ID, { tripId: TRIP_ID });
    assert.equal(stranger.pulse, null);
  });
  it("Today carries the pulse's kept signals as an ok layer, the attention switch, and the pulse decision in its inputs", async () => {
    const tables = base(); tables.trip_plan_items = [walk()]; tables.weather_cache = [forecast()];
    const r = await buildTripTodayProjection(makeClient(withStages(tables)) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.projection.pulseSignals.status, "ok");
    assert.equal((r.projection.pulseSignals as any).items[0].kind, "rain_arriving");
    assert.equal(r.projection.attention.mode, "NORMAL");
    const d = readTripDecision(r.projection.decisionId)!;
    assert.equal(typeof (d.inputs as any).pulseDecisionId, "string");
  });
  it("Today says UNREAD for the pulse when a pulse source table is refused, rather than an empty layer", async () => {
    const r = await buildTripTodayProjection(makeClient(withStages(base()), ["trip_saved_places"]) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.projection.pulseSignals.status, "unread");
  });
  it("§21.1 POST /trips/:id/notifications/acted counts a known kind for a member, refuses an unknown kind and a stranger", async () => {
    install(base());
    assert.equal((await post("notifications/acted", { type: "trip_invite_received" })).status, 204);
    assert.equal((await post("notifications/acted", { type: "made_up" })).status, 400);
    assert.equal((await post("notifications/acted", { type: "trip_invite_received" }, "other-token")).status, 403);
  });
});


describe("§15.1 transport reliability on the pulse (2782's column, TR287)", () => {
  it("a stated value is served as stated; an unstated one is estimated from the mode baseline; completed segments are not judged", async () => {
    const tables = base();
    tables.trip_transport_segments = [
      { id: "tx1", trip_id: TRIP_ID, mode: "taxi", state: "planned", planned_departure_at: T("14:00"), reliability: null },
      { id: "tx2", trip_id: TRIP_ID, mode: "train", state: "booked", planned_departure_at: T("18:00"), reliability: "0.950" },
      { id: "tx3", trip_id: TRIP_ID, mode: "bus", state: "completed", planned_departure_at: T("08:00"), reliability: null },
    ];
    const r = await buildTripPulseProjection(makeClient(withStages(tables)) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const byId = new Map(r.projection.transportReliability.map((e) => [e.segmentId, e]));
    assert.equal(byId.get("tx1")!.basis, "estimated"); assert.equal(byId.get("tx1")!.value, 0.85); assert.deepEqual(byId.get("tx1")!.factors, []);
    assert.equal(byId.get("tx2")!.basis, "stated"); assert.equal(byId.get("tx2")!.value, 0.95);
    assert.equal(byId.has("tx3"), false, "a completed segment has nothing left to be reliable about");
  });
});
