/**
 * Layover session edit / close / overview — route behaviour.
 *
 * node:test + node:assert (NOT vitest). Real router, fake table-backed DB.
 *
 * PATCH /api/airport/sessions/:id used to hand the patch straight to
 * updateSession: departure before arrival, boarding outside the window and a
 * three-day layover were all accepted (POST refuses every one), and the
 * `*Local` wall-time fields its schema accepts were silently DROPPED — an edit
 * sent in airport-local time changed nothing and reported ok.
 *
 * DELETE /api/airport/sessions/:id was the only close path and always passed
 * "cancelled", so `status = 'completed'` was unreachable: a traveller who came
 * back and boarded was recorded as having abandoned the layover.
 *
 * GET /overview now carries the §15 return state, the engine version and the
 * Appendix A reason codes (additive fields).
 *
 * Run: node --import tsx/esm --test src/test/layoverSessionEdit.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { wallTimeToUtc } from "../services/airport/AirportTime.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

let server: http.Server;
let base: string;
const TOKEN = "edit-token";
const USER_ID = "user-1";

function req(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
    if (payload) headers["content-length"] = Buffer.byteLength(payload).toString();
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function stage(sessionOver: Record<string, any> = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER_ID, ...sessionOver })],
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID } }), true);
  return tables;
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("PATCH /airport/sessions/:id — the edited window is validated as a whole", () => {
  it("positive control: a valid departure move is accepted and persisted", async () => {
    const t = stage();
    const dep = new Date(Date.now() + 10 * 3_600_000).toISOString();
    const r = await req("PATCH", "/api/airport/sessions/session-1", { departureTime: dep });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(t.layover_sessions[0].departure_time, dep);
  });

  it("departure before the (unchanged) arrival is refused and nothing is written", async () => {
    const t = stage();
    const before = t.layover_sessions[0].departure_time;
    const r = await req("PATCH", "/api/airport/sessions/session-1", { departureTime: new Date(Date.now() - 3_600_000).toISOString() });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(t.layover_sessions[0].departure_time, before);
  });

  it("boarding outside [arrival, departure] is refused", async () => {
    stage();
    const r = await req("PATCH", "/api/airport/sessions/session-1", { boardingTime: new Date(Date.now() + 20 * 3_600_000).toISOString() });
    assert.equal(r.status, 400);
    assert.match(String(r.body.message ?? ""), /Boarding/);
  });

  it("a window over 48 hours is refused", async () => {
    stage();
    const r = await req("PATCH", "/api/airport/sessions/session-1", { departureTime: new Date(Date.now() + 60 * 3_600_000).toISOString() });
    assert.equal(r.status, 400);
    assert.match(String(r.body.message ?? ""), /48 hours/);
  });

  it("airport-local wall times are converted in the airport's timezone (they used to be dropped)", async () => {
    const t = stage();
    // A local time tomorrow, well inside 48h of the staged arrival.
    const local = new Date(Date.now() + 26 * 3_600_000);
    const y = local.getUTCFullYear(), m = String(local.getUTCMonth() + 1).padStart(2, "0"), d = String(local.getUTCDate()).padStart(2, "0");
    const wall = `${y}-${m}-${d}T18:30`;
    const expected = wallTimeToUtc("Asia/Taipei", wall)!.toISOString();
    const r = await req("PATCH", "/api/airport/sessions/session-1", { departureLocal: wall });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(t.layover_sessions[0].departure_time, expected);
    assert.equal(r.body.session.departureTime, expected);
  });

  it("a closed session cannot be edited", async () => {
    stage({ status: "cancelled" });
    const r = await req("PATCH", "/api/airport/sessions/session-1", { checkedBags: true });
    assert.equal(r.status, 404);
  });
});

describe("DELETE /airport/sessions/:id — completion is representable", () => {
  it("default (no outcome) still cancels — unchanged behaviour", async () => {
    const t = stage();
    const r = await req("DELETE", "/api/airport/sessions/session-1");
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "cancelled");
    assert.equal(t.layover_sessions[0].status, "cancelled");
    assert.ok(t.layover_events.some((e) => e.event_type === "session_cancelled"));
  });

  it("body outcome=completed marks the session completed and records session_completed", async () => {
    const t = stage();
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed" });
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "completed");
    assert.equal(t.layover_sessions[0].status, "completed");
    assert.ok(t.layover_events.some((e) => e.event_type === "session_completed"));
    assert.ok(!t.layover_events.some((e) => e.event_type === "session_cancelled"));
  });

  it("query ?outcome=completed works too; an unknown outcome falls back to cancelled", async () => {
    let t = stage();
    let r = await req("DELETE", "/api/airport/sessions/session-1?outcome=completed");
    assert.equal(t.layover_sessions[0].status, "completed");
    t = stage();
    r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "boarded" });
    assert.equal(r.body.outcome, "cancelled");
    assert.equal(t.layover_sessions[0].status, "cancelled");
  });

  it("closing an already-closed session is not_found, and does not rewrite the status", async () => {
    const t = stage({ status: "completed" });
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "cancelled" });
    assert.equal(r.status, 404);
    assert.equal(t.layover_sessions[0].status, "completed");
  });
});

describe("GET /airport/sessions/:id/overview — certified state fields", () => {
  it("carries returnState, engineVersion and reasonCodes", async () => {
    stage();
    const r = await req("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.window.returnState, "NORMAL");
    assert.equal(typeof r.body.window.engineVersion, "string");
    assert.equal(r.body.advice.engineVersion, r.body.window.engineVersion);
    assert.ok(Array.isArray(r.body.advice.reasonCodes));
    assert.ok(r.body.advice.reasonCodes.includes("ENTRY_NOT_CONFIRMED"));
    assert.ok(r.body.advice.reasonCodes.includes("AIRPORT_MATURITY_LIMITED"), "staged airport is unverified, like every production profile");
  });

  it("past the deadline the state is RETURN_NOW or worse and the code says so", async () => {
    // departure in 30 minutes: the buffer alone exceeds that, so the deadline is behind us
    stage({ departure_time: new Date(Date.now() + 30 * 60_000).toISOString(), arrival_time: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    const r = await req("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200);
    assert.ok(["RETURN_NOW", "CONNECTION_AT_RISK"].includes(r.body.window.returnState), r.body.window.returnState);
    assert.equal(r.body.window.usableMinutes, 0);
    assert.ok(r.body.advice.reasonCodes.includes("RETURN_THRESHOLD_REACHED"));
  });
});
