/**
 * GET /trips/:tripId/structure — §5.1's stage spine becoming visible.
 *
 * WHAT WAS THERE BEFORE
 * =====================
 * trip_stages (2760), trip_legs (2761) and trip_plan_participants (2771) had
 * NO reader — not in this server, not in the app. Kernel commands from 2764,
 * 2765 and 2772 wrote them and nothing could see the result. A stage nobody
 * can be shown is not a stage; census-trips' own rule is that a table nothing
 * writes satisfies nothing, and this is its mirror.
 *
 * THE THREE THINGS PINNED HERE
 * ============================
 * 1. §9.1's PARTY is the `going` rows and only those. `interested` and `maybe`
 *    being counted as attending is the arithmetic error that makes a transport
 *    booking for six people who are four.
 * 2. A DANGLING reference is named, not dropped. The FKs make all three
 *    orphan lists empty today, which is exactly why they are reported: the day
 *    one is not, a silent drop is a row nobody knows is missing.
 * 3. A read that fails refuses the WHOLE response. A trip whose legs could not
 *    be read renders as a set of disconnected stages — a picture of a
 *    different trip, not a partial one.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { ATTENDING_STATE } from "../routes/tripStructure.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const MATE_ID  = "22222222-2222-2222-2222-222222222222";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";
const TRIP_ID  = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type Row = Record<string, any>;

function makeClient(tables: Record<string, Row[]>, errorOn: string[] = []) {
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token") return { data: { user: { id: OWNER_ID } }, error: null };
        if (token === "other-token") return { data: { user: { id: OTHER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from(table: string) {
      if (errorOn.includes(table)) {
        const f: any = {
          select: () => f, eq: () => f, in: () => f, order: () => f, limit: () => f,
          maybeSingle: async () => ({ data: null, error: { message: "unavailable" } }),
          then: (onF: any, onR: any) =>
            Promise.resolve({ data: null, error: { message: "unavailable" } }).then(onF, onR),
        };
        return f;
      }
      const filters: Array<(r: Row) => boolean> = [];
      let single = false;
      const settle = () => {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return { data: single ? rows[0] ?? null : rows, error: null };
      };
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        order: () => chain, limit: () => chain,
        maybeSingle: async () => { single = true; return settle(); },
        single: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      return chain;
    },
  };
}

const crew = [{ trip_id: TRIP_ID, user_id: OWNER_ID, status: "accepted", role: "owner" }];
const base = { trips: [{ id: TRIP_ID, owner_id: OWNER_ID }], trip_members: crew };

const stage = (o: Row = {}) => ({
  id: "s1", trip_id: TRIP_ID, stage_type: "city", place_id: null, city_id: "c1",
  timezone: "Europe/Paris", starts_at: null, ends_at: null, state: "planned", sequence: 1, ...o,
});
const leg = (o: Row = {}) => ({
  id: "l1", trip_id: TRIP_ID, from_stage_id: "s1", to_stage_id: "s2",
  leg_type: "train", starts_at: null, ends_at: null, source_ref: null, ...o,
});
const commitment = (o: Row = {}) => ({
  id: "c1", trip_id: TRIP_ID, stage_id: "s1", type: "event",
  starts_at: null, required_arrival_at: null, place_id: null,
  lateness_tolerance: null, prep_duration: null, flexibility: "flexible",
  confidence: null, source_ref: null, ...o,
});
const planItem = (o: Row = {}) => ({
  id: "pi1", trip_id: TRIP_ID, title: "Dinner", day_date: "2026-10-01",
  starts_at: null, removed_at: null, ...o,
});
const attend = (o: Row = {}) => ({
  plan_id: "pi1", user_id: OWNER_ID, attendance_state: "going", role: null, ...o,
});

let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); });
  });
}
after(() => { server?.close(); });

async function get(token = "owner-token") {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/structure`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function install(tables: Record<string, Row[]>, errorOn: string[] = []) {
  const c = makeClient({ ...base, ...tables }, errorOn);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
}

const empty = {
  trip_stages: [], trip_legs: [], trip_commitments: [],
  trip_plan_items: [], trip_plan_participants: [], trip_outcomes: [],
};

const outcome = (o: Row = {}) => ({
  id: "o1", trip_id: TRIP_ID, stage_id: null, plan_id: "pi1",
  outcome_type: "completed", occurred_at: "2026-10-01T20:00:00Z", evidence_json: {}, ...o,
});

beforeEach(async () => { if (!server) await start(); });

describe("§5.1 — the stage graph is served joined, not as flat lists", () => {
  it("each stage carries its legs and its commitments", async () => {
    install({
      ...empty,
      trip_stages: [stage({ id: "s1", sequence: 1 }), stage({ id: "s2", sequence: 2 })],
      trip_legs: [leg({ id: "l1", from_stage_id: "s1", to_stage_id: "s2" })],
      trip_commitments: [commitment({ id: "c1", stage_id: "s2" })],
    });
    const r = await get();
    assert.equal(r.status, 200);
    const s1 = r.body.stages.find((s: any) => s.id === "s1");
    const s2 = r.body.stages.find((s: any) => s.id === "s2");
    assert.deepEqual(s1.legsFrom, ["l1"]);
    assert.deepEqual(s1.legsTo, []);
    assert.deepEqual(s2.legsTo, ["l1"]);
    assert.deepEqual(s2.commitmentIds, ["c1"]);
    assert.deepEqual(s1.commitmentIds, []);
  });

  it("a commitment with no stage is not attributed to one", async () => {
    install({ ...empty, trip_stages: [stage()], trip_commitments: [commitment({ stage_id: null })] });
    const r = await get();
    assert.deepEqual(r.body.stages[0].commitmentIds, []);
    assert.deepEqual(r.body.orphanedCommitments, [],
      "a NULL stage_id is 'not attached', not 'attached to something missing'");
    assert.equal(r.body.commitments.length, 1, "the commitment must still be served");
  });

  it("intervals are passed through verbatim, not coerced to numbers", async () => {
    // A duration that cannot be read is not a duration of zero — the rule
    // routes/tripFeasibility.ts intervalToMinutes exists for. This route does
    // not parse at all, so it cannot get that wrong.
    install({
      ...empty, trip_stages: [stage()],
      trip_commitments: [commitment({ lateness_tolerance: "00:15:00", prep_duration: "not-an-interval" })],
    });
    const r = await get();
    assert.equal(r.body.commitments[0].latenessTolerance, "00:15:00");
    assert.equal(r.body.commitments[0].prepDuration, "not-an-interval");
  });
});

describe("§9.1 — the party is `going`, and only `going`", () => {
  it("interested and maybe are NOT counted as attending", async () => {
    // The error this prevents: booking transport for six people who are four.
    install({
      ...empty,
      trip_plan_items: [planItem({ id: "pi1" })],
      trip_plan_participants: [
        attend({ user_id: "u-going", attendance_state: "going" }),
        attend({ user_id: "u-interested", attendance_state: "interested" }),
        attend({ user_id: "u-maybe", attendance_state: "maybe" }),
        attend({ user_id: "u-cant", attendance_state: "cant_go" }),
        attend({ user_id: "u-left", attendance_state: "left" }),
      ],
    });
    const r = await get();
    const row = r.body.planAttendance.find((p: any) => p.planId === "pi1");
    assert.deepEqual(row.goingUserIds, ["u-going"]);
    assert.equal(row.participants.length, 5, "every state must still be served, not only the party");
    assert.equal(ATTENDING_STATE, "going");
  });

  it("attendance on a REMOVED plan item is not served as live attendance", async () => {
    install({
      ...empty,
      trip_plan_items: [planItem({ id: "pi-gone", removed_at: "2026-09-01T00:00:00Z" })],
      trip_plan_participants: [attend({ plan_id: "pi-gone" })],
    });
    const r = await get();
    assert.deepEqual(r.body.planAttendance, []);
  });
});

describe("§20.1 — outcomes outlive what they refer to", () => {
  it("an outcome naming a REMOVED plan item is served with planPresent true", async () => {
    // Removed is not gone: the row is still there, soft-deleted.
    install({
      ...empty,
      trip_plan_items: [planItem({ id: "pi1", removed_at: "2026-09-01T00:00:00Z" })],
      trip_outcomes: [outcome({ plan_id: "pi1" })],
    });
    const r = await get();
    assert.equal(r.body.outcomes[0].planPresent, true);
  });

  it("an outcome naming a plan this trip no longer has is a LABEL, not a defect", async () => {
    // §5.2 leaves plan_id without a foreign key precisely so this can happen:
    // the plan may be deleted, the fact that it happened must not be.
    install({ ...empty, trip_plan_items: [], trip_outcomes: [outcome({ plan_id: "pi-vanished" })] });
    const r = await get();
    assert.equal(r.body.outcomes.length, 1, "the outcome was dropped");
    assert.equal(r.body.outcomes[0].planPresent, false);
    // Explicitly NOT counted as orphaned data — that would read as corruption.
    assert.deepEqual(r.body.orphanedAttendance, []);
    assert.deepEqual(r.body.orphanedCommitments, []);
  });

  it("planPresent is NULL — not false — when the outcome names no plan at all", async () => {
    // Three states: attached and present, attached and gone, not attached.
    install({ ...empty, trip_outcomes: [outcome({ plan_id: null, stage_id: null })] });
    const r = await get();
    assert.equal(r.body.outcomes[0].planPresent, null);
    assert.equal(r.body.outcomes[0].stagePresent, null);
  });

  it("an unreadable outcomes table refuses the whole response", async () => {
    install({ ...empty, trip_stages: [stage()] }, ["trip_outcomes"]);
    const r = await get();
    assert.equal(r.status, 503);
  });
});

describe("§5.1 — a dangling reference is named, not dropped", () => {
  it("a leg pointing at a stage outside this trip is reported", async () => {
    install({
      ...empty,
      trip_stages: [stage({ id: "s1" })],
      trip_legs: [leg({ id: "l-bad", from_stage_id: "s1", to_stage_id: "s-elsewhere" })],
    });
    const r = await get();
    assert.deepEqual(r.body.orphanedLegs, ["l-bad"]);
    // Still served — a dangling row is information, not something to hide.
    assert.equal(r.body.legs.length, 1);
  });

  it("a commitment pointing at a missing stage is reported", async () => {
    install({
      ...empty,
      trip_stages: [stage({ id: "s1" })],
      trip_commitments: [commitment({ id: "c-bad", stage_id: "s-gone" })],
    });
    const r = await get();
    assert.deepEqual(r.body.orphanedCommitments, ["c-bad"]);
  });

  it("on a healthy trip all three orphan lists are empty — and present", async () => {
    // A count that should always be zero is worth SHOWING. An absent field
    // and a zero-length one are different, and only the second is a
    // measurement.
    install({ ...empty, trip_stages: [stage()], trip_legs: [], trip_commitments: [] });
    const r = await get();
    assert.deepEqual(r.body.orphanedLegs, []);
    assert.deepEqual(r.body.orphanedCommitments, []);
    assert.deepEqual(r.body.orphanedAttendance, []);
  });
});

describe("§5.1 — fail-closed", () => {
  for (const table of ["trip_stages", "trip_legs", "trip_commitments", "trip_plan_items"]) {
    it(`an unreadable ${table} refuses the whole response`, async () => {
      install({ ...empty, trip_stages: [stage()], trip_legs: [leg()] }, [table]);
      const r = await get();
      assert.equal(r.status, 503, `${table} did not refuse`);
      assert.equal(r.body.stages, undefined);
    });
  }

  it("an unreadable attendance table refuses too — an empty party is a claim", async () => {
    install({ ...empty, trip_plan_items: [planItem()] }, ["trip_plan_participants"]);
    const r = await get();
    assert.equal(r.status, 503);
    assert.equal(r.body.planAttendance, undefined);
  });

  it("a non-member is refused, not answered", async () => {
    install({ ...empty, trip_stages: [stage()] });
    const r = await get("other-token");
    assert.equal(r.status, 403);
    assert.equal(r.body.stages, undefined);
  });

  it("an empty trip is an ANSWER, with every list present", async () => {
    install(empty);
    const r = await get();
    assert.equal(r.status, 200);
    for (const k of ["stages", "legs", "commitments", "planAttendance", "outcomes", "orphanedLegs", "orphanedCommitments", "orphanedAttendance"]) {
      assert.ok(Array.isArray(r.body[k]), `${k} is missing`);
      assert.equal(r.body[k].length, 0);
    }
  });
});

describe("the route is reachable", () => {
  it("is registered in the router index", () => {
    const index = readFileSync(new URL("../routes/index.ts", import.meta.url), "utf8");
    assert.match(index, /import tripStructureRouter from "\.\/tripStructure"/);
    assert.match(index, /router\.use\(tripStructureRouter\)/);
  });
});
