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
    authzRoutineGrants: new Set(),
    collidingFunctionNames: new Set(),
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

/**
 * THE SECOND HALF OF THE WIDENING, and the defect it cost to find.
 *
 * The case above — "a grantfn on an authz function is CHECKED, not skipped" —
 * was written as a feature and it was one. What it did not say is where the
 * GRANT is looked up. `routineGrants` was built from
 * `routine_schema = 'public'` only, so the moment an authz function stopped
 * short-circuiting, its grant was checked against a catalogue that could not
 * contain it. CI measured the result on 2026-09-09: eight grants reported
 * missing, and all eight are live — `has_function_privilege(anon, …)` is true
 * for every one of viewer_in_call, is_trip_crew, accepted_trip_ids,
 * shares_accepted_trip, accepted_trip_role, geofence_trip_id,
 * is_active_thread_member and is_meetup_invitee.
 *
 * These are the mutations for the fix. Each fails if `authzRoutineGrants` is
 * dropped, folded into `routineGrants`, or consulted in place of it.
 */
const grant = (fn: string, grantee = "anon") =>
  ({ kind: "grantfn", key: `grantfn:${fn}.${grantee}`, label: `grant execute on ${fn}() to ${grantee}` }) as any;

describe("audit:schema — a grant on an authz function is found where it actually lives", () => {
  it("THE DEFECT: an authz function whose grant is in authz is NOT missing", () => {
    // The eight from the CI run, each as its own assertion so a partial
    // regression names the function it broke.
    for (const fn of [
      "viewer_in_call", "is_trip_crew", "accepted_trip_ids", "shares_accepted_trip",
      "accepted_trip_role", "geofence_trip_id", "is_active_thread_member", "is_meetup_invitee",
    ]) {
      const live = schema([], [fn], { authzRoutineGrants: new Set([`${fn}.anon`]) });
      assert.equal(isMissing(grant(fn), live), false, `${fn}: the anon grant is live in authz`);
    }
  });

  it("THE MUTATION: an authz function with NO grant anywhere is still MISSING", () => {
    // The half that must stay red. If reading both catalogues ever becomes
    // "assume granted", a predicate that RLS calls and anon cannot execute
    // stops being reportable — which is the failure the grant claim exists for.
    const live = schema([], ["is_trip_crew"], { authzRoutineGrants: new Set(["is_trip_crew.authenticated"]) });
    assert.equal(isMissing(grant("is_trip_crew", "anon"), live), true);
  });

  it("a public function's grant is still read from the public catalogue", () => {
    // The regression direction: the fix must ADD a lookup, not move one.
    const live = schema(["pg_policies_snapshot"], [], { routineGrants: new Set(["pg_policies_snapshot.service_role"]) });
    assert.equal(isMissing(grant("pg_policies_snapshot", "service_role"), live), false);
    assert.equal(isMissing(grant("pg_policies_snapshot", "anon"), live), true);
  });

  it("the name-key really is a name-key — either schema satisfies the claim", () => {
    // Not an endorsement: this pins the LIMITATION so it cannot change by
    // accident. `is_accepted_trip_member` exists in both schemas on portava-ci
    // and is the one 2337 grant that did NOT report missing during the defect,
    // because the public twin carried anon. `collidingFunctionNames` is why the
    // auditor now prints that case instead of trusting it.
    const publicTwinOnly = schema(["is_accepted_trip_member"], ["is_accepted_trip_member"], {
      routineGrants: new Set(["is_accepted_trip_member.anon"]),
      authzRoutineGrants: new Set(),
    });
    assert.equal(isMissing(grant("is_accepted_trip_member"), publicTwinOnly), false,
      "a name-keyed claim is satisfied by the public twin — the case the NOTE reports");
  });
});
