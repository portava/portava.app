/**
 * Trips spec §20.2 closeout, §20.3 minimal reconciliation, §21.2 decision
 * ledger and §12.1 explainTripDecision. census-trips TR383–TR390, TR401,
 * TR402, TR213, TR376, TR428.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { planCloseout, reconciliationQuestions, CLOSEOUT_STEPS } from "../services/trips/TripCloseout.js";
import { runTripCloseout } from "../services/trips/TripCloseoutService.js";
import {
  recordTripDecision, readTripDecision, listTripDecisions, explainTripDecision, _resetTripDecisionLedger,
  TRIP_DECISION_RING, TRIP_ENGINE_VERSIONS,
} from "../services/trips/TripDecisionLedger.js";

const TRIP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const item = (id: string, o: Record<string, any> = {}) => ({ id, title: id, status: "tentative", dayDate: "2026-09-13", locationName: null, ...o });

describe("§20.3 the smallest useful question set", () => {
  it("asks about dated plans not marked done or cancelled, in the spec's own words, and nothing else", () => {
    const q = reconciliationQuestions({ today: "2026-09-15", planItems: [
      item("a", { locationName: "Hoi An" }), item("b", { status: "done" }), item("c", { status: "cancelled" }),
      item("d", { dayDate: null }), item("e", { dayDate: "2026-09-20" }), item("f", { status: "confirmed", title: "Dinner" }),
    ] });
    assert.deepEqual(q.map((x) => [x.planId, x.question]), [["a", "Did you make it to Hoi An?"], ["f", "Did you make it to Dinner?"]]);
    assert.deepEqual([...q[0]!.answers], ["completed", "skipped"], "the two outcomes RECORD_OUTCOME would take");
  });
});

describe("§20.2 the seven steps, planned in order and each said to be actionable, not applicable, or deferred", () => {
  it("names every step in §20.2's order", () => {
    const { steps } = planCloseout({ activeLiveShareIds: [], planItems: [], pendingDecisionTaskIds: null, tripEndDate: null, today: "2026-09-15" });
    assert.deepEqual(steps.map((s) => s.step), [...CLOSEOUT_STEPS]);
    assert.equal(steps.length, 7);
  });
  it("stopping presence is actionable only with active sessions; decision tasks are deferred when unread or pending", () => {
    const a = planCloseout({ activeLiveShareIds: ["s1", "s2"], planItems: [item("a")], pendingDecisionTaskIds: ["t1"], tripEndDate: null, today: "2026-09-15" });
    assert.deepEqual(a.steps[0], { step: "stop_temporary_presence", status: "actionable", ids: ["s1", "s2"], detail: "2 active live-share session(s) stop at completion" });
    assert.equal(a.steps[2]!.status, "actionable");
    assert.deepEqual(a.steps[3], { step: "close_operational_decision_tasks", status: "actionable", ids: ["t1"], detail: "1 pending decision task(s) expire at completion — UPDATE_DECISION_TASK through the kernel" });
    assert.equal(a.steps[6]!.status, "deferred", "the ledger was not read: deferred, by name");
    assert.match(a.steps[6]!.detail, /trip_decisions/);
    assert.equal(a.questions.length, 1);
    const b = planCloseout({ activeLiveShareIds: [], planItems: [item("a", { status: "done" })], pendingDecisionTaskIds: [], storedDecisionIds: [], tripEndDate: null, today: "2026-09-15" });
    assert.equal(b.steps[0]!.status, "not_applicable"); assert.equal(b.steps[2]!.status, "not_applicable"); assert.equal(b.steps[3]!.status, "not_applicable");
    assert.ok(b.steps.slice(4).every((s) => s.status === "not_applicable"), "the last three have nothing to act on in this system, and say what would");
    const c = planCloseout({ activeLiveShareIds: [], planItems: [], pendingDecisionTaskIds: [], storedDecisionIds: ["d1", "d2"], tripEndDate: null, today: "2026-09-15" });
    assert.deepEqual(c.steps[6], { step: "archive_rebuildable_projections", status: "actionable", ids: ["d1", "d2"], detail: "2 stored decision(s) in the §21.2 ledger: retention ends at completion; every other operational projection is generated per request" });
  });
});

describe("runTripCloseout — performs the one step it can, reports the rest", () => {
  type Row = Record<string, any>;
  function fake(tables: Record<string, Row[]>, errorOn: string[] = []) {
    return { from(table: string) {
      const filters: Array<(r: Row) => boolean> = []; let update: Row | null = null; let single = false;
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const fail = () => ({ data: null, error: { message: `${table} unavailable` } });
      const settle = () => {
        if (errorOn.includes(table)) return fail();
        if (update) { const hit = rows(); for (const r of hit) Object.assign(r, update); return { data: hit, error: null }; }
        const r = rows(); return { data: single ? r[0] ?? null : r, error: null };
      };
      const chain: any = {
        select: () => chain, update: (u: Row) => { update = u; return chain; },
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        maybeSingle: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      return chain;
    } };
  }
  const NOW = new Date("2026-09-15T12:00:00Z");
  it("stops every active live-share session for the trip and attaches the §20.3 questions", async () => {
    const tables = {
      trip_crew_location_sessions: [{ id: "s1", trip_id: TRIP_ID, status: "active" }, { id: "s2", trip_id: TRIP_ID, status: "stopped" }, { id: "s3", trip_id: "other", status: "active" }],
      trip_plan_items: [{ id: "p1", trip_id: TRIP_ID, title: "Hoi An", status: "tentative", day_date: "2026-09-13", location_name: null, removed_at: null }],
      feature_flags: [],
    };
    const r = await runTripCloseout(fake(tables) as any, TRIP_ID, { now: NOW });
    assert.equal(r.steps[0]!.status, "performed"); assert.deepEqual((r.steps[0] as any).ids, ["s1"]);
    assert.equal(tables.trip_crew_location_sessions[0]!.status, "stopped");
    assert.equal(tables.trip_crew_location_sessions[2]!.status, "active", "another trip's session is untouched");
    assert.deepEqual(r.questions.map((q) => q.question), ["Did you make it to Hoi An?"]);
    assert.equal(r.steps[3]!.status, "deferred", "decision tasks are not read while the operational capability is off");
    assert.deepEqual(r.unread, []);
  });
  it("§20.2 with the operational capability on: pending tasks are deferred by the kernel flag's name, and the ledger's retention ends; with the kernel on, each task expires through UPDATE_DECISION_TASK, keyed by the closeout", async () => {
    const tables = {
      trip_crew_location_sessions: [], trip_plan_items: [], trip_subgroups: [],
      trip_decision_tasks: [{ id: "t1", trip_id: TRIP_ID, status: "pending" }, { id: "t2", trip_id: TRIP_ID, status: "done" }],
      trip_decisions: [{ decision_id: "d1", trip_id: TRIP_ID, retain_until: "2026-12-01T00:00:00Z" }, { decision_id: "d0", trip_id: TRIP_ID, retain_until: "2026-09-01T00:00:00Z" }, { decision_id: "dx", trip_id: "other", retain_until: "2026-12-01T00:00:00Z" }],
      feature_flags: [{ flag: "trip_operational_projections_enabled", enabled: true }],
    };
    const r = await runTripCloseout(fake(tables) as any, TRIP_ID, { now: NOW, actorUserId: OWNER_ID });
    assert.equal(r.steps[3]!.status, "deferred"); assert.match(r.steps[3]!.detail, /t1.*trip_kernel_enabled is false/);
    assert.equal(r.steps[6]!.status, "performed"); assert.deepEqual((r.steps[6] as any).ids, ["d1"], "only the row still within retention");
    assert.equal(tables.trip_decisions[0]!.retain_until, NOW.toISOString()); assert.equal(tables.trip_decisions[2]!.retain_until, "2026-12-01T00:00:00Z", "another trip's ledger is untouched");
    const calls: Row[] = [];
    const on = { ...tables, trip_decisions: [], feature_flags: [...tables.feature_flags, { flag: "trip_kernel_enabled", enabled: true }] };
    const k: any = fake(on);
    k.rpc = async (fn: string, args: Row) => { if (fn !== "trip_kernel_execute") return { data: null, error: null }; calls.push(args.p_command); return { data: { ok: true, duplicate: false, version: 3, event_id: 1, sequence: 1, result: { id: args.p_command.payload.task_id }, contract_version: 2 }, error: null }; };
    const r2 = await runTripCloseout(k, TRIP_ID, { now: NOW, actorUserId: OWNER_ID });
    assert.equal(r2.steps[3]!.status, "performed", JSON.stringify(r2.steps[3])); assert.deepEqual((r2.steps[3] as any).ids, ["t1"]);
    assert.equal(calls.length, 1); assert.equal(calls[0].type, "UPDATE_DECISION_TASK"); assert.deepEqual(calls[0].payload, { task_id: "t1", patch: { status: "expired" } }); assert.equal(calls[0].idempotency_key, "closeout:task:t1");
    assert.equal(r2.steps[6]!.status, "not_applicable");
  });
  it("a read that fails is a failed step, never a silent skip", async () => {
    const r = await runTripCloseout(fake({ trip_plan_items: [], feature_flags: [] }, ["trip_crew_location_sessions"]) as any, TRIP_ID, { now: NOW });
    assert.equal(r.steps[0]!.status, "failed");
    assert.deepEqual(r.unread, ["trip_crew_location_sessions"]);
  });
});

describe("§21.2 the decision ledger, in-process", () => {
  beforeEach(() => _resetTripDecisionLedger());
  const rec = (o: Partial<Parameters<typeof recordTripDecision>[0]> = {}) => recordTripDecision({
    tripId: TRIP_ID, type: "freedom_windows", inputs: { commitmentIds: ["A", "B"], hopTravelMinutes: [22] }, sources: ["trips", "trip_commitments", "places"],
    assumptions: ["a commitment has no end; the window begins at its start"], constraints: ["travel term is a straight-line lower bound"],
    result: { windows: 1, conflicts: 0 }, confidence: "LOW", engineVersions: { TripFreedomEngine: TRIP_ENGINE_VERSIONS.TripFreedomEngine },
    calculatedAt: "2026-09-13T12:00:00.000Z", sourceTripVersion: 7, ...o,
  });
  it("records every §21.2 field, ids the decision, and explains it in sentences from the record", () => {
    const d = rec();
    for (const k of ["decisionId", "tripId", "type", "inputs", "sources", "assumptions", "constraints", "result", "confidence", "engineVersions", "calculatedAt"]) assert.ok(k in d, k);
    assert.equal(readTripDecision(d.decisionId), d);
    const e = explainTripDecision(d.decisionId)!;
    assert.match(e.explanation[0]!, /freedom windows was computed at 2026-09-13T12:00:00.000Z against trip version 7/);
    assert.ok(e.explanation.some((s) => s.startsWith("Assumed: a commitment has no end")));
    assert.ok(e.explanation.some((s) => s.startsWith("Constrained by: travel term")));
    assert.ok(e.explanation.some((s) => s.includes("TripFreedomEngine@")));
    assert.match(e.retention, /not retained/);
    assert.deepEqual(listTripDecisions(TRIP_ID).map((x) => x.decisionId), [d.decisionId]);
  });
  it("a decision that is not retained is null, never recomputed", () => {
    assert.equal(explainTripDecision("freedom_windows:x:0:0"), null);
    for (let i = 0; i < TRIP_DECISION_RING + 5; i += 1) rec({ calculatedAt: new Date(1_700_000_000_000 + i).toISOString() });
    assert.equal(listTripDecisions(TRIP_ID).length, TRIP_DECISION_RING);
  });
  it("never records a row body: inputs are ids, versions and counts", () => {
    const d = rec();
    const text = JSON.stringify(d.inputs);
    assert.ok(!/lat|lng|title|name/.test(text), text);
  });
});

// ── the routes and the Compass tool ──────────────────────────────────────────
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { toolExplainTripDecision } from "../compass/CompassTools.js";
import { buildTripFreedomProjection } from "../services/trips/TripFreedomProjection.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_TRIP = "cccccccc-cccc-cccc-cccc-cccccccccccc";
type Row = Record<string, any>;

function makeClient(tables: Record<string, Row[]>, errorOn: string[] = []) {
  return {
    auth: { getUser: async (token: string) => token === "owner-token" ? { data: { user: { id: OWNER_ID } }, error: null } : token === "member-token" ? { data: { user: { id: MEMBER_ID } }, error: null } : token === "other-token" ? { data: { user: { id: OTHER_ID } }, error: null } : { data: { user: null }, error: { message: "invalid" } } },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []; let update: Row | null = null; let insert: Row[] | null = null; let single = false;
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const settle = () => {
        if (errorOn.includes(table)) return { data: null, error: { message: `${table} unavailable` } };
        if (insert) { (tables[table] ??= []).push(...insert.map((r) => ({ id: `gen-${Math.random()}`, ...r }))); return { data: insert, error: null }; }
        if (update) { const hit = rows(); for (const r of hit) Object.assign(r, update); return { data: hit, error: null }; }
        const r = rows(); return { data: single ? r[0] ?? null : r, error: null };
      };
      const chain: any = {
        select: () => chain, update: (u: Row) => { update = u; return chain; }, insert: (i: Row | Row[]) => { insert = Array.isArray(i) ? i : [i]; return chain; },
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        or: () => chain, gt: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      return chain;
    },
  };
}
const routeBase = (): Record<string, Row[]> => ({
  trips: [{ id: TRIP_ID, owner_id: OWNER_ID, status: "active", timezone: "Europe/Paris", version: 3, start_date: "2026-09-10", end_date: "2026-09-14" }],
  trip_members: [{ trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" }, { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" }, { trip_id: OTHER_TRIP, user_id: OTHER_ID, role: "owner", status: "accepted" }],
  trip_crew_location_sessions: [{ id: "s1", trip_id: TRIP_ID, user_id: MEMBER_ID, status: "active" }],
  trip_plan_items: [{ id: "p1", trip_id: TRIP_ID, title: "Hoi An", status: "tentative", day_date: "2026-09-11", location_name: null, removed_at: null }],
  trip_activity_log: [], feature_flags: [], trip_commitments: [], places: [],
});
let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
}
async function call(method: string, path: string, token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function install(tables: Record<string, Row[]>, errorOn: string[] = []) {
  const c = makeClient(tables, errorOn); _setTestClient(c as any, true); _setTestServiceClient(c as any); return c;
}

describe("POST /trips/:id/complete performs §20.2 and reports it; GET /closeout plans it", () => {
  beforeEach(async () => { if (!server) await start(); });
  it("stops the trip's live-share sessions at completion and returns the steps and §20.3 questions", async () => {
    const tables = routeBase(); install(tables);
    const r = await call("POST", `${TRIP_ID}/complete`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "completed");
    assert.equal(tables.trips[0]!.status, "completed");
    assert.equal(r.body.closeout.steps[0].step, "stop_temporary_presence");
    assert.equal(r.body.closeout.steps[0].status, "performed");
    assert.deepEqual(r.body.closeout.steps[0].ids, ["s1"]);
    assert.equal(tables.trip_crew_location_sessions[0]!.status, "stopped");
    assert.deepEqual(r.body.closeout.questions.map((q: any) => q.question), ["Did you make it to Hoi An?"]);
    assert.equal(r.body.closeout.steps.length, 7);
  });
  it("GET /closeout is a dry run: the plan and the questions, nothing stopped", async () => {
    const tables = routeBase(); install(tables);
    const r = await call("GET", `${TRIP_ID}/closeout`, "member-token");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.steps[0].status, "actionable");
    assert.equal(tables.trip_crew_location_sessions[0]!.status, "active", "a read did not stop anything");
    assert.equal(r.body.questions.length, 1);
    assert.equal((await call("GET", `${TRIP_ID}/closeout`, "other-token")).status, 403);
  });
});

describe("GET /trips/:id/decisions/:decisionId/explain and explain_trip_decision — §12.1 over the §21.2 ledger", () => {
  beforeEach(async () => { if (!server) await start(); _resetTripDecisionLedger(); });
  it("explains a decision this crew's projection recorded; another trip's decision, or an unknown id, is not retained", async () => {
    const tables = routeBase();
    tables.feature_flags = [{ flag: "trip_operational_projections_enabled", enabled: true }];
    tables.trip_risks = []; tables.trip_stages = [];
    const c = install(tables);
    const built = await buildTripFreedomProjection(c as any, TRIP_ID);
    assert.ok(built.ok);
    const id = built.projection.decisionId;
    const r = await call("GET", `${TRIP_ID}/decisions/${encodeURIComponent(id)}/explain`, "member-token");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.type, "freedom_windows");
    assert.ok(r.body.explanation.some((s: string) => s.includes("TripFreedomEngine@")));
    assert.ok(r.body.explanation.some((s: string) => s.startsWith("Assumed:")));
    const foreign = await call("GET", `${OTHER_TRIP}/decisions/${encodeURIComponent(id)}/explain`, "other-token");
    assert.equal(foreign.status, 404, "a decision belongs to its trip's crew");
    assert.match(foreign.body.message, /not retained/);
    const unknown = await call("GET", `${TRIP_ID}/decisions/nope/explain`);
    assert.equal(unknown.status, 404);
    const tool: any = await toolExplainTripDecision(c as any, OWNER_ID, { tripId: TRIP_ID, decisionId: id });
    assert.ok(Array.isArray(tool.explanation) && tool.explanation.length > 5);
    const stranger: any = await toolExplainTripDecision(c as any, OTHER_ID, { tripId: TRIP_ID, decisionId: id });
    assert.equal(stranger.explanation, null);
  });
});
