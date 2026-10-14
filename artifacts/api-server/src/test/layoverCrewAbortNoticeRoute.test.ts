/**
 * census-layover L144 — the route half of the crew abort notice
 * (services/layover/LayoverCrewAbortNotice.ts; gates and text are pinned in
 * services/layover/__tests__/layoverCrewAbortNotice.test.ts).
 *
 * What this suite proves is REACHABILITY over the real airport router:
 *   - POST /airport/sessions/:id/return-now reads `tellCrew` off the body, and
 *     only the literal boolean `true` is consent;
 *   - the flag (3786, seeded FALSE) decides whether that consent is honoured;
 *   - a 200 and a partial 500 BOTH say whether the crew was told (a count, no
 *     crewmate ids), so a traveller who asked is never left guessing;
 *   - GET /airport/sessions/:id/overview carries `crewAbortNotice`, the one
 *     thing the client reads to decide whether to OFFER the choice.
 *
 * On main (9af376fa4) the return-now handler read no body and the overview had
 * no `crewAbortNotice`: every case that expects a notice or the capability is red
 * there.
 *
 * Run (binds a port — run unsandboxed on this machine):
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/layoverCrewAbortNoticeRoute.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const TOKEN = "crew-abort-token";
const A = "ca-user-a";
const B = "ca-user-b";
const C = "ca-user-c";
const SA = "ca-session-a";
const SB = "ca-session-b";
const SC = "ca-session-c";
const CREW = "ca-crew-1";
const HOUR = 3_600_000;

let server: http.Server;
let base = "";
let tables: Record<string, any[]>;

function send(method: "GET" | "POST", path: string, body?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(body !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

function stage(opts: { flagOn?: boolean; failures?: Record<string, any>; tripId?: string; ghost?: boolean } = {}) {
  const now = Date.now();
  const member = (userId: string, sessionId: string, role = "member") => ({
    crew_id: CREW, user_id: userId, session_id: sessionId, role, joined_at: new Date(now - HOUR).toISOString(), left_at: null,
  });
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_crew_abort_notify_enabled", enabled: opts.flagOn ?? true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ id: SA, user_id: A, status: "active", trip_id: opts.tripId ?? null })],
    trip_crew_location_preferences: opts.tripId && opts.ghost !== undefined ? [{ trip_id: opts.tripId, user_id: A, ghost_mode_enabled: opts.ghost }] : [],
    layover_recommendations: [],
    layover_plan_stops: [{ id: "stop-1", session_id: SA, stop_order: 1, inside_airport: false }],
    layover_events: [],
    trip_plan_items: [], trips: [], trip_members: [],
    layover_crews: [{
      id: CREW, city: "taoyuan", airport_ref: "TPE", created_by: A, created_session_id: SA, title: "Ramen",
      meeting_point_label: null, status: "open", max_members: 6,
      expires_at: new Date(now + 6 * HOUR).toISOString(), created_at: new Date(now - 2 * HOUR).toISOString(),
    }],
    layover_crew_members: [member(A, SA, "owner"), member(B, SB), member(C, SC)],
    blocks: [],
    location_preferences: [A, B, C].map((u) => ({ user_id: u, location_mode: "city_only", sharing_paused: false })),
    profiles: [{ id: A, handle: "ann", name: "Ann", avatar_url: null }],
    profile_privacy_settings: [],
    notifications: [],
    notification_delivery_attempts: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: A }, failures: opts.failures }) as any, true);
  return tables;
}

const RETURN_NOW = `/api/airport/sessions/${SA}/return-now`;
const notices = () => tables.notifications.filter((n) => n.event_type === "layover.crew.member_heading_back");

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});

after(() => { server?.close(); _setTestClient(null as any, false); });

describe("L144 return-now: the traveller's per-abort choice reaches the notice", () => {
  it("flag ON + { tellCrew: true }: 200, the crew is told, and the body carries a COUNT and no crewmate id", async () => {
    stage();
    const r = await send("POST", RETURN_NOW, JSON.stringify({ tellCrew: true }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.crewNotifiedCount, 2);
    assert.equal(r.body.crewNotifyUnavailableReason, null);
    assert.ok(r.body.effects.includes("crew_notified"));
    assert.equal("crewNotified" in r.body, false);
    const wire = JSON.stringify(r.body);
    for (const id of [B, C, SB, SC]) assert.equal(wire.includes(id), false, `${id} on the wire`);
    assert.deepEqual(notices().map((n) => n.user_id).sort(), [B, C]);
  });

  it("flag ON + no choice: nobody is told, the reason is not_requested (control on the same fixture)", async () => {
    stage();
    const r = await send("POST", RETURN_NOW, "{}");
    assert.equal(r.status, 200);
    assert.equal(r.body.crewNotifiedCount, 0);
    assert.equal(r.body.crewNotifyUnavailableReason, "not_requested");
    assert.equal(notices().length, 0);
  });

  it("no body at all (every client build before L144): exactly as before for the flag OFF, not_requested for ON", async () => {
    stage({ flagOn: false });
    const off = await send("POST", RETURN_NOW);
    assert.equal(off.status, 200);
    assert.equal(off.body.crewNotifyUnavailableReason, "crew_notify_not_enabled");
    stage();
    const on = await send("POST", RETURN_NOW);
    assert.equal(on.body.crewNotifyUnavailableReason, "not_requested");
    assert.equal(notices().length, 0);
  });

  it("{ tellCrew: \"true\" } is NOT consent", async () => {
    stage();
    const r = await send("POST", RETURN_NOW, JSON.stringify({ tellCrew: "true" }));
    assert.equal(r.status, 200);
    assert.equal(r.body.crewNotifyUnavailableReason, "not_requested");
    assert.equal(notices().length, 0);
  });

  it("flag OFF + { tellCrew: true }: nobody is told — the owner's decision is not taken by the request", async () => {
    stage({ flagOn: false });
    const r = await send("POST", RETURN_NOW, JSON.stringify({ tellCrew: true }));
    assert.equal(r.status, 200);
    assert.equal(r.body.crewNotifiedCount, 0);
    assert.equal(r.body.crewNotifyUnavailableReason, "crew_notify_not_enabled");
    assert.ok(r.body.effects.includes("crew_notify_unavailable"));
    assert.equal(notices().length, 0);
  });

  it("a PARTIAL abort (500, ledger failed) still tells the crew the traveller asked to tell, and SAYS so", async () => {
    stage({ failures: { "layover_events:insert": { message: "check violation" } } });
    const r = await send("POST", RETURN_NOW, JSON.stringify({ tellCrew: true }));
    assert.equal(r.status, 500);
    assert.equal(r.body.ok, false);
    assert.ok(r.body.returnContract, "the contract survives the partial failure, as before");
    assert.equal(r.body.crewNotifiedCount, 2);
    assert.equal(r.body.crewNotifyUnavailableReason, null);
    assert.equal(notices().length, 2);
  });
});

describe("L144 overview: whether 'tell my crew' may be offered", () => {
  it("flag ON and in a live crew with others: offered", async () => {
    stage();
    const r = await send("GET", `/api/airport/sessions/${SA}/overview`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.crewAbortNotice, { available: true, reason: null });
    assert.ok(r.body.safeReturn, "the posture is still published beside it");
  });

  it("flag OFF: not offered, with the reason", async () => {
    stage({ flagOn: false });
    const r = await send("GET", `/api/airport/sessions/${SA}/overview`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.crewAbortNotice, { available: false, reason: "crew_notify_not_enabled" });
  });

  it("an unreadable crew does not fail the overview; the choice is simply not offered", async () => {
    stage({ failures: { "layover_crew_members:select": { message: "down" } } });
    const r = await send("GET", `/api/airport/sessions/${SA}/overview`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.crewAbortNotice, { available: false, reason: "crew_unreadable" });
  });
});

describe("fix round 1 (F1/F2): the session's trip Ghost Mode reaches both doors", () => {
  it("return-now: a traveller in Ghost Mode on THIS session's trip is not announced, even with { tellCrew: true }", async () => {
    stage({ tripId: "ca-trip-1", ghost: true });
    const r = await send("POST", RETURN_NOW, JSON.stringify({ tellCrew: true }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.crewNotifiedCount, 0);
    assert.equal(r.body.crewNotifyUnavailableReason, "sharing_not_allowed");
    assert.equal(notices().length, 0);
  });

  it("overview: the choice is not offered to that traveller", async () => {
    stage({ tripId: "ca-trip-1", ghost: true });
    const r = await send("GET", `/api/airport/sessions/${SA}/overview`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.crewAbortNotice, { available: false, reason: "sharing_not_allowed" });
  });

  it("control: the same trip with Ghost Mode OFF — offered, and the crew is told", async () => {
    stage({ tripId: "ca-trip-1", ghost: false });
    const o = await send("GET", `/api/airport/sessions/${SA}/overview`);
    assert.deepEqual(o.body.crewAbortNotice, { available: true, reason: null });
    const r = await send("POST", RETURN_NOW, JSON.stringify({ tellCrew: true }));
    assert.equal(r.body.crewNotifiedCount, 2);
  });
});
