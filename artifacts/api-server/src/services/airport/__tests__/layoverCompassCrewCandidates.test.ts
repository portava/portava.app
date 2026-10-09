/**
 * census-layover L110 / L131 — `getCrewCandidates(sessionId)`, the §12 Compass
 * tool that answers "who could I go and meet here?".
 *
 * ── THE DEFECT, STATED BEFORE IT IS FIXED ────────────────────────────────────
 * At `0fa752ece` the tool answered `unavailable: "no_crew_storage"` — every
 * time, for every traveller. That reason was true when the tool was written
 * (census L28: no crew tables). It stopped being true when 2984 created
 * `layover_crews` / `layover_crew_members` and the crew card started reading
 * them, so a traveller asking Compass about crews was told the feature does not
 * exist while the card beneath it listed two crews meeting in the food court.
 * An unavailable tool is a first-class answer (`runLayoverTool`'s doc comment);
 * a FALSE unavailable reason is a fabricated one.
 *
 * ── WHAT IT MUST NOT BECOME ──────────────────────────────────────────────────
 * The answer is a roster of other people's crews, so it carries the same rules
 * as `GET /:id/crew` (census-layover §48, `LayoverCrewVisibility.ts`):
 *   - a crew with a member in a block relation with the asker is not offered —
 *     the model must not be able to say what the card may not show;
 *   - an unreadable block list, member list or crew list is a REFUSAL with a
 *     reason, never the unfiltered list and never a fabricated empty city;
 *   - no other traveller's user id reaches the model. Crews are offered by
 *     title, meeting point and size, which is what the card shows.
 *
 * `runLayoverTool` still reads no database: the route reads the candidates once
 * and hands the read OUTCOME to the tool context, exactly as it does for
 * recommendations and plan stops.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/airport/__tests__/layoverCompassCrewCandidates.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
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

const TOKEN_B = "cc-token-b";
const USER_A = "cc-user-a";
const USER_B = "cc-user-b";
const USER_C = "cc-user-c";
const SESSION_A = "cc-session-a";
const SESSION_B = "cc-session-b";
const SESSION_C = "cc-session-c";
const HOUR = 3_600_000;

function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: { authorization: `Bearer ${TOKEN_B}`, "content-type": "application/json",
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

/**
 * B asks Compass. Two open crews meet in Taoyuan: "Ramen" (founded by A, A in
 * it) and "Tea" (founded by C, C in it). `bInCrew` puts B in "Ramen" instead.
 */
function stage(opts: {
  bStatus?: string;
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  failures?: Record<string, { message: string }>;
  bInCrew?: boolean;
  airportCity?: string;
  failCrewRoster?: boolean;
} = {}) {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const crew = (id: string, owner: string, session: string, title: string, point: string) => ({
    id, city: "taoyuan", airport_ref: "TPE", created_by: owner, created_session_id: session,
    title, meeting_point_label: point, status: "open", max_members: 6,
    expires_at: iso(now + 8 * HOUR), created_at: iso(now - 60_000), updated_at: iso(now - 60_000),
  });
  const member = (crewId: string, userId: string, sessionId: string, role: "owner" | "member") => ({
    crew_id: crewId, user_id: userId, session_id: sessionId, role, joined_at: iso(now - 60_000), left_at: null,
  });
  const members = [
    member("crew-ramen", USER_A, SESSION_A, "owner"),
    member("crew-tea", USER_C, SESSION_C, "owner"),
    ...(opts.bInCrew ? [member("crew-ramen", USER_B, SESSION_B, "member")] : []),
  ];
  const db: any = makeLayoverDb(
    {
      feature_flags: [
        { flag: "airport_mode_enabled", enabled: true },
        { flag: "layover_compass_enabled", enabled: true },
        // LEAD RULING L3-FC-3: the model — and so any tool it calls — is
        // reached only when B's certified verdict is an explicit `yes`. B holds
        // a US passport on a curated visa-free corridor into Taiwan, so it is.
        { flag: ENTRY_FLAG, enabled: true },
      ],
      traveler_passports: [{ user_id: USER_B, issuing_country: "US", is_primary: true, created_at: "2026-01-01T00:00:00.000Z" }],
      entry_requirements: [{
        id: "corr-visa_free", passport_country: "US", destination_country: "TW", status: "visa_free",
        allowed_stay_days: null, passport_validity_rule: null, fee_text: null, processing_time_text: null,
        official_source_url: null, notes: null, confidence: "high", last_verified_at: "2026-09-01T00:00:00.000Z",
      }],
      airport_profiles: [airportRow(opts.airportCity !== undefined ? { city: opts.airportCity } : {})],
      layover_sessions: [
        sessionRow({ id: SESSION_A, user_id: USER_A, departure_time: iso(now + 9 * HOUR) }),
        // L-CL02a (2026-10-08): on a LIVE layover no model is called, the explicit
        // yes included, so the crew TOOL runs only on an ENDED session. B's is
        // `completed` unless a case asks for it live (`bStatus`).
        sessionRow({
          id: SESSION_B, user_id: USER_B, status: opts.bStatus ?? "completed", wants_to_leave: true,
          arrival_time: iso(now - HOUR), departure_time: iso(now + 8 * HOUR), boarding_time: null,
        }),
        sessionRow({ id: SESSION_C, user_id: USER_C, departure_time: iso(now + 7 * HOUR) }),
      ],
      layover_crews: [
        crew("crew-ramen", USER_A, SESSION_A, "Ramen in the old town", "Terminal 2 food court"),
        crew("crew-tea", USER_C, SESSION_C, "Tea house walk", "Arrivals hall pillar 4"),
      ],
      layover_crew_members: members,
      layover_recommendations: [], layover_plan_stops: [], layover_events: [], trip_plan_items: [],
      blocks: opts.blocks ?? [], profiles: [], location_preferences: [], trips: [],
    },
    { users: { [TOKEN_B]: USER_B }, failures: opts.failures ?? {} },
  );
  _setTestClient(opts.failCrewRoster ? failingCrewRoster(db) : db, true);
}

/**
 * The fake fails reads per `table:op`, and BOTH "which crew am I in" and "who
 * is in this crew" select from `layover_crew_members`. This wrapper fails only
 * the second — the roster read keyed on `crew_id` — so the in-crew branch's own
 * refusal is exercised separately from the membership read's.
 */
function failingCrewRoster(db: any) {
  const failing: any = new Proxy({}, {
    get: (_t, k) => (k === "then"
      ? (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: "relation unavailable" } })
      : () => failing),
  });
  const wrapped = Object.create(db);
  wrapped.from = (table: string) => {
    const builder = db.from(table);
    if (table !== "layover_crew_members") return builder;
    const eq = builder.eq.bind(builder);
    builder.eq = (col: string, v: unknown) => (col === "crew_id" ? failing : eq(col, v));
    return builder;
  };
  return wrapped;
}

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

/** Ask Compass with a model that calls getCrewCandidates once; return what the tool fed back. */
async function askForCrews(): Promise<{ status: number; body: any; tool: any; raw: string }> {
  const m = scriptedModel([
    { tool_calls: [{ id: "c1", type: "function", function: { name: "getCrewCandidates", arguments: JSON.stringify({ sessionId: SESSION_B }) } }] },
    { content: "Stay inside the terminal for now." },
  ]);
  _setTestOpenAI(m.client);
  const r = await post(`/api/airport/sessions/${SESSION_B}/compass`, { question: "Is anyone meeting up here?" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(m.seen.length, 2, "the loop must go back to the model with the tool result");
  const msg = m.seen[1].messages.find((x: any) => x.role === "tool");
  assert.ok(msg, "no tool message was fed back");
  return { ...r, tool: JSON.parse(msg.content), raw: msg.content };
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
afterEach(() => { _setTestOpenAI(null); });

describe("L110 — getCrewCandidates answers from the crew store, not 'no_crew_storage'", () => {
  it("1. the open crews in the traveller's city reach the model, by title and meeting point", async () => {
    stage();
    const r = await askForCrews();
    assert.equal(r.tool.ok, true, `the tool must answer: ${r.raw}`);
    assert.equal(r.tool.data.inCrew, false);
    assert.equal(r.tool.data.city, "Taoyuan");
    assert.deepEqual(
      r.tool.data.candidates.map((c: any) => [c.title, c.meetingPointLabel]).sort(),
      [["Ramen in the old town", "Terminal 2 food court"], ["Tea house walk", "Arrivals hall pillar 4"]],
    );
    assert.deepEqual(r.body.toolsConsulted, ["getCrewCandidates"]);
  });

  it("2. no other traveller's user id reaches the model", async () => {
    stage();
    const r = await askForCrews();
    assert.equal(r.tool.ok, true, r.raw);
    for (const id of [USER_A, USER_C, SESSION_A, SESSION_C]) {
      assert.ok(!r.raw.includes(id), `the tool result leaked ${id}: ${r.raw}`);
    }
  });

  it("3. the traveller's own crew is answered as THEIR crew, with its size and no member ids", async () => {
    stage({ bInCrew: true });
    const r = await askForCrews();
    assert.equal(r.tool.ok, true, r.raw);
    assert.equal(r.tool.data.inCrew, true);
    assert.equal(r.tool.data.crew.title, "Ramen in the old town");
    // L-CL02a: the tool runs only on an ENDED session, which is off the §15
    // return ladder, so the own crew's meeting point is withheld here (and on a
    // live session no model is asked at all — the L-CL02a block below).
    assert.equal(r.tool.data.crew.meetingPointLabel, null);
    assert.ok(r.tool.data.crew.meetingPointWithheld.includes("safety_gate_not_cleared"), r.raw);
    assert.equal(r.tool.data.crew.memberCount, 2);
    assert.equal(r.tool.data.crew.youAreOwner, false);
    assert.deepEqual(r.tool.data.candidates, []);
    assert.ok(!r.raw.includes(USER_A), `the tool result leaked a crewmate's id: ${r.raw}`);
  });

  it("4. an airport with no known city is an empty answer that SAYS why", async () => {
    stage({ airportCity: "Unknown" });
    const r = await askForCrews();
    assert.equal(r.tool.ok, true, r.raw);
    assert.deepEqual(r.tool.data.candidates, []);
    assert.equal(r.tool.data.reason, "city_unknown");
  });
});

describe("L110 / §48 — the model cannot offer what the card may not show", () => {
  it("5. a crew with a member B blocked is not offered; the other crew still is", async () => {
    stage({ blocks: [{ blocker_id: USER_B, blocked_id: USER_A }] });
    const r = await askForCrews();
    assert.equal(r.tool.ok, true, r.raw);
    assert.deepEqual(r.tool.data.candidates.map((c: any) => c.title), ["Tea house walk"]);
    assert.ok(!r.raw.includes("Terminal 2 food court"), `the blocked crew's meeting point reached the model: ${r.raw}`);
  });

  it("6. a crew whose member blocked B is not offered either (a block is symmetric)", async () => {
    stage({ blocks: [{ blocker_id: USER_C, blocked_id: USER_B }] });
    const r = await askForCrews();
    assert.equal(r.tool.ok, true, r.raw);
    assert.deepEqual(r.tool.data.candidates.map((c: any) => c.title), ["Ramen in the old town"]);
  });

  it("7. an unreadable block list is a REFUSAL — not the unfiltered list, not an empty city", async () => {
    stage({ failures: { "blocks:select": { message: "relation unavailable" } } });
    const r = await askForCrews();
    assert.equal(r.tool.ok, false, r.raw);
    assert.equal(r.tool.unavailable, true);
    assert.equal(r.tool.reason, "layover_crew_unreadable");
    assert.ok(!r.raw.includes("Ramen") && !r.raw.includes("Tea house"), `a crew reached the model unchecked: ${r.raw}`);
    assert.deepEqual(r.body.toolsConsulted, [], "a refusal is not a source the answer rests on");
  });

  it("8. an unreadable membership read is a refusal, not 'you are in no crew'", async () => {
    stage({ failures: { "layover_crew_members:select": { message: "relation unavailable" } } });
    const r = await askForCrews();
    assert.equal(r.tool.ok, false, r.raw);
    assert.equal(r.tool.reason, "layover_crew_unreadable");
  });

  it("8b. inside a crew, an unreadable roster is a refusal — not a crew of zero", async () => {
    stage({ bInCrew: true, failCrewRoster: true });
    const r = await askForCrews();
    assert.equal(r.tool.ok, false, r.raw);
    assert.equal(r.tool.reason, "layover_crew_unreadable");
  });

  it("8c. CONTROL for 8b: the wrapper leaves the membership read alone", async () => {
    stage({ bInCrew: false, failCrewRoster: true });
    const r = await askForCrews();
    assert.equal(r.tool.ok, true, r.raw);
    assert.equal(r.tool.data.inCrew, false);
  });

  it("9. an unreadable crew list is a refusal, not an empty city", async () => {
    stage({ failures: { "layover_crews:select": { message: "relation unavailable" } } });
    const r = await askForCrews();
    assert.equal(r.tool.ok, false, r.raw);
    assert.equal(r.tool.reason, "layover_crew_unreadable");
  });

  it("10. a crew-read failure does not take the Compass answer down", async () => {
    stage({ failures: { "layover_crews:select": { message: "relation unavailable" } } });
    const r = await askForCrews();
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.answer, "string");
    assert.ok(r.body.hardReturnTime, "the certified deadline is still answered");
  });
});

describe("L-CL02a — on B's LIVE layover no model is asked, so no crew reaches one", () => {
  for (const bStatus of ["active", "returning"]) {
    it(`status ${bStatus}: 0 completions, no tool, no crew title or meeting point in the answer`, async () => {
      stage({ bStatus });
      let calls = 0;
      _setTestOpenAI({ chat: { completions: { create: async () => { calls += 1; return { choices: [{ message: { role: "assistant", content: "Join the ramen crew at the Terminal 2 food court." } }] }; } } } } as any);
      const r = await post(`/api/airport/sessions/${SESSION_B}/compass`, { question: "Is anyone meeting up here?" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(calls, 0);
      assert.equal(r.body.modelConsulted, false);
      assert.deepEqual(r.body.toolsConsulted, []);
      assert.ok(!/ramen|Tea house|food court|pillar/i.test(r.body.answer), r.body.answer);
    });
  }
});
