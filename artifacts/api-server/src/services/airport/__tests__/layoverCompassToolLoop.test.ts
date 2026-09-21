/**
 * census L102–L113 — the twelve §12 Compass tools
 * census L100  — "Compass is an orchestrator and explainer: … compares
 *                 certified plans, personalises wording, **invokes
 *                 deterministic tools**"
 * census L268  — "**Compass** — tool access to certified context; …"
 *
 * ── THE ONE SENTENCE THIS SUITE EXISTS TO FALSIFY ────────────────────────────
 * Every recount of this census since §9 has closed L102–L113 with the same
 * clause, most recently at §10:
 *
 *   > "Twelve §12 tools, reachable from a route that a traveller can now reach
 *   >  — and still **not passed to the model**. The endpoint becoming live does
 *   >  not make the tools live."
 *
 * That was true. `runLayoverTool` had no caller outside `src/test/`, and
 * `LAYOVER_TOOL_SCHEMAS` carried a doc comment saying so in capitals. A tool
 * nothing invokes is a function, not a tool, and twelve requirements were `W`
 * on exactly that distinction.
 *
 * This suite asserts the distinction is gone: the live handler
 * `POST /api/airport/sessions/:id/compass` — the one `LayoverCompassCard`
 * already calls — offers the twelve declarations to the model, executes what
 * the model chooses through `runLayoverTool`, and feeds the results back.
 *
 * ── AND THE THREE WAYS WIRING IT WOULD HAVE MADE THINGS WORSE ────────────────
 * A tool loop is a new way for this surface to speak with false confidence, so
 * three of the cases below are refusals rather than capabilities:
 *
 *  1. `getReachableExperiences` over an UNREADABLE `layover_recommendations`
 *     must answer `unavailable`, not `[]`. An empty list is a measurement —
 *     "there is nothing worth your four hours" — and the route's own reader
 *     already refuses to make that claim from a failed read (census L294).
 *  2. `simulatePlan` over an UNREADABLE `layover_plan_stops` must answer
 *     `unavailable`, not `fitsWindow: true`. Zero stops fit every window, and
 *     "your itinerary fits" computed from a failed read is the one answer this
 *     surface must never guess (census L47, and `loadStops`' own doc comment).
 *  3. A tool name the model invents must be refused by name, and must not throw
 *     — a `TypeError` inside the loop would take the whole answer down and the
 *     traveller would get a 500 for a hallucinated function name.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverCompassToolLoop.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import { _setTestOpenAI } from "../../../lib/openai.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import { LAYOVER_TOOL_NAMES, LAYOVER_TOOL_SCHEMAS } from "../LayoverCompassService.js";

let server: http.Server;
let base: string;
const TOKEN = "compass-tool-token";
const USER_ID = "user-1";
const SESSION_ID = "session-compass";
const HOUR = 3_600_000;

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

function liveSession(over: Record<string, any> = {}) {
  const now = Date.now();
  return sessionRow({
    id: SESSION_ID,
    user_id: USER_ID,
    status: "active",
    arrival_time:   new Date(now - 1 * HOUR).toISOString(),
    departure_time: new Date(now + 8 * HOUR).toISOString(),
    boarding_time:  null,
    wants_to_leave: true,
    ...over,
  });
}

function stage(opts: { failures?: Record<string, { message: string }>; stops?: any[]; recs?: any[] } = {}) {
  _setTestClient(
    makeLayoverDb(
      {
        feature_flags: [
          { flag: "airport_mode_enabled", enabled: true },
          { flag: "layover_compass_enabled", enabled: true },
        ],
        airport_profiles: [airportRow()],
        layover_sessions: [liveSession()],
        layover_recommendations: opts.recs ?? [],
        layover_plan_stops: opts.stops ?? [],
        layover_events: [], trip_plan_items: [],
        blocks: [], profiles: [], location_preferences: [], trips: [],
      },
      { users: { [TOKEN]: USER_ID }, failures: opts.failures ?? {} },
    ),
    true,
  );
}

/**
 * A model double that records every request it is handed and replays a scripted
 * sequence of responses. The recording is the point: the first assertion below
 * is about what the SERVER sent, not about what the model said.
 */
function scriptedModel(turns: Array<{ content?: string; tool_calls?: any[] }>) {
  const seen: any[] = [];
  let i = 0;
  return {
    seen,
    client: {
      chat: {
        completions: {
          create: async (req: any) => {
            seen.push(req);
            const turn = turns[Math.min(i, turns.length - 1)];
            i += 1;
            return { choices: [{ message: { role: "assistant", content: turn.content ?? null, tool_calls: turn.tool_calls } }] };
          },
        },
      },
    } as any,
  };
}

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});

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

// ── 1. The declarations reach the model ──────────────────────────────────────

describe("L102–L113 — the twelve tools are OFFERED on the live compass route", () => {
  it("the request the server sends carries all twelve §12 tool declarations", async () => {
    stage();
    const m = scriptedModel([{ content: "Stay inside the terminal; there is a good food hall past security." }]);
    _setTestOpenAI(m.client);

    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "What should I do here?" });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    assert.ok(m.seen.length >= 1, "the model was not called at all");
    const tools = m.seen[0].tools;
    assert.ok(Array.isArray(tools), `no tool declarations were passed to the model: ${JSON.stringify(Object.keys(m.seen[0]))}`);
    assert.deepEqual(
      tools.map((t: any) => t.function.name).sort(),
      [...LAYOVER_TOOL_NAMES].sort(),
      "the twelve §12 tools must be the ones offered",
    );
    assert.equal(tools.length, LAYOVER_TOOL_SCHEMAS.length);
    // Pinned rather than left to the provider's default. `tool_choice` absent
    // means "auto" on OpenAI today and this request is sent to whatever
    // `AI_INTEGRATIONS_OPENAI_BASE_URL` points at; a gateway whose default is
    // `none` would leave the tools declared and unreachable again, which is the
    // exact state census L102–L113 spent four passes in.
    assert.equal(m.seen[0].tool_choice, "auto");
  });
});

// ── 2. A chosen tool is EXECUTED, and its result is fed back ─────────────────

describe("L102–L113 — a tool the model chooses is run through runLayoverTool", () => {
  it("getReturnContract's certified deadline is handed back as a tool message", async () => {
    stage();
    const m = scriptedModel([
      { tool_calls: [call("c1", "getReturnContract", { sessionId: SESSION_ID })] },
      { content: "Be back at security by the deadline shown on your card." },
    ]);
    _setTestOpenAI(m.client);

    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "When do I need to be back?" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(m.seen.length, 2, "the loop must go back to the model with the tool result");

    const msgs = m.seen[1].messages;
    const toolIdx = msgs.findIndex((x: any) => x.role === "tool");
    assert.ok(toolIdx >= 0, `no tool message was fed back: ${JSON.stringify(msgs.map((x: any) => x.role))}`);
    const toolMsg = msgs[toolIdx];
    assert.equal(toolMsg.tool_call_id, "c1");
    // THE TRANSCRIPT MUST BE WELL-FORMED, not merely carry the answer. The API
    // rejects a `tool` message that does not directly follow an assistant turn
    // declaring that same `tool_call_id`, so a loop that fed results back
    // without replaying the assistant's own call would 400 against a real
    // model while passing every test that only inspects the tool payload.
    const prior = msgs[toolIdx - 1];
    assert.equal(prior?.role, "assistant", `a tool result must follow its assistant turn: ${JSON.stringify(msgs.map((x: any) => x.role))}`);
    assert.deepEqual((prior.tool_calls ?? []).map((c: any) => c.id), ["c1"]);
    const payload = JSON.parse(toolMsg.content);
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.tool, "getReturnContract");
    assert.equal(payload.data.hardReturnTime, r.body.hardReturnTime,
      "the tool must answer the SAME certified deadline the response publishes");

    assert.deepEqual(r.body.toolsConsulted, ["getReturnContract"],
      "the response must record which deterministic tools produced it");
  });
});

// ── 3. The list-shaped tools see the traveller's OWN rows ───────────────────

describe("L106/L107 — the two list tools read this session's real rows", () => {
  it("getReachableExperiences hands back the cards the route read, not an empty list", async () => {
    stage({ recs: [{
      id: "rec-1", session_id: SESSION_ID, rec_type: "landside", title: "Shilin Night Market",
      description: "Street food, twenty minutes out.", safety_rating: "safe",
      travel_time_min: 25, activity_time_min: 60, return_buffer_min: 90,
      hard_return_time: null, warning_reason: null, inside_airport: false,
      location_label: "Shilin", city: "Taipei", neighborhood: null, sort_order: 0,
      place_id: null, plan_item_id: null, status: "active",
    }] });
    const m = scriptedModel([
      { tool_calls: [call("c1", "getReachableExperiences", { sessionId: SESSION_ID })] },
      { content: "The night market is the one to aim for." },
    ]);
    _setTestOpenAI(m.client);

    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "What can I go and see?" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const payload = JSON.parse(m.seen[1].messages.find((x: any) => x.role === "tool").content);
    assert.equal(payload.ok, true, JSON.stringify(payload));
    // The route must hand over what it READ. A handler that passes `[]` on a
    // healthy read leaves every tool answer true-but-empty, and nothing about
    // the response says so.
    assert.equal(payload.data.recommendations.length, 1,
      `the tool must see this session's own cards: ${JSON.stringify(payload.data)}`);
    assert.equal(payload.data.recommendations[0].title, "Shilin Night Market");
  });

  it("simulatePlan measures the stops the traveller actually planned", async () => {
    stage({ stops: [
      { id: "s-1", session_id: SESSION_ID, title: "Night market", stop_order: 0,
        duration_min: 60, travel_min: 25, inside_airport: false, source: "user",
        created_at: "2026-09-14T09:00:00.000Z" },
    ] });
    const m = scriptedModel([
      { tool_calls: [call("c1", "simulatePlan", { sessionId: SESSION_ID })] },
      { content: "That plan fits your window." },
    ]);
    _setTestOpenAI(m.client);

    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "Does my plan fit?" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const payload = JSON.parse(m.seen[1].messages.find((x: any) => x.role === "tool").content);
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.data.neededMin, 110,
      "60 minutes there + 25 out + 25 back — the stored stop, not an empty plan");
    assert.equal(payload.data.unstatedTravelStops, 0);
  });
});

// ── 4. The three refusals ────────────────────────────────────────────────────

describe("L294/L102 — a tool over an unreadable table refuses rather than measuring zero", () => {
  it("getReachableExperiences answers `unavailable`, not an empty list", async () => {
    stage({ failures: { "layover_recommendations:select": { message: "connection reset" } } });
    const m = scriptedModel([
      { tool_calls: [call("c1", "getReachableExperiences", { sessionId: SESSION_ID })] },
      { content: "I could not read your shortlist just now." },
    ]);
    _setTestOpenAI(m.client);

    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "What can I go and see?" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const payload = JSON.parse(m.seen[1].messages.find((x: any) => x.role === "tool").content);
    assert.equal(payload.ok, false,
      `an unreadable recommendation table must not be reported as an empty shortlist: ${JSON.stringify(payload)}`);
    assert.equal(payload.unavailable, true);
    assert.match(String(payload.reason), /recommendation/i);
  });

  it("simulatePlan answers `unavailable`, not `fitsWindow: true`, over an unreadable plan", async () => {
    stage({ failures: { "layover_plan_stops:select": { message: "connection reset" } } });
    const m = scriptedModel([
      { tool_calls: [call("c1", "simulatePlan", { sessionId: SESSION_ID })] },
      { content: "I could not read your plan just now." },
    ]);
    _setTestOpenAI(m.client);

    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "Does my plan fit?" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const payload = JSON.parse(m.seen[1].messages.find((x: any) => x.role === "tool").content);
    assert.equal(payload.ok, false,
      `zero stops fit every window — an unreadable plan must not answer "it fits": ${JSON.stringify(payload)}`);
    assert.equal(payload.unavailable, true);
    assert.match(String(payload.reason), /plan|stop/i);
  });

  it("a candidate set the MODEL supplied is still answerable over an unreadable plan table", async () => {
    // The scope-shrink guard on the refusal above. `simulatePlan` refuses the
    // STORED plan when `layover_plan_stops` is unreadable, because zero rows
    // fit every window. A candidate set the model passed in did not come from
    // that table, so refusing it would take the "what if I did this instead?"
    // question away from every traveller during an outage — a narrower product
    // in the name of a safer one.
    stage({ failures: { "layover_plan_stops:select": { message: "connection reset" } } });
    const m = scriptedModel([
      { tool_calls: [call("c1", "simulatePlan", {
        sessionId: SESSION_ID,
        candidateSet: [{ durationMin: 60, travelMin: 25, insideAirport: false }],
      })] },
      { content: "That one fits." },
    ]);
    _setTestOpenAI(m.client);

    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "What if I did this instead?" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const payload = JSON.parse(m.seen[1].messages.find((x: any) => x.role === "tool").content);
    assert.equal(payload.ok, true, `a model-supplied set is not read from the table: ${JSON.stringify(payload)}`);
    assert.equal(payload.data.neededMin, 110, "60 dwell + 25 out + 25 back");
  });

  it("a tool name the model invented is refused by name and does not 500 the answer", async () => {
    stage();
    const m = scriptedModel([
      { tool_calls: [call("c1", "bookMeATaxi", { sessionId: SESSION_ID })] },
      { content: "I can't book transport, but here is what I can tell you." },
    ]);
    _setTestOpenAI(m.client);

    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "Book me a taxi" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const payload = JSON.parse(m.seen[1].messages.find((x: any) => x.role === "tool").content);
    assert.equal(payload.ok, false);
    assert.equal(payload.unavailable, true);
    assert.match(String(payload.reason), /unknown_tool/);
    assert.ok(!(r.body.toolsConsulted ?? []).includes("bookMeATaxi"),
      "an invented name must not be recorded as a deterministic tool that ran");
  });

  it("tool arguments that are not JSON are refused, not thrown", async () => {
    stage();
    const m = scriptedModel([
      { tool_calls: [{ id: "c1", type: "function", function: { name: "simulatePlan", arguments: "{not json" } }] },
      { content: "Here is what I can tell you." },
    ]);
    _setTestOpenAI(m.client);

    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "Does my plan fit?" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const payload = JSON.parse(m.seen[1].messages.find((x: any) => x.role === "tool").content);
    assert.equal(payload.ok, false);
    assert.match(String(payload.reason), /arguments/i);
  });
});

// ── 5. The loop terminates ───────────────────────────────────────────────────

describe("L102–L113 — a model that never stops calling tools cannot hang the request", () => {
  it("the loop is bounded and the traveller still gets a certified answer", async () => {
    stage();
    const m = scriptedModel([{ tool_calls: [call("c1", "getTimeWallet", { sessionId: SESSION_ID })] }]);
    _setTestOpenAI(m.client);

    const r = await post(`/api/airport/sessions/${SESSION_ID}/compass`, { question: "How long have I got?" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(m.seen.length <= 5, `the tool loop did not terminate: ${m.seen.length} model calls`);
    assert.ok(r.body.answer && String(r.body.answer).length > 0,
      "a model that only ever calls tools must still leave the traveller a certified answer");
    assert.match(String(r.body.answer), /minutes/,
      "the fallback must be the deterministic certified text, not an empty string");
  });
});
