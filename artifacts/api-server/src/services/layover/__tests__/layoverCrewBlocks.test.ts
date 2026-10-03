/**
 * census-layover L185 / L202 / L203 — a crew is a way to MEET people, and the
 * block list was never asked who may meet whom.
 *
 * ── THE DEFECT, STATED BEFORE IT IS FIXED ────────────────────────────────────
 * §27.1 scoped the crew JOIN to a city and recorded, about blocks, that "blocks
 * and `publishableUserIds` / `nameVisibilitySet` still held throughout, so this
 * was not a raw leak of names". That is true of the member CARDS and of nothing
 * else on this surface. Read at `0fa752ece`:
 *
 *   - `GET /:id/crew` (not in a crew) serves `openCrewsInCity` verbatim — every
 *     open crew in the city, its title and its `meetingPointLabel`, whoever is
 *     in it. A traveller somebody has BLOCKED is shown that person's crew and
 *     the place it is meeting.
 *   - `POST /:id/crew/:crewId/join` asks the city and the capacity, never the
 *     block list, so the blocked traveller can join and walk to the meeting
 *     point. The person who blocked them gets no card for them — so they are
 *     not even told who the new crewmate is.
 *   - Inside a crew, `solution.members[]` publishes every member's `userId`
 *     and personal return deadline, and `bindingMemberIds` names whoever binds
 *     — across a block, and for a crewmate whose sharing is paused. The cards
 *     run through blocks + `publishableUserIds`; the solver payload beside them
 *     runs through nothing, so the gate on the face is undone by the id.
 *
 * A block is symmetric for visibility (`lib/blocks.ts`): if A blocked B, neither
 * may see the other. On a surface whose purpose is to put people in the same
 * physical place, "see" includes "be offered as somebody to go and meet".
 *
 * ── THE FAIL-CLOSED ANSWERS (lib/exclusionSet.ts's three shapes) ─────────────
 *   discovery  shape 3 — the answer is entirely a roster of other people's
 *              crews, so an unreadable block list REFUSES (503), never serves
 *              the unfiltered list and never serves a fabricated empty city.
 *   join       shape 1 — one interaction; an unreadable block list refuses the
 *              join (503) and writes nothing. A join across a block is refused
 *              with the SAME answer as a crew that has closed, so the refusal
 *              does not tell anybody that they have been blocked.
 *   solver     shape 2 — the deadline is NOT block-scoped (everybody in the
 *              crew is bound by it), so `sharedReturnBy` and `memberCount` stay
 *              whole; only the per-member identities and deadlines are scoped,
 *              to exactly the people the viewer may see a card for.
 *
 * WHAT THIS DOES NOT PROVE. `fakeLayoverDb` models no RLS; 2984 gives the crew
 * tables zero policies and zero client grants (§26.1), so the route layer is
 * the only gate and is what is tested. Its `.or()` is a NO-OP, which is why the
 * "block between two OTHER people" control below matters: a filter that read
 * the whole blocks table would hide a crew over somebody else's block.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/layover/__tests__/layoverCrewBlocks.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";

let server: http.Server;
let base: string;

const TOKENS = { a: "blk-token-a", b: "blk-token-b", c: "blk-token-c" } as const;
const USER_A = "blk-user-a";
const USER_B = "blk-user-b";
const USER_C = "blk-user-c";
const USER_D = "blk-user-d";
const SESSION_A = "blk-session-a";
const SESSION_B = "blk-session-b";
const SESSION_C = "blk-session-c";
const CREW_ID = "blk-crew-1";

type Reply = { status: number; body: any };

function call(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let p: any;
          try { p = JSON.parse(raw); } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const crewUrl = (sessionId: string, suffix = "") => `/api/airport/sessions/${sessionId}/crew${suffix}`;

/**
 * A, B and C are on layovers in Taoyuan. A departs latest (9h), C at 7h, B
 * earliest (5h) — so whenever B is in a crew, B's deadline binds it.
 *
 * `crewMembers` defaults to an open crew owned by A with A alone in it.
 */
function stage(opts: {
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  members?: Array<{ user_id: string; session_id: string; role: "owner" | "member" }>;
  createdBy?: string;
  failures?: Record<string, { message: string; code?: string }>;
  paused?: string[];
} = {}) {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const members = opts.members ?? [{ user_id: USER_A, session_id: SESSION_A, role: "owner" as const }];
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [
      sessionRow({ id: SESSION_A, user_id: USER_A, departure_time: iso(now + 9 * 3_600_000) }),
      sessionRow({ id: SESSION_B, user_id: USER_B, departure_time: iso(now + 5 * 3_600_000) }),
      sessionRow({ id: SESSION_C, user_id: USER_C, departure_time: iso(now + 7 * 3_600_000) }),
    ],
    layover_crews: [
      {
        id: CREW_ID, city: "taoyuan", airport_ref: "TPE",
        created_by: opts.createdBy ?? USER_A, created_session_id: SESSION_A,
        title: "Ramen in the old town", meeting_point_label: "Terminal 2 food court",
        status: "open", max_members: 6,
        expires_at: iso(now + 8 * 3_600_000),
        created_at: iso(now - 60_000), updated_at: iso(now - 60_000),
      },
    ],
    layover_crew_members: members.map((m) => ({
      crew_id: CREW_ID, user_id: m.user_id, session_id: m.session_id, role: m.role,
      joined_at: iso(now - 60_000), left_at: null,
    })),
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
    blocks: opts.blocks ?? [],
    profiles: [
      { id: USER_A, handle: "ann", name: "Ann", avatar_url: null },
      { id: USER_B, handle: "bo", name: "Bo", avatar_url: null },
      { id: USER_C, handle: "cy", name: "Cy", avatar_url: null },
    ],
    location_preferences: [USER_A, USER_B, USER_C].map((id) => ({
      user_id: id, location_mode: "city", sharing_paused: (opts.paused ?? []).includes(id),
    })),
    trips: [],
  };
  _setTestClient(
    makeLayoverDb(tables, {
      users: { [TOKENS.a]: USER_A, [TOKENS.b]: USER_B, [TOKENS.c]: USER_C },
      failures: opts.failures ?? {},
    }),
    true,
  );
  return tables;
}

const liveMembership = (tables: Record<string, any[]>, userId: string) =>
  tables.layover_crew_members!.filter((m) => m.user_id === userId && (m.left_at ?? null) === null);

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("crew discovery — a crew is not offered across a block", () => {
  it("CONTROL: with no block, B is offered A's crew (title and meeting point)", async () => {
    stage();
    const r = await call(TOKENS.b, "GET", crewUrl(SESSION_B));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.inCrew, false);
    assert.deepEqual(r.body.crews.map((c: any) => c.id), [CREW_ID]);
    assert.equal(r.body.crews[0].meetingPointLabel, "Terminal 2 food court");
  });

  it("CONTROL: a block between two OTHER people does not hide the crew", async () => {
    // fakeLayoverDb's `.or()` is a no-op, so a filter that read the WHOLE blocks
    // table would see this row; only a filter scoped to B and the crew's members
    // gets the right answer.
    stage({ blocks: [{ blocker_id: USER_C, blocked_id: USER_D }] });
    const r = await call(TOKENS.b, "GET", crewUrl(SESSION_B));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.crews.map((c: any) => c.id), [CREW_ID]);
  });

  it("A blocked B: B is not shown A's crew or where it is meeting", async () => {
    stage({ blocks: [{ blocker_id: USER_A, blocked_id: USER_B }] });
    const r = await call(TOKENS.b, "GET", crewUrl(SESSION_B));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.crews, [], `a blocked traveller was offered the blocker's crew: ${JSON.stringify(r.body.crews)}`);
    assert.equal(JSON.stringify(r.body).includes("Terminal 2 food court"), false, "the meeting point leaked");
  });

  it("B blocked A: B is not shown A's crew either (a block is symmetric)", async () => {
    stage({ blocks: [{ blocker_id: USER_B, blocked_id: USER_A }] });
    const r = await call(TOKENS.b, "GET", crewUrl(SESSION_B));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.crews, []);
  });

  it("a block against ANY member hides the crew, not only against its founder", async () => {
    // C founded the crew; A is a member and has blocked B.
    stage({
      createdBy: USER_C,
      members: [
        { user_id: USER_C, session_id: SESSION_C, role: "owner" },
        { user_id: USER_A, session_id: SESSION_A, role: "member" },
      ],
      blocks: [{ blocker_id: USER_A, blocked_id: USER_B }],
    });
    const r = await call(TOKENS.b, "GET", crewUrl(SESSION_B));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.crews, [], "the crew A is in was offered to the person A blocked");
  });

  it("an UNREADABLE block list refuses — never the unfiltered list, never an empty city", async () => {
    stage({
      blocks: [{ blocker_id: USER_A, blocked_id: USER_B }],
      failures: { "blocks:select": { message: "relation unavailable" } },
    });
    const r = await call(TOKENS.b, "GET", crewUrl(SESSION_B));
    assert.equal(r.status, 503, `an unreadable block list answered ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
  });

  it("a crew with more members than one read can certify is refused, not cleared on the rows that fitted", async () => {
    // `CREW_READ_LIMIT` is 12. A crew edited out of band to 14 live members,
    // with the person who blocked B as the 14th row: a member read that stopped
    // at its page would clear this crew against 13 people and offer it to B.
    const filler = Array.from({ length: 12 }, (_, i) => ({
      user_id: `blk-filler-${i}`, session_id: SESSION_C, role: "member" as const,
    }));
    stage({
      createdBy: USER_C,
      members: [
        { user_id: USER_C, session_id: SESSION_C, role: "owner" },
        ...filler,
        { user_id: USER_A, session_id: SESSION_A, role: "member" },
      ],
      blocks: [{ blocker_id: USER_A, blocked_id: USER_B }],
    });
    const r = await call(TOKENS.b, "GET", crewUrl(SESSION_B));
    assert.equal(r.status, 503, `a crew was cleared against a partial member list: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("an unreadable MEMBER list refuses too — the block check has nobody to check", async () => {
    // GREEN BEFORE THE FIX, AND FOR A DIFFERENT REASON — recorded rather than
    // counted as a red-first case. `fakeLayoverDb` fails a table for every read
    // of it, and the FIRST read of `layover_crew_members` on this route is B's
    // own membership (`activeCrewForUser`), which already refused. The case is
    // kept because it pins the answer, not the path: a refactor that reads the
    // open crews first must not then clear them against an unread member list.
    stage({ failures: { "layover_crew_members:select": { message: "relation unavailable" } } });
    const r = await call(TOKENS.b, "GET", crewUrl(SESSION_B));
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
  });
});

describe("crew join — refused across a block, and refused when blocks cannot be read", () => {
  it("CONTROL: with no block, B joins A's crew", async () => {
    const tables = stage();
    const r = await call(TOKENS.b, "POST", crewUrl(SESSION_B, `/${CREW_ID}/join`));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(liveMembership(tables, USER_B).length, 1);
  });

  it("A blocked B: B cannot join A's crew, and the refusal reads like a closed crew", async () => {
    const tables = stage({ blocks: [{ blocker_id: USER_A, blocked_id: USER_B }] });
    const r = await call(TOKENS.b, "POST", crewUrl(SESSION_B, `/${CREW_ID}/join`));
    assert.equal(r.status, 404, `a blocked traveller joined the blocker's crew: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "not_found");
    // Indistinguishable from a crew that has closed: the refusal must not tell
    // B that somebody in it blocked them.
    assert.equal(r.body.message, "That crew is no longer open.");
    assert.equal(liveMembership(tables, USER_B).length, 0, "a refused join still wrote a membership row");
  });

  it("B blocked A: B cannot join A's crew either", async () => {
    const tables = stage({ blocks: [{ blocker_id: USER_B, blocked_id: USER_A }] });
    const r = await call(TOKENS.b, "POST", crewUrl(SESSION_B, `/${CREW_ID}/join`));
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(liveMembership(tables, USER_B).length, 0);
  });

  it("a block against a non-founder member refuses the join", async () => {
    const tables = stage({
      createdBy: USER_C,
      members: [
        { user_id: USER_C, session_id: SESSION_C, role: "owner" },
        { user_id: USER_A, session_id: SESSION_A, role: "member" },
      ],
      blocks: [{ blocker_id: USER_A, blocked_id: USER_B }],
    });
    const r = await call(TOKENS.b, "POST", crewUrl(SESSION_B, `/${CREW_ID}/join`));
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(liveMembership(tables, USER_B).length, 0);
  });

  it("an UNREADABLE block list refuses the join (503) and writes nothing", async () => {
    const tables = stage({ failures: { "blocks:select": { message: "relation unavailable" } } });
    const r = await call(TOKENS.b, "POST", crewUrl(SESSION_B, `/${CREW_ID}/join`));
    assert.equal(r.status, 503, `a join went ahead on an unread block list: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(liveMembership(tables, USER_B).length, 0, "nothing may be written on an unchecked block list");
  });
});

describe("inside a crew — the deadline binds everyone, identities only where a card may be shown", () => {
  /** A and B both in A's crew; B (5h) binds A (9h). */
  const bothIn = [
    { user_id: USER_A, session_id: SESSION_A, role: "owner" as const },
    { user_id: USER_B, session_id: SESSION_B, role: "member" as const },
  ];

  it("CONTROL: with no block, each sees the other in the solver and B is named as binding", async () => {
    stage({ members: bothIn });
    const r = await call(TOKENS.a, "GET", crewUrl(SESSION_A));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.solution.members.map((m: any) => m.userId).sort(), [USER_A, USER_B].sort());
    assert.deepEqual(r.body.solution.bindingMemberIds, [USER_B]);
    assert.equal(r.body.solution.bindingMemberHidden, false);
  });

  it("blocked after joining: neither side's id or personal deadline is published to the other", async () => {
    stage({ members: bothIn, blocks: [{ blocker_id: USER_A, blocked_id: USER_B }] });

    for (const [token, self, other] of [[TOKENS.a, USER_A, USER_B], [TOKENS.b, USER_B, USER_A]] as const) {
      const r = await call(token, "GET", crewUrl(token === TOKENS.a ? SESSION_A : SESSION_B));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const body = JSON.stringify(r.body);
      assert.equal(body.includes(other), false, `${self}'s view of the crew carries ${other}'s id: ${body}`);
      assert.deepEqual(r.body.solution.members.map((m: any) => m.userId), [self]);
      // Counted, and still binding — the deadline is the CREW's, not a person's.
      assert.equal(r.body.crew.memberCount, 2);
      assert.ok(r.body.solution.sharedReturnBy, "the crew deadline must survive the redaction");
    }

    // A's view: B binds, and A is told that a crewmate it cannot see binds.
    const a = await call(TOKENS.a, "GET", crewUrl(SESSION_A));
    const own = a.body.solution.members.find((m: any) => m.userId === USER_A);
    assert.ok(own?.requiredReturnBy, JSON.stringify(a.body.solution));
    assert.ok(
      Date.parse(a.body.solution.sharedReturnBy) < Date.parse(own.requiredReturnBy),
      "the hidden crewmate's earlier deadline must still bind A",
    );
    assert.deepEqual(a.body.solution.bindingMemberIds, []);
    assert.equal(a.body.solution.bindingMemberHidden, true);
  });

  it("in a MIXED crew the visible crewmate is named and the blocked one is not", async () => {
    // Three members: A (viewer), C (visible to A) and B (blocked by A). With
    // only one other member, a hidden crewmate empties the visible set and the
    // member-card read returns early — so the branch that publishes a
    // NON-empty visible set needs a crewmate on each side of the gate.
    stage({
      members: [
        { user_id: USER_A, session_id: SESSION_A, role: "owner" },
        { user_id: USER_B, session_id: SESSION_B, role: "member" },
        { user_id: USER_C, session_id: SESSION_C, role: "member" },
      ],
      blocks: [{ blocker_id: USER_A, blocked_id: USER_B }],
    });
    const r = await call(TOKENS.a, "GET", crewUrl(SESSION_A));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.members.map((m: any) => m.id), [USER_C], "C has a card, B does not");
    assert.deepEqual(r.body.solution.members.map((m: any) => m.userId).sort(), [USER_A, USER_C].sort());
    assert.equal(JSON.stringify(r.body.solution).includes(USER_B), false, JSON.stringify(r.body.solution));
    assert.equal(r.body.crew.memberCount, 3);
    // B (5h) binds, and B is the one A cannot see.
    assert.equal(r.body.solution.bindingMemberHidden, true);
  });

  it("a crewmate who paused sharing is not identified in the solver either", async () => {
    stage({ members: bothIn, paused: [USER_B] });
    const r = await call(TOKENS.a, "GET", crewUrl(SESSION_A));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.members.length, 0, "precondition: no card for a paused crewmate");
    assert.equal(JSON.stringify(r.body.solution).includes(USER_B), false, JSON.stringify(r.body.solution));
    assert.equal(r.body.solution.bindingMemberHidden, true);
  });

  it("an unreadable block list publishes only the viewer's own entry — and the deadline", async () => {
    stage({ members: bothIn, failures: { "blocks:select": { message: "relation unavailable" } } });
    const r = await call(TOKENS.a, "GET", crewUrl(SESSION_A));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.solution.members.map((m: any) => m.userId), [USER_A]);
    assert.equal(JSON.stringify(r.body.solution).includes(USER_B), false);
    assert.ok(r.body.solution.sharedReturnBy);
    assert.equal(r.body.degraded, true);
  });
});
