/**
 * Trip Kernel — the §5.1 stage command family (census-trips TR78's writer).
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE, SAID FIRST
 * ===============================================
 * The stage family's BEHAVIOUR lives in plpgsql (migration 2764), and 2764 is
 * not rehearsed on any Supabase database — measured 2026-09-09, both portava-ci
 * and production carry 2420's original plan-family-only kernel, and migrations
 * 2450/2500/2590 have never been applied to either. So there is no Supabase
 * database anywhere with a kernel this family could be exercised against.
 *
 * Behaviour is instead exercised by db/harness/run.sh, a local PostgreSQL 16
 * cluster: it applies 2764 to the real 2590 body, runs the actual commands, and
 * checks the rows, the events, the version bumps and the refusals. That harness
 * needs a PostgreSQL installation and is not part of `npm test`.
 *
 * What THIS file checks is the CONTRACT — that the command types, the event
 * vocabulary and the rejection reasons agree between the TypeScript side and the
 * migration that implements them. That agreement is exactly what broke in this
 * repo before — a reason declared in TypeScript with no producer, an event type
 * emitted by SQL that no consumer had heard of — so it is what this file pins.
 *
 * It is worth being precise about the division, because the harness found a
 * defect this file could not: the first draft of 2764 set v_event_type on all
 * three branches and v_family on none, so every stage event was filed under the
 * plan family. Every assertion below passed on that draft. A contract test
 * checks that two files agree on a NAME; it cannot check what the name does.
 *
 * The migration's own postconditions carry the rest, and they run when it does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TRIP_EVENT_TYPES } from "../lib/tripKernel.js";

const MIGRATION = new URL("../migrations/2764_trip_kernel_stage_family.sql", import.meta.url);
const sql = readFileSync(MIGRATION, "utf8");
const ts = readFileSync(new URL("../lib/tripKernel.ts", import.meta.url), "utf8");

describe("§5.1 stage family — the TS contract and the migration agree", () => {
  it("every stage command type the migration dispatches is declared in TypeScript", () => {
    for (const cmd of ["ADD_STAGE", "UPDATE_STAGE", "REMOVE_STAGE"]) {
      assert.ok(sql.includes(`'${cmd}'`), `${cmd} missing from the migration`);
      assert.ok(ts.includes(`"${cmd}"`), `${cmd} missing from TripCommandType`);
    }
  });

  it("every stage event type the migration emits is in TRIP_EVENT_TYPES", () => {
    // The reverse of the defect this repo already found once: SQL emitting a
    // type no consumer subscribes to. Consumers read TRIP_EVENT_TYPES.
    for (const ev of ["trip.stage_added", "trip.stage_updated", "trip.stage_removed"]) {
      assert.ok(sql.includes(`'${ev}'`), `${ev} not emitted by the migration`);
      assert.ok(
        (TRIP_EVENT_TYPES as readonly string[]).includes(ev),
        `${ev} is emitted by SQL but absent from TRIP_EVENT_TYPES`,
      );
    }
  });

  it("every rejection reason the migration returns is in TripKernelReason", () => {
    for (const reason of ["TRIP_STAGE_NOT_FOUND", "TRIP_STAGE_SEQUENCE_TAKEN"]) {
      assert.ok(sql.includes(`'${reason}'`), `${reason} not returned by the migration`);
      assert.ok(ts.includes(`"${reason}"`), `${reason} missing from TripKernelReason`);
    }
  });

  it("the stage family emits NO event type the vocabulary has not declared", () => {
    // Guards the direction the previous test does not: a new 'trip.stage_*'
    // string appearing in the migration without a matching declaration.
    const emitted = [...sql.matchAll(/'(trip\.stage_[a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(emitted.length >= 3, "the scan found no stage events — it is not reading the migration");
    for (const ev of new Set(emitted)) {
      assert.ok(
        (TRIP_EVENT_TYPES as readonly string[]).includes(ev!),
        `${ev} is emitted but undeclared`,
      );
    }
  });
});

describe("§4 — the migration cannot be applied to a stale kernel", () => {
  it("asserts its base carries 2590 before touching anything", () => {
    // This is the assertion that refused the real apply against portava-ci,
    // whose kernel is still 2420's. Without it the stage family would have been
    // grafted onto a function missing the trip and participant families, and it
    // would have applied cleanly.
    assert.match(sql, /SET_TRIP_COVER' in d\) = 0 THEN[\s\S]{0,200}RAISE EXCEPTION/);
    assert.match(sql, /Apply 2450 -> 2500 -> 2590 first/);
  });

  it("asserts each anchor occurs EXACTLY once before replacing it", () => {
    // A replace() against an anchor that occurs twice would edit one site and
    // silently leave the other; against zero it is a no-op that still reports
    // success. Both are counted.
    const guards = [...sql.matchAll(/expected 1', n/g)];
    assert.equal(guards.length, 3, `expected 3 exactly-once anchor guards, found ${guards.length}`);
  });

  it("re-checks the guarantees a careless rewrite would drop", () => {
    for (const survivor of [
      "TRIP_VERSION_CONFLICT",
      "authz.is_accepted_trip_member",
      "trip_command_receipts",
      "trip_outbox",
    ]) {
      assert.ok(
        sql.includes(`position('${survivor}' in d) = 0 THEN RAISE EXCEPTION`),
        `the postconditions do not verify ${survivor} survived`,
      );
    }
    // And the count, not just the presence: two trip-level range checks.
    assert.match(sql, /expected the 2 pre-existing trip-level range checks/);
  });
});

describe("§5.1 stage family — the ledger attribution the harness found missing", () => {
  it("all three branches set v_family to 'stage', not the kernel's 'plan' default", () => {
    // The kernel sets v_family := 'plan' before the CASE and every non-plan
    // branch overrides it. A stage branch that forgets writes its event into
    // trip_events.payload_json under family 'plan', which is silently wrong:
    // the row is there, the type is right, and every consumer that filters by
    // family sees a plan event. This was the actual first-draft defect.
    const assignments = sql.match(/v_family\s+:= 'stage';/g) ?? [];
    assert.equal(assignments.length, 3, "expected one 'stage' family assignment per branch");
  });

  it("the migration refuses itself if that count ever changes", () => {
    // The assertion above pins the source. This one pins the MIGRATION's own
    // postcondition, so the defect cannot come back through a database that
    // was migrated by an older copy of the file.
    assert.match(sql, /expected 3 stage-family assignments, found/);
  });

  it("each stage branch pairs its family with its event type", () => {
    for (const evt of ["trip.stage_added", "trip.stage_updated", "trip.stage_removed"]) {
      const idx = sql.indexOf(`v_event_type := '${evt}'`);
      assert.ok(idx > 0, `${evt} not emitted`);
      const preceding = sql.slice(Math.max(0, idx - 120), idx);
      assert.match(preceding, /v_family\s+:= 'stage';/,
        `${evt} is emitted without the stage family being set immediately before it`);
    }
  });
});
