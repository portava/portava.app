/**
 * census-layover L30 (`layover_checkpoints`), L173 (`recordCheckpoint`) and
 * L43's input — the traveller reports "I've left the airport" / "I'm back at
 * the airport", and the close's outcome row carries what they reported.
 *
 * Over the real airport router and `fakeLayoverDb`, asserting the STORE:
 *
 *   - gate OFF (production today): nothing is written, and a read says the
 *     store is off with `checkpoints: null` — never `[]`, which would read as
 *     "you have reported nothing";
 *   - gate ON: one row per report — TRAVELLER / MEDIUM, a dedup key built from
 *     the client's operation id, an expiry after departure, no coordinate;
 *   - a retried tap is the same row; a failed write or read is a refusal;
 *   - a report never moves the certified deadline;
 *   - the outcome row records left_airport / actual return from the reports,
 *     and NULL — never false — when nothing was reported or nothing could be read.
 *
 * Controlled evidence only: 2992 is applied to no database this suite reaches.
 *
 * Run: node --import tsx/esm --test src/test/layoverCheckpoints.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { _setTestOpenAI } from "../lib/openai.js";
import {
  CHECKPOINT_WRITE_FLAG,
  CHECKPOINT_VISIBLE_AFTER_DEPARTURE_MIN,
  airportPresenceFrom,
  observedReturnFrom,
} from "../services/layover/LayoverCheckpointStore.js";

let server: http.Server;
let base: string;
const TOKEN = "checkpoint-token";
const STRANGER_TOKEN = "stranger-token";
const USER_ID = "user-1";

function req(method: string, path: string, body?: any, token = TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };
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

const DEPARTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();

function stage(opts: { gate?: boolean; status?: string; checkpoints?: any[]; recommendations?: any[]; failures?: Record<string, { message: string; code?: string }> } = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      ...(opts.gate ? [{ flag: CHECKPOINT_WRITE_FLAG, enabled: true }] : []),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      user_id: USER_ID,
      arrival_time: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      departure_time: DEPARTURE,
      status: opts.status ?? "active",
    })],
    layover_checkpoints: opts.checkpoints ?? [],
    layover_outcomes: [], layover_events: [], layover_plan_stops: [], layover_recommendations: opts.recommendations ?? [],
    passport_stamps: [], passport_visibility_preferences: [], trip_plan_items: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID, [STRANGER_TOKEN]: "user-2" }, failures: opts.failures }), true);
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

const P = "/api/airport/sessions/session-1/checkpoints";

describe("gate OFF — production today", () => {
  it("a read says the store is OFF, with checkpoints: null — never an empty list", async () => {
    stage();
    const r = await req("GET", P);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, available: false, reason: "persistence_disabled", checkpoints: null, airportPresence: null });
  });

  it("a report is refused and nothing is written", async () => {
    const t = stage();
    const r = await req("POST", P, { type: "LANDSIDE_EXIT", operationId: "op-1" });
    assert.equal(r.body.error, "feature_disabled", JSON.stringify(r.body));
    assert.equal(t.layover_checkpoints.length, 0);
  });
});

describe("gate ON — a report is one row, and the traveller's presence follows the latest one", () => {
  it("'I've left the airport' is one TRAVELLER row with the operation's dedup key, an expiry after departure and no coordinate", async () => {
    const t = stage({ gate: true });
    const before = Date.now();
    const r = await req("POST", P, { type: "LANDSIDE_EXIT", operationId: "op-1" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.duplicate, false);
    assert.equal(r.body.airportPresence, "landside");
    assert.equal(t.layover_checkpoints.length, 1);
    const row = t.layover_checkpoints[0];
    assert.equal(row.session_id, "session-1");
    assert.equal(row.checkpoint_type, "LANDSIDE_EXIT");
    assert.equal(row.source, "TRAVELLER");
    assert.equal(row.confidence, "MEDIUM");
    assert.equal(row.dedup_key, "LANDSIDE_EXIT:op-1");
    assert.ok(Date.parse(row.observed_at) >= before - 1000);
    assert.equal(Date.parse(row.expires_at), Date.parse(DEPARTURE) + CHECKPOINT_VISIBLE_AFTER_DEPARTURE_MIN * 60_000);
    for (const k of Object.keys(row)) assert.ok(!/lat|lng|lon|coord|position/i.test(k), `no coordinate column: ${k}`);
  });

  it("'I'm back at the airport' after leaving makes the presence airside, and a read returns both reports newest first", async () => {
    stage({ gate: true });
    await req("POST", P, { type: "LANDSIDE_EXIT", operationId: "op-1" });
    await new Promise((r) => setTimeout(r, 5));
    const back = await req("POST", P, { type: "AIRPORT_REENTRY", operationId: "op-2" });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    assert.equal(back.body.airportPresence, "airside");
    const read = await req("GET", P);
    assert.equal(read.body.available, true);
    assert.deepEqual(read.body.checkpoints.map((c: any) => c.type), ["AIRPORT_REENTRY", "LANDSIDE_EXIT"]);
    assert.equal(read.body.airportPresence, "airside");
  });

  it("a retried tap is the SAME row, answered as a duplicate", async () => {
    const prior = { id: "cp-1", session_id: "session-1", checkpoint_type: "LANDSIDE_EXIT", observed_at: new Date().toISOString(), source: "TRAVELLER", confidence: "MEDIUM", dedup_key: "LANDSIDE_EXIT:op-1", expires_at: DEPARTURE };
    const t = stage({ gate: true, checkpoints: [prior], failures: { "layover_checkpoints:insert": { message: "duplicate key value violates unique constraint", code: "23505" } } });
    const r = await req("POST", P, { type: "LANDSIDE_EXIT", operationId: "op-1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.duplicate, true);
    assert.equal(r.body.checkpoint.id, "cp-1");
    assert.equal(t.layover_checkpoints.length, 1);
  });

  it("an expired report is invisible to reads", async () => {
    const old = { id: "cp-old", session_id: "session-1", checkpoint_type: "LANDSIDE_EXIT", observed_at: new Date(Date.now() - 3_600_000).toISOString(), source: "TRAVELLER", confidence: "MEDIUM", dedup_key: "LANDSIDE_EXIT:old", expires_at: new Date(Date.now() - 60_000).toISOString() };
    stage({ gate: true, checkpoints: [old] });
    const r = await req("GET", P);
    assert.deepEqual(r.body.checkpoints, []);
    assert.equal(r.body.airportPresence, "unreported");
  });
});

describe("refusals — a failure is never a success and never an absence", () => {
  it("a failed write is 503 and writes nothing", async () => {
    const t = stage({ gate: true, failures: { "layover_checkpoints:insert": { message: "boom" } } });
    const r = await req("POST", P, { type: "LANDSIDE_EXIT", operationId: "op-1" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(t.layover_checkpoints.length, 0);
  });

  it("an unreadable store is 503, not an empty list", async () => {
    stage({ gate: true, failures: { "layover_checkpoints:select": { message: "boom" } } });
    const r = await req("GET", P);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("only the two traveller-reportable types, and an operation id, are accepted", async () => {
    const t = stage({ gate: true });
    for (const body of [{ type: "BOARDING", operationId: "x" }, { type: "GATE", operationId: "x" }, { type: "LANDSIDE_EXIT" }, { type: "LANDSIDE_EXIT", operationId: "" }]) {
      const r = await req("POST", P, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(t.layover_checkpoints.length, 0);
  });

  it("a layover that has ended takes no reports", async () => {
    const t = stage({ gate: true, status: "completed" });
    const r = await req("POST", P, { type: "AIRPORT_REENTRY", operationId: "op-1" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(t.layover_checkpoints.length, 0);
  });

  it("another traveller's layover is not found, read or written", async () => {
    const t = stage({ gate: true });
    const w = await req("POST", P, { type: "LANDSIDE_EXIT", operationId: "op-1" }, STRANGER_TOKEN);
    assert.equal(w.status, 404, JSON.stringify(w.body));
    const r = await req("GET", P, undefined, STRANGER_TOKEN);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(t.layover_checkpoints.length, 0);
  });
});

describe("a report never moves the certified deadline", () => {
  it("the overview's hard return is identical before and after 'I've left the airport'", async () => {
    stage({ gate: true });
    const before = await req("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(before.status, 200, JSON.stringify(before.body).slice(0, 300));
    await req("POST", P, { type: "LANDSIDE_EXIT", operationId: "op-1" });
    const after = await req("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(after.body.window.hardReturnTime, before.body.window.hardReturnTime);
    assert.equal(after.body.advice.verdict, before.body.advice.verdict);
  });
});

describe("the close's outcome carries what the traveller reported", () => {
  it("left and came back: left_airport TRUE and the re-entry instant", async () => {
    const t = stage({ gate: true });
    await req("POST", P, { type: "LANDSIDE_EXIT", operationId: "op-1" });
    await new Promise((r) => setTimeout(r, 5));
    const back = await req("POST", P, { type: "AIRPORT_REENTRY", operationId: "op-2" });
    const close = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed" });
    assert.equal(close.status, 200, JSON.stringify(close.body));
    assert.equal(t.layover_outcomes.length, 1);
    assert.strictEqual(t.layover_outcomes[0].left_airport, true);
    assert.equal(t.layover_outcomes[0].actual_airport_return_at, back.body.checkpoint.observedAt);
    assert.ok(Date.parse(t.layover_outcomes[0].actual_airport_return_at) <= Date.parse(t.layover_outcomes[0].completed_at), "2992's CHECK: return not after completion");
  });

  it("reported nothing: both NULL — the absence of a report is not 'stayed airside'", async () => {
    const t = stage({ gate: true });
    await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed" });
    assert.strictEqual(t.layover_outcomes[0].left_airport, null);
    assert.strictEqual(t.layover_outcomes[0].actual_airport_return_at, null);
  });

  it("checkpoints unreadable at the close: both NULL, never false, and the close stands", async () => {
    const t = stage({ gate: true, checkpoints: [{ id: "cp-1", session_id: "session-1", checkpoint_type: "LANDSIDE_EXIT", observed_at: new Date().toISOString(), source: "TRAVELLER", confidence: "MEDIUM", dedup_key: "x", expires_at: DEPARTURE }], failures: { "layover_checkpoints:select": { message: "boom" } } });
    const close = await req("DELETE", "/api/airport/sessions/session-1", { outcome: "completed" });
    assert.equal(close.status, 200, JSON.stringify(close.body));
    assert.strictEqual(t.layover_outcomes[0].left_airport, null);
    assert.strictEqual(t.layover_outcomes[0].actual_airport_return_at, null);
  });
});

describe("one gate, spelled three times", () => {
  it("the checkpoint and outcome writers read exactly 2992's gate, DECISION_PERSISTENCE_FLAG", async () => {
    const { DECISION_PERSISTENCE_FLAG } = await import("../services/layover/LayoverDecisionStore.js");
    const { OUTCOME_WRITE_FLAG } = await import("../services/layover/LayoverOutcomeStore.js");
    assert.equal(CHECKPOINT_WRITE_FLAG, DECISION_PERSISTENCE_FLAG);
    assert.equal(OUTCOME_WRITE_FLAG, DECISION_PERSISTENCE_FLAG);
  });
});

describe("the two pure derivations", () => {
  const cp = (type: string, at: number) => ({ id: `${type}-${at}`, type, observedAt: new Date(at).toISOString(), source: "TRAVELLER", confidence: "MEDIUM" });
  it("presence follows the NEWEST observed report, whatever order rows arrive in", () => {
    assert.equal(airportPresenceFrom([]), "unreported");
    assert.equal(airportPresenceFrom([cp("AIRPORT_REENTRY", 2000), cp("LANDSIDE_EXIT", 1000)]), "airside");
    assert.equal(airportPresenceFrom([cp("AIRPORT_REENTRY", 1000), cp("LANDSIDE_EXIT", 2000)]), "landside");
  });
  it("a re-entry BEFORE the last exit is not the return", () => {
    const o = observedReturnFrom({ ok: true, checkpoints: [cp("LANDSIDE_EXIT", 1000), cp("AIRPORT_REENTRY", 2000), cp("LANDSIDE_EXIT", 3000)] });
    assert.deepEqual(o, { leftAirport: true, actualAirportReturnAt: null });
  });
});

// ── census L43 — RETURNING → AIRPORT_REENTERED: landside discovery stops ─────

function rec(id: string, insideAirport: boolean, sort: number) {
  return {
    id, session_id: "session-1", rec_type: insideAirport ? "inside_airport" : "food", title: insideAirport ? "Lounge" : "Night market",
    description: null, safety_rating: "safe", travel_time_min: insideAirport ? 0 : null, activity_time_min: 45,
    return_buffer_min: 120, hard_return_time: null, warning_reason: null, inside_airport: insideAirport,
    location_label: null, city: "Taoyuan", neighborhood: null, sort_order: sort, place_id: null, plan_item_id: null,
    status: "active", created_at: new Date().toISOString(),
  };
}
const RECS = () => [rec("r-air", true, 1), rec("r-land", false, 2)];
const R = "/api/airport/sessions/session-1/recommendations";
const cp = (id: string, type: string, minutesAgo: number) => ({
  id, session_id: "session-1", checkpoint_type: type, observed_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  source: "TRAVELLER", confidence: "MEDIUM", dedup_key: `${type}:${id}`, expires_at: DEPARTURE,
});

describe("L43 — once the traveller reports being back at the airport, landside suggestions stop", () => {
  it("after 'I've left' then 'I'm back': only airport-side recommendations, and the response says why", async () => {
    stage({ gate: true, recommendations: RECS(), checkpoints: [cp("c1", "LANDSIDE_EXIT", 90), cp("c2", "AIRPORT_REENTRY", 10)] });
    const r = await req("GET", R);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.recommendations.map((x: any) => x.id), ["r-air"]);
    assert.equal(r.body.landsideSuppression?.reason, "airport_reentered");
    assert.equal(typeof r.body.landsideSuppression?.reportedAt, "string");
  });

  it("a traveller still out (newest report 'I've left') keeps every suggestion", async () => {
    stage({ gate: true, recommendations: RECS(), checkpoints: [cp("c1", "AIRPORT_REENTRY", 90), cp("c2", "LANDSIDE_EXIT", 10)] });
    const r = await req("GET", R);
    assert.deepEqual(r.body.recommendations.map((x: any) => x.id).sort(), ["r-air", "r-land"]);
    assert.strictEqual(r.body.landsideSuppression, null);
  });

  it("no report, or the store OFF: nothing is withheld", async () => {
    stage({ gate: false, recommendations: RECS() });
    const off = await req("GET", R);
    assert.deepEqual(off.body.recommendations.map((x: any) => x.id).sort(), ["r-air", "r-land"]);
    assert.strictEqual(off.body.landsideSuppression, null);
    stage({ gate: true, recommendations: RECS() });
    const none = await req("GET", R);
    assert.deepEqual(none.body.recommendations.map((x: any) => x.id).sort(), ["r-air", "r-land"]);
    assert.strictEqual(none.body.landsideSuppression, null);
  });

  it("unreadable check-ins: landside is NOT hidden for everyone on an outage, and the response says it could not check", async () => {
    stage({ gate: true, recommendations: RECS(), failures: { "layover_checkpoints:select": { message: "boom" } } });
    const r = await req("GET", R);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.recommendations.map((x: any) => x.id).sort(), ["r-air", "r-land"]);
    assert.deepEqual(r.body.landsideSuppression, { reason: "checkpoints_unreadable", reportedAt: null });
  });

  it("re-entry never moves the certified deadline (it only withholds suggestions)", async () => {
    stage({ gate: true, recommendations: RECS() });
    const before = await req("GET", "/api/airport/sessions/session-1/overview");
    await req("POST", P, { type: "AIRPORT_REENTRY", operationId: "op-back" });
    const after = await req("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(after.body.window.hardReturnTime, before.body.window.hardReturnTime);
    assert.equal(after.body.advice.verdict, before.body.advice.verdict);
  });
});

describe("L43 — Compass is handed the same airport-side list after re-entry", () => {
  it("getReachableExperiences lists only airport-side ideas once the traveller is back", async () => {
    const t = stage({ gate: true, recommendations: RECS(), checkpoints: [cp("c1", "LANDSIDE_EXIT", 90), cp("c2", "AIRPORT_REENTRY", 10)] });
    t.feature_flags.push({ flag: "layover_compass_enabled", enabled: true });
    const seen: any[] = [];
    let i = 0;
    const turns = [
      { tool_calls: [{ id: "t1", type: "function", function: { name: "getReachableExperiences", arguments: JSON.stringify({ sessionId: "session-1" }) } }] },
      { content: "Stay near your gate." },
    ];
    _setTestOpenAI({ chat: { completions: { create: async (r: any) => { seen.push(r); const turn: any = turns[Math.min(i++, turns.length - 1)]; return { choices: [{ message: { role: "assistant", content: turn.content ?? null, tool_calls: turn.tool_calls } }] }; } } } } as any);
    try {
      const r = await req("POST", "/api/airport/sessions/session-1/compass", { question: "What can I do now?" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const toolMsg = seen[1]?.messages?.find((m: any) => m.role === "tool");
      assert.ok(toolMsg, "the tool result must go back to the model");
      const ids = JSON.parse(toolMsg.content).data.recommendations.map((x: any) => x.id);
      assert.deepEqual(ids, ["r-air"], `Compass was handed landside ideas after re-entry: ${toolMsg.content}`);
    } finally {
      _setTestOpenAI(null);
    }
  });
});
