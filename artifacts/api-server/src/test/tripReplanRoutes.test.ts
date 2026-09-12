/**
 * Trips spec §9.4 / §12.1 / §11.3 / §14.3 / §17.3 over real reads: the
 * preview, simulate, replan, meeting-point and rescue routes; Compass
 * simulate_plan / create_proposal / get_rescue_plan and §12.3's questions
 * on get_opportunities; §8.4 triggers on Today; §8.3 readiness by day and
 * by stage. census-trips TR143, TR145–TR147, TR156, TR196, TR209–TR212,
 * TR220, TR272–TR279, TR291–TR295, TR320–TR328.
 *
 * Run: node --import tsx/esm --test src/test/tripReplanRoutes.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { buildTripTodayProjection } from "../services/trips/TripTodayProjection.js";
import { toolSimulatePlan, toolCreateProposal, toolGetRescuePlan, toolGetOpportunities, toolReplanDay, toolFindMeetingPoint } from "../compass/CompassTools.js";
import { summarizeReadiness, type ReadinessItem } from "../lib/tripReadiness.js";
import { _resetTripMetrics } from "../lib/tripMetrics.js";
import { _resetOpportunityPortfolios } from "../services/trips/TripOpportunityProjection.js";
import { _resetTripDecisionLedger } from "../services/trips/TripDecisionLedger.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
const NOW = new Date(T("12:00"));
type Row = Record<string, any>;
const NEAR_A = { lat: 48.8600, lng: 2.3600 };

function withStages(tables: Record<string, Row[]>): Record<string, Row[]> {
  return { ...tables, trip_stages: tables.trip_stages ?? [{ id: "st1", trip_id: TRIP_ID, sequence: 1, starts_at: T("00:00", "12"), ends_at: T("23:59", "15") }] };
}
const plan = (id: string, o: Row = {}): Row => ({ id, trip_id: TRIP_ID, title: id, category: "activity", status: "confirmed", starts_at: T("15:00"), ends_at: T("17:00"), day_date: "2026-09-13", plan_scope: "ALL_CREW", lat: NEAR_A.lat, lng: NEAR_A.lng, location_is_private: false, removed_at: null, ...o });
function fixture(): Record<string, Row[]> {
  const t = base();
  t.trip_plan_items = [plan("Walking tour", { id: "walk" })];
  t.trip_reservations = [{ id: "res1", trip_id: TRIP_ID, user_id: OWNER_ID, title: "Walking tour", type: "activity", status: "confirmed", starts_at: T("15:00"), ends_at: T("17:00"), cancellation_deadline_at: T("13:00") }];
  t.trip_saved_places = [{ id: "s1", trip_id: TRIP_ID, user_id: OWNER_ID, place_id: null, place_name: "Café Mid", place_type: "cafe", lat: NEAR_A.lat, lng: NEAR_A.lng }];
  return t;
}
function withRpc(c: any, rpc: (fn: string, args: Row) => Promise<{ data: any; error: any }>) { c.rpc = rpc; return c; }
let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
}
after(() => { server?.close(); });
async function post(path: string, body: unknown, token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function install(tables: Record<string, Row[]>, rpc?: (fn: string, args: Row) => Promise<{ data: any; error: any }>) {
  const c = makeClient(withStages(tables)); if (rpc) withRpc(c, rpc);
  _setTestClient(c as any, true); _setTestServiceClient(c as any); return c;
}
const kernelOk = (calls: Row[]) => async (fn: string, args: Row) => {
  if (fn !== "trip_kernel_execute") return { data: null, error: null };
  calls.push(args.p_command);
  return { data: { ok: true, duplicate: false, version: 10, event_id: 1, sequence: 1, result: { id: `obj-${calls.length}` }, contract_version: 2 }, error: null };
};
beforeEach(async () => { if (!server) await start(); _resetTripMetrics(); _resetOpportunityPortfolios(); _resetTripDecisionLedger(); });

describe("§9.4 POST /proposals/preview and §12.1 POST /simulate", () => {
  it("cancelling the booked shared walk: the booking at risk with its deadline, confirmation required, unanimous suggested; a bad change is 400; a stranger 403", async () => {
    install(fixture());
    const r = await post("proposals/preview", { change: { kind: "cancel_plan", targetId: "walk" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = r.body.preview;
    assert.equal(p.changesConfirmedPlan, true); assert.equal(p.bookingSideEffects.requiresUserConfirmation, true); assert.equal(p.bookingSideEffects.cancellationDeadline, T("13:00"));
    assert.equal(p.bookingSideEffects.potentialCostMinor, null, "trip_reservations carries no price: unknown, not zero");
    assert.equal(p.governance.suggestedDecisionRule, "unanimous");
    assert.equal((await post("proposals/preview", { change: { kind: "teleport" } })).status, 400);
    assert.equal((await post("proposals/preview", { change: { kind: "cancel_plan", targetId: "walk" } }, "other-token")).status, 403);
  });
  it("simulate: a move into commitment B's approach window is INFEASIBLE with the conflict named; a move inside the free window is FEASIBLE", async () => {
    install(fixture());
    const bad = await post("simulate", { change: { kind: "move_plan", targetId: "walk", startsAt: T("15:45"), endsAt: T("16:15") } });
    assert.equal(bad.status, 200, JSON.stringify(bad.body)); assert.equal(bad.body.simulation.feasibility, "INFEASIBLE"); assert.equal(bad.body.simulation.conflicts[0].commitmentIds[0], "B");
    const ok = await post("simulate", { change: { kind: "move_plan", targetId: "walk", startsAt: T("12:30"), endsAt: T("13:30") } });
    assert.equal(ok.status, 200); assert.equal(ok.body.simulation.feasibility, "FEASIBLE"); assert.ok(ok.body.simulation.windowAfter);
  });
});

describe("§11.3 POST /replan — the candidate diff, and proposals only when asked and enabled", () => {
  it("rain on the booked walk: cancel with side effects + the café as the fallback add; both shared → proposals; createProposals without the kernel is skipped by name; with it, CREATE_PROPOSAL per entry", async () => {
    const t = fixture();
    t.weather_cache = [{ destination: "Paris", date_key: "2026-09-13:2026-09-15", fetched_at: T("11:00"), forecasts_json: [{ date: "2026-09-13", precipMm: 9, weatherCode: 63, summary: "Rain" }] }];
    install(t);
    // the route runs on the real clock: ask for the fixture's day explicitly
    const r = await post("replan", { day: "2026-09-13" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.diff;
    const cancel = d.entries.find((e: any) => e.planId === "walk");
    assert.ok(cancel && cancel.op === "cancel" && cancel.reason === "PLAN_INVALIDATED_BY_SIGNAL", JSON.stringify(d.entries));
    assert.equal(cancel.impact.bookingSideEffects.requiresUserConfirmation, true);
    assert.equal(d.requiresUserConfirmation, true); assert.ok(d.proposals.length >= 1);
    assert.equal(r.body.proposals.skipped, null); assert.deepEqual(r.body.proposals.created, []);
    const off = await post("replan", { day: "2026-09-13", createProposals: true });
    assert.equal(off.body.proposals.skipped, "trip_kernel_enabled is false");
    const on = fixture(); on.weather_cache = t.weather_cache; on.feature_flags = [...on.feature_flags, { flag: "trip_kernel_enabled", enabled: true }];
    const calls: Row[] = []; install(on, kernelOk(calls));
    const created = await post("replan", { day: "2026-09-13", createProposals: true });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const proposals = calls.filter((c) => c.type === "CREATE_PROPOSAL");
    assert.ok(proposals.length >= 1); assert.equal(proposals[0].payload.proposal_type, "replan_cancel"); assert.equal(proposals[0].payload.decision_rule, "unanimous");
    assert.equal(proposals[0].payload.payload_json.source, "replan"); assert.ok(proposals[0].idempotency_key.startsWith("replan:2026-09-13:cancel:walk"));
    assert.equal(created.body.proposals.created.length, proposals.length);
  });
});

describe("§14.3 POST /meeting-point and §17.3 POST /rescue", () => {
  it("without the crew map, nobody is placed and it says why per participant; candidates are the saved ideas and the plans with a point", async () => {
    install(fixture());
    const r = await post("meeting-point", {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.meetingPoint.recommended, null);
    assert.deepEqual(r.body.meetingPoint.unplaced.map((u: any) => u.userId).sort(), [MEMBER_ID, OWNER_ID].sort());
    assert.match(r.body.meetingPoint.unplaced[0].reason, /trip_crew_map_enabled is off/);
    assert.equal(r.body.candidatesConsidered, 2); assert.equal(r.body.meetingPoint.constraintsApplied.length, 6);
  });
  it("rescue: a typed problem returns the plan; the disruption is declared through the kernel when enabled, skipped by name when not; an unknown problem is 400", async () => {
    install(fixture());
    const r = await post("rescue", { problem: "missed_transport" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.plan.problem, "missed_transport"); assert.ok(r.body.plan.escalation.length >= 1); assert.equal(r.body.declared.skipped, "trip_kernel_enabled is false");
    assert.equal((await post("rescue", { problem: "lost_wallet" })).status, 400);
    const on = fixture(); on.feature_flags = [...on.feature_flags, { flag: "trip_kernel_enabled", enabled: true }];
    const calls: Row[] = []; install(on, kernelOk(calls));
    const d = await post("rescue", { problem: "emergency" });
    assert.equal(d.status, 201); assert.equal(d.body.declared.ok, true);
    const cmd = calls.find((c) => c.type === "DECLARE_DISRUPTION")!;
    assert.deepEqual([cmd.payload.kind, cmd.payload.severity], ["safety", "critical"]); assert.ok(cmd.idempotency_key.startsWith("rescue:emergency:"));
  });
});

describe("§8.2 GET /decisions — urgency on every task", () => {
  it("each task carries the four terms and a band; tasks come back by urgency, not by due date; the urgency inputs that could not be read are named", async () => {
    const t = fixture();
    t.trip_goals = []; t.trip_risks = []; t.trip_proposals = []; t.trip_proposal_votes = [];
    t.trip_decision_tasks = [
      { id: "soon-trivial", trip_id: TRIP_ID, type: "booking", deadline_at: T("14:00"), consequence: "a small fee", assigned_user_id: null, status: "pending" },
      { id: "later-severe", trip_id: TRIP_ID, type: "lodging", deadline_at: T("10:00", "14"), consequence: "nowhere to sleep — the crew would be stranded", assigned_user_id: null, status: "pending" },
    ];
    // commitment B (16:00, from the base fixture) starts within a day of soon-trivial's deadline; the walk plan (15:00) too
    install(t);
    const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/decisions`, { headers: { Authorization: "Bearer owner-token" } });
    const body: any = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.urgencyInputsUnread, []);
    for (const task of body.decisionTasks) {
      assert.deepEqual(Object.keys(task.urgency.terms), ["timeRemaining", "availabilityDecay", "downstreamImpact", "consequence"]);
      assert.ok(["low", "medium", "high", "critical"].includes(task.urgency.band));
    }
    const soon = body.decisionTasks.find((x: any) => x.id === "soon-trivial"); const severe = body.decisionTasks.find((x: any) => x.id === "later-severe");
    assert.equal(soon.urgency.consequenceLevel, "minor"); assert.equal(severe.urgency.consequenceLevel, "severe");
    assert.ok(soon.urgency.terms.downstreamImpact > 0, "commitment B and the walk depend on it");
    assert.equal(body.decisionTasks[0].urgency.score, Math.max(soon.urgency.score, severe.urgency.score), "sorted by urgency");
  });
});

describe("§8.4 on Today, §8.3 readiness grouping, and the Compass tools", () => {
  it("Today carries the four triggers; rain on the walk fires weather_sensitive with the spec's mitigation; the others say why they did not fire", async () => {
    const t = fixture();
    t.weather_cache = [{ destination: "Paris", date_key: "2026-09-13:2026-09-15", fetched_at: T("11:00"), forecasts_json: [{ date: "2026-09-13", precipMm: 9, weatherCode: 63, summary: "Rain" }] }];
    const r = await buildTripTodayProjection(makeClient(withStages(t)) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const trig = r.projection.riskTriggers;
    assert.deepEqual(trig.map((x) => x.kind), ["tight_arrival", "weather_sensitive", "late_check_in", "crew_transport_mismatch"]);
    const weather = trig.find((x) => x.kind === "weather_sensitive")!;
    assert.equal(weather.fired, true); assert.deepEqual(weather.affectedIds, ["walk"]); assert.equal(weather.mitigation, "Prepare indoor fallback.");
    assert.ok(trig.filter((x) => !x.fired).every((x) => x.evidence.length > 10));
  });
  it("readiness: open items grouped by due date, soonest first and undated last, and by stage when stages are given; null byStage when they are not", () => {
    const item = (id: string, dueAt: string | null, severity: "normal" | "critical" = "normal", status: ReadinessItem["status"] = "action_needed"): ReadinessItem => ({ id, userId: null, category: "plan", status, severity, title: id, detail: null, dueAt, actionRef: null, dedupeKey: id, computedAt: null });
    const items = [item("late", T("10:00", "14"), "critical"), item("soon", T("18:00", "13")), item("undated", null), item("ready", T("09:00", "13"), "normal", "ready")];
    const s = summarizeReadiness(items, T("12:00"), null, [{ id: "st1", sequence: 1, startsAt: T("00:00", "12"), endsAt: T("23:59", "13") }, { id: "st2", sequence: 2, startsAt: T("00:00", "14"), endsAt: T("23:59", "15") }]);
    assert.deepEqual(s.byDay.map((d) => [d.date, d.critical, d.actionNeeded, d.itemIds]), [["2026-09-13", 0, 1, ["soon"]], ["2026-09-14", 1, 1, ["late"]], [null, 0, 1, ["undated"]]]);
    assert.deepEqual(s.byStage!.map((st) => [st.stageId, st.critical, st.itemIds]), [["st1", 0, ["soon"]], ["st2", 1, ["late"]]]);
    assert.equal(summarizeReadiness(items, T("12:00")).byStage, null);
  });
  it("Compass: simulate_plan judges without writing; create_proposal is refused by name without the kernel and goes through CREATE_PROPOSAL with it; get_rescue_plan is read-only; get_opportunities carries §12.3's questions", async () => {
    const c = install(fixture());
    const sim: any = await toolSimulatePlan(c as any, OWNER_ID, { tripId: TRIP_ID, kind: "cancel_plan", targetId: "walk" });
    assert.equal(sim.simulation.feasibility, "FEASIBLE"); assert.equal(sim.simulation.bookingSideEffects.requiresUserConfirmation, true);
    const noKernel: any = await toolCreateProposal(c as any, OWNER_ID, { tripId: TRIP_ID, proposalType: "cancel_plan", change: { targetId: "walk", rationale: "rain" } });
    assert.equal(noKernel.proposal, null); assert.match(noKernel.info, /trip_kernel_enabled is false/);
    const on = fixture(); on.feature_flags = [...on.feature_flags, { flag: "trip_kernel_enabled", enabled: true }];
    const calls: Row[] = []; const k = install(on, kernelOk(calls));
    const made: any = await toolCreateProposal(k as any, OWNER_ID, { tripId: TRIP_ID, proposalType: "cancel_plan", change: { targetId: "walk", rationale: "rain" }, decisionRule: "majority" });
    assert.equal(made.proposal.status, "pending"); assert.equal(calls[0].type, "CREATE_PROPOSAL"); assert.equal(calls[0].payload.decision_rule, "majority"); assert.equal(calls[0].payload.payload_json.source, "compass");
    const rescue: any = await toolGetRescuePlan(k as any, OWNER_ID, { tripId: TRIP_ID, problem: "hotel_issue" });
    assert.equal(rescue.rescue.problem, "hotel_issue"); assert.equal(calls.filter((x) => x.type === "DECLARE_DISRUPTION").length, 0, "read-only");
    const opp: any = await toolGetOpportunities(k as any, OWNER_ID, { tripId: TRIP_ID });
    assert.ok(opp.opportunities.questionsWorthAsking); assert.ok(Array.isArray(opp.opportunities.questionsWorthAsking.ask) && Array.isArray(opp.opportunities.questionsWorthAsking.representedAsUncertainty));
  });
  it("Compass: replan_day carries the same diff as the route, never writes, and names create_proposal for the shared mutations; a stranger gets info, not a diff", async () => {
    const t = fixture();
    t.weather_cache = [{ destination: "Paris", date_key: "2026-09-13:2026-09-15", fetched_at: T("11:00"), forecasts_json: [{ date: "2026-09-13", precipMm: 9, weatherCode: 63, summary: "Rain" }] }];
    const calls: Row[] = []; const c = install(t, kernelOk(calls));
    const r: any = await toolReplanDay(c as any, OWNER_ID, { tripId: TRIP_ID, day: "2026-09-13" });
    assert.ok(r.replan, JSON.stringify(r));
    assert.equal(r.replan.day, "2026-09-13");
    const cancel = r.replan.entries.find((e: any) => e.planId === "walk");
    assert.ok(cancel && cancel.op === "cancel" && cancel.reason === "PLAN_INVALIDATED_BY_SIGNAL", JSON.stringify(r.replan.entries));
    assert.equal(cancel.sharedMutation, true); assert.equal(cancel.bookingSideEffects.requiresUserConfirmation, true); assert.equal(cancel.governance.suggestedDecisionRule, "unanimous");
    assert.equal(r.replan.requiresUserConfirmation, true); assert.ok(r.replan.proposals >= 1);
    assert.match(r.info, /create_proposal/);
    assert.equal(calls.length, 0, "the tool proposes; it never issues a command");
    const locked: any = await toolReplanDay(c as any, OWNER_ID, { tripId: TRIP_ID, day: "2026-09-13", lockedPlanIds: ["walk"] });
    assert.ok(locked.replan); assert.ok(!locked.replan.entries.some((e: any) => e.planId === "walk" && e.op === "cancel"), "a locked plan is kept");
    const stranger: any = await toolReplanDay(c as any, "33333333-3333-3333-3333-333333333333", { tripId: TRIP_ID, day: "2026-09-13" });
    assert.equal(stranger.replan, null); assert.equal(typeof stranger.info, "string");
  });
  it("Compass: find_meeting_point without the crew map places nobody and says why per participant; the candidates are the saved ideas and the located plans", async () => {
    const c = install(fixture());
    const r: any = await toolFindMeetingPoint(c as any, OWNER_ID, { tripId: TRIP_ID });
    assert.ok(r.meetingPoint, JSON.stringify(r));
    assert.equal(r.meetingPoint.recommended, null);
    assert.deepEqual(r.meetingPoint.unplaced.map((u: any) => u.userId).sort(), [MEMBER_ID, OWNER_ID].sort());
    assert.match(r.meetingPoint.unplaced[0].reason, /trip_crew_map_enabled is off/);
    assert.equal(r.candidatesConsidered, 2); assert.equal(r.meetingPoint.constraintsApplied.length, 6);
    const stranger: any = await toolFindMeetingPoint(c as any, "33333333-3333-3333-3333-333333333333", { tripId: TRIP_ID });
    assert.equal(stranger.meetingPoint, null); assert.equal(typeof stranger.info, "string");
  });
});
