/**
 * census-layover L138 — the §14.1 "meet here" gate, and the two doors that
 * were offering the meet without it.
 *
 * ── THE DEFECT, STATED BEFORE IT IS FIXED ────────────────────────────────────
 * L138 is *"Traveler pins must not expose an unsafe 'meet here' action without
 * the social/safety gate."* `meetActionAvailability`
 * (`services/airport/LayoverCrewService.ts`) has encoded that rule for several
 * census passes and the census graded the row `C ∅` — **vacuous**, "real
 * refusal, empty path" — because nothing reached it. Read at `f71cfb85f`:
 * `meetActionAvailability` had ZERO callers outside `src/test/`.
 *
 * The path stopped being empty. Two surfaces now offer a traveller a crew to
 * go and physically meet, each carrying the crew's `meeting_point_label` and,
 * on the client, a one-tap Join:
 *
 *   DOOR 1  `GET /api/airport/sessions/:id/crew` — the roster of open crews in
 *           the city, and the traveller's own crew card.
 *   DOOR 2  the §12 Compass tool `getCrewCandidates` — the same answer, handed
 *           to the MODEL, which puts it in a sentence.
 *
 * Both asked the block list and NOTHING else: one of the guard's six clauses.
 * The missing clause that bites is the SAFETY gate. The sibling
 * people-discovery surface on the same screen, `GET /:id/buddies`, refuses with
 * `reason: "safety_gate_not_passed"` for precisely this (census L273,
 * `LayoverBuddyGate`) — and the crew surface consulted it nowhere. A traveller
 * whose certified verdict is `stay_airside`, or who is already on the §15
 * escalation ladder, was handed a list of landside crews to go and join BY THE
 * SAME SERVER that had computed that verdict for that session.
 *
 * ── WHAT THIS SUITE PROVES, AND WHY NONE OF IT IS VACUOUS ───────────────────
 * Per WIRED clause: a viewer who fails it does NOT receive the meeting-point
 * label, THROUGH BOTH DOORS — a guard on one door is not a guard. Every
 * negative has a CONTROL beside it in which the same fixture, with only that
 * one input changed, DOES receive the label, so no assertion can pass because
 * the surface is broken or the fixture is empty.
 *
 * The HTTP assertions name exact statuses and exact field values, never
 * `status !== 500`; `req.log` is installed because the real server installs
 * one, so a handler throw cannot masquerade as a considered refusal.
 *
 * Every failed-read case is staged through `fakeLayoverDb`'s failure
 * injection, which RESOLVES `{ data: null, error }` the way supabase-js does.
 * That is the point: `try/catch` would not see these, and `data ?? []` turns
 * "we could not check" into "there is nothing to stop us".
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/layover/__tests__/layoverCrewMeetGate.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _setTestClient } from "../../../lib/http.js";
import { _setTestOpenAI } from "../../../lib/openai.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import { ENTRY_FLAG } from "../../../lib/entryRequirements.js";
import {
  CREW_MEET_DENIALS_NOT_ENFORCED,
  crewMeetDecision,
  crewMeetingPointFor,
  type CrewMeetFacts,
} from "../LayoverCrewVisibility.js";
import { meetActionAvailability, type MeetActionDenial } from "../../airport/LayoverCrewService.js";

const HERE = dirname(fileURLToPath(import.meta.url));

let server: http.Server;
let base: string;

const TOKEN_V = "meet-token-v";
const USER_V = "meet-user-v"; // the viewer, every request below is theirs
const USER_M = "meet-user-m"; // a crewmate
const USER_O = "meet-user-o"; // the founder of a crew the viewer is NOT in
const SESSION_V = "meet-session-v";
const SESSION_M = "meet-session-m";
const SESSION_O = "meet-session-o";
const CREW_MINE = "meet-crew-mine";
const CREW_OPEN = "meet-crew-open";
const POINT_MINE = "Terminal 2 food court";
const POINT_OPEN = "Arrivals hall pillar 4";
const HOUR = 3_600_000;

type Reply = { status: number; body: any };

function request(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method,
        headers: {
          authorization: `Bearer ${TOKEN_V}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
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

/** A session state, expressed in the only two inputs that decide the gate. */
type Clock =
  /** Hours of slack: verdict clears, `returnState` NORMAL. */
  | "clear"
  /** The traveller's own answer: `wants_to_leave = false` → verdict `stay_airside`. */
  | "stay_airside"
  /** Departure within the hour: past the hard return, so RETURN_NOW / CONNECTION_AT_RISK. */
  | "escalated";

function sessionFor(id: string, userId: string, clock: Clock, now: number): Record<string, any> {
  const iso = (ms: number) => new Date(ms).toISOString();
  if (clock === "stay_airside") {
    return sessionRow({ id, user_id: userId, wants_to_leave: false, arrival_time: iso(now - HOUR), departure_time: iso(now + 8 * HOUR) });
  }
  if (clock === "escalated") {
    return sessionRow({ id, user_id: userId, arrival_time: iso(now - 2 * HOUR), departure_time: iso(now + HOUR) });
  }
  return sessionRow({ id, user_id: userId, arrival_time: iso(now - HOUR), departure_time: iso(now + 9 * HOUR) });
}

/**
 * The viewer V is on a layover in Taoyuan. O owns `CREW_OPEN` (V is not in it)
 * and M owns `CREW_MINE`. `inCrew` puts V into `CREW_MINE` beside M, which is
 * the MEMBER scope; leaving it out is the OFFER scope, where `CREW_OPEN` is
 * what discovery has to decide about.
 */
function stage(opts: {
  inCrew?: boolean;
  viewer?: Clock;
  mate?: Clock;
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  failures?: Record<string, { message: string; code?: string }>;
  failSessionBatch?: boolean;
  /**
   * The crewmate's layover row is GONE — ended, expired or deleted. The
   * membership row survives it (2984 cascades on the session, but a read can
   * race a delete, and `crewSolverMembers` is written for exactly this), so the
   * crew has one member nobody can place on the §15 ladder.
   */
  mateSessionMissing?: boolean;
  /**
   * Puts the VIEWER'S membership row first in `layover_crew_members`.
   *
   * Row order in that table is arbitrary, and a "worst member state" that is
   * really "the first member's state" agrees with the truth exactly when the
   * escalated member happens to be read first. Both orders are staged so that
   * agreement cannot be the reason a test passes.
   */
  viewerFirst?: boolean;
} = {}) {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const crew = (id: string, owner: string, ownerSession: string, title: string, point: string) => ({
    id, city: "taoyuan", airport_ref: "TPE", created_by: owner, created_session_id: ownerSession,
    title, meeting_point_label: point, status: "open", max_members: 6,
    expires_at: iso(now + 8 * HOUR), created_at: iso(now - 60_000), updated_at: iso(now - 60_000),
  });
  const member = (crewId: string, userId: string, sessionId: string, role: "owner" | "member") => ({
    crew_id: crewId, user_id: userId, session_id: sessionId, role, joined_at: iso(now - 60_000), left_at: null,
  });
  const db: any = makeLayoverDb(
    {
      feature_flags: [
        { flag: "airport_mode_enabled", enabled: true },
        { flag: "layover_compass_enabled", enabled: true },
        // LEAD RULING L3-FC-3 (2026-10-07): door 2 reaches the MODEL only when
        // the viewer's certified verdict is an explicit `yes`. V holds a US
        // passport on a curated visa-free corridor into Taiwan, so a "clear" V
        // certifies `yes` and the tool cases below still run through the model.
        { flag: ENTRY_FLAG, enabled: true },
      ],
      traveler_passports: [{ user_id: USER_V, issuing_country: "US", is_primary: true, created_at: "2026-01-01T00:00:00.000Z" }],
      entry_requirements: [{
        id: "corr-visa_free", passport_country: "US", destination_country: "TW", status: "visa_free",
        allowed_stay_days: null, passport_validity_rule: null, fee_text: null, processing_time_text: null,
        official_source_url: null, notes: null, confidence: "high", last_verified_at: "2026-09-01T00:00:00.000Z",
      }],
      airport_profiles: [airportRow()],
      layover_sessions: [
        sessionFor(SESSION_V, USER_V, opts.viewer ?? "clear", now),
        ...(opts.mateSessionMissing ? [] : [sessionFor(SESSION_M, USER_M, opts.mate ?? "clear", now)]),
        sessionFor(SESSION_O, USER_O, "clear", now),
      ],
      layover_crews: [
        crew(CREW_MINE, USER_M, SESSION_M, "Ramen in the old town", POINT_MINE),
        crew(CREW_OPEN, USER_O, SESSION_O, "Tea house walk", POINT_OPEN),
      ],
      layover_crew_members: [
        ...(opts.inCrew && opts.viewerFirst ? [member(CREW_MINE, USER_V, SESSION_V, "member")] : []),
        member(CREW_MINE, USER_M, SESSION_M, "owner"),
        member(CREW_OPEN, USER_O, SESSION_O, "owner"),
        ...(opts.inCrew && !opts.viewerFirst ? [member(CREW_MINE, USER_V, SESSION_V, "member")] : []),
      ],
      blocks: opts.blocks ?? [],
      profiles: [
        { id: USER_M, handle: "mate", name: "Mate", avatar_url: null },
        { id: USER_O, handle: "owner", name: "Owner", avatar_url: null },
      ],
      location_preferences: [], layover_recommendations: [], layover_plan_stops: [],
      layover_events: [], trip_plan_items: [], trips: [],
    },
    { users: { [TOKEN_V]: USER_V }, failures: opts.failures ?? {} },
  );
  _setTestClient(opts.failSessionBatch ? failingSessionBatch(db) : db, true);
}

/**
 * The fake fails reads per `table:op`, and `layover_sessions:select` would also
 * fail the OWNED-SESSION read that every handler starts with — a 404 proves
 * nothing about the meet gate. This wrapper fails only the BATCH read
 * (`readSessionsByIds`, which filters with `.in("id", …)`), leaving the owner's
 * own `.eq("id", …)` read working.
 */
function failingSessionBatch(db: any) {
  const failing: any = new Proxy({}, {
    get: (_t, k) => (k === "then"
      ? (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: "relation unavailable" } })
      : () => failing),
  });
  const wrapped = Object.create(db);
  wrapped.from = (table: string) => {
    const builder = db.from(table);
    if (table !== "layover_sessions") return builder;
    const inFn = builder.in.bind(builder);
    builder.in = (col: string, v: unknown) => (col === "id" ? failing : inFn(col, v));
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
      chat: { completions: { create: async (req: any) => {
        seen.push(req);
        const turn = turns[Math.min(i, turns.length - 1)];
        i += 1;
        return { choices: [{ message: { role: "assistant", content: turn.content ?? null, tool_calls: turn.tool_calls } }] };
      } } },
    } as any,
  };
}

/** DOOR 1. */
const crewDoor = () => request("GET", `/api/airport/sessions/${SESSION_V}/crew`);

/** DOOR 2 — what the tool actually fed back to the model, parsed. */
async function compassDoor(): Promise<{ tool: any; raw: string }> {
  const m = scriptedModel([
    { tool_calls: [{ id: "c1", type: "function", function: { name: "getCrewCandidates", arguments: JSON.stringify({ sessionId: SESSION_V }) } }] },
    { content: "Stay inside the terminal for now." },
  ]);
  _setTestOpenAI(m.client);
  const r = await request("POST", `/api/airport/sessions/${SESSION_V}/compass`, { question: "Is anyone meeting up here?" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(m.seen.length, 2, "the tool loop must go back to the model with the result");
  const msg = m.seen[1].messages.find((x: any) => x.role === "tool");
  assert.ok(msg, "no tool message was fed back");
  return { tool: JSON.parse(msg.content), raw: msg.content };
}

/**
 * DOOR 2 for a viewer whose certified verdict is NOT an explicit yes
 * (`stay_airside`, or on the §15 ladder). Under lead ruling L3-FC-3 the route
 * answers with certified text and calls no model, so no tool runs and the crew
 * answer is never handed to anything that could put it in a sentence. This is
 * asserted, not assumed: a counting model, zero calls, and the label nowhere in
 * what the traveller receives.
 */
async function compassDoorWithoutModel(): Promise<{ status: number; body: any }> {
  const m = scriptedModel([
    { tool_calls: [{ id: "c1", type: "function", function: { name: "getCrewCandidates", arguments: JSON.stringify({ sessionId: SESSION_V }) } }] },
    { content: "Meet the crew at the food court." },
  ]);
  _setTestOpenAI(m.client);
  const r = await request("POST", `/api/airport/sessions/${SESSION_V}/compass`, { question: "Is anyone meeting up here?" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.certification?.verdict, "yes", "fixture: this viewer must not certify an explicit yes");
  assert.equal(m.seen.length, 0, "L3-FC-3: below an explicit yes the model — and so the crew tool — is never reached");
  assert.equal(r.body.modelConsulted, false);
  assert.deepEqual(r.body.toolsConsulted, []);
  return r;
}

/**
 * The strongest form of "did not receive the label": the string is nowhere in
 * the serialised answer. A field-by-field check can miss a second copy; this
 * cannot.
 */
function assertNoPoint(serialised: string, point: string, what: string) {
  assert.ok(!serialised.includes(point), `${what}: the meeting point "${point}" reached the viewer — ${serialised}`);
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

// ═══════════════════════════════════════════════════════════════════════════
// 0. The guard is wired, and WHICH of its clauses this surface stands behind
//    is a declaration rather than an inline `if`
// ═══════════════════════════════════════════════════════════════════════════

describe("L138 — the clauses this affordance enforces are declared, not implied", () => {
  it("the UNENFORCED set is exactly the four argued clauses, per scope", () => {
    // A clause quietly added here is a clause quietly switched off. Changing
    // either row is a deliberate act and this assertion is where it shows up.
    assert.deepEqual([...CREW_MEET_DENIALS_NOT_ENFORCED.member].sort(), ["meeting_point_not_public", "not_mutual"]);
    assert.deepEqual(
      [...CREW_MEET_DENIALS_NOT_ENFORCED.offer].sort(),
      ["meeting_point_not_public", "no_crew", "not_mutual", "return_state_escalated"],
    );
  });

  it("every unenforced name is a denial the guard can actually produce", () => {
    // Non-vacuity: a typo in the list would silently enforce the clause it
    // meant to exempt, or exempt nothing at all.
    const all = meetActionAvailability({
      blocked: true, mutualConnection: false, sameCrewId: null,
      meetingPointIsPublicVenue: false, safetyGateCleared: false,
      viewerReturnState: null, targetReturnState: null,
    }).denials;
    assert.equal(all.length, 6, "the guard no longer returns all six failures at once");
    for (const scope of ["member", "offer"] as const) {
      for (const d of CREW_MEET_DENIALS_NOT_ENFORCED[scope]) {
        assert.ok(all.includes(d), `${scope}: "${d}" is not a denial meetActionAvailability returns`);
      }
    }
  });

  it("MEMBER scope enforces blocked, the safety gate and BOTH sides of the return state", () => {
    const all = crewMeetDecision(
      { blocked: true, sameCrewId: null, safetyGateCleared: false, viewerReturnState: null, crewReturnState: null },
      "member",
    );
    assert.deepEqual(all.withheld.sort(), ["blocked", "no_crew", "return_state_escalated", "safety_gate_not_cleared"]);
    assert.equal(all.allowed, false);
  });

  it("every enforced clause withholds ON ITS OWN, and all-good serves — swept, not sampled", () => {
    const good: CrewMeetFacts = {
      blocked: false, sameCrewId: CREW_MINE, safetyGateCleared: true,
      viewerReturnState: "NORMAL", crewReturnState: "NORMAL",
    };
    assert.deepEqual(crewMeetingPointFor(POINT_MINE, good), { label: POINT_MINE, withheld: [] });

    const sweep: Array<[Partial<CrewMeetFacts>, MeetActionDenial]> = [
      [{ blocked: true }, "blocked"],
      [{ sameCrewId: null }, "no_crew"],
      [{ safetyGateCleared: false }, "safety_gate_not_cleared"],
      [{ viewerReturnState: null }, "return_state_escalated"],
      [{ viewerReturnState: "RETURN_NOW" }, "return_state_escalated"],
      [{ viewerReturnState: "CONNECTION_AT_RISK" }, "return_state_escalated"],
      [{ crewReturnState: null }, "return_state_escalated"],
      [{ crewReturnState: "RETURN_NOW" }, "return_state_escalated"],
      [{ crewReturnState: "CONNECTION_AT_RISK" }, "return_state_escalated"],
    ];
    for (const [patch, denial] of sweep) {
      const r = crewMeetingPointFor(POINT_MINE, { ...good, ...patch });
      assert.equal(r.label, null, `${JSON.stringify(patch)} still disclosed the label`);
      assert.ok(r.withheld.includes(denial), `${JSON.stringify(patch)} did not report "${denial}": ${r.withheld.join(",")}`);
    }
  });

  it("both return states are READ off a certified record, never asserted", () => {
    /**
     * A SOURCE-STRUCTURE PIN, and it is here because an output test cannot do
     * this one. `safetyGateCleared` is `buddySafetyGateFor(...).passed`, which
     * requires `returnState === "NORMAL"`, so on every output this surface can
     * produce the viewer half of the guard's escalation clause is masked by the
     * stricter clause beside it. Replacing `viewerReturnState` with the literal
     * `"NORMAL"` is therefore invisible to every assertion above — and it would
     * leave the clause asserting its own input. This goes red the moment either
     * state stops being read from the record.
     */
    const src = readFileSync(join(HERE, "..", "..", "..", "routes", "airport.ts"), "utf8");
    const start = src.indexOf("function crewMeetFactsFrom(");
    assert.ok(start > 0, "crewMeetFactsFrom is gone — the meet gate's fact derivation moved");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    assert.match(body, /viewerReturnState:\s*mine\?\.envelope\.returnState/);
    assert.match(body, /m\.record\?\.envelope\.returnState/);
    for (const state of ["NORMAL", "RETURN_SOON", "RETURN_NOW", "CONNECTION_AT_RISK"]) {
      assert.ok(
        !body.includes(`"${state}"`) && !body.includes(`'${state}'`),
        `crewMeetFactsFrom names the return state ${state} as a literal — it must only ever report what the record says`,
      );
    }
  });

  it("RETURN_SOON is withheld too — the layover safety gate is stricter than the guard's own ladder test", () => {
    // `buddySafetyGateFor` requires NORMAL, so a RETURN_SOON traveller fails
    // `safetyGateCleared` even though `meetActionAvailability`'s own escalation
    // test (RETURN_NOW / CONNECTION_AT_RISK) would let them through. The gate
    // this surface supplies is the layover lane's, and it is the stricter one.
    const r = crewMeetingPointFor(POINT_MINE, {
      blocked: false, sameCrewId: CREW_MINE, safetyGateCleared: false,
      viewerReturnState: "RETURN_SOON", crewReturnState: "NORMAL",
    });
    assert.equal(r.label, null);
    assert.deepEqual(r.withheld, ["safety_gate_not_cleared"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. OFFER scope — a traveller who must not be offered a landside meeting is
//    offered none, through BOTH doors
// ═══════════════════════════════════════════════════════════════════════════

describe("L138 — the safety gate on crew discovery (door 1) and the Compass tool (door 2)", () => {
  it("CONTROL: a clear traveller is offered the open crew, meeting point and all", async () => {
    stage();
    const r = await crewDoor();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.inCrew, false);
    // Both crews are open and the viewer is in neither, so both are offered.
    assert.deepEqual([...r.body.crews.map((c: any) => c.id)].sort(), [CREW_MINE, CREW_OPEN].sort());
    assert.deepEqual(
      [...r.body.crews.map((c: any) => c.meetingPointLabel)].sort(),
      [POINT_MINE, POINT_OPEN].sort(),
    );
    assert.equal(r.body.reason, undefined, "a cleared traveller must not be refused");
  });

  it("CONTROL: and the model is told the same thing", async () => {
    stage();
    const r = await compassDoor();
    assert.equal(r.tool.ok, true, r.raw);
    assert.equal(r.tool.data.inCrew, false);
    assert.deepEqual(
      [...r.tool.data.candidates.map((c: any) => c.meetingPointLabel)].sort(),
      [POINT_MINE, POINT_OPEN].sort(),
    );
    assert.equal(r.tool.data.reason, null);
  });

  it("door 1: `stay_airside` is offered NO crew, and is told why rather than shown an empty city", async () => {
    stage({ viewer: "stay_airside" });
    const r = await crewDoor();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.inCrew, false);
    assert.deepEqual(r.body.crews, []);
    assert.equal(r.body.reason, "safety_gate_not_passed");
    assert.deepEqual(r.body.meetWithheld, ["safety_gate_not_cleared"]);
    for (const p of [POINT_OPEN, POINT_MINE]) assertNoPoint(JSON.stringify(r.body), p, "door 1 / stay_airside");
  });

  // RESTATED 2026-10-07 under lead ruling L3-FC-3: a `stay_airside` viewer's
  // verdict is not an explicit yes, so door 2 no longer reaches the model at
  // all — the crew answer is never handed to it. Stronger than the tool's
  // refusal it used to assert: there is no tool round to refuse in.
  it("door 2: `stay_airside` never reaches the MODEL, and no crew is in the answer", async () => {
    stage({ viewer: "stay_airside" });
    const r = await compassDoorWithoutModel();
    for (const p of [POINT_OPEN, POINT_MINE]) assertNoPoint(JSON.stringify(r.body), p, "door 2 / stay_airside");
  });

  it("door 1: a traveller on the §15 escalation ladder is offered NO crew", async () => {
    stage({ viewer: "escalated" });
    const r = await crewDoor();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.crews, []);
    assert.equal(r.body.reason, "safety_gate_not_passed");
    for (const p of [POINT_OPEN, POINT_MINE]) assertNoPoint(JSON.stringify(r.body), p, "door 1 / escalated");
  });

  // RESTATED 2026-10-07 under L3-FC-3: an escalated viewer is not an explicit
  // yes, so the model — and the crew tool with it — is never reached.
  it("door 2: and the model is not reached at all, so it is handed none either", async () => {
    stage({ viewer: "escalated" });
    const r = await compassDoorWithoutModel();
    for (const p of [POINT_OPEN, POINT_MINE]) assertNoPoint(JSON.stringify(r.body), p, "door 2 / escalated");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. MEMBER scope — the traveller's OWN crew. The label is a member's fact and
//    it survives, except when a clause the gate enforces says otherwise
// ═══════════════════════════════════════════════════════════════════════════

describe("L138 — the meeting point on the traveller's own crew, both doors", () => {
  it("CONTROL door 1: a legitimate crew member still gets the meeting point", async () => {
    stage({ inCrew: true });
    const r = await crewDoor();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.inCrew, true);
    assert.equal(r.body.crew.meetingPointLabel, POINT_MINE);
    assert.deepEqual(r.body.crew.meetingPointWithheld, []);
  });

  it("CONTROL door 2: and so does the model", async () => {
    stage({ inCrew: true });
    const r = await compassDoor();
    assert.equal(r.tool.ok, true, r.raw);
    assert.equal(r.tool.data.inCrew, true);
    assert.equal(r.tool.data.crew.meetingPointLabel, POINT_MINE);
    assert.deepEqual(r.tool.data.crew.meetingPointWithheld, []);
  });

  it("door 1: a member on the escalation ladder loses the meeting point, NOT the shared deadline", async () => {
    stage({ inCrew: true, viewer: "escalated" });
    const r = await crewDoor();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.inCrew, true);
    assert.equal(r.body.crew.meetingPointLabel, null);
    assert.ok(r.body.crew.meetingPointWithheld.includes("safety_gate_not_cleared"), JSON.stringify(r.body.crew));
    // The crew's own facts are NOT withheld: every member is bound by them,
    // seen or not. Same split `publishedCrewSolution` already makes.
    assert.equal(r.body.crew.memberCount, 2);
    assert.equal(r.body.crew.title, "Ramen in the old town");
    assert.ok(r.body.solution, "the certified solution must still be published");
    assertNoPoint(JSON.stringify(r.body), POINT_MINE, "door 1 / member escalated");
  });

  // RESTATED 2026-10-07 under L3-FC-3: the escalated member is not an explicit
  // yes, so door 2 never reaches the model; the meeting point is in nothing the
  // traveller receives. (Door 1 above still pins the member's withheld label
  // and the crew's whole size.)
  it("door 2: same member, and the Compass door does not reach the model at all", async () => {
    stage({ inCrew: true, viewer: "escalated" });
    const r = await compassDoorWithoutModel();
    assertNoPoint(JSON.stringify(r.body), POINT_MINE, "door 2 / member escalated");
  });

  it("door 1: a CREWMATE on the ladder ends the meet for a viewer whose own clock is fine", async () => {
    stage({ inCrew: true, mate: "escalated" });
    const r = await crewDoor();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.crew.meetingPointLabel, null);
    assert.deepEqual(r.body.crew.meetingPointWithheld, ["return_state_escalated"]);
    assertNoPoint(JSON.stringify(r.body), POINT_MINE, "door 1 / crewmate escalated");
  });

  it("door 2: and the model is told the same", async () => {
    stage({ inCrew: true, mate: "escalated" });
    const r = await compassDoor();
    assert.equal(r.tool.ok, true, r.raw);
    assert.equal(r.tool.data.crew.meetingPointLabel, null);
    assert.deepEqual(r.tool.data.crew.meetingPointWithheld, ["return_state_escalated"]);
    assertNoPoint(r.raw, POINT_MINE, "door 2 / crewmate escalated");
  });

  it("the crew's worst is taken over EVERY member, not the first one read — both row orders", async () => {
    // Kills the "worst = members[0]'s state" reading, which agrees with the
    // truth exactly when the escalated member happens to be read first.
    for (const viewerFirst of [false, true]) {
      stage({ inCrew: true, mate: "escalated", viewerFirst });
      const d1 = await crewDoor();
      assert.equal(d1.status, 200, JSON.stringify(d1.body));
      assert.equal(d1.body.crew.meetingPointLabel, null, `door 1, viewerFirst=${viewerFirst}`);
      assert.deepEqual(d1.body.crew.meetingPointWithheld, ["return_state_escalated"]);

      stage({ inCrew: true, mate: "escalated", viewerFirst });
      const d2 = await compassDoor();
      assert.equal(d2.tool.ok, true, d2.raw);
      assert.equal(d2.tool.data.crew.meetingPointLabel, null, `door 2, viewerFirst=${viewerFirst}`);
      assert.deepEqual(d2.tool.data.crew.meetingPointWithheld, ["return_state_escalated"]);
    }
  });

  it("door 1: ONE crewmate nobody can place on the ladder withholds it — not a worst over the readable subset", async () => {
    // The viewer IS certified and clear here, so nothing but the crew-side
    // clause can close this. A worst taken over the members we could certify
    // would be NORMAL — a CALMER state than the truth, which is the direction a
    // safety maximum must never move.
    stage({ inCrew: true, mateSessionMissing: true });
    const r = await crewDoor();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.crew.meetingPointLabel, null);
    assert.deepEqual(r.body.crew.meetingPointWithheld, ["return_state_escalated"]);
    assert.equal(r.body.crew.memberCount, 2, "the crew's size is still true");
    assertNoPoint(JSON.stringify(r.body), POINT_MINE, "door 1 / crewmate uncertifiable");
  });

  it("door 2: and the model is not told where that crew is meeting either", async () => {
    stage({ inCrew: true, mateSessionMissing: true });
    const r = await compassDoor();
    assert.equal(r.tool.ok, true, r.raw);
    assert.equal(r.tool.data.crew.meetingPointLabel, null);
    assert.deepEqual(r.tool.data.crew.meetingPointWithheld, ["return_state_escalated"]);
    assertNoPoint(r.raw, POINT_MINE, "door 2 / crewmate uncertifiable");
  });

  it("door 1: a block created AFTER joining withholds the meeting point", async () => {
    // `blockAdmission` refuses a join across a block, so the only way into this
    // state is a block made later — which is exactly the state nothing checked.
    stage({ inCrew: true, blocks: [{ blocker_id: USER_M, blocked_id: USER_V }] });
    const r = await crewDoor();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.crew.meetingPointLabel, null);
    assert.deepEqual(r.body.crew.meetingPointWithheld, ["blocked"]);
    assertNoPoint(JSON.stringify(r.body), POINT_MINE, "door 1 / blocked after joining");
  });

  it("door 2: same block, same withholding — the Compass branch had no block read at all", async () => {
    stage({ inCrew: true, blocks: [{ blocker_id: USER_M, blocked_id: USER_V }] });
    const r = await compassDoor();
    assert.equal(r.tool.ok, true, r.raw);
    assert.equal(r.tool.data.crew.meetingPointLabel, null);
    assert.deepEqual(r.tool.data.crew.meetingPointWithheld, ["blocked"]);
    assertNoPoint(r.raw, POINT_MINE, "door 2 / blocked after joining");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. A FAILED READ withholds. supabase-js RESOLVES {data, error}, so each of
//    these is a value the code had to branch on — not an exception it caught
// ═══════════════════════════════════════════════════════════════════════════

describe("L138 — an input that could not be read withholds, never discloses", () => {
  it("door 1: an unreadable BLOCK LIST withholds the meeting point", async () => {
    stage({ inCrew: true, failures: { "blocks:select": { message: "relation unavailable" } } });
    const r = await crewDoor();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.crew.meetingPointLabel, null);
    assert.deepEqual(r.body.crew.meetingPointWithheld, ["blocked"]);
    // The existing degraded contract is unchanged beside it.
    assert.equal(r.body.degraded, true);
    assert.ok(r.body.degradedReasons.includes("blocks_unreadable"));
    assertNoPoint(JSON.stringify(r.body), POINT_MINE, "door 1 / blocks unreadable");
  });

  it("door 2: an unreadable BLOCK LIST withholds it from the model too", async () => {
    stage({ inCrew: true, failures: { "blocks:select": { message: "relation unavailable" } } });
    const r = await compassDoor();
    assert.equal(r.tool.ok, true, r.raw);
    assert.equal(r.tool.data.crew.meetingPointLabel, null);
    assert.deepEqual(r.tool.data.crew.meetingPointWithheld, ["blocked"]);
    assertNoPoint(r.raw, POINT_MINE, "door 2 / blocks unreadable");
  });

  it("door 1: unreadable MEMBER SESSIONS refuse the whole crew answer, so no label is served", async () => {
    stage({ inCrew: true, failSessionBatch: true });
    const r = await crewDoor();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assertNoPoint(JSON.stringify(r.body), POINT_MINE, "door 1 / sessions unreadable");
  });

  it("door 2: unreadable MEMBER SESSIONS withhold the label while the crew is still named", async () => {
    stage({ inCrew: true, failSessionBatch: true });
    const r = await compassDoor();
    assert.equal(r.tool.ok, true, r.raw);
    assert.equal(r.tool.data.crew.meetingPointLabel, null);
    // The viewer cannot be certified and the crew cannot be placed on the
    // ladder, and BOTH say so rather than defaulting to NORMAL.
    assert.deepEqual(
      r.tool.data.crew.meetingPointWithheld.sort(),
      ["return_state_escalated", "safety_gate_not_cleared"],
    );
    assertNoPoint(r.raw, POINT_MINE, "door 2 / sessions unreadable");
  });

  it("door 1: an unreadable AIRPORT refuses discovery rather than offering crews uncertified", async () => {
    stage({ failures: { "airport_profiles:select": { message: "relation unavailable" } } });
    const r = await crewDoor();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    for (const p of [POINT_OPEN, POINT_MINE]) assertNoPoint(JSON.stringify(r.body), p, "door 1 / airport unreadable");
  });
});
