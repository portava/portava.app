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
import { readFileSync, readdirSync } from "node:fs";

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

/**
 * An ALLOWLIST entry asserts "live deliberately differs from what this migration
 * claims". That assertion has a JUSTIFICATION living in another file, and nothing
 * made the two move together — the entry would survive its own reason being
 * deleted, silently hiding real drift from then on.
 *
 * This binds the trip_reservations_owner_delete entry to the migration that
 * earns it. 0172 creates the policy; 2784 drops it and revokes DELETE from
 * `authenticated` so that clients cancel and only the service deletes. If 2784
 * ever stops carrying either half, the entry stops being true and this fails.
 */
describe("audit:schema ALLOWLIST — trip_reservations_owner_delete is earned, not assumed", () => {
  const MIGRATIONS = new URL("../migrations/", import.meta.url);
  const read = (f: string) => readFileSync(new URL(f, MIGRATIONS), "utf8");

  it("0172 still CLAIMS the policy — otherwise the entry is dead and must be deleted", () => {
    assert.match(
      read("0172_trip_reservations.sql"),
      /CREATE POLICY\s+trip_reservations_owner_delete\s+ON\s+trip_reservations\s+FOR DELETE/,
      "0172 no longer claims trip_reservations_owner_delete; remove the ALLOWLIST entry rather than leaving it to hide a future policy of the same name",
    );
  });

  it("2784 still DROPS the policy and REVOKEs DELETE — the entry's whole justification", () => {
    const m2784 = read("2784_trip_reservation_history.sql");
    assert.match(
      m2784,
      /DROP POLICY IF EXISTS\s+trip_reservations_owner_delete\s+ON\s+public\.trip_reservations/,
      "2784 no longer drops the policy, so live may legitimately carry it — the ALLOWLIST entry would now hide real drift",
    );
    assert.match(
      m2784,
      /REVOKE DELETE ON public\.trip_reservations FROM authenticated/,
      "2784 no longer revokes DELETE; the drop alone does not make the tightening true",
    );
  });

  it("2784 refuses to record itself unless the revocation actually took", () => {
    assert.match(
      read("2784_trip_reservation_history.sql"),
      /has_table_privilege\('authenticated', 'public\.trip_reservations', 'DELETE'\)[\s\S]{0,120}RAISE EXCEPTION/,
      "2784's postcondition no longer proves authenticated lost DELETE, so applying it proves nothing about the live state the ALLOWLIST entry describes",
    );
  });

  it("the allowlisted key is spelled the way the auditor builds policy keys", () => {
    // auditMigrationsVsLive.ts:697 — add("policy", `${table}.${pol}`, …).
    // A typo here is invisible: a key that matches nothing simply never
    // suppresses anything, and the audit stays red for a reason no one reads.
    const auditor = readFileSync(
      new URL("../scripts/auditMigrationsVsLive.ts", import.meta.url), "utf8");
    assert.ok(
      auditor.includes('"policy:trip_reservations.trip_reservations_owner_delete"'),
      "the ALLOWLIST entry is missing or misspelled; the auditor keys policies as policy:<table>.<policy>",
    );
  });
});

/**
 * Same binding for the routes_api_try_spend entry (main 2de186f820, live-DB run
 * 37737811561: audit:schema listed 3971's function as missing after 3971 and
 * 3973 had BOTH applied). 3971 creates the unscoped spend function; 3973 moves
 * its one caller to routes_api_try_spend_scoped() and drops it. The entry is
 * true exactly while 3971 still claims the function and 3973 still drops it.
 */
describe("audit:schema ALLOWLIST — routes_api_try_spend is earned, not assumed", () => {
  const MIGRATIONS = new URL("../migrations/", import.meta.url);
  const read = (f: string) => readFileSync(new URL(f, MIGRATIONS), "utf8");

  it("3971 still CLAIMS the function — otherwise the entry is dead and must be deleted", () => {
    assert.match(
      read("3971_trip_routes_api_spend_gate.sql"),
      /CREATE OR REPLACE FUNCTION public\.routes_api_try_spend\(/,
      "3971 no longer claims routes_api_try_spend; remove the ALLOWLIST entry rather than leaving it to hide a future function of the same name",
    );
  });

  it("3973 still DROPS it and still creates the scoped replacement — the entry's whole justification", () => {
    const m3973 = read("3973_trip_routes_api_user_trip_shares.sql");
    assert.match(
      m3973,
      /^DROP FUNCTION IF EXISTS public\.routes_api_try_spend\(integer, bigint, bigint\);$/m,
      "3973 no longer drops routes_api_try_spend, so live may legitimately carry it — the ALLOWLIST entry would now hide real drift",
    );
    assert.match(m3973, /CREATE OR REPLACE FUNCTION public\.routes_api_try_spend_scoped\(/);
  });

  it("the replacement is NOT allowlisted: its absence would still be reported", () => {
    const auditor = readFileSync(new URL("../scripts/auditMigrationsVsLive.ts", import.meta.url), "utf8");
    assert.ok(!auditor.includes('"function:routes_api_try_spend_scoped"'));
  });

  it("the allowlisted key is spelled the way the auditor builds function keys", () => {
    // auditMigrationsVsLive.ts — add("function", name(m), …): a bare, unqualified
    // name with no argument list.
    const auditor = readFileSync(new URL("../scripts/auditMigrationsVsLive.ts", import.meta.url), "utf8");
    assert.ok(
      auditor.includes('"function:routes_api_try_spend",'),
      "the ALLOWLIST entry is missing or misspelled; the auditor keys functions as function:<name>",
    );
  });
});

/**
 * Same binding for the trip_events entries (main be5cd6c25, live-DB run
 * 37767628457: certify stage 5's audit:schema listed 2420's crew policy and
 * its SELECT grant to authenticated as missing after 3976 applied). 2420 opens
 * the client door; 3976 (D-65) closes it on purpose. The entries are true
 * exactly while 2420 still claims both and 3976 still removes both.
 */
describe("audit:schema ALLOWLIST — trip_events' closed client door is earned, not assumed", () => {
  const MIGRATIONS = new URL("../migrations/", import.meta.url);
  const read = (f: string) => readFileSync(new URL(f, MIGRATIONS), "utf8");
  const auditor = () => readFileSync(new URL("../scripts/auditMigrationsVsLive.ts", import.meta.url), "utf8");

  it("2420 still CLAIMS the policy and the grant — otherwise the entries are dead and must be deleted", () => {
    const m2420 = read("2420_trip_kernel_foundation.sql");
    assert.match(m2420, /^CREATE POLICY trip_events_crew_select ON public\.trip_events$/m,
      "2420 no longer creates trip_events_crew_select; remove its ALLOWLIST entry");
    assert.match(m2420, /^GRANT SELECT ON public\.trip_events TO authenticated;$/m,
      "2420 no longer grants SELECT on trip_events to authenticated; remove its ALLOWLIST entry");
  });

  it("3976 still DROPS the policy and REVOKES the client grants, and does not re-grant SELECT", () => {
    const m3976 = read("3976_trip_events_private_place_minimised.sql");
    assert.match(m3976, /^DROP POLICY IF EXISTS trip_events_crew_select ON public\.trip_events;$/m,
      "3976 no longer drops the crew policy, so live may legitimately carry it — the entry would hide real drift");
    assert.match(m3976, /^REVOKE ALL ON public\.trip_events FROM PUBLIC, anon, authenticated;$/m,
      "3976 no longer revokes the client grants on trip_events");
    assert.doesNotMatch(m3976, /GRANT\s+(SELECT|ALL)[^;]*ON\s+(TABLE\s+)?public\.trip_events\s+TO\s+[^;]*authenticated/i,
      "3976 re-grants a client role on trip_events; the entry would hide that grant going missing");
    // And its own postcondition still asserts the closed state.
    assert.match(m3976, /polname = 'trip_events_crew_select'\) THEN\s+RAISE EXCEPTION 'POSTCONDITION FAILED \(3976\)/);
    assert.match(m3976, /has_table_privilege\('authenticated', 'public\.trip_events', 'SELECT'\)/);
  });

  it("no later migration re-opens the door the entries assume closed", () => {
    // A file after 3976 that re-creates the policy or re-grants SELECT would
    // make the live object legitimate again; the entries must then go.
    const later = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f > "3976_");
    for (const f of later) {
      const sql = read(f);
      assert.doesNotMatch(sql, /CREATE POLICY trip_events_crew_select/, `${f} re-creates trip_events_crew_select`);
      assert.doesNotMatch(sql, /GRANT\s+(SELECT|ALL)[^;]*ON\s+(TABLE\s+)?public\.trip_events\s+TO\s+[^;]*authenticated/i,
        `${f} re-grants SELECT on trip_events to authenticated`);
    }
  });

  it("the keys are spelled the way the auditor builds policy and grant keys", () => {
    const a = auditor();
    assert.ok(a.includes('"policy:trip_events.trip_events_crew_select",'),
      "policy keys are policy:<table>.<policy>");
    assert.ok(a.includes('"grant:trip_events.authenticated.select",'),
      "grant keys are grant:<table>.<role>.<privilege>");
    // anon never held the 2420 grant, so it must not be allowlisted.
    assert.ok(!a.includes('"grant:trip_events.anon.select"'));
  });
});
