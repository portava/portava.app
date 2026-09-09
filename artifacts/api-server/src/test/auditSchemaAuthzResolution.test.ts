/**
 * audit:schema — a function claim resolves in `public` OR `authz`, and the
 * widening must not have bought that at the cost of the rule still biting.
 *
 * WHY THIS EXISTS. Until 2026-09-09 auditMigrationsVsLive resolved claimed
 * functions in `public` only. Seven live functions — authz.is_trip_crew (2334),
 * authz.accepted_trip_ids / shares_accepted_trip / accepted_trip_role /
 * geofence_trip_id (2337), authz.is_active_thread_member (2402),
 * authz.is_meetup_invitee (2460) — were therefore reported as missing on
 * portava-ci while every one of them existed, and two more (is_blocked,
 * viewer_in_call) had standing ALLOWLIST entries whose only job was to hide the
 * same blindness. An allowlist entry asserts "this object does not exist"; those
 * objects do, so the entries were false and are now deleted.
 *
 * The danger in widening a "does it exist" rule is a false pass. These cases
 * are the mutation: case 3 is the one that must stay red, and cases 1-2 are the
 * false positives that must go green. If someone later collapses the two sets
 * into one, or drops the authz lookup entirely, exactly one of these fails.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Imports the PURE predicate, not the auditor. `isMissing` compares two
// in-memory structures and touches no database, so this test needs no Supabase
// credential, no guard front door and no env at all. See the header of
// schemaClaimResolution.ts for why it was extracted — check:guard-coverage
// caught the earlier version of this file naming credential env vars.
import { isMissing, type LiveSchema } from "../scripts/lib/schemaClaimResolution.js";

/** A LiveSchema with nothing in it but the function sets under test. */
function schema(pub: string[], authz: string[], extra: Partial<LiveSchema> = {}): LiveSchema {
  return {
    relations: new Set(),
    columns: new Set(),
    functions: new Set(pub),
    authzFunctions: new Set(authz),
    indexes: new Set(),
    policies: new Set(),
    enums: new Set(),
    enumValues: new Set(),
    triggers: new Set(),
    rlsEnabled: new Set(),
    tableGrants: new Set(),
    routineGrants: new Set(),
    ...extra,
  };
}

const fnClaim = (name: string) =>
  ({ kind: "function", key: `function:${name}`, label: `function ${name}` }) as any;

describe("audit:schema — function claims resolve in public OR authz", () => {
  it("a function in public only is NOT missing", () => {
    assert.equal(isMissing(fnClaim("trip_kernel_execute"), schema(["trip_kernel_execute"], [])), false);
  });

  it("a function in authz only is NOT missing — the seven false positives", () => {
    for (const fn of [
      "is_trip_crew", "accepted_trip_ids", "shares_accepted_trip",
      "accepted_trip_role", "geofence_trip_id", "is_active_thread_member",
      "is_meetup_invitee",
    ]) {
      assert.equal(isMissing(fnClaim(fn), schema([], [fn])), false, `${fn} exists in authz`);
    }
  });

  it("THE MUTATION: a function in NEITHER schema is still MISSING", () => {
    // If this ever goes false the widening has become a blanket pass and
    // audit:schema stops being able to report a dropped function at all.
    assert.equal(isMissing(fnClaim("is_trip_crew"), schema([], [])), true);
    assert.equal(isMissing(fnClaim("trip_snapshot_fold"), schema(["something_else"], ["is_trip_crew"])), true);
  });

  it("a grantfn on an authz function is CHECKED, not skipped as absent", () => {
    // Before the widening, `!live.functions.has(fn)` was true for an authz
    // function, so the grant claim returned false — "not missing" — for the
    // wrong reason: the auditor thought the function did not exist. A missing
    // EXECUTE grant on a live authz predicate would have gone unreported.
    const live = schema([], ["is_trip_crew"], { routineGrants: new Set() });
    assert.equal(isMissing({ kind: "grantfn", key: "grantfn:is_trip_crew.authenticated", label: "x" } as any, live), true);

    const granted = schema([], ["is_trip_crew"], { routineGrants: new Set(["is_trip_crew.authenticated"]) });
    assert.equal(isMissing({ kind: "grantfn", key: "grantfn:is_trip_crew.authenticated", label: "x" } as any, granted), false);
  });

  it("a grantfn on a function in neither schema is still skipped (unchanged)", () => {
    assert.equal(isMissing({ kind: "grantfn", key: "grantfn:gone.authenticated", label: "x" } as any, schema([], [])), false);
  });
});
