/**
 * census L102–L113 — the twelve §12 Compass tools
 * census L100  — "Compass is an orchestrator and explainer: … invokes
 *                 deterministic tools"
 *
 * ── RESTATED 2026-10-09 UNDER LEAD RULING L-CL02d ───────────────────────────
 * This suite used to prove that `POST /api/airport/sessions/:id/compass` offered
 * the twelve §12 tool declarations to a model, ran what the model chose through
 * `runLayoverTool`, fed the results back, and refused the three ways a tool loop
 * speaks with false confidence (an unreadable shortlist read as `[]`, an
 * unreadable plan read as "fits", an invented tool name thrown as a 500).
 *
 * L-CL02a made every live-layover question certified-only; L-CL02c made any
 * session whose departure is ahead live; and a certified explicit `yes` needs a
 * departure ahead — so the model branch was unreachable, and L-CL02d deleted it,
 * the tool loop and the twelve tools from this door. The SAME scenarios are kept
 * here as the statement that is now true: whatever a model would have asked for
 * (each tool, an invented tool, unparseable arguments, an endless tool loop) and
 * whatever the tables hold or fail to hold, the route asks NO model, runs NO
 * tool, reads none of the lists a tool would have read, and answers with the
 * certified text + airport facts. Census L102–L113 and L100 are `W` for this
 * reason (census-layover §56.3).
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverCompassToolLoop.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import { _setTestOpenAI } from "../../../lib/openai.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import { ENTRY_FLAG } from "../../../lib/entryRequirements.js";

let server: http.Server;
let base: string;
const TOKEN = "compass-tool-token";
const USER_ID = "user-1";
const SESSION_ID = "session-compass";
const HOUR = 3_600_000;

/** The twelve tool names the deleted loop offered; kept here only as the scenarios' vocabulary. */
const FORMER_TOOLS = [
  "getLayoverContext", "getConnectionState", "getTimeWallet", "getSafeEnvelope", "getReachableExperiences",
  "simulatePlan", "getReturnContract", "getAirportState", "getCrewCandidates", "requestConstraintClarification",
  "replan", "explainDecision",
] as const;

function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
                   "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    r.end(payload);
  });
}

function compassSession(over: Record<string, any> = {}) {
  const now = Date.now();
  return sessionRow({
    id: SESSION_ID, user_id: USER_ID, status: "active",
    arrival_time:   new Date(now - 1 * HOUR).toISOString(),
    departure_time: new Date(now + 8 * HOUR).toISOString(),
    boarding_time:  null, wants_to_leave: true,
    ...over,
  });
}

/** A US passport on a curated visa-free corridor into Taiwan: with a departure ahead, the verdict is an explicit `yes`. */
function permittedEntry(): Record<string, any[]> {
  return {
    traveler_passports: [{ user_id: USER_ID, issuing_country: "US", is_primary: true, created_at: "2026-01-01T00:00:00.000Z" }],
    entry_requirements: [{
      id: "corr-visa_free", passport_country: "US", destination_country: "TW", status: "visa_free",
      allowed_stay_days: null, passport_validity_rule: null, fee_text: null, processing_time_text: null,
      official_source_url: null, notes: null, confidence: "high", last_verified_at: "2026-09-01T00:00:00.000Z",
    }],
  };
}

const RECS = () => [{ id: "r-1", session_id: SESSION_ID, title: "Night market dumplings", category: "food", inside_airport: false, created_at: new Date().toISOString() }];
const STOPS = () => [{ id: "st-1", session_id: SESSION_ID, title: "Temple visit", position: 0, planned_minutes: 90, status: "active", created_at: new Date().toISOString() }];

function stage(opts: { failures?: Record<string, { message: string }>; entry?: "permitted" | "unverified"; status?: string; departure?: string | null; arrival?: string } = {}) {
  const permitted = (opts.entry ?? "permitted") === "permitted";
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_compass_enabled", enabled: true },
      ...(permitted ? [{ flag: ENTRY_FLAG, enabled: true }] : []),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [compassSession({ status: opts.status ?? "active", ...(opts.departure !== undefined ? { departure_time: opts.departure } : {}), ...(opts.arrival !== undefined ? { arrival_time: opts.arrival } : {}) })],
    layover_recommendations: RECS(),
    layover_plan_stops: STOPS(),
    layover_crews: [], layover_crew_members: [], layover_checkpoints: [],
    layover_events: [], trip_plan_items: [],
    blocks: [], profiles: [], location_preferences: [], trips: [],
    ...(permitted ? permittedEntry() : {}),
  };
  const db = makeLayoverDb(tables, { users: { [TOKEN]: USER_ID }, failures: opts.failures ?? {} });
  const realFrom = db.from;
  const reads: Record<string, number> = {};
  db.from = (name: string) => { if (LIST_TABLES.includes(name)) reads[name] = (reads[name] ?? 0) + 1; return realFrom(name); };
  _setTestClient(db, true);
  return { tables, reads };
}
/** The tables the deleted tool loop read; L-CL02b/L-CL02d: this door reads none of them. */
const LIST_TABLES = ["layover_recommendations", "layover_plan_stops", "layover_crews", "layover_crew_members", "layover_checkpoints"];

/** A model double that records every request and replays a script — here, to prove it is never asked. */
function scriptedModel(turns: Array<{ content?: string; tool_calls?: any[] }>) {
  const seen: any[] = [];
  let i = 0;
  return {
    seen,
    client: { chat: { completions: { create: async (req: any) => {
      seen.push(req);
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return { choices: [{ message: { role: "assistant", content: turn.content ?? null, tool_calls: turn.tool_calls } }] };
    } } } } as any,
  };
}
const call = (id: string, name: string, args: Record<string, unknown> | string = {}) => ({
  id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});

const YES_LEAD = /^You have about \d+ minutes of usable time\. You can leave the airport — but make sure you're back at security by /;

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
afterEach(() => { _setTestOpenAI(null); });

/** Ask once; assert the certified-only shape every answer on this door has. */
async function ask(question: string, m: ReturnType<typeof scriptedModel>) {
  _setTestOpenAI(m.client);
  const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(m.seen.length, 0, `a completion was requested on the layover door: ${JSON.stringify(m.seen[0] ?? {}).slice(0, 200)}`);
  assert.equal(r.body.modelConsulted, false);
  assert.deepEqual(r.body.modelProse, { mode: "certified_only", droppedSentences: 0 });
  assert.deepEqual(r.body.toolsConsulted, []);
  assert.deepEqual(r.body.boundaryViolations, []);
  assert.match(r.body.answer, /You're at Taiwan Taoyuan International Airport \(TPE\)/);
  return r;
}

// ── 1. Every status, every clock: no model, no tool, certified text ─────────

describe("L-CL02d — the layover door asks no model and runs no tool, for every session", () => {
  for (const status of ["active", "returning", "some_future_status", "completed", "cancelled", "expired"]) {
    it(`status ${status}, departure ahead, certified yes: 0 completions, 0 tools, the certified yes text`, async () => {
      stage({ status });
      const m = scriptedModel([
        { tool_calls: [call("c1", "getReturnContract", { sessionId: SESSION_ID })] },
        { content: "You've got ample margin to venture beyond the terminal. The cathedral is a short cab away." },
      ]);
      const answers = new Set<string>();
      for (const question of ["Can I leave the airport?", "Where can I eat?", "Is the cathedral worth it?", "Thoughts?"]) {
        const r = await ask(question, m);
        assert.equal(r.body.certification.verdict, "yes", "fixture: this world must certify yes");
        assert.match(r.body.answer, YES_LEAD);
        assert.ok(!/ample margin|cathedral is a short/.test(r.body.answer), r.body.answer);
        answers.add(r.body.answer);
      }
      assert.equal(answers.size, 1, "the question changed what the traveller was shown");
    });
  }

  it("entry unverified: the certified 'not confirmed' text, no model", async () => {
    stage({ entry: "unverified" });
    const r = await ask("Where can I eat?", scriptedModel([{ content: "Try the noodle bar." }]));
    assert.equal(r.body.certification.verdict, "entry_unverified");
    assert.match(r.body.answer, /^Leaving the airport has not been confirmed as possible on this layover/);
  });
});

// ── 2. Each former tool scenario: the model would have called it; nothing runs ──

describe("L102–L113 (former tool scenarios) — whatever tool a model would choose, none runs and none is offered", () => {
  for (const tool of FORMER_TOOLS) {
    it(`${tool}: no completion, no tool message, no tool in toolsConsulted`, async () => {
      stage();
      const m = scriptedModel([{ tool_calls: [call("c1", tool, { sessionId: SESSION_ID })] }, { content: "Done." }]);
      const r = await ask("What can I do here?", m);
      assert.match(r.body.answer, YES_LEAD);
    });
  }

  it("the certified return deadline is the response's own field, not a tool message", async () => {
    stage();
    const r = await ask("When do I need to be back?", scriptedModel([{ tool_calls: [call("c1", "getReturnContract", { sessionId: SESSION_ID })] }]));
    assert.ok(Number.isFinite(Date.parse(r.body.hardReturnTime)), JSON.stringify(r.body));
  });

  it("the shortlist and the plan are NOT shown: their titles never reach the answer", async () => {
    stage();
    const r = await ask("What should I do?", scriptedModel([{ tool_calls: [call("c1", "getReachableExperiences", { sessionId: SESSION_ID }), call("c2", "simulatePlan", { sessionId: SESSION_ID })] }]));
    assert.ok(!/Night market dumplings|Temple visit/.test(r.body.answer), r.body.answer);
  });

  it("an invented tool name and unparseable arguments cannot 500 the answer — nothing is asked", async () => {
    stage();
    await ask("Anything?", scriptedModel([{ tool_calls: [call("c1", "bookMeAFlight", {}), call("c2", "getTimeWallet", "{not json")] }]));
  });

  it("a model that would never stop calling tools cannot hang the request — it is never called", async () => {
    stage();
    await ask("Plan my layover", scriptedModel([{ tool_calls: [call("c1", "getTimeWallet", { sessionId: SESSION_ID })] }]));
  });
});

// ── 3. Least data touched: no list a tool would have read is read (L-CL02b, F1) ──

describe("L-CL02b/L-CL02d — no recommendation, plan-stop, crew or checkpoint read, for ANY session", () => {
  const now = Date.now();
  const worlds: Array<[string, { status: string; departure?: string }]> = [
    ["active", { status: "active" }],
    ["returning", { status: "returning" }],
    ["some_future_status (fail closed)", { status: "some_future_status" }],
    ["cancelled, departure ahead", { status: "cancelled" }],
    ["completed, departure passed", { status: "completed", departure: new Date(now - HOUR).toISOString() }],
    ["expired, departure passed", { status: "expired", departure: new Date(now - HOUR).toISOString() }],
  ];
  for (const [label, w] of worlds) {
    it(`${label}: zero reads of the five list tables`, async () => {
      const { reads } = stage(w);
      await ask("What should I do here?", scriptedModel([{ content: "Try the food court." }]));
      assert.deepEqual(reads, {}, label);
    });
  }

  it("an UNREADABLE shortlist or plan cannot affect the answer — neither is read", async () => {
    stage({ failures: { "layover_recommendations:select": { message: "boom" }, "layover_plan_stops:select": { message: "boom" } } });
    const r = await ask("What should I do?", scriptedModel([{ content: "x" }]));
    assert.match(r.body.answer, YES_LEAD);
  });
});

// ── 4. The event: always certified_only/false; liveLayover by L-CL02c (F2) ────

describe("compass_question_asked records certified_only / no model for EVERY status, and liveLayover by L-CL02c", () => {
  const now = Date.now();
  const cases: Array<[string, { status: string; departure?: string | null }, boolean]> = [
    ["active", { status: "active" }, true],
    ["returning", { status: "returning" }, true],
    ["some_future_status", { status: "some_future_status" }, true],
    ["cancelled, departure ahead (L-CL02c: still mid-layover)", { status: "cancelled" }, true],
    ["cancelled, departure passed (ended; certifies no)", { status: "cancelled", departure: new Date(now - HOUR).toISOString() }, false],
    ["completed, departure passed", { status: "completed", departure: new Date(now - HOUR).toISOString() }, false],
    ["expired, departure passed", { status: "expired", departure: new Date(now - HOUR).toISOString() }, false],
    // An unreadable departure is LIVE (fail closed) — pinned at the unit level in
    // layoverCompassCertifiedText; through the route the certification itself
    // cannot run on one (the column is a NOT NULL timestamptz in the schema).
  ];
  for (const [label, w, live] of cases) {
    it(`${label}: answerMode certified_only, modelConsulted false, liveLayover ${live}`, async () => {
      const { tables } = stage(w);
      const r = await ask("Can I leave the airport?", scriptedModel([{ content: "Off you go." }]));
      if (w.departure) assert.equal(r.body.certification.verdict, "no", "an ended session with its departure passed certifies no");
      const e = tables.layover_events.find((x: any) => x.event_type === "compass_question_asked");
      assert.ok(e, "no compass_question_asked event");
      assert.deepEqual([e.metadata.answerMode, e.metadata.modelConsulted, e.metadata.liveLayover], ["certified_only", false, live], label);
    });
  }
});

// ── V-R9: the route certifies at the REAL instant, and refuses an unreadable clock ──

describe("V-R9 — the route hands the certification its own clock (a wrong clock would fail OPEN)", () => {
  it("F1: a long-span DEPARTED cancelled session (arrival −10 h, departure −1 h) certifies `no` and says so", async () => {
    const now = Date.now();
    stage({ status: "cancelled", arrival: new Date(now - 10 * HOUR).toISOString(), departure: new Date(now - HOUR).toISOString() });
    const r = await ask("Can I leave the airport?", scriptedModel([{ content: "x" }]));
    assert.equal(r.body.certification.verdict, "no", JSON.stringify(r.body.certification));
    assert.match(r.body.answer, /^Leaving the airport is not recommended on this layover/);
    assert.doesNotMatch(r.body.answer, /you can leave the airport/i);
  });

  it("F1 CONTROL: an active session departing in +10 h certifies `yes`", async () => {
    const now = Date.now();
    stage({ status: "active", arrival: new Date(now - HOUR).toISOString(), departure: new Date(now + 10 * HOUR).toISOString() });
    const r = await ask("Can I leave the airport?", scriptedModel([{ content: "x" }]));
    assert.equal(r.body.certification.verdict, "yes");
    assert.match(r.body.answer, YES_LEAD);
  });

  it("F2: the event's liveLayover reads the certification instant, not a second clock", () => {
    const src = readFileSync(new URL("../../../routes/airport.ts", import.meta.url), "utf8");
    const handler = src.slice(src.indexOf('router.post("/airport/sessions/:id/compass"'), src.indexOf("// ── POST /api/airport/sessions/:id/plan"));
    assert.match(handler, /const certifiedAtMs = snapshot \? snapshot\.certifiedRecord\.inputs\.nowMs : nowMs;/);
    assert.match(handler, /nowMs: certifiedAtMs,/);
    assert.match(handler, /liveLayover: layoverSessionIsLiveAt\(session, certifiedAtMs\),/);
    assert.equal((handler.match(/Date\.now\(\)/g) ?? []).length, 1, "one clock read in the handler");
  });

  it("an UNPARSEABLE departure is a retryable refusal (degraded_unavailable), never a 500", async () => {
    stage({ departure: "not a date" });
    _setTestOpenAI(scriptedModel([{ content: "x" }]).client);
    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "Can I leave the airport?" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code ?? r.body.error, "degraded_unavailable", JSON.stringify(r.body));
  });
});
