/**
 * The crew itinerary — §14.1's per-branch feasibility, finally exercised.
 *
 * `certifyCrewPlan` has implemented "Crew plan must be certified against every
 * member branch" since before `layover_crews` existed, and `routes/airport.ts`
 * called it with `unsplitPlan(members, [])`: one branch, everybody, NO STOPS.
 * With no stops `branchNeededMinutes` is 0, so `plan_exceeds_usable_minutes`
 * and `plan_ends_after_shared_return` could not fire and `split` was always
 * false. Migration 3515, `LayoverCrewItineraryStore` and five routes give it a
 * plan.
 *
 * The properties below are the ones that make this a certified itinerary rather
 * than a list of stops, and each is asserted against behaviour:
 *
 *   1. THE EMPTY PLAN CERTIFIES FEASIBLE, so an unreadable read must REFUSE.
 *      This is the headline property and the reason the store's reads are
 *      discriminated. Zero needed minutes fit inside any usable minutes and end
 *      before any deadline, so a stops table served as `[]` publishes
 *      `feasible: true` over an itinerary nobody could measure. The test stages
 *      the read failure and asserts the ENDPOINT refuses — not merely that the
 *      store returned `ok: false`, because a route that ignored the refusal
 *      would pass that.
 *   2. AN UNASSIGNED MEMBER IS IN NO BRANCH. Once one assignment exists the
 *      crew has split, and folding the leftovers into `'all'` would certify
 *      them against an itinerary they were never put on. `certifyCrewPlan`
 *      reports `member_unassigned`; the reader must let it.
 *   3. THE UNSPLIT CASE IS BYTE-IDENTICAL TO `unsplitPlan`. A crew that has
 *      never split must read exactly as it read before this change, branch id
 *      included — pinned by reading the literal out of `unsplitPlan` itself
 *      rather than by trusting two copies of the string.
 *   4. A STOP THAT DOES NOT FIT MAKES THE PLAN INFEASIBLE. The verdict the
 *      empty plan could never reach, asserted end to end over HTTP.
 *   5. THE LANDSIDE TRAVEL RULE IS THE SOLO SURFACE'S, not a second copy
 *      (census L47 is what a fabricated zero leg cost).
 *   6. A DELETE THAT MATCHED NOTHING IS NOT A SUCCESS. The state after the
 *      write is what is asserted, per CONTRIBUTING.md's rule.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverCrewItinerary.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  UNSPLIT_BRANCH_ID,
  buildCrewPlan,
  canonBranchId,
  type CrewBranchAssignmentRow,
  type CrewStopRow,
} from "../services/layover/LayoverCrewItineraryStore.js";
import { certifyCrewPlan, unsplitPlan } from "../services/airport/LayoverCrewService.js";

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// ═══════════════════════════════════════════════════════════════════════════
// 1. buildCrewPlan — pure, no database, no clock
// ═══════════════════════════════════════════════════════════════════════════

function stopRow(over: Partial<CrewStopRow> = {}): CrewStopRow {
  return {
    id: over.id ?? `stop-${Math.random().toString(36).slice(2, 8)}`,
    crewId: "crew-1",
    branchId: over.branchId ?? UNSPLIT_BRANCH_ID,
    stopOrder: over.stopOrder ?? 0,
    title: over.title ?? "Noodles",
    durationMin: over.durationMin ?? 45,
    travelMin: over.travelMin ?? 0,
    insideAirport: over.insideAirport ?? true,
    locationLabel: over.locationLabel ?? null,
    proposedBy: over.proposedBy ?? "user-a",
    createdAt: over.createdAt ?? "2031-01-01T00:00:00.000Z",
    ...over,
  };
}

function assignmentRow(userId: string, branchId: string): CrewBranchAssignmentRow {
  return {
    crewId: "crew-1",
    userId,
    branchId,
    assignedBy: "user-a",
    assignedAt: "2031-01-01T00:00:00.000Z",
  };
}

describe("buildCrewPlan — the unsplit case costs nothing", () => {
  it("no assignments means ONE branch, everybody, the 'all' stops", () => {
    const plan = buildCrewPlan({
      memberIds: ["user-a", "user-b", "user-c"],
      stops: [stopRow({ title: "Noodles" }), stopRow({ title: "Observation deck" })],
      assignments: [],
    });
    assert.equal(plan.branches.length, 1);
    assert.equal(plan.branches[0].branchId, UNSPLIT_BRANCH_ID);
    assert.deepEqual(plan.branches[0].memberIds, ["user-a", "user-b", "user-c"]);
    assert.deepEqual(
      plan.branches[0].stops.map((s) => s.title),
      ["Noodles", "Observation deck"],
    );
  });

  /**
   * THE PIN. `unsplitPlan` writes its branch id as an inline literal and does
   * not export it, so "a crew with no assignments reads exactly as it read
   * before this change" is only true while the two agree. Comparing the two
   * strings is what makes that a fact rather than a hope — and it fails if
   * either side is renamed, which is the point.
   */
  it("the unsplit branch id is the one unsplitPlan uses, not a second copy of it", () => {
    const theirs = unsplitPlan([{ userId: "user-a", sessionId: "s-a", record: null }], []);
    assert.equal(theirs.branches[0].branchId, UNSPLIT_BRANCH_ID);
  });

  it("an empty crew with no stops is still one branch, so certifyCrewPlan can say no_members", () => {
    const plan = buildCrewPlan({ memberIds: [], stops: [], assignments: [] });
    assert.equal(plan.branches.length, 1);
    assert.deepEqual(plan.branches[0].memberIds, []);
    const solution = certifyCrewPlan(plan, [], { nowMs: Date.parse("2031-01-01T00:00:00Z") });
    assert.ok(solution.reasons.includes("no_members"));
  });
});

describe("buildCrewPlan — a split plan is only what the assignments say", () => {
  /**
   * The defect this forbids: "anyone without an assignment is in `'all'`". That
   * rule invents a branch for a member the split forgot, gives them that
   * branch's stops, and certifies them against an itinerary they were never put
   * on. `certifyCrewPlan` has `member_unassigned` for exactly this and the
   * reader must not repair it away.
   */
  it("a member with no assignment appears in NO branch, and certifyCrewPlan says so", () => {
    const plan = buildCrewPlan({
      memberIds: ["user-a", "user-b"],
      stops: [stopRow({ branchId: "museum" }), stopRow({ branchId: UNSPLIT_BRANCH_ID, title: "Left behind" })],
      assignments: [assignmentRow("user-a", "museum")],
    });
    const everyone = plan.branches.flatMap((b) => b.memberIds);
    assert.deepEqual(everyone, ["user-a"], "user-b must not be folded into a branch nobody put them in");

    const solution = certifyCrewPlan(plan, [
      { userId: "user-a", sessionId: "s-a", record: null },
      { userId: "user-b", sessionId: "s-b", record: null },
    ], { nowMs: Date.parse("2031-01-01T00:00:00Z") });
    assert.ok(solution.reasons.includes("member_unassigned"));
  });

  it("an assignment for somebody who has left the crew is dropped, not reported as unknown", () => {
    const plan = buildCrewPlan({
      memberIds: ["user-a"],
      stops: [],
      assignments: [assignmentRow("user-a", "museum"), assignmentRow("user-gone", "market")],
    });
    const everyone = plan.branches.flatMap((b) => b.memberIds);
    assert.deepEqual(everyone, ["user-a"]);
    const solution = certifyCrewPlan(plan, [{ userId: "user-a", sessionId: "s-a", record: null }], {
      nowMs: Date.parse("2031-01-01T00:00:00Z"),
    });
    assert.ok(
      !solution.reasons.includes("unknown_member_in_branch"),
      "a departed member is not an unknown one; leaveCrew left their assignment row behind and the crew is not malformed",
    );
  });

  /**
   * A branch holding stops but nobody is KEPT. Dropping it would quietly
   * discard an itinerary somebody proposed; keeping it makes the state visible
   * as `empty_branch`, which is what it is.
   */
  it("a branch with stops and no members survives, so certifyCrewPlan reports empty_branch", () => {
    const plan = buildCrewPlan({
      memberIds: ["user-a"],
      stops: [stopRow({ branchId: "museum" }), stopRow({ branchId: "market" })],
      assignments: [assignmentRow("user-a", "museum")],
    });
    const market = plan.branches.find((b) => b.branchId === "market");
    assert.ok(market, "the market branch must not be dropped just because nobody is on it");
    assert.deepEqual(market!.memberIds, []);
    const solution = certifyCrewPlan(plan, [{ userId: "user-a", sessionId: "s-a", record: null }], {
      nowMs: Date.parse("2031-01-01T00:00:00Z"),
    });
    assert.ok(solution.reasons.includes("empty_branch"));
  });

  it("branch order is deterministic, so a client is not re-ordered between polls", () => {
    const plan = buildCrewPlan({
      memberIds: ["user-a", "user-b", "user-c"],
      stops: [],
      assignments: [
        assignmentRow("user-c", "zoo"),
        assignmentRow("user-a", "museum"),
        assignmentRow("user-b", "market"),
      ],
    });
    assert.deepEqual(plan.branches.map((b) => b.branchId), ["market", "museum", "zoo"]);
  });

  it("a trailing space does not make a second branch that looks identical in every UI", () => {
    assert.equal(canonBranchId(" museum "), "museum");
    const plan = buildCrewPlan({
      memberIds: ["user-a", "user-b"],
      stops: [stopRow({ branchId: "museum " })],
      assignments: [assignmentRow("user-a", " museum"), assignmentRow("user-b", "museum")],
    });
    assert.equal(plan.branches.length, 1);
    assert.equal(plan.branches[0].stops.length, 1);
  });

  /**
   * Case is NOT folded, unlike `canonCity`. A branch id is a label a client
   * chose, and merging `"Museum"` with `"museum"` would put two groups of
   * people on one itinerary.
   */
  it("case is NOT folded, because merging two branches merges two groups of people", () => {
    const plan = buildCrewPlan({
      memberIds: ["user-a", "user-b"],
      stops: [],
      assignments: [assignmentRow("user-a", "Museum"), assignmentRow("user-b", "museum")],
    });
    assert.equal(plan.branches.length, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Over HTTP, against the real router
// ═══════════════════════════════════════════════════════════════════════════

let server: http.Server;
let base: string;

const A_TOKEN = "crew-itin-a";
const B_TOKEN = "crew-itin-b";
const USER_A = "user-a";
const USER_B = "user-b";
const SESSION_A = "session-a";
const SESSION_B = "session-b";
const CREW_ID = "crew-1";

type Reply = { status: number; body: any };

function call(
  token: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Reply> {
  return new Promise((done, fail) => {
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
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let p: any;
          try { p = JSON.parse(raw); } catch { p = raw; }
          done({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", fail);
    if (payload) r.write(payload);
    r.end();
  });
}

const crewUrl = (suffix = "") => `/api/airport/sessions/${SESSION_A}/crew${suffix}`;

/**
 * A crew of two at one airport, A nine hours from departure and B five, so B's
 * deadline is the binding one and `min()` is a real test rather than "some time
 * came back".
 *
 * `departureHoursA` is a knob so a plan can be made to NOT fit without
 * inventing an absurd stop: a traveller an hour from their flight has very few
 * usable minutes.
 */
function stage(
  opts: {
    stops?: Record<string, any>[];
    assignments?: Record<string, any>[];
    failures?: Record<string, { message: string; code?: string }>;
    departureHoursA?: number;
    departureHoursB?: number;
  } = {},
) {
  const now = Date.now();
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [
      sessionRow({
        id: SESSION_A,
        user_id: USER_A,
        departure_time: new Date(now + (opts.departureHoursA ?? 9) * 3_600_000).toISOString(),
      }),
      sessionRow({
        id: SESSION_B,
        user_id: USER_B,
        departure_time: new Date(now + (opts.departureHoursB ?? 5) * 3_600_000).toISOString(),
      }),
    ],
    layover_crews: [
      {
        id: CREW_ID,
        city: "taoyuan",
        airport_ref: "TPE",
        created_by: USER_A,
        created_session_id: SESSION_A,
        title: "Noodles and a nap",
        meeting_point_label: "Terminal 2 food court",
        status: "open",
        max_members: 6,
        expires_at: new Date(now + 4 * 3_600_000).toISOString(),
        created_at: new Date(now - 60_000).toISOString(),
        updated_at: new Date(now - 60_000).toISOString(),
      },
    ],
    layover_crew_members: [
      { crew_id: CREW_ID, user_id: USER_A, session_id: SESSION_A, role: "owner", joined_at: new Date(now - 60_000).toISOString(), left_at: null },
      { crew_id: CREW_ID, user_id: USER_B, session_id: SESSION_B, role: "member", joined_at: new Date(now - 30_000).toISOString(), left_at: null },
    ],
    layover_crew_stops: opts.stops ?? [],
    layover_crew_branch_assignments: opts.assignments ?? [],
    layover_crew_location_grants: [],
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
    blocks: [],
    profiles: [
      { id: USER_A, handle: "ann", name: "Ann", avatar_url: null },
      { id: USER_B, handle: "bo", name: "Bo", avatar_url: null },
    ],
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

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", airportRouter);
  await new Promise<void>((done) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      done();
    });
  });
});

after(async () => {
  _setTestClient(null as any, false);
  await new Promise<void>((done) => server.close(() => done()));
});

describe("an unreadable itinerary REFUSES — it is never certified as feasible", () => {
  /**
   * THE HEADLINE PROPERTY. An empty plan certifies feasible, so a stops read
   * served as `[]` would publish `feasible: true` over an itinerary nobody
   * could measure, to a crew about to go and walk it. A refusal is a retry; a
   * false green is a missed flight.
   *
   * Asserted at the ENDPOINT, not at the store: a route that received
   * `ok: false` and carried on regardless would pass a store-level assertion.
   */
  it("GET /crew refuses when layover_crew_stops cannot be read", async () => {
    stage({ failures: { "layover_crew_stops:select": { message: "boom" } } });
    const res = await call(A_TOKEN, "GET", crewUrl());
    assert.notEqual(res.status, 200, "an unreadable itinerary must not be served as a certified plan");
    assert.equal(res.body?.solution, undefined);
  });

  /**
   * The other direction, and it is not symmetrical. An unreadable ASSIGNMENT
   * list reads as unsplit, which is the stricter arithmetic — but it is strict
   * about a plan that does not exist, and `split` would go out false over a
   * crew that had split.
   */
  it("GET /crew refuses when layover_crew_branch_assignments cannot be read", async () => {
    stage({ failures: { "layover_crew_branch_assignments:select": { message: "boom" } } });
    const res = await call(A_TOKEN, "GET", crewUrl());
    assert.notEqual(res.status, 200);
  });

  /** The positive control: the same stage without the failure must be 200. */
  it("and serves the plan when both reads succeed", async () => {
    stage();
    const res = await call(A_TOKEN, "GET", crewUrl());
    assert.equal(res.status, 200);
    assert.equal(res.body.solution.split, false);
    assert.equal(res.body.solution.branches.length, 1);
    assert.equal(res.body.solution.branches[0].branchId, UNSPLIT_BRANCH_ID);
    assert.equal(res.body.solution.branches[0].neededMinutes, 0);
    assert.deepEqual(res.body.itinerary.stops, []);
  });
});

describe("proposing a stop makes §14.1's per-branch verdicts reachable", () => {
  it("a stop's minutes reach the branch verdict, and the response is the re-certified crew", async () => {
    stage();
    const res = await call(A_TOKEN, "POST", crewUrl("/stops"), {
      title: "Noodles",
      durationMin: 45,
      insideAirport: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.itinerary.stops.length, 1);
    assert.equal(res.body.itinerary.stops[0].proposedBy, USER_A);
    assert.equal(
      res.body.solution.branches[0].neededMinutes,
      45,
      "the branch verdict must be computed over the stop that was just proposed, not over the empty plan",
    );
  });

  /**
   * THE VERDICT THE EMPTY PLAN COULD NEVER REACH. B is an hour from departure,
   * so a three-hour landside stop does not fit inside B's usable minutes — and
   * §14.1 takes the MINIMUM over the branch's members, not the average, so the
   * whole branch is infeasible even though A has nine hours.
   */
  it("a stop that does not fit the tightest member makes the plan infeasible", async () => {
    stage({ departureHoursB: 1 });
    const res = await call(A_TOKEN, "POST", crewUrl("/stops"), {
      title: "Across the city",
      durationMin: 120,
      travelMin: 60,
      insideAirport: false,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.solution.feasible, false);
    const branch = res.body.solution.branches[0];
    assert.equal(branch.feasible, false);
    assert.ok(
      branch.reasons.length > 0,
      "the branch must say WHY, or the per-branch verdict is a boolean nobody can act on",
    );
    const tightest = branch.perMemberSlackMin.find((m: any) => m.userId === USER_B);
    assert.ok(tightest && tightest.slackMin < 0, "the member who cannot make it must be named with negative slack");
  });

  /**
   * census L47: a landside stop whose journey nobody stated contributed its
   * dwell and nothing else, and the plan was certified over journeys that were
   * never measured. The refusal is the SOLO surface's function, reused — a
   * second copy is how the two would come to disagree.
   */
  it("a landside stop with no travel time is refused, not stored as a measured zero", async () => {
    const tables = stage();
    const res = await call(A_TOKEN, "POST", crewUrl("/stops"), {
      title: "Night market",
      durationMin: 60,
      insideAirport: false,
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body?.error?.message ?? res.body?.message ?? ""), /travel time/i);
    assert.equal(tables.layover_crew_stops.length, 0, "nothing may be written when the journey was never stated");
  });

  it("an airside stop's zero travel time IS a fact and is accepted", async () => {
    const tables = stage();
    const res = await call(A_TOKEN, "POST", crewUrl("/stops"), {
      title: "Airside noodles",
      durationMin: 30,
      insideAirport: true,
    });
    assert.equal(res.status, 200);
    assert.equal(tables.layover_crew_stops.length, 1);
    assert.equal(tables.layover_crew_stops[0].travel_min, 0);
  });

  it("a stop proposed by a non-member is refused", async () => {
    const tables = stage();
    tables.layover_crew_members = tables.layover_crew_members.filter((m) => m.user_id !== USER_B);
    const res = await call(B_TOKEN, "POST", `/api/airport/sessions/${SESSION_B}/crew/stops`, {
      title: "Not mine to plan",
      durationMin: 30,
      insideAirport: true,
    });
    assert.notEqual(res.status, 200);
    assert.equal(tables.layover_crew_stops.length, 0);
  });

  it("the per-branch stop cap is enforced", async () => {
    const now = Date.now();
    const full = Array.from({ length: 12 }, (_, i) => ({
      id: `stop-${i}`,
      crew_id: CREW_ID,
      branch_id: UNSPLIT_BRANCH_ID,
      stop_order: i,
      title: `Stop ${i}`,
      duration_min: 10,
      travel_min: 0,
      inside_airport: true,
      location_label: null,
      proposed_by: USER_A,
      created_at: new Date(now - 1000 + i).toISOString(),
      updated_at: new Date(now - 1000 + i).toISOString(),
    }));
    const tables = stage({ stops: full });
    const res = await call(A_TOKEN, "POST", crewUrl("/stops"), {
      title: "One too many",
      durationMin: 10,
      insideAirport: true,
    });
    assert.equal(res.status, 400);
    assert.equal(tables.layover_crew_stops.length, 12);
  });

  /**
   * The cap is per BRANCH, not per crew: a branch is what one person actually
   * walks, and a crew split three ways may legitimately hold 36 stops.
   */
  it("a full branch does not stop another branch from taking a stop", async () => {
    const now = Date.now();
    const full = Array.from({ length: 12 }, (_, i) => ({
      id: `stop-${i}`,
      crew_id: CREW_ID,
      branch_id: UNSPLIT_BRANCH_ID,
      stop_order: i,
      title: `Stop ${i}`,
      duration_min: 10,
      travel_min: 0,
      inside_airport: true,
      location_label: null,
      proposed_by: USER_A,
      created_at: new Date(now - 1000 + i).toISOString(),
      updated_at: new Date(now - 1000 + i).toISOString(),
    }));
    const tables = stage({ stops: full });
    const res = await call(A_TOKEN, "POST", crewUrl("/stops"), {
      title: "Museum instead",
      durationMin: 10,
      insideAirport: true,
      branchId: "museum",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(tables.layover_crew_stops.length, 13);
  });
});

describe("dropping a stop asserts the resulting state, not the call", () => {
  it("a stop id from another crew deletes nothing and is reported as such", async () => {
    const now = Date.now();
    const tables = stage({
      stops: [
        {
          id: "stop-elsewhere",
          crew_id: "another-crew",
          branch_id: UNSPLIT_BRANCH_ID,
          stop_order: 0,
          title: "Someone else's plan",
          duration_min: 30,
          travel_min: 0,
          inside_airport: true,
          location_label: null,
          proposed_by: "user-z",
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        },
      ],
    });
    const res = await call(A_TOKEN, "DELETE", crewUrl("/stops/stop-elsewhere"));
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(
      tables.layover_crew_stops.length,
      1,
      "the other crew's stop must still be there — and the answer must not have said success",
    );
  });

  it("a stop of this crew is dropped and the crew comes back re-certified", async () => {
    const now = Date.now();
    const tables = stage({
      stops: [
        {
          id: "stop-mine",
          crew_id: CREW_ID,
          branch_id: UNSPLIT_BRANCH_ID,
          stop_order: 0,
          title: "Noodles",
          duration_min: 45,
          travel_min: 0,
          inside_airport: true,
          location_label: null,
          proposed_by: USER_A,
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        },
      ],
    });
    const res = await call(A_TOKEN, "DELETE", crewUrl("/stops/stop-mine"));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(tables.layover_crew_stops.length, 0);
    assert.equal(res.body.solution.branches[0].neededMinutes, 0);
  });

  /**
   * ANY member may drop any of the crew's stops. A decision, not an omission:
   * a crew's plan has no owner, and "only the proposer may remove it" leaves a
   * crew unable to drop a stop proposed by somebody whose flight has gone.
   */
  it("a crewmate may drop a stop somebody else proposed", async () => {
    const now = Date.now();
    const tables = stage({
      stops: [
        {
          id: "stop-a",
          crew_id: CREW_ID,
          branch_id: UNSPLIT_BRANCH_ID,
          stop_order: 0,
          title: "Ann's idea",
          duration_min: 30,
          travel_min: 0,
          inside_airport: true,
          location_label: null,
          proposed_by: USER_A,
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        },
      ],
    });
    const res = await call(B_TOKEN, "DELETE", `/api/airport/sessions/${SESSION_B}/crew/stops/stop-a`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(tables.layover_crew_stops.length, 0);
  });
});

describe("the split is written whole, so a crew is never half-assigned", () => {
  it("PUT /branches splits the crew and the branches reach the wire", async () => {
    const now = Date.now();
    const tables = stage({
      stops: [
        {
          id: "stop-m", crew_id: CREW_ID, branch_id: "museum", stop_order: 0,
          title: "Museum", duration_min: 60, travel_min: 20, inside_airport: false,
          location_label: null, proposed_by: USER_A,
          created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
        },
      ],
    });
    const res = await call(A_TOKEN, "PUT", crewUrl("/branches"), {
      assignments: [
        { userId: USER_A, branchId: "museum" },
        { userId: USER_B, branchId: "lounge" },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.solution.split, true, "two branches is the spec's explicit split plan");
    assert.equal(tables.layover_crew_branch_assignments.length, 2);
    const museum = res.body.solution.branches.find((b: any) => b.branchId === "museum");
    const lounge = res.body.solution.branches.find((b: any) => b.branchId === "lounge");
    assert.ok(museum && lounge);
    assert.deepEqual(museum.memberIds, [USER_A]);
    assert.equal(museum.neededMinutes, 100, "60 dwell + 20 out + 20 back");
    assert.equal(lounge.neededMinutes, 0, "the lounge branch has no stops of its own");
  });

  /**
   * An empty array is the way back to unsplit, not a bad argument. The delete
   * alone expresses "we are all going together again".
   */
  it("an empty assignment list puts the crew back together", async () => {
    const tables = stage({
      assignments: [
        { crew_id: CREW_ID, user_id: USER_A, branch_id: "museum", assigned_by: USER_A, assigned_at: new Date().toISOString() },
      ],
    });
    const res = await call(A_TOKEN, "PUT", crewUrl("/branches"), { assignments: [] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.solution.split, false);
    assert.equal(res.body.solution.branches[0].branchId, UNSPLIT_BRANCH_ID);
    assert.equal(tables.layover_crew_branch_assignments.length, 0);
  });

  it("a split naming somebody outside the crew is refused and changes nothing", async () => {
    const tables = stage();
    const res = await call(A_TOKEN, "PUT", crewUrl("/branches"), {
      assignments: [{ userId: "user-stranger", branchId: "museum" }],
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(
      tables.layover_crew_branch_assignments.length,
      0,
      "the previous split must survive a refused one — the clear must not have run",
    );
  });

  it("a member named on two branches is refused before anything is written", async () => {
    const tables = stage();
    const res = await call(A_TOKEN, "PUT", crewUrl("/branches"), {
      assignments: [
        { userId: USER_A, branchId: "museum" },
        { userId: USER_A, branchId: "lounge" },
      ],
    });
    assert.equal(res.status, 400);
    assert.equal(tables.layover_crew_branch_assignments.length, 0);
  });

  it("an unreadable membership list refuses the split rather than clearing it", async () => {
    const tables = stage({
      assignments: [
        { crew_id: CREW_ID, user_id: USER_A, branch_id: "museum", assigned_by: USER_A, assigned_at: new Date().toISOString() },
      ],
      failures: { "layover_crew_members:select": { message: "boom" } },
    });
    const res = await call(A_TOKEN, "PUT", crewUrl("/branches"), {
      assignments: [{ userId: USER_A, branchId: "lounge" }],
    });
    assert.notEqual(res.status, 200);
    assert.equal(tables.layover_crew_branch_assignments.length, 1, "the previous split must still stand");
  });
});

describe("the source says what it does", () => {
  /**
   * The old call site was `unsplitPlan(solver.members, [])` with a comment
   * explaining that the empty plan was the honest thing to publish until a crew
   * could have an itinerary. It can now, so that call must be gone — and a
   * source assertion is the only way to pin "the empty plan is no longer what
   * gets certified" against a future edit that reintroduces it as a fallback.
   */
  it("routes/airport.ts no longer certifies the empty unsplit plan", () => {
    // Comments stripped first, the way the certification ratchet in
    // `layoverFeasibilityRecord.test.ts` does it: this file's own prose names
    // the old call site in order to explain why it is gone, and a scan that
    // counted that would be asserting against its own documentation.
    const src = readFileSync(resolvePath(SRC, "routes/airport.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const calls = (src.match(/unsplitPlan\s*\(/g) ?? []).length;
    assert.equal(
      calls, 0,
      "certifyCrewPlan must be given the crew's stored plan; an empty plan certifies FEASIBLE, so a fallback to it is a false green",
    );
    assert.match(src, /buildCrewPlan\s*\(/);
  });
});
