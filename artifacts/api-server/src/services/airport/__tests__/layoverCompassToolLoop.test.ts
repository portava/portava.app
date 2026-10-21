/**
 * census L102–L113 — the twelve §12 Compass tools
 * census L100  — "Compass is an orchestrator and explainer: … invokes
 *                 deterministic tools"
 *
 * ── RESTATED 2026-10-18: OWNER DECISION (supersedes L-CL02a/c/d on this door) ──
 * Sections 1–4 below were L-CL02d's "no model, no tool" pins. Their scenarios
 * are unchanged and still pass, because they run with the new flag
 * `layover_compass_assistant_enabled` ABSENT — its production seed is FALSE
 * (3846) — and with the flag off the door is exactly the certified-only door
 * L-CL02d left: no model, no tool, none of the five list tables read.
 *
 * WHAT CHANGED (stated per assertion in the handback): the titles of sections
 * 1–4 now say "flag OFF"; nothing they assert was weakened. Section 5 is new:
 * with the flag ON the same route offers the twelve §12 declarations, runs what
 * the model chooses through LayoverCompassAssistant, refuses an unreadable
 * shortlist / plan as a named reason (not [] / "fits"), refuses an invented
 * tool by name, bounds an endless tool loop, keeps the certified text first,
 * withdraws adversarial prose (census-compass CL-02) and falls back to the
 * certified answer on an outage. Census L100, L102–L113 and L268 rest on
 * section 5 (BUILT, flag seeded FALSE: not C until the owner's press);
 * census-layover §56.3's L-CL02d reason is superseded.
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

/** The twelve §12 tool names; sections 1–4 use them as the scenarios' vocabulary (flag OFF: none runs). */
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
/** The tables the tools read; L-CL02b: with the flag OFF this door reads none of them. */
const LIST_TABLES = ["layover_recommendations", "layover_plan_stops", "layover_crews", "layover_crew_members", "layover_checkpoints"];

/** A model double that records every request and replays a script — flag OFF: to prove it is never asked. */
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

describe("L-CL02d — the layover door asks no model and runs no tool, for every session — with the assistant flag OFF (the seed)", () => {
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

  it("entry unconfirmed: the certified refusal, no model", async () => {
    stage({ entry: "unverified" });
    const r = await ask("Where can I eat?", scriptedModel([{ content: "Try the noodle bar." }]));
    assert.equal(r.body.certification.verdict, "no");
    assert.match(r.body.answer, /^Leaving the airport is not recommended on this layover/);
  });
});

// ── 2. Each former tool scenario: the model would have called it; nothing runs ──

describe("L102–L113 (former tool scenarios) — flag OFF: whatever tool a model would choose, none runs and none is offered", () => {
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

describe("L-CL02b/L-CL02d — flag OFF: no recommendation, plan-stop, crew or checkpoint read, for ANY session", () => {
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

describe("compass_question_asked records certified_only / no model for EVERY status (flag OFF), and liveLayover by L-CL02c", () => {
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


// ── 5. Owner decision 2026-10-18: flag ON — the assistant on the live route ──
//
// Appended at the foot so no cited line above moves. Census L100, L102–L113,
// L268 (the tools are offered, chosen and run; plans are compared from the
// certified record; clarification and OpportunityEvents reach the model through
// the tools) and census-compass CL-02 (hard safety is not overridden by prose).
import { _resetRateLimit } from "../../../lib/rateLimit.js";
import { LAYOVER_TOOL_NAMES } from "../LayoverCompassAssistant.js";

/** `stage`, with the assistant flag ON (its production seed is FALSE: 3846). */
function stageOn(opts: Parameters<typeof stage>[0] = {}) {
  const s = stage(opts);
  s.tables.feature_flags.push({ flag: "layover_compass_assistant_enabled", enabled: true });
  _resetRateLimit();
  return s;
}
async function askOn(question: string, m: ReturnType<typeof scriptedModel>) {
  _setTestOpenAI(m.client);
  const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}
const replyJson = (reply: string, compare: Array<{ planRef: string; why: string }> = []) => JSON.stringify({ reply, compare, clarify: null });
const toolResults = (req: any) => req.messages.filter((x: any) => x.role === "tool").map((x: any) => JSON.parse(x.content));

describe("flag ON (owner decision 2026-10-18) — L100 / L102–L113 / L268 on the live route, with CL-02 held", () => {
  it("the twelve §12 declarations travel on the request; the model's choice runs; what it reads is the certified record", async () => {
    stageOn();
    const m = scriptedModel([
      { tool_calls: [call("c1", "getReturnContract", { sessionId: SESSION_ID }), call("c2", "getTimeWallet", { sessionId: SESSION_ID })] },
      { content: replyJson("The lounge offers a calm spot to recharge.") },
    ]);
    const r = await askOn("What should I do here?", m);
    assert.equal(m.seen.length, 2);
    assert.deepEqual(m.seen[0].tools.map((t: any) => t.function.name), [...LAYOVER_TOOL_NAMES]);
    const [contract, wallet] = toolResults(m.seen[1]);
    assert.equal(contract.data.hardReturnTime, r.body.hardReturnTime, "the deadline the model read is the response's own certified field");
    assert.equal(wallet.data.usableMinutes, Number(/about (\d+) minutes of usable time/.exec(r.body.answer)![1]));
    assert.deepEqual(r.body.toolsConsulted, ["getReturnContract", "getTimeWallet"]);
    assert.equal(r.body.modelConsulted, true);
    assert.deepEqual(r.body.assistant, { enabled: true, status: "answered", fallbackReason: null, model: "gpt-5-mini" });
    assert.match(r.body.answer, YES_LEAD, "the certified text leads");
    assert.match(r.body.answer, /You're at Taiwan Taoyuan International Airport \(TPE\).* The lounge offers a calm spot to recharge\.$/);
    assert.deepEqual(r.body.modelProse, { mode: "confined", droppedSentences: 0 });
  });

  it("an UNREADABLE shortlist and plan reach the model as named refusals — never [] and never 'fits'", async () => {
    stageOn({ failures: { "layover_recommendations:select": { message: "boom" }, "layover_plan_stops:select": { message: "boom" } } });
    const m = scriptedModel([
      { tool_calls: [call("c1", "getReachableExperiences", { sessionId: SESSION_ID }), call("c2", "simulatePlan", { sessionId: SESSION_ID, candidateSet: null })] },
      { content: replyJson("The lounge offers a calm spot to recharge.") },
    ]);
    const r = await askOn("What should I do?", m);
    assert.deepEqual(toolResults(m.seen[1]).map((x: any) => [x.ok, x.reason]), [[false, "layover_recommendations_unreadable"], [false, "layover_plan_stops_unreadable"]]);
    assert.deepEqual(r.body.toolsConsulted, []);
    assert.match(r.body.answer, YES_LEAD);
  });

  it("the comparison is the server's certified fit of the persisted card, not the model's claim", async () => {
    stageOn();
    const m = scriptedModel([{ content: replyJson("", [{ planRef: "rec:r-1", why: "A tasty pick." }, { planRef: "rec:made-up", why: "A lovely choice." }]) }]);
    const r = await askOn("Compare my options", m);
    assert.deepEqual(r.body.planComparison.map((l: any) => [l.planRef, l.available, l.status]), [["rec:r-1", false, "not certified: nobody has measured how long it takes"]]);
    assert.match(r.body.answer, /Comparing your options: Night market dumplings — not certified: nobody has measured how long it takes\./);
  });

  it("an invented tool and unparseable arguments are refused by name; an endless tool loop is bounded; neither is a 500", async () => {
    stageOn();
    const m1 = scriptedModel([{ tool_calls: [call("c1", "bookMeAFlight", {}), call("c2", "getTimeWallet", "{not json")] }, { content: replyJson("The lounge offers a calm spot to recharge.") }]);
    await askOn("Anything?", m1);
    assert.deepEqual(toolResults(m1.seen[1]).map((x: any) => x.reason), ["unknown_tool:bookMeAFlight", "malformed_tool_arguments"]);
    stageOn();
    const m2 = scriptedModel([{ tool_calls: [call("c1", "getTimeWallet", { sessionId: SESSION_ID })] }]);
    const r2 = await askOn("Plan my layover", m2);
    assert.equal(m2.seen.length, 5, "four tool rounds, then one forced tool-less round");
    assert.match(r2.body.answer, YES_LEAD);
    assert.equal(r2.body.assistant.status, "fallback");
  });

  it("CL-02: on a not-yes layover, prose claiming entry and urging the traveller out is withdrawn and REPORTED; the certified text is the whole answer", async () => {
    stageOn({ entry: "unverified" });
    const m = scriptedModel([{ content: replyJson("You won't need a visa, so head into the city. The cathedral is a short cab away.") }]);
    const r = await askOn("Can I leave the airport?", m);
    assert.equal(r.body.certification.verdict, "no");
    assert.match(r.body.answer, /^Leaving the airport is not recommended on this layover/);
    assert.doesNotMatch(r.body.answer, /visa|cathedral|head into/i);
    assert.ok(r.body.boundaryViolations.some((v: any) => v.kind === "entry_status_asserted"));
    assert.ok(r.body.boundaryViolations.some((v: any) => v.kind === "risk_band_widened"));
    assert.equal(r.body.assistant.fallbackReason, "boundary_violation");
    assert.equal(r.body.modelProse.mode, "certified_only");
  });

  it("CL-02: on the explicit yes, a later deadline in words and a wider window are withdrawn and reported", async () => {
    stageOn();
    const m = scriptedModel([{ content: replyJson("No rush — be back by quarter to midnight, you have the whole evening.") }]);
    const r = await askOn("When do I need to be back?", m);
    assert.match(r.body.answer, YES_LEAD);
    assert.doesNotMatch(r.body.answer, /quarter to|whole evening|No rush/);
    assert.ok(r.body.boundaryViolations.length > 0);
  });

  it("fail closed: a model outage is a 200 with the certified answer and the reason", async () => {
    stageOn();
    _setTestOpenAI({ chat: { completions: { create: async () => { throw new Error("upstream 503"); } } } } as any);
    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "What should I do?" });
    assert.equal(r.status, 200);
    assert.match(r.body.answer, YES_LEAD);
    assert.deepEqual([r.body.assistant.status, r.body.assistant.fallbackReason], ["fallback", "model_error"]);
  });

  it("the compass_question_asked event records the assistant's status and the tools it consulted", async () => {
    const { tables } = stageOn();
    await askOn("What now?", scriptedModel([{ tool_calls: [call("c1", "explainDecision", { sessionId: SESSION_ID, snapshotId: null, recommendationId: null })] }, { content: replyJson("The lounge offers a calm spot to recharge.") }]));
    const e = tables.layover_events.find((x: any) => x.event_type === "compass_question_asked");
    assert.deepEqual([e.metadata.assistant, e.metadata.assistantFallback, e.metadata.toolsConsulted, e.metadata.modelConsulted], ["answered", null, ["explainDecision"], true]);
  });

  it("the crew roster is read only when the model asks for it (least data touched)", async () => {
    const { reads } = stageOn();
    await askOn("What now?", scriptedModel([{ content: replyJson("The lounge offers a calm spot to recharge.") }]));
    assert.equal(reads.layover_crews ?? 0, 0);
    assert.equal(reads.layover_crew_members ?? 0, 0);
    assert.equal(reads.layover_checkpoints ?? 0, 0);
  });

  it("flag OFF again: the same request asks no model (the seed's posture)", async () => {
    stage();
    const m = scriptedModel([{ content: replyJson("The lounge offers a calm spot to recharge.") }]);
    const r = await ask("What should I do here?", m);
    assert.deepEqual(r.body.assistant, { enabled: false, status: "off", fallbackReason: null, model: null });
    assert.deepEqual(r.body.planComparison, []);
  });
});
