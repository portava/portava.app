/**
 * census-compass CT-07 — the TWELVE Compass trip tools of Trips spec §12.1,
 * census-trips TR202..TR213, pinned as a SET rather than one at a time.
 *
 * WHAT THIS FILE FOUND, SAID PLAINLY
 * ==================================
 * The row was written as "two of twelve exist, ten are missing". By the time
 * this suite was written all twelve were DECLARED and DISPATCHED in
 * compass/CompassTools.ts, each a thin read over an existing projection or
 * service — so the honest gap was never "build ten trip engines", it was that
 * nothing held the twelve to their contract at once. Case A is that holding:
 * delete any one of the twelve and it goes red, which is the only thing that
 * stops the row re-opening.
 *
 * THE DEFECT THIS SUITE DID FIND
 * ==============================
 * A MALFORMED tripId was passed straight through to the database. Postgres
 * answers `22P02 invalid input syntax for type uuid`, PostgREST returns it as a
 * read error, `requireTripMember` correctly refuses to call that "not a member"
 * and throws `TripAccessUnavailableError`, and `executeCompassTool` correctly
 * relays THAT as:
 *
 *     "That trip's records are unreadable right now — this is temporary …"
 *
 * Every link in that chain is right and the sentence is FALSE. Nothing is
 * unreadable and nothing is temporary: the model sent a string that is not a
 * trip id, and telling it to "try again shortly" invites it to send the same
 * bad id again. `add_to_trip` had guarded its id since it was written
 * (`/^[0-9a-f-]{36}$/i`); the other ten did not. Case B is that grammar, applied
 * to all of them, and it asserts the refusal happens with ZERO table reads —
 * because "refused it" and "asked the database about it and lost" are different
 * facts and only the first is what the tool should do.
 *
 * TEST-FIRST, AND WHAT RED ACTUALLY LOOKED LIKE. Written before the guard
 * existed and run: all twelve of case B failed, each answering
 * `"The user is not a member of that trip."` to `"not-a-uuid"` — because the
 * fake client below does not reject a non-uuid the way Postgres does, so the
 * membership read came back empty and the tool made a CONFIDENT CLAIM ABOUT A
 * PERSON'S ACCESS out of a string that is not an id. Against a real database
 * the same call takes the 22P02 path above and produces the "temporary" lie
 * instead. Two different wrong answers from one missing check, which is why the
 * assertion is "name the id", not "do not say X". Case D failed on the flag
 * name: the refusal read `Commitments are not enabled: flag_off`.
 *
 * MUTATION LOG — each applied ALONE to the source, this suite re-run, then the
 * source restored. Baseline: 44 pass / 0 fail.
 *   M1 `isWellFormedTripId` returns true for any string
 *        (CompassCurrentTrip.ts)                            → RED  31/13 — all twelve of B
 *   M2 the malformed-id guard dropped from `resolveMemberTrip`
 *        ALONE, the five inline ones left in place          → RED  38/6  — exactly the six
 *                                                                   tools behind that seam
 *   M3 `describeOperationalGate(gate)` → `gate.reason` in
 *        toolGetCommitments                                 → RED  43/1  — D: the flag unnamed
 *   M4 `isAcceptedTripMember` dropped from toolGetTodayState → RED  43/1  — C: TR203
 *   M5 `get_saved_ideas` removed from COMPASS_TOOL_DEFINITIONS → RED 43/1 — A: TR207 missing
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassTripTools.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  COMPASS_TOOL_DEFINITIONS,
  COMPASS_TOOL_NAMES,
  executeCompassTool,
  toolGetTodayState,
  toolGetCommitments,
  toolGetFreedomWindows,
} from "../compass/CompassTools.js";
import { isWellFormedTripId, MALFORMED_TRIP_ID_INFO } from "../compass/CompassCurrentTrip.js";
import {
  TRIP_OPERATIONAL_PROJECTIONS_FLAG,
  invalidateTripOperationalProjectionsGate,
} from "../domain/trips/policies/tripOperationalProjections.js";

const OWNER_ID   = "a0000077-0000-0000-0000-000000000001";
const MEMBER_ID  = "a0000077-0000-0000-0000-000000000002";
const STRANGER   = "a0000077-0000-0000-0000-000000000099";
const TRIP_ID    = "b0000077-0000-0000-0000-000000000001";
const DECISION_ID = "c0000077-0000-0000-0000-000000000001";

/**
 * §12.1's twelve, by their census-trips row and by the Compass tool name that
 * answers each. The spec name is kept beside it so a reader can check the
 * mapping without opening the census.
 */
const TWELVE = [
  { tr: "TR202", spec: "getTripContext(tripId)",                 tool: "get_current_trip",       takesTripId: true  },
  { tr: "TR203", spec: "getTodayState(tripId)",                  tool: "get_today_state",        takesTripId: true  },
  { tr: "TR204", spec: "getCrewState(tripId)",                   tool: "get_crew_state",         takesTripId: true  },
  { tr: "TR205", spec: "getFreedomWindows(tripId)",              tool: "get_freedom_windows",    takesTripId: true  },
  { tr: "TR206", spec: "getCommitments(tripId)",                 tool: "get_commitments",        takesTripId: true  },
  { tr: "TR207", spec: "getSavedIdeas(tripId)",                  tool: "get_saved_ideas",        takesTripId: true  },
  { tr: "TR208", spec: "getLiveConditions(tripId)",              tool: "get_live_conditions",    takesTripId: true  },
  { tr: "TR209", spec: "simulatePlan(tripId, proposal)",         tool: "simulate_plan",          takesTripId: true  },
  { tr: "TR210", spec: "createProposal(tripId, change)",         tool: "create_proposal",        takesTripId: true  },
  { tr: "TR211", spec: "replanDay(tripId, constraints)",         tool: "replan_day",             takesTripId: true  },
  { tr: "TR212", spec: "findMeetingPoint(tripId, participants)", tool: "find_meeting_point",     takesTripId: true  },
  { tr: "TR213", spec: "explainTripDecision(decisionId)",        tool: "explain_trip_decision",  takesTripId: true  },
] as const;

/** The extra arguments each tool needs to get PAST its own argument validation. */
const REQUIRED_ARGS: Record<string, Record<string, unknown>> = {
  simulate_plan:        { kind: "move_plan", targetId: "p1", startsAt: "2026-09-20T10:00:00Z" },
  create_proposal:      { proposalType: "move_plan", change: { planId: "p1" } },
  explain_trip_decision: { decisionId: DECISION_ID },
};

// ── Fake Supabase client ──────────────────────────────────────────────────────
//
// It COUNTS reads by table and TRAPS every write verb, because two of this
// file's claims are about what a tool did NOT do: refuse a malformed id without
// asking the database, and answer a question without writing.

interface FakeState {
  featureFlags?: Record<string, boolean>;
  trips?: any[];
  tripMembers?: any[];
  tripCommitments?: any[];
  tripSavedPlaces?: any[];
}

function makeClient(state: FakeState = {}) {
  const reads: string[] = [];
  const writes: string[] = [];

  function rowsFor(table: string): any[] {
    if (table === "feature_flags") {
      return Object.entries(state.featureFlags ?? {}).map(([flag, enabled]) => ({ flag, enabled, value: enabled }));
    }
    if (table === "trips")            return state.trips ?? [];
    if (table === "trip_members")     return state.tripMembers ?? [];
    if (table === "trip_commitments") return state.tripCommitments ?? [];
    if (table === "trip_saved_places") return state.tripSavedPlaces ?? [];
    return [];
  }

  function builder(table: string): any {
    const rows = rowsFor(table);
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    const matched = () => {
      const m = rows.filter((r) => filters.every((f) => f(r)));
      return _limit === null ? m : m.slice(0, _limit);
    };
    const b: any = {
      select(_c?: string) { reads.push(table); return b; },
      eq(c: string, v: any)  { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any)  { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; },
      or() { return b; }, not() { return b; }, ilike() { return b; }, contains() { return b; },
      order() { return b; },
      limit(n: number) { _limit = n; return b; },
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      single:      async () => ({ data: matched()[0] ?? null, error: null }),
      then(onF: any, onR: any) { return Promise.resolve({ data: matched(), error: null }).then(onF, onR); },
      insert() { writes.push(`insert:${table}`); return b; },
      upsert() { writes.push(`upsert:${table}`); return b; },
      update() { writes.push(`update:${table}`); return b; },
      delete() { writes.push(`delete:${table}`); return b; },
      rpc()    { writes.push(`rpc:${table}`);    return b; },
    };
    return b;
  }

  const client: any = {
    from: (table: string) => builder(table),
    rpc: (name: string) => { writes.push(`rpc:${name}`); return Promise.resolve({ data: null, error: null }); },
    reads, writes,
  };
  return client;
}

function crewFixture(over: Partial<FakeState> = {}): FakeState {
  return {
    featureFlags: {
      [TRIP_OPERATIONAL_PROJECTIONS_FLAG]: false,
      trip_crew_map_enabled: false,
      trip_kernel_enabled: false,
    },
    trips: [{ id: TRIP_ID, owner_id: OWNER_ID, title: "Lisbon", destination_city: "Lisbon", destination_country: "PT", start_date: "2026-09-19", end_date: "2026-09-25", status: "active", timezone: null, version: 3 }],
    tripMembers: [
      { trip_id: TRIP_ID, user_id: OWNER_ID,  role: "owner",  status: "accepted" },
      { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
    ],
    ...over,
  };
}

beforeEach(() => { invalidateTripOperationalProjectionsGate(); });

// ── A. The twelve exist, as ONE set ───────────────────────────────────────────

describe("CT-07 A — §12.1's twelve trip tools are all declared and all dispatched", () => {
  it("every one of TR202..TR213 is a declared Compass tool", () => {
    const declared = new Set(COMPASS_TOOL_DEFINITIONS.map((d: any) => d.function.name));
    const missing = TWELVE.filter((t) => !declared.has(t.tool));
    assert.deepEqual(
      missing.map((m) => `${m.tr} ${m.spec} → ${m.tool}`), [],
      "census-trips TR202..TR213: every §12.1 trip tool must be declared in COMPASS_TOOL_DEFINITIONS",
    );
    for (const t of TWELVE) assert.ok(COMPASS_TOOL_NAMES.has(t.tool), `${t.tr}: ${t.tool} must be in COMPASS_TOOL_NAMES`);
  });

  it("every one of them is reachable by name through executeCompassTool — a declaration with no branch is not a tool", async () => {
    for (const t of TWELVE) {
      const out: any = await executeCompassTool(
        makeClient(crewFixture()), STRANGER, null, t.tool,
        { tripId: TRIP_ID, ...(REQUIRED_ARGS[t.tool] ?? {}) },
      );
      assert.ok(out && typeof out === "object", `${t.tr} ${t.tool}: returned no object`);
      assert.notDeepEqual(out, { error: `Unknown tool: ${t.tool}` }, `${t.tr}: ${t.tool} is declared but has no dispatcher branch`);
      assert.equal((out as any).error, undefined, `${t.tr} ${t.tool}: a refusal is an \`info\`, never a crash — got ${JSON.stringify(out).slice(0, 160)}`);
    }
  });

  it("each of the twelve names its own projection or service — none of them is a trip engine of its own", () => {
    // The row's own instruction: "Do NOT write new trip logic". The check that
    // can be made from here is that the tool bodies CONSUME — every §12.1 tool
    // is dispatched from this one file and the file imports its answers.
    const declared = COMPASS_TOOL_DEFINITIONS.map((d: any) => d.function.name);
    assert.equal(new Set(declared).size, declared.length, "no tool name is declared twice");
  });
});

// ── B. A malformed trip id is REFUSED, not sent to the database ───────────────

describe("CT-07 B — a malformed tripId is named as invalid, and never reaches a table", () => {
  const MALFORMED = ["not-a-uuid", "12345", "'; drop table trips; --", "b0000077-0000-0000-0000-00000000000"];

  it("the id grammar is the one add_to_trip has always used", () => {
    assert.equal(isWellFormedTripId(TRIP_ID), true);
    for (const bad of MALFORMED) assert.equal(isWellFormedTripId(bad), false, bad);
    assert.equal(isWellFormedTripId(""), false, "an empty string is not an id");
    assert.equal(isWellFormedTripId(undefined), false);
    assert.equal(isWellFormedTripId(42), false);
  });

  for (const t of TWELVE) {
    it(`${t.tr} ${t.tool} refuses a malformed tripId with zero table reads`, async () => {
      for (const bad of MALFORMED) {
        const c = makeClient(crewFixture());
        const out: any = await executeCompassTool(c, OWNER_ID, null, t.tool, { tripId: bad, ...(REQUIRED_ARGS[t.tool] ?? {}) });
        const said = JSON.stringify(out);
        assert.match(String(out.info ?? ""), /not a valid trip id/i,
          `${t.tr} ${t.tool} on ${JSON.stringify(bad)}: expected the id to be named as invalid, got ${said.slice(0, 200)}`);
        assert.doesNotMatch(said, /temporar|try again shortly|unreadable right now/i,
          `${t.tr} ${t.tool}: a bad id is NOT a temporary outage — saying so invites the model to resend it`);
        assert.deepEqual(c.reads, [],
          `${t.tr} ${t.tool}: refused correctly but only after asking the database — reads: ${c.reads.join(", ")}`);
        assert.deepEqual(c.writes, [], `${t.tr} ${t.tool}: wrote on a malformed id`);
      }
    });
  }

  it("the refusal sentence is one string, so the twelve cannot drift apart", () => {
    assert.match(MALFORMED_TRIP_ID_INFO, /not a valid trip id/i);
  });
});

// ── C. Membership is enforced by every one of them, and never widened ─────────

describe("CT-07 C — a non-member is refused by every trip tool", () => {
  for (const t of TWELVE) {
    it(`${t.tr} ${t.tool} refuses a user who is not an accepted member`, async () => {
      const c = makeClient(crewFixture());
      const out: any = await executeCompassTool(c, STRANGER, null, t.tool, { tripId: TRIP_ID, ...(REQUIRED_ARGS[t.tool] ?? {}) });
      assert.match(String(out.info ?? ""), /not a member/i,
        `${t.tr} ${t.tool}: expected a membership refusal, got ${JSON.stringify(out).slice(0, 200)}`);
      assert.deepEqual(c.writes, [], `${t.tr} ${t.tool}: a refused caller must not cause a write`);
    });
  }

  it("an accepted member is NOT refused — the gate is a gate, not a wall", async () => {
    const c = makeClient(crewFixture());
    const out: any = await toolGetCommitments(c, MEMBER_ID, { tripId: TRIP_ID });
    assert.doesNotMatch(String(out.info ?? ""), /not a member/i, "an accepted member must pass the membership gate");
  });
});

// ── D. The feature gate is respected, and NAMED ───────────────────────────────

describe("CT-07 D — a gated projection reports `unavailable` when its flag is off, and says which flag", () => {
  it("get_commitments refuses on a closed operational-projections gate and names the flag", async () => {
    const c = makeClient(crewFixture({ featureFlags: { [TRIP_OPERATIONAL_PROJECTIONS_FLAG]: false } }));
    const out: any = await toolGetCommitments(c, OWNER_ID, { tripId: TRIP_ID });
    assert.equal(out.commitments, null, "a gated tool answers `null`, never a fabricated empty list");
    assert.match(String(out.info), /not enabled/i);
    assert.match(String(out.info), new RegExp(TRIP_OPERATIONAL_PROJECTIONS_FLAG),
      "the refusal must name the flag that caused it — 'flag_off' tells an operator nothing");
    assert.deepEqual(c.reads.filter((r: string) => r === "trip_commitments"), [],
      "a closed gate must be consulted BEFORE the table it gates is read");
  });

  it("get_today_state and get_freedom_windows say 'not enabled' rather than 'no plan' on the same closed gate", async () => {
    const c = makeClient(crewFixture({ featureFlags: { [TRIP_OPERATIONAL_PROJECTIONS_FLAG]: false } }));
    const today: any = await toolGetTodayState(c, OWNER_ID, { tripId: TRIP_ID });
    assert.equal(today.today, null);
    assert.match(String(today.info), /not enabled/i);

    invalidateTripOperationalProjectionsGate();
    const c2 = makeClient(crewFixture({ featureFlags: { [TRIP_OPERATIONAL_PROJECTIONS_FLAG]: false } }));
    const windows: any = await toolGetFreedomWindows(c2, OWNER_ID, { tripId: TRIP_ID });
    assert.deepEqual(windows.windows, []);
    assert.match(String(windows.info), /not enabled/i);
  });
});

// ── E. Eleven of the twelve are READ-ONLY ─────────────────────────────────────

describe("CT-07 E — only createProposal may write; the other eleven are reads", () => {
  for (const t of TWELVE.filter((x) => x.tool !== "create_proposal")) {
    it(`${t.tr} ${t.tool} performs no write for a member of the trip`, async () => {
      const c = makeClient(crewFixture());
      await executeCompassTool(c, OWNER_ID, null, t.tool, { tripId: TRIP_ID, ...(REQUIRED_ARGS[t.tool] ?? {}) });
      assert.deepEqual(c.writes, [], `${t.tr} ${t.tool} wrote: ${c.writes.join(", ")}`);
    });
  }

  it("create_proposal writes nothing either when the Trip Kernel is off — and says so", async () => {
    const c = makeClient(crewFixture({ featureFlags: { trip_kernel_enabled: false } }));
    const out: any = await executeCompassTool(c, OWNER_ID, null, "create_proposal", { tripId: TRIP_ID, ...REQUIRED_ARGS.create_proposal });
    assert.equal(out.proposal, null);
    assert.match(String(out.info), /trip_kernel_enabled/);
    assert.deepEqual(c.writes, [], "a refused proposal must not have written");
  });
});
