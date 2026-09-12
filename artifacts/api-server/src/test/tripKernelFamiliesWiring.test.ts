/**
 * The API side of 2779–2785, on fake clients: what the routes and services do
 * with the new families when the flags are on, and that they do NOTHING new
 * when the flags are off.
 *
 *   §20.2 closeout dissolves temporary subgroups (DISSOLVE_SUBGROUP, keyed)
 *   §4.2  the engines record commitment_at_risk / free_window_created as
 *         actor_role "system", keyed by the fact, and say so when they cannot
 *   §21.2 decisions persist to trip_decisions and can be explained from it
 *   §15.4 / §18.3 reservations: If-Match, cancel-not-delete, history, compensation
 *
 * The SQL side is src/test/db/*.db.test.ts on the real kernel.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { runTripCloseout } from "../services/trips/TripCloseoutService.js";
import { recordDerivedEvents, freeWindowKey, commitmentAtRiskKey } from "../lib/tripDerivedEvents.js";
import { persistTripDecision, readTripDecisionFrom, explainTripDecisionFrom, recordTripDecision, _resetTripDecisionLedger } from "../services/trips/TripDecisionLedger.js";
import { invalidateTripOperationalProjectionsGate } from "../lib/tripOperationalProjections.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tripReservationsRouter from "../routes/tripReservations.js";

type Row = Record<string, any>;
const TRIP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const RES_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** A fake with tables, a kernel `rpc` that records calls, and update/insert/delete. */
function fake(tables: Record<string, Row[]>, opts: { rpc?: (name: string, args: any) => any; errorOn?: string[] } = {}) {
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const client: any = {
    auth: { getUser: async (token: string) => token === "owner-token" ? { data: { user: { id: OWNER_ID } }, error: null } : token === "member-token" ? { data: { user: { id: MEMBER_ID } }, error: null } : { data: { user: null }, error: { message: "invalid" } } },
    rpc: async (name: string, args: any) => { rpcCalls.push({ name, args }); return opts.rpc ? opts.rpc(name, args) : { data: { ok: true, duplicate: false, version: 1, event_id: "e", sequence: 1, result: {}, contract_version: 2 }, error: null }; },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []; let update: Row | null = null; let insert: Row[] | null = null; let del = false; let single = false;
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const settle = () => {
        if (opts.errorOn?.includes(table)) return { data: null, error: { message: `${table} unavailable`, code: "XX000" } };
        if (insert) { (tables[table] ??= []).push(...insert.map((r) => ({ id: r.id ?? `gen-${Math.random()}`, ...r }))); return { data: single ? insert[0] : insert, error: null }; }
        if (update) { const hit = rows(); for (const r of hit) Object.assign(r, update); return { data: single ? hit[0] ?? null : hit, error: null }; }
        if (del) { const hit = rows(); tables[table] = (tables[table] ?? []).filter((r) => !hit.includes(r)); return { data: null, error: null }; }
        const r = rows(); return { data: single ? r[0] ?? null : r, error: null };
      };
      const chain: any = {
        select: () => chain, update: (u: Row) => { update = u; return chain; }, insert: (i: Row | Row[]) => { insert = Array.isArray(i) ? i : [i]; return chain; }, delete: () => { del = true; return chain; },
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        or: () => chain, gt: () => chain, lt: () => chain, order: () => chain, limit: () => chain, ilike: () => chain,
        maybeSingle: async () => { single = true; return settle(); },
        single: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      return chain;
    },
  };
  return { client, rpcCalls, tables };
}
const flags = (on: Record<string, boolean>) => Object.entries(on).map(([flag, enabled]) => ({ flag, enabled }));
const closeoutTables = (over: Record<string, Row[]> = {}): Record<string, Row[]> => ({
  trips: [{ id: TRIP_ID, owner_id: OWNER_ID, status: "active", timezone: "Europe/Lisbon", version: 3 }],
  trip_crew_location_sessions: [], trip_plan_items: [], trip_decision_tasks: [],
  trip_subgroups: [{ id: "g1", trip_id: TRIP_ID, state: "active" }, { id: "g2", trip_id: TRIP_ID, state: "active" }, { id: "g3", trip_id: TRIP_ID, state: "dissolved" }],
  feature_flags: flags({ trip_operational_projections_enabled: true, trip_kernel_enabled: false }),
  ...over,
});

beforeEach(() => { invalidateTripOperationalProjectionsGate(); _resetTripDecisionLedger(); });

describe("§20.2 closeout dissolves temporary subgroups (2780)", () => {
  it("gate off: the step is deferred and trip_subgroups is not read", async () => {
    const f = fake(closeoutTables({ feature_flags: [] }));
    const r = await runTripCloseout(f.client, TRIP_ID, { now: new Date("2026-09-12T10:00:00Z"), actorUserId: OWNER_ID });
    const step = r.steps.find((s) => s.step === "dissolve_temporary_crews")!;
    assert.equal(step.status, "deferred");
    assert.match(step.detail, /not read/);
    assert.equal(f.rpcCalls.length, 0);
  });
  it("gate on, kernel off: the active subgroups are named and the step is deferred to the kernel flag; nothing is issued", async () => {
    const f = fake(closeoutTables());
    const r = await runTripCloseout(f.client, TRIP_ID, { now: new Date("2026-09-12T10:00:00Z"), actorUserId: OWNER_ID });
    const step = r.steps.find((s) => s.step === "dissolve_temporary_crews")!;
    assert.equal(step.status, "deferred");
    assert.match(step.detail, /2 active subgroup\(s\) remain \(g1, g2\)/);
    assert.equal(f.rpcCalls.length, 0);
  });
  it("gate on, kernel on: one DISSOLVE_SUBGROUP per active subgroup, keyed closeout:dissolve:<id>, as the completing user; the step is performed", async () => {
    const f = fake(closeoutTables({ feature_flags: flags({ trip_operational_projections_enabled: true, trip_kernel_enabled: true }) }));
    const r = await runTripCloseout(f.client, TRIP_ID, { now: new Date("2026-09-12T10:00:00Z"), actorUserId: OWNER_ID });
    const step = r.steps.find((s) => s.step === "dissolve_temporary_crews")!;
    assert.equal(step.status, "performed");
    assert.deepEqual((step as any).ids, ["g1", "g2"]);
    const cmds = f.rpcCalls.filter((c) => c.name === "trip_kernel_execute").map((c) => c.args.p_command);
    assert.deepEqual(cmds.map((c) => [c.type, c.payload.subgroup_id, c.idempotency_key, c.actor_user_id]), [
      ["DISSOLVE_SUBGROUP", "g1", "closeout:dissolve:g1", OWNER_ID], ["DISSOLVE_SUBGROUP", "g2", "closeout:dissolve:g2", OWNER_ID],
    ]);
  });
  it("dry run plans the step without issuing; a kernel refusal is reported as failed with the reason", async () => {
    const dry = fake(closeoutTables({ feature_flags: flags({ trip_operational_projections_enabled: true, trip_kernel_enabled: true }) }));
    const plan = await runTripCloseout(dry.client, TRIP_ID, { now: new Date(), actorUserId: OWNER_ID, dryRun: true });
    assert.equal(plan.steps.find((s) => s.step === "dissolve_temporary_crews")!.status, "actionable");
    assert.equal(dry.rpcCalls.length, 0);
    const refusing = fake(closeoutTables({ feature_flags: flags({ trip_operational_projections_enabled: true, trip_kernel_enabled: true }) }),
      { rpc: (_n, args) => ({ data: args.p_command.payload.subgroup_id === "g2" ? { ok: false, reason: "TRIP_AUTH_NOT_HOST" } : { ok: true, duplicate: false, version: 1, event_id: "e", sequence: 1, result: {} }, error: null }) });
    const r = await runTripCloseout(refusing.client, TRIP_ID, { now: new Date(), actorUserId: OWNER_ID });
    const step = r.steps.find((s) => s.step === "dissolve_temporary_crews")!;
    assert.equal(step.status, "failed");
    assert.match(step.detail, /1 dissolved, 1 refused: g2: TRIP_AUTH_NOT_HOST/);
  });
});

describe("§4.2 derived events from the engines (2785)", () => {
  const window = (id: string, beginsAt: string, endsAt: string) => ({ id, position: "between", beginsAt, endsAt, durationMinutes: 120, certified: false } as any);
  const conflict = (ids: string[], kind = "NO_TIME_TO_TRAVEL") => ({ reason: "TRIP_TEMPORAL_CONFLICT", kind, commitmentIds: ids, planIds: [], shortfallMinutes: 7, overridden: false, detail: "" } as any);
  it("trip_kernel_enabled off: nothing is issued and the report says why", async () => {
    const f = fake({ feature_flags: flags({ trip_kernel_enabled: false }) });
    const r = await recordDerivedEvents(f.client, TRIP_ID, { windows: [window("w", "2026-09-13T10:00:00.000Z", "2026-09-13T12:00:00.000Z")], conflicts: [conflict(["c1"])] });
    assert.deepEqual(r, { skipped: "trip_kernel_enabled is false", issued: 0, duplicates: 0, failed: 0, failures: [] });
    assert.equal(f.rpcCalls.length, 0);
  });
  it("on: one MARK per conflicting commitment and one OPEN per window, actor_role system with no user, keyed by the fact", async () => {
    const f = fake({ feature_flags: flags({ trip_kernel_enabled: true }) });
    const w = window("w", "2026-09-13T10:00:00.000Z", "2026-09-13T12:00:00.000Z");
    const r = await recordDerivedEvents(f.client, TRIP_ID, { windows: [w], conflicts: [conflict(["c1", "c2"])] });
    assert.deepEqual([r.issued, r.duplicates, r.failed, r.skipped], [3, 0, 0, null]);
    const cmds = f.rpcCalls.map((c) => c.args.p_command);
    assert.deepEqual(cmds.map((c) => [c.type, c.actor_role, c.actor_user_id, c.idempotency_key]), [
      ["MARK_COMMITMENT_AT_RISK", "system", null, commitmentAtRiskKey("c1", "NO_TIME_TO_TRAVEL")],
      ["MARK_COMMITMENT_AT_RISK", "system", null, commitmentAtRiskKey("c2", "NO_TIME_TO_TRAVEL")],
      ["OPEN_FREE_WINDOW", "system", null, freeWindowKey(TRIP_ID, w)],
    ]);
    assert.equal(cmds[0]!.payload.shortfall_minutes, 7);
    assert.equal(cmds[2]!.payload.duration_minutes, 120);
  });
  it("a duplicate receipt is counted as a duplicate, a refusal as a failure with its reason; neither throws", async () => {
    const f = fake({ feature_flags: flags({ trip_kernel_enabled: true }) }, {
      rpc: (_n, args) => ({ data: args.p_command.type === "OPEN_FREE_WINDOW" ? { ok: true, duplicate: true, version: 4, event_id: "e", result: {} } : { ok: false, reason: "TRIP_COMMITMENT_NOT_FOUND" }, error: null }),
    });
    const r = await recordDerivedEvents(f.client, TRIP_ID, { windows: [window("w", "a", "b")], conflicts: [conflict(["gone"])] });
    assert.deepEqual([r.issued, r.duplicates, r.failed, r.failures], [0, 1, 1, ["TRIP_COMMITMENT_NOT_FOUND"]]);
  });
});

describe("§21.2 decisions persist to trip_decisions (2781)", () => {
  const decision = () => recordTripDecision({
    tripId: TRIP_ID, type: "trip_health", inputs: { tripVersion: 3, commitments: 2 }, sources: ["trips"], assumptions: ["a"], constraints: ["c"],
    result: { health: "AT_RISK" }, confidence: "MEDIUM", engineVersions: { TripHealth: "x" }, calculatedAt: "2026-09-12T10:00:00.000Z", sourceTripVersion: 3,
  });
  const tables = (on: boolean) => ({ feature_flags: flags({ trip_operational_projections_enabled: on }), trips: [], trip_commitments: [], trip_risks: [], trip_stages: [], trip_subgroups: [], trip_subgroup_members: [], trip_crew_location_sessions: [], trip_decisions: [] as Row[], trip_disruptions: [], trip_reservations: [], trip_reservation_events: [] });
  it("gate off: not persisted, reason flag_off, and the ring still explains it", async () => {
    const f = fake(tables(false));
    const d = decision();
    assert.deepEqual(await persistTripDecision(f.client, d), { persisted: false, reason: "flag_off" });
    assert.equal(f.tables.trip_decisions.length, 0);
    assert.ok((await explainTripDecisionFrom(f.client, d.decisionId))?.explanation.length);
  });
  it("gate on: the row carries the §21.2 fields; a decision displaced from the ring is read back from the table and explained", async () => {
    const f = fake(tables(true));
    const d = decision();
    assert.deepEqual(await persistTripDecision(f.client, d), { persisted: true, reason: null });
    const row = f.tables.trip_decisions[0]!;
    assert.equal(row.decision_id, d.decisionId); assert.equal(row.decision_type, "trip_health"); assert.equal(row.confidence, "MEDIUM");
    assert.deepEqual(row.inputs_json, { tripVersion: 3, commitments: 2 }); assert.equal(row.source_trip_version, 3); assert.equal(row.calculated_at, "2026-09-12T10:00:00.000Z");
    _resetTripDecisionLedger();
    const back = await readTripDecisionFrom(f.client, d.decisionId);
    assert.equal(back?.decisionId, d.decisionId); assert.equal(back?.type, "trip_health");
    const e = await explainTripDecisionFrom(f.client, d.decisionId);
    assert.ok(e?.explanation.some((s) => s.includes("trip health")), JSON.stringify(e?.explanation));
    assert.match(e!.retention, /90 days/);
  });
  it("an insert error is reported, never thrown", async () => {
    const f = fake(tables(true), { errorOn: ["trip_decisions"] });
    invalidateTripOperationalProjectionsGate();
    const r = await persistTripDecision(f.client, decision());
    assert.equal(r.persisted, false);
    assert.ok(r.reason);
  });
});

describe("§9.2 subgroup-scoped live shares on the crew map (2780)", () => {
  const VIEWER = MEMBER_ID; const SHARER = "33333333-3333-4333-8333-333333333333"; const OUTSIDER = "44444444-4444-4444-8444-444444444444";
  const crewTables = (gateOn: boolean, viewerInSubgroup: boolean): Record<string, Row[]> => ({
    feature_flags: flags({ trip_operational_projections_enabled: gateOn, trip_crew_map_enabled: true }),
    trips: [{ id: TRIP_ID, owner_id: OWNER_ID, version: 1 }],
    trip_members: [{ trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" }, { trip_id: TRIP_ID, user_id: VIEWER, role: "member", status: "accepted" }, { trip_id: TRIP_ID, user_id: SHARER, role: "member", status: "accepted" }, { trip_id: TRIP_ID, user_id: OUTSIDER, role: "member", status: "accepted" }],
    profiles: [{ id: SHARER, username: "sharer", full_name: "Sharer" }, { id: OWNER_ID, username: "owner" }, { id: OUTSIDER, username: "out" }],
    trip_crew_location_preferences: [{ user_id: SHARER, default_visibility: "nearby", ghost_mode_enabled: false, share_arrival_status: true, share_safe_return_status: false }],
    user_location_state: [{ user_id: SHARER, city: "Lisboa", district: "Alfama", country: "PT", updated_at: new Date().toISOString(), last_known_at: new Date().toISOString(), lat: 38.71, lng: -9.13, source: "gps", accuracy_meters: 20 }],
    location_preferences: [], plan_checkins: [], safe_return_sessions: [], blocks: [],
    trip_crew_location_sessions: [{ id: "s-sub", trip_id: TRIP_ID, user_id: SHARER, status: "active", expires_at: new Date(Date.now() + 3_600_000).toISOString(), allowed_member_ids: [VIEWER, OUTSIDER], visibility_level: "nearby", subgroup_id: "g1" }],
    trip_subgroup_members: viewerInSubgroup ? [{ subgroup_id: "g1", user_id: VIEWER, left_at: null }] : [],
    trip_commitments: [], trip_risks: [], trip_stages: [], trip_subgroups: [{ id: "g1", trip_id: TRIP_ID, state: "active" }], trip_decisions: [], trip_disruptions: [], trip_reservations: [], trip_reservation_events: [],
  });
  it("gate on: a share scoped to a subgroup reaches a viewer in it, and not one outside it", async () => {
    const { getCrewMap } = await import("../services/tripCrew/TripCrewLocationService.js");
    const inside = await getCrewMap(fake(crewTables(true, true)).client as any, TRIP_ID, VIEWER);
    const sharerIn = inside.members.find((c) => c.userId === SHARER)!;
    assert.ok(sharerIn, "sharer card missing");
    // A live share under a 'nearby' grant is the only way a card carries exact coordinates.
    assert.ok(sharerIn.exactCoords, `no live share for a subgroup member: ${JSON.stringify(sharerIn)}`);
    invalidateTripOperationalProjectionsGate();
    const outside = await getCrewMap(fake(crewTables(true, false)).client as any, TRIP_ID, VIEWER);
    const sharerOut = outside.members.find((c) => c.userId === SHARER)!;
    assert.ok(!sharerOut.exactCoords, `a subgroup-scoped share reached a viewer outside the subgroup: ${JSON.stringify(sharerOut)}`);
    assert.notEqual(sharerOut.statusLabel, sharerIn.statusLabel, "the subgroup scope changed nothing");
  });
  it("gate off: subgroup_id is not read and the session is trip-scoped exactly as before", async () => {
    const { getCrewMap } = await import("../services/tripCrew/TripCrewLocationService.js");
    invalidateTripOperationalProjectionsGate();
    const f = fake(crewTables(false, false));
    const r = await getCrewMap(f.client as any, TRIP_ID, VIEWER);
    const sharer = r.members.find((c) => c.userId === SHARER)!;
    assert.ok(sharer.exactCoords, `the trip-scoped share did not reach an allowed viewer: ${JSON.stringify(sharer)}`);
  });
});

describe("§15.4 / §18.3 reservation routes over 2784", () => {
  let server: Server; let port = 0;
  const app = express(); app.use(express.json()); app.use("/api", tripReservationsRouter);
  beforeEach(async () => { if (!server) await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); }); });
  after(() => { server?.close(); _setTestClient(null as any, false); });
  const call = async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/reservations${path}`, { method, headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => null)) as any, etag: res.headers.get("etag") };
  };
  const tables = (gateOn: boolean): Record<string, Row[]> => ({
    feature_flags: flags({ reservation_import_enabled: true, trip_operational_projections_enabled: gateOn }),
    trips: [{ id: TRIP_ID, owner_id: OWNER_ID, version: 3 }], trip_members: [{ trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" }],
    trip_reservations: [{ id: RES_ID, trip_id: TRIP_ID, user_id: OWNER_ID, type: "stay", title: "Hotel", status: "confirmed", version: 2, cancelled_at: null }],
    trip_reservation_events: [{ id: 1, reservation_id: RES_ID, trip_id: TRIP_ID, event_type: "created", from_status: null, to_status: "pending_confirm", version: 0 }, { id: 2, reservation_id: RES_ID, trip_id: TRIP_ID, event_type: "confirmed", from_status: "pending_confirm", to_status: "confirmed", version: 1 }],
    trip_commitments: [], trip_risks: [], trip_stages: [], trip_subgroups: [], trip_subgroup_members: [], trip_crew_location_sessions: [], trip_decisions: [], trip_disruptions: [], trip_plan_items: [],
  });
  const install = (t: Record<string, Row[]>, opts: Parameters<typeof fake>[1] = {}) => { const f = fake(t, opts); _setTestClient(f.client, true); _setTestServiceClient(f.client); invalidateTripOperationalProjectionsGate(); return f; };

  it("PATCH with a stale If-Match is 409 TRIP_VERSION_CONFLICT and writes nothing; a matching one writes and answers an ETag", async () => {
    const f = install(tables(true));
    const stale = await call("PATCH", `/${RES_ID}`, { title: "Renamed" }, { "If-Match": '"1"' });
    assert.equal(stale.status, 409); assert.equal(stale.body.reason, "TRIP_VERSION_CONFLICT");
    assert.equal(f.tables.trip_reservations[0]!.title, "Hotel");
    const ok = await call("PATCH", `/${RES_ID}`, { title: "Renamed" }, { "If-Match": "2" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.etag, "2"); assert.equal(f.tables.trip_reservations[0]!.title, "Renamed");
  });
  it("DELETE cancels instead of deleting (status cancelled, cancelled_at set); a second DELETE is idempotent", async () => {
    const f = install(tables(true));
    const r = await call("DELETE", `/${RES_ID}`);
    assert.equal(r.status, 200); assert.equal(r.body.reservation.status, "cancelled"); assert.ok(r.body.reservation.cancelled_at);
    assert.equal(f.tables.trip_reservations.length, 1, "the row was deleted");
    const again = await call("DELETE", `/${RES_ID}`);
    assert.equal(again.status, 200); assert.equal(again.body.idempotent, true);
  });
  it("GET history lists the append-only events; POST compensation records through the SQL function and maps its refusals", async () => {
    const f = install(tables(true), { rpc: (name, args) => ({ data: name === "trip_reservation_record_compensation" ? (args.p_reservation_id === RES_ID ? { ok: true, event_id: 9, version: 2 } : { ok: false, reason: "TRIP_BOOKING_NOT_FOUND" }) : null, error: null }) });
    const h = await call("GET", `/${RES_ID}/history`);
    assert.equal(h.status, 200); assert.equal(h.body.version, 2); assert.deepEqual(h.body.events.map((e: any) => e.event_type), ["created", "confirmed"]);
    const c = await call("POST", `/${RES_ID}/compensation`, { kind: "voucher", amountMinor: 1500, currency: "EUR", note: "late cancel" });
    assert.equal(c.status, 201, JSON.stringify(c.body)); assert.equal(c.body.eventId, 9);
    const rpc = f.rpcCalls.find((x) => x.name === "trip_reservation_record_compensation")!;
    assert.deepEqual(rpc.args.p_payload, { kind: "voucher", amount_minor: 1500, currency: "EUR", note: "late cancel" }); assert.equal(rpc.args.p_actor, OWNER_ID);
    const bad = await call("POST", `/${RES_ID}/compensation`, { currency: "euro" });
    assert.equal(bad.status, 400);
  });
  it("gate off: PATCH ignores If-Match and answers no ETag; DELETE hard-deletes with 204; history and compensation are feature_disabled", async () => {
    const f = install(tables(false));
    const p = await call("PATCH", `/${RES_ID}`, { title: "Legacy" }, { "If-Match": '"1"' });
    // express adds a weak content hash on its own; what must NOT be there is the row version.
    assert.equal(p.status, 200); assert.ok(!/^"?\d+"?$/.test(p.etag ?? ""), `row version served as ETag: ${p.etag}`); assert.equal(f.tables.trip_reservations[0]!.title, "Legacy");
    assert.equal((await call("GET", `/${RES_ID}/history`)).status, 404);
    assert.equal((await call("POST", `/${RES_ID}/compensation`, { kind: "refund" })).status, 404);
    const d = await call("DELETE", `/${RES_ID}`);
    assert.equal(d.status, 204); assert.equal(f.tables.trip_reservations.length, 0);
  });
});
