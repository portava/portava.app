/**
 * census-layover L28/L29/L131/L185/L186/L188 — the §14 crew gets storage, four
 * routes and a screen, and the §14.1 solver finally gets members.
 *
 * L28 and L29 (`layover_crews`, `layover_crew_members`) read "Absent."; L131
 * (§14 "L3 crew formed") and L185/L186/L188 (`LayoverCrewService.create` /
 * `.join` / `.leave`) read N with the one-word reason "No crew."
 *
 * `certifyCrewPlan` and `sharedReturnBy` already had their own suite
 * (`src/test/layoverCrewConstraints.test.ts`) and this file does NOT retest the
 * arithmetic. What is new, and what is tested here, is everything that had to
 * be true for that arithmetic to be reachable at all — and the ways a crew
 * surface can be built that quietly undo it:
 *
 *   1. the round trip — create, and the crew is there on a FRESH read;
 *   2. a second traveller joins, and the shared deadline becomes the EARLIER of
 *      the two, not the joiner's and not the founder's;
 *   3. a member whose feasibility cannot be certified makes the shared deadline
 *      ABSENT rather than later — the direction a safety minimum must not move;
 *   4. one crew at a time, and a double-tapped join is not a second membership;
 *   5. `max_members` binds, and an unreadable member list refuses the join and
 *      writes nothing — see that case for exactly how much it proves;
 *   6. the owner leaving disbands, so no crew outlives the layover that made it;
 *   7. an unreadable crew read refuses instead of answering "you are in no crew";
 *   8. a blocked crewmate gets no card but is STILL COUNTED and still binds the
 *      deadline — the count and the faces are different questions;
 *   9. an unreadable `blocks` table publishes NO cards rather than all of them.
 *
 * WHAT THIS DOES NOT PROVE — AND THE HALF OF IT THAT IS NO LONGER TRUE.
 * This paragraph used to end "it is not evidence that the storage exists".
 * The storage now exists: census-layover §26.1 records migration 2984 applied
 * to production and to CI on 2026-09-16, both tables re-probed afterwards. That
 * clause is struck rather than deleted, because it is the reason L28/L29 moved
 * `N → C` and the reason L185/L186/L188 could be graded at all (§26.4).
 *
 * What still stands: every case here runs against `fakeLayoverDb`, a double
 * that models no unique index (case 4 stages the 23505 itself), no RLS and no
 * foreign keys. So this is evidence that the STORE and the ROUTES behave, not
 * evidence about the live schema. For these two tables that gap is narrower
 * than it sounds — 2984 gives them zero policies and zero client grants, so
 * there is no database-level behaviour underneath the route layer for a live
 * test to observe that this one cannot.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/layover/__tests__/layoverCrewSurface.test.ts
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

const A_TOKEN = "crew-token-a";
const B_TOKEN = "crew-token-b";
const USER_A = "user-a";
const USER_B = "user-b";
const SESSION_A = "session-a";
const SESSION_B = "session-b";

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
 * Two travellers on layovers at the same airport. B departs EARLIER, so once
 * both are in a crew B's deadline is the binding one — which is what makes
 * case 2 a real test of `min()` rather than of "some time came back".
 */
function stage(
  opts: {
    crews?: Record<string, any>[];
    members?: Record<string, any>[];
    failures?: Record<string, { message: string; code?: string }>;
    blocks?: Record<string, any>[];
    sessionBDepartureHours?: number;
    sessionBStatus?: string;
  } = {},
) {
  const now = Date.now();
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [
      sessionRow({ id: SESSION_A, user_id: USER_A, departure_time: new Date(now + 9 * 3_600_000).toISOString() }),
      sessionRow({
        id: SESSION_B,
        user_id: USER_B,
        departure_time: new Date(now + (opts.sessionBDepartureHours ?? 5) * 3_600_000).toISOString(),
        status: opts.sessionBStatus ?? "active",
      }),
    ],
    layover_crews: opts.crews ?? [],
    layover_crew_members: opts.members ?? [],
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
    blocks: opts.blocks ?? [],
    profiles: [
      { id: USER_A, handle: "ann", name: "Ann", avatar_url: null },
      { id: USER_B, handle: "bo", name: "Bo", avatar_url: null },
    ],
    // Both travellers publishable by default; `publishableUserIds` reads this.
    location_preferences: [
      { user_id: USER_A, location_mode: "city", sharing_paused: false },
      { user_id: USER_B, location_mode: "city", sharing_paused: false },
    ],
    trips: [],
  };
  _setTestClient(
    makeLayoverDb(tables, {
      users: { [A_TOKEN]: USER_A, [B_TOKEN]: USER_B },
      failures: opts.failures ?? {},
    }),
    true,
  );
  return tables;
}

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

describe("L28/L29/L185 — a crew can be formed and survives a reload", () => {
  it("create, then a FRESH read finds it", async () => {
    const tables = stage();
    const created = await call(A_TOKEN, "POST", crewUrl(SESSION_A), {
      title: "Ramen in the old town",
      meetingPointLabel: "Terminal 2 food court",
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.inCrew, true);
    assert.equal(created.body.crew.youAreOwner, true);
    assert.equal(created.body.crew.memberCount, 1);

    // PERSISTED, not echoed.
    assert.equal(tables.layover_crews.length, 1);
    assert.equal(tables.layover_crew_members.length, 1);
    assert.equal(tables.layover_crew_members[0].role, "owner");
    // The city is canonicalised on the way in, so discovery cannot split on
    // two spellings of one city.
    assert.equal(tables.layover_crews[0].city, "taoyuan");
    // NO COORDINATE ANYWHERE. 2984 asserts the columns do not exist; this
    // asserts the writer does not try.
    const written = JSON.stringify(tables.layover_crews[0]);
    for (const k of ["lat", "lng", "latitude", "longitude"]) {
      assert.equal(written.includes(`"${k}"`), false, `crew row carries ${k}`);
    }

    const fresh = await call(A_TOKEN, "GET", crewUrl(SESSION_A));
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal(fresh.body.inCrew, true);
    assert.equal(fresh.body.crew.title, "Ramen in the old town");
    assert.equal(fresh.body.crew.meetingPointLabel, "Terminal 2 food court");
  });

  it("a crew is discoverable by another traveller in the same city", async () => {
    stage();
    await call(A_TOKEN, "POST", crewUrl(SESSION_A), { title: "Ramen" });
    const seen = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    assert.equal(seen.body.inCrew, false);
    assert.equal(seen.body.crews.length, 1);
    assert.equal(seen.body.crews[0].title, "Ramen");
  });
});

describe("L131/L186 — §14.1 shared_return_by is a minimum over the crew", () => {
  it("the shared deadline is the EARLIER traveller's, not the founder's", async () => {
    // B departs in 5h, A in 9h, so B binds.
    stage({ sessionBDepartureHours: 5 });
    const created = await call(A_TOKEN, "POST", crewUrl(SESSION_A), { title: "Ramen" });
    const crewId = created.body.crew.id;

    const alone = created.body.solution.sharedReturnBy as string;
    assert.ok(alone, "a one-member crew is certified against that member");

    const joined = await call(B_TOKEN, "POST", crewUrl(SESSION_B, `/${crewId}/join`));
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.crew.memberCount, 2);

    const shared = joined.body.solution.sharedReturnBy as string;
    assert.ok(shared, JSON.stringify(joined.body.solution));
    assert.ok(
      Date.parse(shared) < Date.parse(alone),
      `the crew deadline must move EARLIER when a tighter traveller joins: alone=${alone} shared=${shared}`,
    );
    assert.deepEqual(joined.body.solution.bindingMemberIds, [USER_B],
      "the binding member is the one whose deadline it is");
  });

  it("an uncertifiable member makes the deadline ABSENT, never later", async () => {
    // B's session is `completed`, so no record can be produced for them. The
    // tempting behaviour -- take the minimum over the members we CAN certify --
    // would hand the crew A's much later deadline and call it shared.
    stage({ sessionBStatus: "completed" });
    const created = await call(A_TOKEN, "POST", crewUrl(SESSION_A), { title: "Ramen" });
    const crewId = created.body.crew.id;

    // B cannot join from an ended layover, so seed the membership directly --
    // this is the state a crew reaches when a member's layover ends underneath
    // it, which is the case that matters.
    const tables = stage({
      crews: [{ ...toCrewRow(created.body.crew, USER_A, SESSION_A), id: crewId }],
      members: [
        { crew_id: crewId, user_id: USER_A, session_id: SESSION_A, role: "owner", joined_at: new Date().toISOString(), left_at: null },
        { crew_id: crewId, user_id: USER_B, session_id: SESSION_B, role: "member", joined_at: new Date().toISOString(), left_at: null },
      ],
      sessionBStatus: "completed",
    });
    assert.equal(tables.layover_crew_members.length, 2);

    const read = await call(A_TOKEN, "GET", crewUrl(SESSION_A));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.solution.sharedReturnBy, null,
      "a minimum over the readable subset is a LATER deadline than the truth");
    assert.equal(read.body.solution.feasible, false);
    assert.ok(
      read.body.solution.reasons.includes("member_without_certified_feasibility"),
      JSON.stringify(read.body.solution.reasons),
    );
    // …and the member is still COUNTED. Dropping them would make the crew look
    // smaller and the deadline look settled.
    assert.equal(read.body.crew.memberCount, 2);
  });
});

describe("L188 — membership is exclusive, bounded and reversible", () => {
  it("one crew at a time", async () => {
    stage();
    const first = await call(A_TOKEN, "POST", crewUrl(SESSION_A), { title: "Ramen" });
    assert.equal(first.status, 200);
    const second = await call(A_TOKEN, "POST", crewUrl(SESSION_A), { title: "Sushi" });
    assert.equal(second.status, 400, JSON.stringify(second.body));
  });

  it("a double-tapped join is not a second membership", async () => {
    const tables = stage();
    const created = await call(A_TOKEN, "POST", crewUrl(SESSION_A), { title: "Ramen" });
    const crewId = created.body.crew.id;
    const one = await call(B_TOKEN, "POST", crewUrl(SESSION_B, `/${crewId}/join`));
    assert.equal(one.status, 200, JSON.stringify(one.body));
    const two = await call(B_TOKEN, "POST", crewUrl(SESSION_B, `/${crewId}/join`));
    assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.equal(two.body.crew.memberCount, 2, "the second press must not add a row");
    assert.equal(tables.layover_crew_members.filter((m: any) => m.user_id === USER_B).length, 1);
  });

  it("max_members binds", async () => {
    const created = await call(A_TOKEN, "POST", crewUrl(SESSION_A), { title: "Ramen", maxMembers: 2 });
    // Re-stage with the crew already at its cap, so B's join is the one over.
    const now = new Date().toISOString();
    const crewId = "crew-full";
    stage({
      crews: [{
        id: crewId, city: "taoyuan", airport_ref: "TPE", created_by: USER_A,
        created_session_id: SESSION_A, title: "Ramen", meeting_point_label: null,
        status: "open", max_members: 2, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        created_at: now, updated_at: now,
      }],
      members: [
        { crew_id: crewId, user_id: USER_A, session_id: SESSION_A, role: "owner", joined_at: now, left_at: null },
        { crew_id: crewId, user_id: "user-c", session_id: SESSION_A, role: "member", joined_at: now, left_at: null },
      ],
    });
    void created;
    const over = await call(B_TOKEN, "POST", crewUrl(SESSION_B, `/${crewId}/join`));
    assert.equal(over.status, 400, JSON.stringify(over.body));
    assert.match(String(over.body.message ?? ""), /full/i);
  });

  it("an unreadable member list REFUSES the join and writes nothing", async () => {
    // The capacity check and the one-crew-at-a-time check are both READS of
    // `layover_crew_members`, so an unreadable member table is an UNENFORCED
    // limit on both counts. Same rule the stops route applies to MAX_STOPS.
    //
    // WHAT THIS CASE PROVES, STATED EXACTLY, because it is weaker than its
    // first name suggested: `fakeLayoverDb` keys failure injection by
    // `table:op`, and BOTH guards read the same table, so this cannot isolate
    // the capacity one -- a mutation that removes only the capacity refusal
    // stays green here, and that was measured rather than assumed. What it does
    // prove is the property that actually protects the invariant: on an
    // unreadable member list the join REFUSES and NO ROW IS WRITTEN. Moving the
    // insert above either guard reddens this and two other cases with it.
    const now = new Date().toISOString();
    const crewId = "crew-x";
    const tables = stage({
      crews: [{
        id: crewId, city: "taoyuan", airport_ref: "TPE", created_by: USER_A,
        created_session_id: SESSION_A, title: "Ramen", meeting_point_label: null,
        status: "open", max_members: 2, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        created_at: now, updated_at: now,
      }],
      failures: { "layover_crew_members:select": { message: "relation unavailable" } },
    });
    const r = await call(B_TOKEN, "POST", crewUrl(SESSION_B, `/${crewId}/join`));
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable", JSON.stringify(r.body));
    assert.equal(tables.layover_crew_members.length, 0, "nothing may be written on an unchecked limit");
  });

  it("the owner leaving DISBANDS, so no crew outlives the layover that made it", async () => {
    const tables = stage();
    const created = await call(A_TOKEN, "POST", crewUrl(SESSION_A), { title: "Ramen" });
    const crewId = created.body.crew.id;
    await call(B_TOKEN, "POST", crewUrl(SESSION_B, `/${crewId}/join`));

    const left = await call(A_TOKEN, "POST", crewUrl(SESSION_A, "/leave"));
    assert.equal(left.status, 200, JSON.stringify(left.body));
    assert.equal(left.body.disbanded, true);
    assert.equal(tables.layover_crews[0].status, "disbanded");

    // And B is no longer in a live crew.
    const bs = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
    assert.equal(bs.status, 200, JSON.stringify(bs.body));
    assert.equal(bs.body.inCrew, false);
  });

  it("a non-owner leaving does not disband", async () => {
    const tables = stage();
    const created = await call(A_TOKEN, "POST", crewUrl(SESSION_A), { title: "Ramen" });
    const crewId = created.body.crew.id;
    await call(B_TOKEN, "POST", crewUrl(SESSION_B, `/${crewId}/join`));

    const left = await call(B_TOKEN, "POST", crewUrl(SESSION_B, "/leave"));
    assert.equal(left.status, 200, JSON.stringify(left.body));
    assert.equal(left.body.disbanded, false);
    assert.equal(tables.layover_crews[0].status, "open");

    const as = await call(A_TOKEN, "GET", crewUrl(SESSION_A));
    assert.equal(as.body.inCrew, true);
    assert.equal(as.body.crew.memberCount, 1, "the leaver must stop being counted");
  });
});

describe("an outage is not an empty crew, and membership is not entitlement", () => {
  it("an unreadable crew read refuses instead of answering 'you are in no crew'", async () => {
    stage({ failures: { "layover_crews:select": { message: "relation unavailable" } } });
    const r = await call(A_TOKEN, "GET", crewUrl(SESSION_A));
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable", JSON.stringify(r.body));
  });

  it("a blocked crewmate gets no card but is STILL counted and still binds", async () => {
    // The two questions are different: who is in this crew (arithmetic) and
    // whose face may you see (entitlement). Answering the first with the second
    // would un-count a traveller whose deadline the whole crew depends on.
    stage({ sessionBDepartureHours: 5 });
    const created = await call(A_TOKEN, "POST", crewUrl(SESSION_A), { title: "Ramen" });
    const crewId = created.body.crew.id;
    const joined = await call(B_TOKEN, "POST", crewUrl(SESSION_B, `/${crewId}/join`));
    assert.equal(joined.status, 200, JSON.stringify(joined.body));

    // Re-stage the same crew with a block between them.
    const now = new Date().toISOString();
    stage({
      sessionBDepartureHours: 5,
      crews: [{
        id: crewId, city: "taoyuan", airport_ref: "TPE", created_by: USER_A,
        created_session_id: SESSION_A, title: "Ramen", meeting_point_label: null,
        status: "open", max_members: 6, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        created_at: now, updated_at: now,
      }],
      members: [
        { crew_id: crewId, user_id: USER_A, session_id: SESSION_A, role: "owner", joined_at: now, left_at: null },
        { crew_id: crewId, user_id: USER_B, session_id: SESSION_B, role: "member", joined_at: now, left_at: null },
      ],
      blocks: [{ blocker_id: USER_A, blocked_id: USER_B }],
    });

    const read = await call(A_TOKEN, "GET", crewUrl(SESSION_A));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.members.length, 0, "a blocked crewmate must not get a card");
    assert.equal(read.body.crew.memberCount, 2, "…and must still be counted");
    assert.deepEqual(read.body.solution.bindingMemberIds, [USER_B],
      "…and must still bind the shared deadline");
  });

  it("an unreadable blocks table publishes NO cards rather than all of them", async () => {
    const now = new Date().toISOString();
    const crewId = "crew-b";
    stage({
      crews: [{
        id: crewId, city: "taoyuan", airport_ref: "TPE", created_by: USER_A,
        created_session_id: SESSION_A, title: "Ramen", meeting_point_label: null,
        status: "open", max_members: 6, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        created_at: now, updated_at: now,
      }],
      members: [
        { crew_id: crewId, user_id: USER_A, session_id: SESSION_A, role: "owner", joined_at: now, left_at: null },
        { crew_id: crewId, user_id: USER_B, session_id: SESSION_B, role: "member", joined_at: now, left_at: null },
      ],
      failures: { "blocks:select": { message: "relation unavailable" } },
    });
    const read = await call(A_TOKEN, "GET", crewUrl(SESSION_A));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.members.length, 0, "an unreadable block list is not 'nobody is blocked'");
    assert.equal(read.body.degraded, true);
    assert.ok(read.body.degradedReasons.includes("blocks_unreadable"), JSON.stringify(read.body.degradedReasons));
    assert.equal(read.body.crew.memberCount, 2, "the count survives the card outage");
  });
});

/** The crew row shape, from the payload the route published. */
function toCrewRow(crew: any, ownerId: string, sessionId: string): Record<string, any> {
  const now = new Date().toISOString();
  return {
    id: crew.id,
    city: "taoyuan",
    airport_ref: "TPE",
    created_by: ownerId,
    created_session_id: sessionId,
    title: crew.title,
    meeting_point_label: crew.meetingPointLabel ?? null,
    status: "open",
    max_members: crew.maxMembers,
    expires_at: crew.expiresAt,
    created_at: now,
    updated_at: now,
  };
}
