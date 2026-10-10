/**
 * census-layover L39 / L40 / L43 — the §5 graph wired beside the routes that
 * move a layover, over the real airport router and `fakeLayoverDb`.
 *
 *   flag OFF (the seed, migration 3632): SHADOW. Every response is what it was
 *     — no `lifecycle` key anywhere — and every write still succeeds.
 *   flag ON: the overview publishes the graph's state, the EVALUATING guard
 *     and the required intents; the close, the abort and a checkpoint publish
 *     the transition. A checkpoint the graph cannot place is published as
 *     divergent and is STILL recorded: the machine is advisory.
 *
 * Run: node --import tsx/esm --test src/test/layoverLifecycleRoutes.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { CHECKPOINT_WRITE_FLAG } from "../services/layover/LayoverCheckpointStore.js";
import { LAYOVER_LIFECYCLE_FLAG } from "../services/airport/LayoverLifecycle.js";

let server: http.Server;
let base: string;
const TOKEN = "lifecycle-token";
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

function stage(opts: { lifecycle?: boolean; checkpoints?: boolean } = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      ...(opts.lifecycle ? [{ flag: LAYOVER_LIFECYCLE_FLAG, enabled: true }] : []),
      ...(opts.checkpoints ? [{ flag: CHECKPOINT_WRITE_FLAG, enabled: true }] : []),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      user_id: USER_ID,
      arrival_time: new Date(Date.now() - 1 * 3_600_000).toISOString(),
      departure_time: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      status: "active",
    })],
    layover_checkpoints: [], layover_outcomes: [], layover_events: [], layover_plan_stops: [], layover_recommendations: [],
    passport_stamps: [], passport_visibility_preferences: [], trip_plan_items: [],
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

const S = "/api/airport/sessions/session-1";

describe("flag OFF — shadow: nothing on the wire changes", () => {
  it("the overview carries no lifecycle", async () => {
    stage();
    const r = await req("GET", `${S}/overview`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!("lifecycle" in r.body));
    assert.ok("layoverState" in r.body, "the projection is published exactly as before");
  });

  it("the close succeeds and carries no lifecycle", async () => {
    const t = stage();
    const r = await req("DELETE", S, { outcome: "completed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!("lifecycle" in r.body));
    assert.equal(t.layover_sessions[0].status, "completed");
  });

  it("a checkpoint the graph cannot place is still recorded", async () => {
    const t = stage({ checkpoints: true });
    const r = await req("POST", `${S}/checkpoints`, { type: "AIRPORT_REENTRY", operationId: "op-1" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(!("lifecycle" in r.body));
    assert.equal(t.layover_checkpoints.length, 1);
  });
});

describe("flag ON — the graph is published, and still refuses nothing", () => {
  it("the overview publishes the state, the EVALUATING guard and the intents", async () => {
    stage({ lifecycle: true });
    const r = await req("GET", `${S}/overview`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const lc = r.body.lifecycle;
    assert.ok(lc, "lifecycle is published under the flag");
    assert.equal(typeof lc.state, "string");
    assert.ok(Array.isArray(lc.guardFailures));
    assert.ok(Array.isArray(lc.intents));
    assert.ok(Array.isArray(lc.availableEvents));
    assert.equal(lc.projectedState, r.body.layoverState, "the graph sits beside the projection, not instead of it");
    assert.equal(lc.checkpointRead, "unavailable", "the checkpoint store is gated off: placed from the record alone");
    // No entry corridor is confirmed on this fixture, so the guard cannot hold.
    assert.ok(lc.guardFailures.includes("entry_not_confirmed_allowed"));
    assert.notEqual(lc.state, "LANDSIDE_AVAILABLE");
  });

  it("the close publishes TRAVELLER_CLOSED → COMPLETED", async () => {
    stage({ lifecycle: true });
    const r = await req("DELETE", S, { outcome: "completed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.lifecycle.event, "TRAVELLER_CLOSED");
    assert.equal(r.body.lifecycle.transition.ok, true);
    assert.equal(r.body.lifecycle.transition.to, "COMPLETED");
    assert.equal(r.body.lifecycle.divergent, false);
  });

  it("a re-entry on an `active` row is published as unresolved, and recorded anyway", async () => {
    const t = stage({ lifecycle: true, checkpoints: true });
    const r = await req("POST", `${S}/checkpoints`, { type: "AIRPORT_REENTRY", operationId: "op-1" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.lifecycle.event, "AIRPORT_REENTERED");
    assert.equal(r.body.lifecycle.divergent, true);
    assert.equal(r.body.lifecycle.transition.refusal, "from_state_unresolved");
    assert.equal(t.layover_checkpoints.length, 1);
  });

  it("after a re-entry report the overview places the traveller in AIRPORT_REENTERED with its side effects (L43)", async () => {
    stage({ lifecycle: true, checkpoints: true });
    await req("POST", `${S}/checkpoints`, { type: "AIRPORT_REENTRY", operationId: "op-1" });
    const r = await req("GET", `${S}/overview`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.lifecycle.checkpointRead, "ok");
    assert.equal(r.body.lifecycle.state, "AIRPORT_REENTERED");
    assert.deepEqual(r.body.lifecycle.intents, ["STOP_LANDSIDE_DISCOVERY", "REFRESH_GATE_AND_SECURITY"]);
  });
});
