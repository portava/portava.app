/**
 * Trips spec §13 — the opportunity projection over real reads: candidates
 * from saved ideas, live conditions from intel snapshots and the pulse,
 * windows from the freedom projection; the §13.3 event against the last
 * ledgered portfolio; RECORD_OPPORTUNITY_CHANGE through the kernel when it
 * matters; `GET /trips/:id/opportunities`, `POST …/:experienceId/accept`
 * (ADD_PLAN through the kernel), Compass `get_opportunities`, Today's
 * `opportunities` layer, the map's `liveOpportunities` layer, and §21.1's
 * opportunity_created / accepted / completed.
 * census-trips TR224–TR253, TR263, TR397, TR413.
 *
 * Run: node --import tsx/esm --test src/test/tripOpportunityProjection.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { buildTripOpportunityProjection, _resetOpportunityPortfolios } from "../services/trips/TripOpportunityProjection.js";
import { buildTripTodayProjection } from "../services/trips/TripTodayProjection.js";
import { toolGetOpportunities } from "../compass/CompassTools.js";
import { readTripDecision, _resetTripDecisionLedger } from "../services/trips/TripDecisionLedger.js";
import { readTripMetric, _resetTripMetrics } from "../lib/tripMetrics.js";
import { makeClient, base } from "./tripHealthProjection.test.js";
import { recordOpportunityCompletion } from "../lib/tripOpportunityMetrics.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const OTHER_ID  = "33333333-3333-3333-3333-333333333333";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VENUE_ID  = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
const NOW = new Date(T("12:00"));
type Row = Record<string, any>;
// base() puts commitment A at 10:00 (ORIGIN) and B's required arrival at 16:00 (DEST); the window between is fw:A:B.
const NEAR_A = { lat: 48.8600, lng: 2.3600 };

function withStages(tables: Record<string, Row[]>): Record<string, Row[]> {
  return { ...tables, trip_stages: tables.trip_stages ?? [{ id: "st1", trip_id: TRIP_ID, sequence: 1, starts_at: T("00:00", "12"), ends_at: T("23:59", "15") }] };
}
const saved = (id: string, o: Row = {}): Row => ({ id, trip_id: TRIP_ID, user_id: OWNER_ID, place_id: null, place_name: id, place_type: "park", lat: NEAR_A.lat, lng: NEAR_A.lng, ...o });
function withRpc(c: any, rpc: (fn: string, args: Row) => Promise<{ data: any; error: any }>) { c.rpc = rpc; return c; }

let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
}
after(() => { server?.close(); });
async function call(method: string, path: string, body?: unknown, token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function install(tables: Record<string, Row[]>, errorOn: string[] = [], rpc?: (fn: string, args: Row) => Promise<{ data: any; error: any }>) {
  const c = makeClient(withStages(tables), errorOn);
  if (rpc) withRpc(c, rpc);
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  return c;
}
beforeEach(async () => { if (!server) await start(); _resetTripMetrics(); _resetOpportunityPortfolios(); _resetTripDecisionLedger(); });

const ORIGIN_COORDS = () => { const p = (base().places as any[]); return { a: p[0], b: p[1] }; };

describe("§13 buildTripOpportunityProjection — the eight inputs from the trip", () => {
  it("no saved ideas: one window, an empty portfolio, an 'initial' event of low significance, nothing recorded (kernel flag off), sources named", async () => {
    const r = await buildTripOpportunityProjection(makeClient(withStages(base())) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const p = r.projection;
    assert.equal(p.sourceTripVersion, 9); assert.equal(p.windows[0].windowId, "fw:A:B", "current-or-next first; the after_last window follows");
    assert.equal(p.windows.length, 2);
    assert.deepEqual(p.windows[0].executable, []); assert.equal(p.windows[0].candidates, 0);
    assert.ok(p.event); assert.equal(p.event.trigger, "initial"); assert.equal(p.event.significance, "low");
    assert.equal(p.notify.wouldNotify, false); assert.equal(p.recorded.skipped, "trip_kernel_enabled is false");
    assert.deepEqual(p.sources, { savedIdeas: 0, intelSnapshots: "none", goals: 0, participants: 2, origin: "window" });
    const d = readTripDecision(p.decisionId); assert.ok(d && d.type === "opportunity_projection");
  });
  it("a saved park near the origin is EXECUTABLE in the window with a walk each way; a saved museum with unknown hours is UNCERTAIN; a live closure makes a venue NOT_EXECUTABLE", async () => {
    const tables = base();
    tables.trip_saved_places = [saved("park"), saved("museum", { place_type: "museum" }), saved("bar", { place_type: "bar", place_id: VENUE_ID })];
    tables.intel_state_snapshots = [{ subject_id: VENUE_ID, zone_id: "", claim_type: "closure.state", value: { state: "temporarily_closed" }, confidence: 0.9, observed_at: T("11:50"), expires_at: T("13:00") }];
    const r = await buildTripOpportunityProjection(makeClient(withStages(tables)) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const w = r.projection.windows[0];
    assert.deepEqual(w.executable.map((e) => e.candidateId), ["park"]);
    assert.equal(w.executable[0].primitive, "WALK"); assert.equal(w.executable[0].travel.mode, "walk"); assert.ok(w.executable[0].arriveAt && w.executable[0].leaveBy);
    assert.deepEqual(w.uncertain.map((e) => [e.candidateId, e.reasonCodes.includes("EXPERIENCE_HOURS_UNKNOWN")]), [["museum", true]]);
    assert.deepEqual(w.notExecutable.map((e) => [e.candidateId, e.reasonCodes.includes("EXPERIENCE_CLOSED_LIVE")]), [["bar", true]]);
    assert.equal(r.projection.sources.intelSnapshots, "ok");
    assert.equal(r.projection.event!.significance, "medium", "the first portfolio with an executable option");
    assert.deepEqual(readTripMetric("opportunity_created_total").map((s) => [s.labels.primitive, s.count]), [["WALK", 1]]);
  });
  it("the second computation diffs against the first: unchanged → none; a park invalidated by rain → the rooftop case, HIGH, would notify as plan_invalidated", async () => {
    const tables = base();
    // park: open-air, invalidated by rain; meetup: a MEET primitive, open-air but not weather-bound — the indoor plan that "now fits"
    tables.trip_saved_places = [saved("park"), saved("meetup", { place_type: "meeting_point" })];
    const c = makeClient(withStages(tables));
    const first = await buildTripOpportunityProjection(c as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(first.ok); assert.equal(first.projection.event!.trigger, "initial");
    const same = await buildTripOpportunityProjection(c as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(same.ok); assert.equal(same.projection.event!.significance, "none"); assert.equal(same.projection.recorded.skipped, "no change");
    // rain arrives: the park is open-air and a weather-sensitive plan exists that day
    tables.weather_cache = [{ destination: "Paris", date_key: "2026-09-13:2026-09-15", fetched_at: T("11:00"), forecasts_json: [{ date: "2026-09-13", precipMm: 9, weatherCode: 63, summary: "Rain" }] }];
    tables.trip_plan_items = [{ id: "walk", trip_id: TRIP_ID, title: "Walking tour", category: "activity", status: "planned", starts_at: T("15:00"), ends_at: T("17:00"), lat: null, lng: null, location_name: null, removed_at: null }];
    // makeClient copies the table map, so a changed world is a new client; the ledger (the previous portfolio) is in process.
    const rain = await buildTripOpportunityProjection(makeClient(withStages(tables)) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(rain.ok, JSON.stringify(rain));
    const ev = rain.projection.event!;
    assert.deepEqual(ev.opportunitiesRemoved.map((x) => x.candidateId), ["park"]);
    assert.ok(ev.opportunitiesRemoved[0].reasonCodes.includes("EXPERIENCE_WEATHER_INVALIDATED"));
    assert.equal(ev.significance, "high", "a hard removal with an option left standing");
    assert.deepEqual(rain.projection.windows[0].executable.map((e) => e.candidateId), ["meetup"]);
    assert.equal(rain.projection.notify.kind, "plan_invalidated"); assert.equal(rain.projection.notify.wouldNotify, true); assert.equal(rain.projection.notify.level, "NOTIFY");
  });
  it("with trip_kernel_enabled on, a significant change is RECORDED through the kernel with a diff-derived idempotency key; the same diff again is a duplicate; a refusal is reported, not hidden", async () => {
    const tables = base(); tables.trip_saved_places = [saved("park")];
    tables.feature_flags = [...tables.feature_flags, { flag: "trip_kernel_enabled", enabled: true }];
    const calls: Row[] = [];
    // With the kernel flag on, the freedom projection issues its own derived
    // events (OPEN_FREE_WINDOW) through the same rpc, so the fake is a real
    // receipt table: a duplicate is a key it has seen, nothing else.
    const seen = new Set<string>();
    const c = withRpc(makeClient(withStages(tables)), async (fn, args) => {
      if (fn !== "trip_kernel_execute") return { data: null, error: null };
      const cmd = (args as any).p_command;
      calls.push({ fn, cmd });
      const dup = seen.has(cmd.idempotency_key); seen.add(cmd.idempotency_key);
      return { data: { ok: true, duplicate: dup, version: 10, event_id: 1, sequence: 1, result: {}, contract_version: 2 }, error: null };
    });
    const opp = () => calls.filter((x) => x.cmd.type === "RECORD_OPPORTUNITY_CHANGE");
    const r1 = await buildTripOpportunityProjection(c as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r1.ok, JSON.stringify(r1));
    assert.deepEqual(r1.projection.recorded, { issued: true, duplicate: false, skipped: null, failed: null });
    assert.equal(opp().length, 1);
    const cmd = opp()[0].cmd;
    assert.match(cmd.idempotency_key, /^engine:opportunity:aaaaaaaa/); assert.equal(cmd.actor_role, "system"); assert.equal(cmd.actor_user_id, null);
    assert.equal(cmd.payload.significance, "medium"); assert.equal(cmd.payload.window_id, "fw:A:B"); assert.equal(cmd.payload.added.length, 1);
    // second run: the portfolio is unchanged, so no event is issued at all
    const r2 = await buildTripOpportunityProjection(c as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r2.ok); assert.equal(r2.projection.recorded.skipped, "no change"); assert.equal(opp().length, 1);
    _resetOpportunityPortfolios(); _resetTripDecisionLedger();
    const refusing = withRpc(makeClient(withStages(tables)), async () => ({ data: { ok: false, reason: "TRIP_COMMAND_UNKNOWN_TYPE", contract_version: 2 }, error: null }));
    const r3 = await buildTripOpportunityProjection(refusing as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r3.ok); assert.equal(r3.projection.recorded.failed, "TRIP_COMMAND_UNKNOWN_TYPE");
  });
  it("§17.2: a major disruption suppresses the executable list, by name, and nothing would be notified", async () => {
    const tables = base(); tables.trip_saved_places = [saved("park")];
    tables.trip_disruptions = [{ id: "d1", trip_id: TRIP_ID, kind: "transport", severity: "major", state: "active" }];
    const r = await buildTripOpportunityProjection(makeClient(withStages(tables)) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.projection.attention.mode, "AT_RISK");
    assert.deepEqual(r.projection.windows[0].executable, []);
    assert.match(r.projection.notify.reason, /^TRIP_DISRUPTION_SUPPRESSED/);
  });
  it("saved ideas unreadable → refused; intel unreadable → served with intelSnapshots 'unread'", async () => {
    const tables = base(); tables.trip_saved_places = [saved("bar", { place_type: "bar", place_id: VENUE_ID })];
    const refused = await buildTripOpportunityProjection(makeClient(withStages(tables), ["trip_saved_places"]) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(!refused.ok && refused.reason === "TRIP_PROJECTION_UNAVAILABLE");
    const served = await buildTripOpportunityProjection(makeClient(withStages(tables), ["intel_state_snapshots"]) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(served.ok); assert.equal(served.projection.sources.intelSnapshots, "unread");
  });
});

describe("routes, Compass, Today and the map", () => {
  it("GET /opportunities serves a member and refuses a stranger; POST accept writes ADD_PLAN through the kernel once (source_type opportunity), counts accepted, and refuses a non-executable one by reason", async () => {
    const tables = base(); tables.trip_saved_places = [saved("park"), saved("museum", { place_type: "museum" })];
    const calls: Row[] = [];
    install(tables, [], async (fn, args) => {
      if (fn !== "trip_kernel_execute") return { data: null, error: null };
      calls.push({ fn, args }); return { data: { ok: true, duplicate: calls.length > 1, version: 10, event_id: 7, sequence: 3, result: { id: "plan-1" }, contract_version: 2 }, error: null };
    });
    const r = await call("GET", "opportunities");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // the route runs on the real clock, so the window is found by id, not position
    const fw = r.body.windows.find((w: any) => w.windowId === "fw:A:B");
    assert.ok(fw, JSON.stringify(r.body.windows.map((w: any) => w.windowId)));
    assert.equal(fw.executable[0].candidateId, "park");
    assert.equal((await call("GET", "opportunities", undefined, "other-token")).status, 403);
    const id = fw.executable[0].id;
    const a = await call("POST", `opportunities/${encodeURIComponent(id)}/accept`, {});
    assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(a.body.ok, true); assert.equal(a.body.experienceId, id);
    const sent = JSON.stringify(calls[0].args);
    assert.match(sent, /"type":"ADD_PLAN"/); assert.match(sent, /"source_type":"opportunity"/); assert.match(sent, new RegExp(`opportunity:accept:${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.deepEqual(readTripMetric("opportunity_accepted_total").map((s) => s.count), [1]);
    const again = await call("POST", `opportunities/${encodeURIComponent(id)}/accept`, {});
    assert.equal(again.status, 200); assert.equal(again.body.duplicate, true);
    assert.deepEqual(readTripMetric("opportunity_accepted_total").map((s) => s.count), [1], "a duplicate is not a second acceptance");
    const museumId = fw.uncertain[0].id;
    const nope = await call("POST", `opportunities/${encodeURIComponent(museumId)}/accept`, {});
    assert.equal(nope.status, 409); assert.equal(nope.body.reason, "UNCERTAIN"); assert.ok(nope.body.reasonCodes.includes("EXPERIENCE_HOURS_UNKNOWN"));
    assert.equal((await call("POST", "opportunities/nope/accept", {})).status, 404);
  });
  it("§21.1 opportunity_completed_total: a COMPLETE_ACTIVITY whose result row came from an opportunity counts once; a duplicate, another command or another source does not; the plan PATCH cutover calls it", () => {
    assert.equal(recordOpportunityCompletion("COMPLETE_ACTIVITY", { id: "p1", source_type: "opportunity", category: "activity" }, TRIP_ID, false), true);
    assert.equal(recordOpportunityCompletion("COMPLETE_ACTIVITY", { id: "p1", source_type: "opportunity", category: "activity" }, TRIP_ID, true), false, "a replay is not a second completion");
    assert.equal(recordOpportunityCompletion("CONFIRM_PLAN", { id: "p1", source_type: "opportunity" }, TRIP_ID, false), false);
    assert.equal(recordOpportunityCompletion("COMPLETE_ACTIVITY", { id: "p2", source_type: "manual" }, TRIP_ID, false), false);
    assert.equal(recordOpportunityCompletion("COMPLETE_ACTIVITY", null, TRIP_ID, false), false);
    assert.deepEqual(readTripMetric("opportunity_completed_total").map((s) => [s.labels.trip, s.count]), [[TRIP_ID, 1]]);
    // the kernel path of PATCH /trips/:id/plan/items/:itemId is where COMPLETE_ACTIVITY is issued (the commands endpoint gates it), and it calls this
    const trips = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../routes/trips.ts"), "utf8");
    const at = trips.indexOf("recordOpportunityCompletion(planCommandTypeForPatch(patch), r.result, tripId, r.duplicate)");
    assert.ok(at > 0, "the plan PATCH cutover does not record completions");
    assert.ok(trips.lastIndexOf("type: planCommandTypeForPatch(patch),", at) > 0 && at - trips.lastIndexOf("type: planCommandTypeForPatch(patch),", at) < 400, "the call is not on the kernel path");
  });
  it("Compass get_opportunities returns the accepted portfolio with names wrapped; Today carries the executable list as its opportunities layer; the map's liveOpportunities layer has the point", async () => {
    const tables = base(); tables.trip_saved_places = [saved("park")];
    const c = install(tables);
    const out: any = await toolGetOpportunities(c as any, OWNER_ID, { tripId: TRIP_ID });
    assert.equal(out.opportunities.tripId, TRIP_ID);
    const fw = out.opportunities.windows.find((w: any) => w.windowId === "fw:A:B");
    assert.equal(fw.executable.length, 1); assert.match(fw.executable[0].name, /park/);
    assert.equal(out.opportunities.event.trigger, "initial");
    const stranger: any = await toolGetOpportunities(c as any, OTHER_ID, { tripId: TRIP_ID });
    assert.equal(stranger.opportunities, null);
    const today = await buildTripTodayProjection(c as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(today.ok, JSON.stringify(today));
    assert.equal(today.projection.opportunities.status, "ok"); assert.equal((today.projection.opportunities as any).items[0].candidateId, "park");
    const d = readTripDecision(today.projection.decisionId)!; assert.equal(typeof (d.inputs as any).opportunityDecisionId, "string");
    const map = await call("GET", "map-projection");
    assert.equal(map.status, 200, JSON.stringify(map.body));
    assert.equal(map.body.liveOpportunities.status, "ok");
    assert.deepEqual(map.body.liveOpportunities.items.map((p: any) => [p.kind, p.label, p.lat]), [["opportunity", "park", NEAR_A.lat]]);
  });
});
