/**
 * Trip Kernel — the §5.1 leg and commitment families (census-trips TR79, TR81).
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE, SAID FIRST
 * ===============================================
 * Behaviour lives in plpgsql (migration 2765) and is exercised by
 * db/harness/run.sh, a local PostgreSQL cluster, because no Supabase database
 * carries even the 2590 kernel these families are built on
 * (docs/architecture/blocker-ledger.md, TRIP_KERNEL_NEVER_DEPLOYED). That
 * harness is not part of `npm test` — it needs a PostgreSQL installation.
 *
 * This file pins the CONTRACT: that the command types, the event vocabulary and
 * the refusal reasons agree between TypeScript and the migration. The division
 * matters and is not theoretical — the harness caught a defect in 2764 that
 * every contract test passed, because a contract test checks that two files
 * agree on a NAME and cannot check what the name does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TRIP_EVENT_TYPES } from "../lib/tripKernel.js";

const sql = readFileSync(
  new URL("../migrations/2765_trip_kernel_leg_and_commitment_families.sql", import.meta.url),
  "utf8",
);
const ts = readFileSync(new URL("../lib/tripKernel.ts", import.meta.url), "utf8");

const COMMANDS = [
  "ADD_LEG", "UPDATE_LEG", "REMOVE_LEG",
  "ADD_COMMITMENT", "UPDATE_COMMITMENT", "REMOVE_COMMITMENT",
] as const;
const EVENTS = [
  "trip.leg_added", "trip.leg_updated", "trip.leg_removed",
  "trip.commitment_added", "trip.commitment_updated", "trip.commitment_removed",
] as const;

describe("§5.1 leg and commitment families — TS and the migration agree", () => {
  it("every command the migration dispatches is declared in TypeScript", () => {
    for (const cmd of COMMANDS) {
      assert.ok(sql.includes(`'${cmd}'`), `${cmd} missing from the migration`);
      assert.ok(ts.includes(`"${cmd}"`), `${cmd} missing from TripCommandType`);
    }
  });

  it("every event the migration emits is in TRIP_EVENT_TYPES", () => {
    for (const evt of EVENTS) {
      assert.ok(sql.includes(`'${evt}'`), `${evt} not emitted by the migration`);
      assert.ok((TRIP_EVENT_TYPES as readonly string[]).includes(evt),
        `${evt} is emitted by SQL and unknown to every consumer`);
    }
  });

  it("every refusal reason the migration returns is declared in TypeScript", () => {
    for (const reason of ["TRIP_LEG_NOT_FOUND", "TRIP_COMMITMENT_NOT_FOUND"]) {
      assert.ok(sql.includes(`'${reason}'`), `${reason} not returned by the migration`);
      assert.ok(ts.includes(`"${reason}"`), `${reason} missing from TripKernelReason`);
    }
  });

  it("declares no reason TypeScript has no producer for", () => {
    // The reverse direction, which is the one that rots quietly: a reason named
    // in TypeScript that nothing ever returns reads as a handled case forever.
    for (const reason of ["TRIP_LEG_NOT_FOUND", "TRIP_COMMITMENT_NOT_FOUND"]) {
      const returns = sql.match(new RegExp(`'reason',\\s*'${reason}'`, "g")) ?? [];
      assert.ok(returns.length >= 1, `${reason} is declared but never returned`);
    }
  });
});

describe("§5.1 leg and commitment families — the invariants the migration must keep", () => {
  it("both leg endpoints are checked against the trip, not left to the foreign key", () => {
    // The FK refuses a stage that does not exist. It does NOT refuse a stage
    // that exists on a DIFFERENT trip, and a leg joining two trips' stages
    // reads fine and corrupts every consumer downstream. Three ownership
    // checks: from_stage_id and to_stage_id on ADD_LEG, and the pair on
    // UPDATE_LEG's patch — plus the two on the commitment family.
    const checks = sql.match(/FROM public\.trip_stages\n\s*WHERE id = \(v_(?:payload|patch)->>'[a-z_]+'\)::uuid AND trip_id = v_trip_id/g) ?? [];
    assert.ok(checks.length >= 6,
      `expected at least 6 stage-ownership checks, found ${checks.length}`);
  });

  it("all six branches set v_family, three per family", () => {
    // 2764's first draft set v_event_type on every branch and v_family on none,
    // so every stage event was filed under the plan family — the value the
    // kernel sets before the CASE. Only executing the command found it.
    const legs = sql.match(/v_family\s+:= 'leg';/g) ?? [];
    const commits = sql.match(/v_family\s+:= 'commitment';/g) ?? [];
    assert.equal(legs.length, 3, "expected 3 leg-family assignments");
    assert.equal(commits.length, 3, "expected 3 commitment-family assignments");
  });

  it("each event type is preceded by its own family assignment", () => {
    for (const evt of EVENTS) {
      const family = evt.startsWith("trip.leg") ? "leg" : "commitment";
      const idx = sql.indexOf(`v_event_type := '${evt}'`);
      assert.ok(idx > 0, `${evt} not emitted`);
      const preceding = sql.slice(Math.max(0, idx - 120), idx);
      assert.match(preceding, new RegExp(`v_family\\s+:= '${family}';`),
        `${evt} is emitted without v_family being set to '${family}' immediately before it`);
    }
  });

  it("refuses to apply to a kernel without the stage family", () => {
    // Legs reference stages. Applying this to a pre-2764 kernel would produce a
    // function dispatching ADD_LEG at branches whose terminator does not exist.
    assert.match(sql, /the installed kernel predates 2764/);
    assert.match(sql, /predates 2590/);
  });

  it("carries the postconditions that would catch a damaged transform", () => {
    for (const survivor of ["ADD_STAGE", "SET_TRIP_COVER", "JOIN_VIA_LINK", "CREATE_TRIP",
                            "TRIP_VERSION_CONFLICT", "authz.is_accepted_trip_member",
                            "trip_command_receipts", "trip_outbox"]) {
      assert.ok(sql.includes(`'${survivor}'`), `${survivor} is not checked for survival`);
    }
    assert.match(sql, /expected exactly 6/, "the branch-count invariant is missing");
  });
});
