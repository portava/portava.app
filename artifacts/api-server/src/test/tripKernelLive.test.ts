/**
 * Trips command kernel — LIVE DATABASE certification of the vertical slice.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS: 993 GREEN TESTS THAT NEVER RUN THE KERNEL
 * ══════════════════════════════════════════════════════════════════════════════
 * There are 49 `trip*.test.ts` suites — 993 tests, 0 skipped — and every one of
 * them runs against a double or against the TypeScript wrapped around the RPC.
 * They are worth having: they pin the SHAPE of the contract and they go red if
 * `lib/tripKernel.ts` starts inventing answers. What they cannot do is prove the
 * contract, because `public.trip_kernel_execute` is 103,400 characters of
 * PL/pgSQL and none of them executes a line of it. Ask what would turn them red
 * and the answer is "editing the TypeScript or editing the fake", which is not a
 * property of the deployed function.
 *
 * census-trips §35 certified the kernel end to end — thirteen commands,
 * idempotency, version conflict, presence freshness, replay determinism proven
 * equal at a cut point — by hand, through the Supabase management API. That is a
 * SNAPSHOT, not a guard: nothing turned red on its own if the kernel changed
 * underneath it, and the document would have gone on reporting a green that no
 * longer held. This file is that snapshot made executable. Everything it asserts
 * was first measured by hand at §35, so a failure here is a change in the
 * database, not an untested guess about it.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT IT ASSERTS, AND WHY EACH ONE IS HERE
 * ══════════════════════════════════════════════════════════════════════════════
 *   the slice          twelve commands across seven families — trip, stage, leg,
 *                      commitment, plan, attendance, presence, proposal, vote,
 *                      acceptance, outcome — each returning a MONOTONIC version
 *                      and an event id. A family that stops writing its row, or
 *                      stops bumping the aggregate, fails here.
 *   §22.4 idempotency  the same key replayed returns `duplicate: true` at the
 *                      ORIGINAL version. A kernel that re-applied the command
 *                      would return a NEW version and pass every fake test.
 *   §22 concurrency    a stale `expectedTripVersion` is refused
 *                      TRIP_VERSION_CONFLICT rather than silently winning.
 *   §22 fail-closed    four malformed payloads are refused as
 *                      TRIP_COMMAND_MALFORMED — not raised, not accepted. The
 *                      §35 finding TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT is
 *                      the case where that is NOT true, and it is pinned below
 *                      as the CURRENT behaviour with its ledger id, so closing
 *                      that blocker turns this file red on purpose.
 *
 * Snapshot/replay determinism is NOT here. `trip_snapshot_write` and
 * `trip_snapshot_verify_replay` are granted to `service_role`, so they are
 * reachable — but reaching them means `sc.rpc()` on functions no module in this
 * repository owns, and a test that names an RPC no writer names is a second
 * source of truth for that name. §35 records the measurement
 * (`from-seed == from-snapshot-at-v1`, whole-jsonb equality on a populated
 * state); it stays a measurement until a module owns those calls.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * NOTE ON SKIPPING
 * ══════════════════════════════════════════════════════════════════════════════
 * `.github/scripts/run-live-suite.sh` scores a live suite on its OUTPUT (pass > 0
 * AND skipped == 0), not on its exit code, so a run without credentials fails
 * the job rather than passing vacuously. Every skip below is `!CREDS`.
 *
 * Run: node --import tsx/esm --env-file-if-exists=.env --test \
 *        src/test/tripKernelLive.test.ts
 */
// FIRST import, deliberately: refuses to let this process reach an unsanctioned
// database before the Supabase client library is even loaded.
import "../lib/ciSupabaseGuard.mjs";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { deleteFixtureUser, findUserByEmail, fixtureEmail, fixtureLabel } from "./liveFixtureUsers.js";
import { executeTripCommand, type TripCommand, type TripKernelResult } from "../lib/tripKernel.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CREDS = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

const admin = (): SupabaseClient =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const TAG = "tripkern_live_";
const EMAIL_OWNER = fixtureEmail(`${TAG}owner@portava-test.invalid`);

/** Every idempotency key this run writes starts with this, so a key from one run
 *  can never be mistaken for a replay of another's. */
const KEY_PREFIX = `tripkern-${randomUUID().slice(0, 8)}-`;
const key = (s: string): string => `${KEY_PREFIX}${s}`;

let sc: SupabaseClient;
let owner = "";
/** The trip this run creates. Deleting the owner cascades it away. */
const TRIP_ID = randomUUID();

async function ensureUser(email: string, handle: string): Promise<string> {
  const { data: created, error } = await sc.auth.admin.createUser({
    email, password: `${TAG}Pw!23456`, email_confirm: true,
  });
  let id = created?.user?.id ?? "";
  if (error || !id) id = await findUserByEmail(sc, email);
  if (!id) throw new Error(`could not create or find test user ${email}`);
  const { error: pErr } = await sc.from("profiles").upsert({ id, handle, name: handle }, { onConflict: "id" });
  if (pErr) throw new Error(`could not upsert profile ${handle} for ${email}: ${pErr.message}`);
  return id;
}

function cmd(over: Pick<TripCommand, "type" | "idempotencyKey"> & Partial<TripCommand>): TripCommand {
  return {
    commandId: randomUUID(),
    tripId: TRIP_ID,
    actorUserId: owner,
    expectedTripVersion: null,
    payload: {},
    ...over,
  };
}

/** Run a command and REQUIRE it to succeed, naming the rejection if it does not. */
async function ok(over: Pick<TripCommand, "type" | "idempotencyKey"> & Partial<TripCommand>) {
  const r = await executeTripCommand(sc, cmd(over));
  assert.equal(r.ok, true, `${over.type} was rejected: ${JSON.stringify(r)}`);
  return r as Extract<TripKernelResult, { ok: true }>;
}

/** Run a command and REQUIRE it to be refused with this reason. */
async function refused(reason: string, over: Pick<TripCommand, "type" | "idempotencyKey"> & Partial<TripCommand>) {
  const r = await executeTripCommand(sc, cmd(over));
  assert.equal(r.ok, false, `${over.type} was ACCEPTED and should not have been: ${JSON.stringify(r)}`);
  assert.equal((r as any).reason, reason, `${over.type}: ${JSON.stringify(r)}`);
  return r as Extract<TripKernelResult, { ok: false }>;
}

/**
 * The slice is built ONCE in `before` and asserted by the suites below, because
 * every command after the first depends on the aggregate the previous one left.
 * `versions` is the ordered record of what the kernel answered.
 */
const versions: Array<[string, number]> = [];
let stageOne = "";
let stageTwo = "";
let planId = "";
let proposalId = "";
let joinPlanVersion = -1;

before(async () => {
  if (!CREDS) return;
  sc = admin();
  owner = await ensureUser(EMAIL_OWNER, fixtureLabel(`${TAG}owner`));

  const step = async (label: string, over: Pick<TripCommand, "type" | "idempotencyKey"> & Partial<TripCommand>) => {
    const r = await ok(over);
    versions.push([label, r.version]);
    return r;
  };

  await step("CREATE_TRIP", {
    type: "CREATE_TRIP", idempotencyKey: key("create"),
    // destination_city is present because it MUST be: see the
    // TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT suite at the end of this file.
    payload: { title: "tripkern live slice", destination_city: "Da Nang", destination_country: "Vietnam", visibility: "private" },
  });

  stageOne = (await step("ADD_STAGE_1", {
    type: "ADD_STAGE", idempotencyKey: key("stage-1"),
    payload: {
      stage_type: "city", city_id: randomUUID(), timezone: "Asia/Ho_Chi_Minh", sequence: 1,
      starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-01T20:00:00Z",
    },
  })).result.id;

  stageTwo = (await step("ADD_STAGE_2", {
    type: "ADD_STAGE", idempotencyKey: key("stage-2"),
    payload: {
      stage_type: "city", city_id: randomUUID(), timezone: "Asia/Ho_Chi_Minh", sequence: 2,
      starts_at: "2026-10-02T08:00:00Z", ends_at: "2026-10-02T20:00:00Z",
    },
  })).result.id;

  await step("ADD_LEG", {
    type: "ADD_LEG", idempotencyKey: key("leg"),
    payload: {
      from_stage_id: stageOne, to_stage_id: stageTwo, leg_type: "bus",
      starts_at: "2026-10-01T20:30:00Z", ends_at: "2026-10-02T04:00:00Z",
    },
  });

  // §7's own worked example: an activity at 19:00 with a required arrival of
  // 18:45. The feasibility VERDICT is computed in TypeScript and pinned by
  // tripFeasibilityEngine.test.ts; what is proven here is that the row the
  // engine reads is the row the kernel writes.
  await step("ADD_COMMITMENT", {
    type: "ADD_COMMITMENT", idempotencyKey: key("commitment"),
    payload: {
      stage_id: stageTwo, type: "event",
      starts_at: "2026-10-02T19:00:00Z", required_arrival_at: "2026-10-02T18:45:00Z",
      prep_duration: "00:20:00", lateness_tolerance: "00:05:00",
      confidence: 0.9, flexibility: "fixed",
    },
  });

  planId = (await step("ADD_PLAN", {
    type: "ADD_PLAN", idempotencyKey: key("plan"),
    payload: { title: "Dinner", stage_id: stageTwo, day_date: "2026-10-02" },
  })).result.id;

  const joined = await step("JOIN_PLAN", {
    type: "JOIN_PLAN", idempotencyKey: key("join-plan"),
    payload: { plan_id: planId },
  });
  joinPlanVersion = joined.version;

  await step("SET_PRESENCE", {
    type: "SET_PRESENCE", idempotencyKey: key("presence"),
    payload: {
      presence_state: "at_plan", stage_id: stageTwo, ttl_seconds: 600,
      confidence: 0.8, source: "explicit", visibility: "crew",
    },
  });

  proposalId = (await step("CREATE_PROPOSAL", {
    type: "CREATE_PROPOSAL", idempotencyKey: key("proposal"),
    payload: { proposal_type: "stage_change", payload_json: { stage_id: stageTwo }, decision_rule: "host" },
  })).result.id;

  await step("VOTE_ON_PROPOSAL", {
    type: "VOTE_ON_PROPOSAL", idempotencyKey: key("vote"),
    payload: { proposal_id: proposalId, vote: "yes" },
  });

  await step("ACCEPT_PROPOSAL", {
    type: "ACCEPT_PROPOSAL", idempotencyKey: key("accept"),
    payload: { proposal_id: proposalId },
  });

  await step("RECORD_OUTCOME", {
    type: "RECORD_OUTCOME", idempotencyKey: key("outcome"),
    payload: { outcome_type: "completed", stage_id: stageTwo, plan_id: planId, occurred_at: "2026-10-02T22:00:00Z" },
  });
});

after(async () => {
  if (!CREDS || !sc) return;
  // trip_events / receipts / stages / legs / commitments / plans / presence /
  // proposals / votes / outcomes all hang off trips.id or the owner, and both
  // cascade from auth.users. The trip is deleted explicitly first so a failure
  // to remove the user does not silently leave the aggregate behind.
  const { error } = await sc.from("trips").delete().eq("id", TRIP_ID);
  if (error) console.error(`[tripKernelLive] trip cleanup failed: ${error.message}`);
  if (owner) await deleteFixtureUser(sc, owner);
});

describe("the slice — twelve commands, seven families, one aggregate", () => {
  it("every command was accepted, in order, by the deployed function", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    assert.deepEqual(versions.map(([label]) => label), [
      "CREATE_TRIP", "ADD_STAGE_1", "ADD_STAGE_2", "ADD_LEG", "ADD_COMMITMENT",
      "ADD_PLAN", "JOIN_PLAN", "SET_PRESENCE", "CREATE_PROPOSAL",
      "VOTE_ON_PROPOSAL", "ACCEPT_PROPOSAL", "RECORD_OUTCOME",
    ]);
  });

  it("the aggregate version is STRICTLY monotonic — every command was a transition", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    // The point is not that versions rise; it is that NONE of the twelve was a
    // no-op. A family that stops writing its row but still returns ok would
    // repeat a version here, and every fake-backed suite would stay green.
    const nums = versions.map(([, v]) => v);
    assert.deepEqual(nums, [...Array(nums.length)].map((_, i) => nums[0]! + i),
      `versions were ${JSON.stringify(versions)}`);
  });

  it("the rows the read routes serve are actually there", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    // routes/tripStructure.ts reads exactly these. A kernel that answered ok
    // without writing would pass every assertion above and fail this one.
    //
    // The queries are written out one per table rather than looped over a table
    // NAME, for the reason routes/tripStructure.ts gives in its own header:
    // check:write-path-columns resolves `.from()`/`.select()` statically, and a
    // variable table name makes every column here invisible to the one guard
    // that would catch a column this database does not have. Writing them out
    // also forced the keys to be looked up rather than assumed — three of these
    // eight tables have NO `id`: trip_presence is keyed (trip_id, user_id),
    // trip_proposal_votes (proposal_id, user_id) and carries no trip_id at all,
    // and trip_plan_participants is keyed (plan_id, user_id).
    const rows = async (label: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
      // supabase-js RESOLVES on a database error: an unbound `error` would make
      // a failed read read as an empty table, which is exactly the shape that
      // silently passes a count assertion.
      const { data, error } = await q;
      if (error) throw new Error(`read ${label} failed: ${error.message}`);
      if (!Array.isArray(data)) throw new Error(`read ${label} returned a non-array body`);
      return data as any[];
    };

    assert.deepEqual({
      trip_stages: (await rows("trip_stages", sc.from("trip_stages").select("id").eq("trip_id", TRIP_ID))).length,
      trip_legs: (await rows("trip_legs", sc.from("trip_legs").select("id").eq("trip_id", TRIP_ID))).length,
      trip_commitments: (await rows("trip_commitments", sc.from("trip_commitments").select("id").eq("trip_id", TRIP_ID))).length,
      trip_outcomes: (await rows("trip_outcomes", sc.from("trip_outcomes").select("id").eq("trip_id", TRIP_ID))).length,
      trip_proposals: (await rows("trip_proposals", sc.from("trip_proposals").select("id").eq("trip_id", TRIP_ID))).length,
      trip_presence: (await rows("trip_presence", sc.from("trip_presence").select("user_id").eq("trip_id", TRIP_ID))).length,
      trip_proposal_votes: (await rows("trip_proposal_votes", sc.from("trip_proposal_votes").select("user_id").eq("proposal_id", proposalId))).length,
    }, {
      trip_stages: 2, trip_legs: 1, trip_commitments: 1, trip_outcomes: 1,
      trip_proposals: 1, trip_presence: 1, trip_proposal_votes: 1,
    });

    // §9.1: the party is the rows in `going`, and JOIN_PLAN is how one gets there.
    const att = await rows("trip_plan_participants",
      sc.from("trip_plan_participants").select("attendance_state").eq("plan_id", planId));
    assert.deepEqual(att.map((r) => r.attendance_state), ["going"]);
  });

  it("the accepted proposal is `accepted`, and says so about its own effect", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const { data, error } = await sc
      .from("trip_proposals").select("status, decision_rule").eq("id", proposalId).maybeSingle();
    if (error) throw new Error(`read trip_proposals failed: ${error.message}`);
    assert.equal(data?.status, "accepted");
    assert.equal(data?.decision_rule, "host");
  });
});

describe("§22.4 idempotency — the same key is the same answer, not a second transition", () => {
  it("replaying JOIN_PLAN's key returns duplicate:true at the ORIGINAL version", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const r = await ok({ type: "JOIN_PLAN", idempotencyKey: key("join-plan"), payload: { plan_id: planId } });
    assert.equal(r.duplicate, true, "a replayed key produced a FRESH transition");
    // The load-bearing half. `duplicate: true` with a new version would mean the
    // command ran again and the receipt was written afterwards.
    assert.equal(r.version, joinPlanVersion,
      `replay returned version ${r.version}, the original was ${joinPlanVersion}`);
  });

  it("the replay left no second attendance row", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    const { data, error } = await sc.from("trip_plan_participants").select("plan_id").eq("plan_id", planId);
    if (error) throw new Error(`read trip_plan_participants failed: ${error.message}`);
    if (!Array.isArray(data)) throw new Error("read trip_plan_participants returned a non-array body");
    assert.equal(data.length, 1);
  });
});

describe("§22 optimistic concurrency — a stale expected version cannot win", () => {
  it("expectedTripVersion behind head is refused TRIP_VERSION_CONFLICT", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    await refused("TRIP_VERSION_CONFLICT", {
      type: "ADD_GOAL", idempotencyKey: key("stale-goal"),
      expectedTripVersion: 1, payload: { title: "stale" },
    });
  });
});

describe("fail-closed — a malformed payload is refused, not raised and not accepted", () => {
  // Each of these is a CHECK constraint the family catches in its own
  // BEGIN … EXCEPTION and converts to a structured, PERMANENT rejection. They
  // are here because "the kernel rejects bad input" is the claim that a double
  // can restate but not test: the constraints live in the database.
  it("a stage with neither place_id nor city_id — trip_stages_one_anchor", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    await refused("TRIP_COMMAND_MALFORMED", {
      type: "ADD_STAGE", idempotencyKey: key("bad-anchor"),
      payload: { stage_type: "city", timezone: "Asia/Ho_Chi_Minh", sequence: 99 },
    });
  });

  it("a commitment type outside the vocabulary — trip_commitments_type_known", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    await refused("TRIP_COMMAND_MALFORMED", {
      type: "ADD_COMMITMENT", idempotencyKey: key("bad-commitment-type"),
      payload: { stage_id: stageTwo, type: "show", starts_at: "2026-10-02T19:00:00Z", flexibility: "fixed" },
    });
  });

  it("a proposal type outside the vocabulary — trip_proposals_type_known", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    await refused("TRIP_COMMAND_MALFORMED", {
      type: "CREATE_PROPOSAL", idempotencyKey: key("bad-proposal-type"),
      payload: { proposal_type: "change_stage", payload_json: {}, decision_rule: "host" },
    });
  });

  it("a text confidence on a numeric column", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    await refused("TRIP_COMMAND_MALFORMED", {
      type: "SET_PRESENCE", idempotencyKey: key("bad-confidence"),
      payload: {
        presence_state: "at_plan", stage_id: stageTwo, ttl_seconds: 600,
        confidence: "high", source: "explicit", visibility: "crew",
      },
    });
  });
});

describe("TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT — pinned as the CURRENT behaviour", () => {
  it("CREATE_TRIP with no destination_city reports an OUTAGE, not a malformed command", async (t) => {
    if (!CREDS) return t.skip("no live credentials");
    // This asserts a DEFECT, deliberately, and it is on the blocker ledger under
    // that id. Every other family wraps its INSERT (2764's ADD_STAGE catches
    // check_violation and returns TRIP_COMMAND_MALFORMED); the trip family
    // (2450) does not, so destination_city's NOT NULL raises 23502 straight out
    // of the function and executeTripCommand reports the throw as
    // TRIP_KERNEL_UNAVAILABLE — a reason meaning "try again" for a command that
    // can never succeed.
    //
    // It is pinned rather than described because a comment does not go red. When
    // the migration that wraps that INSERT lands, this test fails, and the
    // expected reason becomes TRIP_COMMAND_MALFORMED in the same change that
    // earns it. `POST /trips` sends exactly this payload for a draft — its own
    // comment says "Trips without title/city are saved as drafts" — so this is
    // reachable, not contrived.
    const r = await executeTripCommand(sc, {
      commandId: randomUUID(),
      tripId: randomUUID(),
      actorUserId: owner,
      expectedTripVersion: null,
      idempotencyKey: key("draft-no-city"),
      type: "CREATE_TRIP",
      payload: { title: "tripkern draft with no city" },
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "TRIP_KERNEL_UNAVAILABLE",
      "the trip family's INSERT is now guarded — close TRIP_KERNEL_CREATE_TRIP_UNGUARDED_INSERT and expect TRIP_COMMAND_MALFORMED here");
  });
});
