/**
 * census-layover L32 (`layover_outcomes`), and through it L10, L174, L195, L214
 * — closing a layover now stores its OUTCOME, behind 2992's own write gate.
 *
 * Over the real airport router and `fakeLayoverDb`, asserting the STORE:
 *
 *   - gate OFF (the default, and production today): the close succeeds, NOTHING
 *     is written to `layover_outcomes`, and the response says so;
 *   - gate ON: "I made my flight" is one row, BOARDED, with `completed_at`;
 *     "ending early" is one row, UNKNOWN, with `completed_at` NULL;
 *   - every column nothing observes is NULL, never `false` — "did not leave the
 *     airport" is a claim, and the absence of a report is not evidence for it;
 *   - a failed outcome write never fails the close, and is reported;
 *   - a close that FAILED writes no outcome.
 *
 * Controlled evidence only: a fake, not a database. 2992 is not applied to any
 * database this suite can reach.
 *
 * Run: node --import tsx/esm --test src/test/layoverOutcomeStore.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  layoverOutcomeRow,
  recordLayoverOutcome,
  BOARDING_OUTCOMES,
  OUTCOME_WRITE_FLAG,
} from "../services/layover/LayoverOutcomeStore.js";

let server: http.Server;
let base: string;
const TOKEN = "outcome-token";
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

function stage(opts: { gate?: boolean; failures?: Record<string, { message: string; code?: string }> } = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      ...(opts.gate ? [{ flag: OUTCOME_WRITE_FLAG, enabled: true }] : []),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER_ID, arrival_time: new Date(Date.now() - 6 * 3_600_000).toISOString() })],
    layover_events: [], layover_plan_stops: [], layover_outcomes: [],
    passport_stamps: [], passport_visibility_preferences: [], trip_plan_items: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID }, failures: opts.failures }), true);
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

const UNOBSERVED = ["left_airport", "completed_experience", "met_people_count", "actual_airport_return_at", "comfort_rating", "plan_change_reason"];

describe("gate OFF — the default, and production today", () => {
  it("closes the layover, writes NO outcome, and says why", async () => {
    const t = stage();
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.session.status, "completed");
    assert.deepEqual(r.body.outcomeRecord, { recorded: false, reason: "persistence_disabled" });
    assert.equal(t.layover_outcomes.length, 0);
  });
});

describe("gate ON — the close's answer becomes ONE outcome row", () => {
  it("'I made my flight' is BOARDED with completed_at, and every unobserved column is NULL — never false", async () => {
    const t = stage({ gate: true });
    const before = Date.now();
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.outcomeRecord, { recorded: true, boardingOutcome: "BOARDED" });
    assert.equal(t.layover_outcomes.length, 1);
    const row = t.layover_outcomes[0];
    assert.equal(row.session_id, "session-1");
    assert.equal(row.boarding_outcome, "BOARDED");
    assert.ok(Date.parse(row.completed_at) >= before - 1000, `completed_at is the close instant: ${row.completed_at}`);
    for (const k of UNOBSERVED) assert.strictEqual(row[k], null, `${k} must be NULL (not observed), got ${JSON.stringify(row[k])}`);
    for (const k of Object.keys(row)) assert.ok(!/lat|lng|lon|coord|position/i.test(k), `no coordinate column: ${k}`);
  });

  it("ending early is UNKNOWN with completed_at NULL — ending early is not evidence of a missed flight", async () => {
    const t = stage({ gate: true });
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "cancelled" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.session.status, "cancelled");
    assert.deepEqual(r.body.outcomeRecord, { recorded: true, boardingOutcome: "UNKNOWN" });
    assert.equal(t.layover_outcomes.length, 1);
    assert.equal(t.layover_outcomes[0].boarding_outcome, "UNKNOWN");
    assert.strictEqual(t.layover_outcomes[0].completed_at, null);
  });

  it("the default close (no outcome sent) is recorded as UNKNOWN, matching the session's cancelled status", async () => {
    const t = stage({ gate: true });
    const r = await req("DELETE", "/api/airport/sessions/session-1");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(t.layover_outcomes.length, 1);
    assert.equal(t.layover_outcomes[0].boarding_outcome, "UNKNOWN");
  });
});

describe("an outcome that cannot be stored never fails the close", () => {
  it("a failed outcome write: the close stands, the response reports write_failed", async () => {
    const t = stage({ gate: true, failures: { "layover_outcomes:upsert": { message: "relation \"layover_outcomes\" does not exist", code: "42P01" } } });
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.session.status, "completed");
    assert.equal(t.layover_sessions[0].status, "completed");
    assert.deepEqual(r.body.outcomeRecord, { recorded: false, reason: "write_failed" });
    assert.equal(t.layover_outcomes.length, 0);
  });

  it("a close that FAILED writes no outcome at all", async () => {
    const t = stage({ gate: true, failures: { "layover_sessions:update": { message: "boom" } } });
    const r = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(t.layover_outcomes.length, 0, "an outcome for a layover that was never closed is an event that did not happen");
  });
});

describe("the row and the writer", () => {
  it("uses only 2992's boarding vocabulary", () => {
    for (const o of ["completed", "cancelled"] as const) {
      assert.ok((BOARDING_OUTCOMES as readonly string[]).includes(layoverOutcomeRow("s", o, 0).boarding_outcome as string));
    }
  });

  it("a replayed write is the same row, not a second one (session_id is the key)", async () => {
    const tables: Record<string, any[]> = { feature_flags: [{ flag: OUTCOME_WRITE_FLAG, enabled: true }], layover_outcomes: [] };
    const db = makeLayoverDb(tables) as any;
    const a = await recordLayoverOutcome(db, { sessionId: "s-1", outcome: "completed", nowMs: Date.UTC(2026, 9, 1) });
    const b = await recordLayoverOutcome(db, { sessionId: "s-1", outcome: "completed", nowMs: Date.UTC(2026, 9, 1, 0, 5) });
    assert.equal(a.recorded, true);
    assert.equal(b.recorded, true);
    assert.equal(tables.layover_outcomes.length, 1);
  });
});
