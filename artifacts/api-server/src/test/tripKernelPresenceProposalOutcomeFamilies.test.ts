/**
 * Trip Kernel — §10.1 presence, §9.3 proposals, §20.1 outcomes
 * (census-trips TR87, TR88, TR90).
 *
 * The invariants every family shares are in tripKernelFamilyContract.test.ts.
 * This file holds what is specific to 2768, and every item in it is a rule that
 * would be indefensible to get wrong rather than a restatement of the code.
 *
 * Behaviour is db/harness/run.sh; this file reads SQL as text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../migrations/2768_trip_kernel_presence_proposal_outcome_families.sql", import.meta.url),
  "utf8",
);
const presence2767 = readFileSync(
  new URL("../migrations/2767_trip_presence_spec_vocabulary.sql", import.meta.url),
  "utf8",
);
const ts = readFileSync(new URL("../lib/tripKernel.ts", import.meta.url), "utf8");

describe("§10.1 presence", () => {
  it("uses the spec's command name, SET_PRESENCE", () => {
    // §4.1 lists SET_PRESENCE among the command examples. A local ADD_PRESENCE /
    // UPDATE_PRESENCE pair would have been two divergences at once: the name,
    // and the shape.
    assert.ok(sql.includes("'SET_PRESENCE'"));
    assert.ok(!sql.includes("'ADD_PRESENCE'"), "invented an ADD_ name the spec does not use");
    assert.ok(!sql.includes("'UPDATE_PRESENCE'"), "invented an UPDATE_ name the spec does not use");
  });

  it("is an upsert, because a participant has exactly one presence", () => {
    assert.match(sql, /ON CONFLICT \(trip_id, user_id\) DO UPDATE SET/,
      "two commands for one keyed row would let a client observe a participant with none");
  });

  it("refuses to write anyone else's presence", () => {
    assert.match(sql, /'reason', 'TRIP_PRESENCE_NOT_SELF'/);
    assert.match(sql, /\(v_payload->>'user_id'\)::uuid IS DISTINCT FROM v_actor/,
      "the self check is missing or does not compare against the actor");
    // The write itself must name the ACTOR, never the payload. A check that
    // passes followed by an insert of payload.user_id is not a check.
    assert.match(sql, /VALUES \(v_trip_id, v_actor, v_payload->>'presence_state'/,
      "the presence row is written from the payload's user_id rather than the actor's id");
  });

  it("requires a TTL: a presence row that never expires is not presence", () => {
    // §10.1: "Every presence row carries observed_at, expires_at, source,
    // confidence, and visibility." §10.2 is about never drawing a stale
    // location as current — which is impossible if nothing ever goes stale.
    assert.match(sql, /expires_at or ttl_seconds is required/);
    assert.match(sql, /make_interval\(secs =>/, "ttl_seconds is accepted but never converted");
  });

  it("writes only states 2767 allows, and 2767 is the spec's vocabulary", () => {
    // The pairing is the point: this test fails if either the migration starts
    // writing a state the table refuses, or the table's vocabulary drifts back.
    for (const state of ["available", "free", "getting_ready", "transiting",
                         "at_plan", "resting", "returning", "offline"]) {
      assert.ok(presence2767.includes(`'${state}'`),
        `§10.1 state ${state} is not in 2767's CHECK`);
    }
    for (const dead of ["here", "nearby", "en_route", "away", "unknown"]) {
      assert.ok(!sql.includes(`'${dead}'`),
        `2768 references ${dead}, a state 2767 removed`);
    }
  });

  it("defaults source to explicit rather than leaving provenance blank", () => {
    assert.match(sql, /coalesce\(v_payload->>'source','explicit'\)/,
      "a presence row whose provenance nobody recorded must still record one");
  });
});

describe("§9.3 proposals", () => {
  it("uses the spec's command and event names", () => {
    // §4.1 names CREATE_PROPOSAL and ACCEPT_PROPOSAL; §4.2 names
    // trip.proposal_accepted. These are not ours to rename.
    assert.ok(sql.includes("'CREATE_PROPOSAL'"));
    assert.ok(sql.includes("'ACCEPT_PROPOSAL'"));
    assert.ok(sql.includes("'trip.proposal_accepted'"));
    assert.ok(!sql.includes("'ADD_PROPOSAL'"));
  });

  it("gates the two DECISIONS on host and leaves CREATION to crew", () => {
    // §9.3's whole shape is that anyone may propose and not everyone may
    // decide. Collapsing the two capabilities loses the distinction the table
    // exists to record.
    assert.match(sql, /WHEN 'CREATE_PROPOSAL' THEN 'crew'/);
    assert.match(sql, /WHEN 'ACCEPT_PROPOSAL' THEN 'host'/);
    assert.match(sql, /WHEN 'REJECT_PROPOSAL' THEN 'host'/);
  });

  it("refuses to apply if the host gating is ever widened", () => {
    // The postcondition, not just the source. A capability widened in a
    // database this file never read would otherwise go unnoticed.
    assert.match(sql, /ACCEPT_PROPOSAL is not host-gated/);
    assert.match(sql, /REJECT_PROPOSAL is not host-gated/);
  });

  it("decides only pending proposals", () => {
    // Accepting an already-rejected proposal is not a late accept; it is a
    // second decision overwriting a recorded first.
    const guards = sql.match(/IF v_proposal_status <> 'pending' THEN/g) ?? [];
    assert.equal(guards.length, 2, "expected the pending guard on both ACCEPT and REJECT");
    assert.match(sql, /'reason', 'TRIP_PROPOSAL_NOT_PENDING'/);
    assert.ok(ts.includes('"TRIP_PROPOSAL_NOT_PENDING"'));
  });

  it("locks the row before reading its status", () => {
    // Without FOR UPDATE two concurrent decisions both read 'pending' and both
    // write, and the second silently wins.
    const locked = sql.match(/FROM public\.trip_proposals\n\s*WHERE id = v_proposal_id AND trip_id = v_trip_id FOR UPDATE/g) ?? [];
    assert.equal(locked.length, 2, "a proposal decision is read without FOR UPDATE");
  });

  it("records the version the proposal was reasoning about", () => {
    assert.match(sql, /coalesce\(\(v_payload->>'affected_version'\)::bigint, v_current\)/,
      "affected_version is left NULL, so nothing records what the proposal saw");
  });

  it("says out loud that §9.3 governance is not implemented", () => {
    // The decisionRule column does not exist. Host is an interim choice and the
    // migration must not read as though governance were done.
    assert.match(sql, /decisionRule/);
    assert.match(sql, /PROPOSAL_DECISION_RULE/,
      "the missing governance column is not pointed at a ledger entry");
  });
});

describe("§20.1 outcomes", () => {
  it("is append-only: no update, no remove", () => {
    // A record of what happened that can be edited afterwards is not evidence.
    assert.ok(sql.includes("'RECORD_OUTCOME'"));
    assert.ok(!sql.includes("'UPDATE_OUTCOME'"), "outcomes must not be editable");
    assert.ok(!sql.includes("'REMOVE_OUTCOME'"), "outcomes must not be deletable");
    assert.ok(!ts.includes('"UPDATE_OUTCOME"'));
    assert.ok(!ts.includes('"REMOVE_OUTCOME"'));
  });

  it("checks a named stage belongs to this trip", () => {
    assert.match(sql, /WHERE id = \(v_payload->>'stage_id'\)::uuid AND trip_id = v_trip_id/);
  });

  it("leaves plan_id unvalidated, deliberately and in writing", () => {
    // 2763 gave trip_outcomes exactly two foreign keys and plan_id is not one
    // of them: an outcome outlives the plan it refers to (§20.1). Adding a
    // lookup here would quietly reintroduce the dependency that choice removed.
    assert.ok(!sql.includes("FROM public.trip_plan_items"),
      "plan_id is being resolved against a table, which reintroduces the dependency 2763 removed");
  });
});

describe("2768 does not claim what it did not build", () => {
  it("says why trip_snapshots has no command here", () => {
    // A snapshot is a projection artifact for replay (§22.1). Writing one
    // through the kernel would bump trips.version, so its aggregate_version
    // would be stale the instant it was written.
    assert.match(sql, /trip_snapshots \(TR89\) IS DELIBERATELY NOT HERE/);
    assert.ok(!sql.includes("'WRITE_SNAPSHOT'"),
      "a snapshot command was added despite the header saying it should not be");
  });
});
