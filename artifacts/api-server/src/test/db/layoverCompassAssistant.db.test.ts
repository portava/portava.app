/**
 * Layover 165 lane B1-C — the Layover Compass assistant (census-layover L100,
 * L102–L113, L268; census-compass CL-02), PRESSED, against the real migrated
 * schema (pressedLayoverDb: the baseline + every file in src/migrations,
 * replayed; the routes behind the real supabase-js client).
 *
 * THE PRESS: 3846 (seeds `layover_compass_assistant_enabled` FALSE), then that
 * flag ON, over production's flag snapshot (`productionBaseFlags`).
 *
 * NO REAL MODEL: a scripted double through `_setTestOpenAI` calls the twelve §12
 * tools and writes the prose each case needs. What this file proves that the
 * fake-table suites cannot: every tool's read (layover_recommendations,
 * layover_plan_stops, the crew tables, the disruption ledger in layover_events,
 * the OpportunityEvents in notifications, the decision ledger gate) works
 * against the REAL columns and constraints, a proactive OpportunityEvent written
 * by the REAL replan path reaches the model through getConnectionState, and the
 * route's event row with the assistant's status satisfies layover_events' CHECKs.
 *
 * Falsified by B1P_ARM=flag-off and B1P_ARM=absent (A1–A5 go red: the assistant
 * never runs; A0 reports the seed or its absence).
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverCompassAssistant.db.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, seedConfirmedCorridor, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
import { _setTestOpenAI } from "../../lib/openai.js";
import { _resetRateLimit } from "../../lib/rateLimit.js";
import { LAYOVER_TOOL_NAMES } from "../../services/airport/LayoverCompassAssistant.js";

const FLAG = "layover_compass_assistant_enabled";
const PRESS = { migrations: ["3846"], flags: { [FLAG]: true } } as const;

let db: PressedDb;
let app: PressedApp;
let seed: boolean | "absent";
let u: PressedUser;
let sid: string;

/** A model double: replays `turns`, records every request. */
function scripted(turns: Array<{ content?: string | null; tool_calls?: unknown[] }>) {
  const seen: any[] = [];
  let i = 0;
  _setTestOpenAI({ chat: { completions: { create: async (req: unknown) => {
    seen.push(JSON.parse(JSON.stringify(req)));
    const t = turns[Math.min(i, turns.length - 1)]!;
    i += 1;
    return { choices: [{ message: { role: "assistant", content: t.content ?? null, tool_calls: t.tool_calls } }] };
  } } } } as never);
  return seen;
}
const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const reply = (r: string) => ({ content: JSON.stringify({ reply: r, compare: [], clarify: null }) });
const toolResults = (req: any) => req.messages.filter((x: any) => x.role === "tool").map((x: any) => JSON.parse(x.content));
const args = (sessionId: string): Record<string, Record<string, unknown>> => ({
  simulatePlan: { sessionId, candidateSet: null },
  requestConstraintClarification: { sessionId, field: null },
  replan: { sessionId, trigger: "flight.departure_delayed", payload: { delayMinutes: 90, newDepartureTime: null, waitMinutes: null, extraMinutes: null, gate: null, condition: null, checkpoint: null } },
  explainDecision: { sessionId, snapshotId: null, recommendationId: null },
});

describe("B1-C the Layover Compass assistant, pressed on the real schema", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    seed = await db.flag(FLAG);
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
    u = await db.seedUser("b1c");
    await seedConfirmedCorridor(db, u.id, "US", "SG");
    sid = (await startSession(app, u, { iata: "SIN", wantsToLeave: true }, { departsInH: 10 })).id;
    // The persisted shortlist the tools read: the card route generates and stores it.
    const recs = await app.call("GET", `/api/airport/sessions/${sid}/recommendations`, u);
    assert.equal(recs.status, 200, recs.raw);
  });
  afterEach(() => { _setTestOpenAI(null); _resetRateLimit(); });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("A0 the press: 3846 seeds the flag FALSE (absent without 3846)", () => {
      assert.equal(seed, PRESS_ARM === "absent" ? "absent" : false);
    });

    it("A1 L102–L113: all twelve tools run against the real tables and answer from the certified record — none fails", async () => {
      const a = args(sid);
      const seen = scripted([
        { tool_calls: LAYOVER_TOOL_NAMES.slice(0, 6).map((n, i) => call(`a${i}`, n, a[n] ?? { sessionId: sid })) },
        { tool_calls: LAYOVER_TOOL_NAMES.slice(6).map((n, i) => call(`b${i}`, n, a[n] ?? { sessionId: sid })) },
        reply("The lounge offers a calm spot to recharge."),
      ]);
      const r = await app.call("POST", `/api/airport/sessions/${sid}/compass`, u, { question: "What should I do with my layover?" });
      assert.equal(r.status, 200, r.raw);
      assert.equal(seen.length, 3, `the model was asked ${seen.length} time(s): ${r.raw.slice(0, 300)}`);
      const results = toolResults(seen[2]); // the final request carries every tool message of the conversation
      assert.deepEqual(results.map((x: any) => [x.tool, x.ok, x.reason ?? null]), LAYOVER_TOOL_NAMES.map((n) => [n, true, null]));
      assert.deepEqual(r.body.toolsConsulted, [...LAYOVER_TOOL_NAMES]);
      const byTool = Object.fromEntries(results.map((x: any) => [x.tool, x.data]));
      assert.equal(byTool.getReturnContract.hardReturnTime, r.body.hardReturnTime, "the deadline the model read is the response's certified one");
      assert.equal(byTool.getSafeEnvelope.hardReturnTime, r.body.hardReturnTime);
      assert.equal(byTool.explainDecision.kind, "current_record");
      assert.equal(byTool.explainDecision.certification.inputHash, r.body.certification.inputHash);
      assert.ok(Array.isArray(byTool.getReachableExperiences.experiences) && byTool.getReachableExperiences.experiences.length > 0, "the persisted shortlist was read");
      assert.equal(byTool.getConnectionState.disruption.status, "known", "the disruption ledger read the real layover_events");
      assert.ok(Array.isArray(byTool.getConnectionState.latestOpportunities), "the notifications read worked on the real columns");
      assert.equal(byTool.replan.preview, true);
      assert.equal(byTool.replan.applied, false);
      assert.equal(byTool.requestConstraintClarification.writes, false);
      assert.doesNotMatch(JSON.stringify(seen), /"(lat|lng|userId|user_id|crewId|placeId)"/, "a coordinate key or an identity reached the model");
      assert.ok(!JSON.stringify(seen).includes(u.id), "the traveller's own user id reached the model");
      assert.match(r.body.answer, /You have about \d+ minutes of usable time\. You can leave the airport/, "the certified text leads");
      assert.match(r.body.answer, /The lounge offers a calm spot to recharge\.$/);
    });

    it("A2 L268: a proactive OpportunityEvent written by the REAL replan path reaches the model through getConnectionState", async () => {
      const s = (await db.query<{ departure_time: string }>(`SELECT departure_time::text FROM public.layover_sessions WHERE id = '${sid}'`))[0]!;
      const later = new Date(Date.parse(s.departure_time) + 3 * 3_600_000).toISOString();
      const edit = await app.call("PATCH", `/api/airport/sessions/${sid}`, u, { departureTime: later });
      assert.equal(edit.status, 200, edit.raw);
      const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notifications WHERE user_id = '${u.id}' AND event_type = 'compass.layover.opportunity' AND action_url = '/airport/sessions/${sid}'`);
      assert.ok(rows[0]!.n >= 1, `the replan wrote no OpportunityEvent notification: ${JSON.stringify(edit.body.replan ?? edit.body).slice(0, 400)}`);
      const seen = scripted([{ tool_calls: [call("c1", "getConnectionState", { sessionId: sid })] }, reply("The lounge offers a calm spot to recharge.")]);
      const r = await app.call("POST", `/api/airport/sessions/${sid}/compass`, u, { question: "Did anything change?" });
      assert.equal(r.status, 200, r.raw);
      const state = toolResults(seen[1])[0];
      assert.equal(state.ok, true);
      assert.ok(state.data.latestOpportunities.length >= 1, JSON.stringify(state.data));
      assert.match(state.data.latestOpportunities[0].title, /Your layover (options changed|window moved)/);
    });

    it("A3 CL-02 on the real stack: prose claiming visa-free entry and a later deadline is withdrawn and reported", async () => {
      scripted([reply("You won't need a visa, and you can be back by 23:59. Take a taxi into town.")]);
      const r = await app.call("POST", `/api/airport/sessions/${sid}/compass`, u, { question: "Can I go into town?" });
      assert.equal(r.status, 200, r.raw);
      assert.doesNotMatch(r.body.answer, /visa|23:59|taxi/i);
      assert.ok(r.body.boundaryViolations.length > 0, r.raw);
      assert.equal(r.body.assistant.fallbackReason, "boundary_violation");
    });

    it("A4 the route's event row records the assistant's status, and satisfies layover_events' real CHECKs", async () => {
      const rows = await db.query<{ m: any }>(`SELECT metadata AS m FROM public.layover_events WHERE session_id = '${sid}' AND event_type = 'compass_question_asked' ORDER BY created_at DESC LIMIT 1`);
      const m = typeof rows[0]!.m === "string" ? JSON.parse(rows[0]!.m) : rows[0]!.m;
      assert.equal(m.assistant, "fallback");
      assert.equal(m.assistantFallback, "boundary_violation");
      assert.equal(m.modelConsulted, true);
    });

    it("A5 fail closed on the real stack: an outage answers the certified text, 200", async () => {
      _setTestOpenAI({ chat: { completions: { create: async () => { throw new Error("upstream 503"); } } } } as never);
      const r = await app.call("POST", `/api/airport/sessions/${sid}/compass`, u, { question: "What now?" });
      assert.equal(r.status, 200, r.raw);
      assert.deepEqual([r.body.assistant.status, r.body.assistant.fallbackReason], ["fallback", "model_error"]);
      assert.match(r.body.answer, /^You have about \d+ minutes of usable time\./);
    });
  });
});
