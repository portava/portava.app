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
 * ── RESTATED 2026-10-09 UNDER LEAD RULING L-CL02d ───────────────────────────
 * The Compass tool loop is deleted from the layover door, so `getCrewCandidates`
 * no longer exists there (`compassCrewCandidates`, its crew-service half, stays
 * in LayoverCrewVisibility for the crew card's rules but has no caller on this
 * door). Every world below — open crews, own crew, unknown city, blocks either
 * way, every unreadable read — is kept and now pins the stronger statement: a
 * model that would call the crew tool is never asked, and no crew title,
 * meeting point or other traveller's id reaches the answer.
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
        // B's session is `completed` by status (departure ahead, so LIVE by
        // L-CL02c) unless a case sets `bStatus`; under L-CL02d no status reaches a model.
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

/**
 * Ask Compass with a model that WOULD call getCrewCandidates; assert it is never
 * asked, no tool ran, and nothing about any crew or any other traveller is in
 * the response (L-CL02d).
 */
async function askNoCrews(): Promise<{ status: number; body: any; raw: string }> {
  const m = scriptedModel([
    { tool_calls: [{ id: "c1", type: "function", function: { name: "getCrewCandidates", arguments: JSON.stringify({ sessionId: SESSION_B }) } }] },
    { content: "Join the ramen crew at the Terminal 2 food court." },
  ]);
  _setTestOpenAI(m.client);
  const r = await post(`/api/airport/sessions/${SESSION_B}/compass`, { question: "Is anyone meeting up here?" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(m.seen.length, 0, "a model was asked on the layover door");
  assert.equal(r.body.modelConsulted, false);
  assert.deepEqual(r.body.toolsConsulted, []);
  const raw = JSON.stringify(r.body);
  for (const leak of ["Ramen", "Tea house", "Terminal 2 food court", "Arrivals hall pillar 4", USER_A, USER_C, SESSION_A, SESSION_C]) {
    assert.ok(!raw.includes(leak), `${leak} reached the response: ${raw}`);
  }
  assert.ok(r.body.hardReturnTime, "the certified deadline is still answered");
  return { ...r, raw };
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

describe("L110 (former crew-tool worlds) — whatever the crew store holds or fails to read, no model is asked and no crew is named", () => {
  const worlds: Array<[string, Parameters<typeof stage>[0]]> = [
    ["1. open crews in the traveller's city", {}],
    ["2. other travellers' ids exist in the store", {}],
    ["3. the traveller's own crew", { bInCrew: true }],
    ["4. an airport with no known city", { airportCity: "Unknown" }],
    ["5. a crew with a member B blocked", { blocks: [{ blocker_id: USER_B, blocked_id: USER_A }] }],
    ["6. a crew whose member blocked B", { blocks: [{ blocker_id: USER_C, blocked_id: USER_B }] }],
    ["7. an unreadable block list", { failures: { "blocks:select": { message: "relation unavailable" } } }],
    ["8. an unreadable membership read", { failures: { "layover_crew_members:select": { message: "relation unavailable" } } }],
    ["8b. inside a crew, an unreadable roster", { bInCrew: true, failCrewRoster: true }],
    ["8c. outside a crew, the roster wrapper on", { bInCrew: false, failCrewRoster: true }],
    ["9/10. an unreadable crew list", { failures: { "layover_crews:select": { message: "relation unavailable" } } }],
    ["B live (active)", { bStatus: "active" }],
    ["B live (returning)", { bStatus: "returning" }],
  ];
  for (const [label, opts] of worlds) {
    it(`${label}: 0 completions, no tool, no crew or traveller id in the answer`, async () => {
      stage(opts);
      await askNoCrews();
    });
  }
});
