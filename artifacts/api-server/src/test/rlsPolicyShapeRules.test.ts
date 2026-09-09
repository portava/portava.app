/**
 * The three membership-shape rules the live RLS guard evaluates, proven on REAL
 * policy text without a database.
 *
 * WHY A SEPARATE, DATABASE-FREE SUITE
 * ===================================
 * rlsPolicyShapeLive.test.ts runs only in the live-db workflow, against
 * portava-ci, behind ciSupabaseGuard. A rule that is wrong in the way 2337's
 * commissioning heuristic was wrong — reporting 24 where the truth was 34,
 * missing three policies that reach trip_members through a function and three
 * that gate on nothing — would report green there just as confidently. So each
 * rule is exercised here on policy text copied VERBATIM from pg_policies on
 * portava-ci (2026-09-07), for every verdict it can return, plus the mutations
 * that must flip it. Every allowlist is checked for internal consistency
 * against the rules it excuses, and the vacuity guard is shown to throw.
 *
 * This suite also reads migration 2530 and applies its single-branch rewrite
 * (the regex and replacement it declares) to BOTH live shapes of
 * highlights_select_active — 0026's on production, 2313's on CI — and asserts
 * the rewrite is minimal on each. If someone edits that regex and breaks it,
 * this fails before the owner runs the migration.
 *
 * Run: node --import tsx/esm --test src/test/rlsPolicyShapeRules.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARRAY_GRANT_KNOWN_OPEN,
  FOR_ALL_WITHOUT_WITH_CHECK_BASELINE,
  SNAPSHOT_SENTINELS,
  TRIP_MEMBERS_KNOWN_OPEN,
  TRIP_MEMBERS_REVIEWED_ALLOWLIST,
  UNGATED_TRIP_MEMBERS_FUNCTIONS,
  arrayGrantVerdict,
  ungatedFunctionPattern,
  assertSnapshotExamined,
  compareUngatedFunctionList,
  evaluatePolicySnapshot,
  forAllWriteCheckVerdict,
  policyKey,
  tripMembersVerdict,
  type PolicyDispositions,
  type PolicySnapshotRow,
  type TripMembersReaderRow,
} from "../scripts/rlsDispositions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_2530 = join(HERE, "../migrations/2530_highlights_trip_only_accepted_crew.sql");

/* ── Policy text, verbatim from pg_policies on portava-ci, 2026-09-07 ────────── */

const TRIP_ONLY_SELF_JOIN =
  `((visibility = 'trip_only'::text) AND (EXISTS ( SELECT 1
   FROM (trip_members tm1
     JOIN trip_members tm2 ON ((tm1.trip_id = tm2.trip_id)))
  WHERE ((tm1.user_id = highlights.owner_id) AND (tm2.user_id = auth.uid())))))`;

const TRIP_ONLY_HELPER = `((visibility = 'trip_only'::text) AND authz.shares_accepted_trip(owner_id))`;

const CIRCLE_BRANCH =
  `((visibility = 'circle_only'::text) AND (EXISTS ( SELECT 1
   FROM circle_memberships cm
  WHERE ((cm.user_id = highlights.owner_id) AND (cm.other_id = auth.uid())))))`;

/** CI shape (2313 / PR #461): owner-first, NULL-arm expiry. */
const HIGHLIGHTS_CI = `((deleted_at IS NULL) AND ((owner_id = auth.uid()) OR (((expires_at IS NULL) OR (expires_at > now())) AND (NOT authz.is_blocked(auth.uid(), owner_id)) AND ((visibility = ANY (ARRAY['public'::text, 'travelers_nearby'::text])) OR ${CIRCLE_BRANCH} OR ${TRIP_ONLY_SELF_JOIN}))))`;
/** Production shape (0026): expiry ANDed across the whole policy. */
const HIGHLIGHTS_PROD = `((deleted_at IS NULL) AND (expires_at > now()) AND (NOT authz.is_blocked(auth.uid(), owner_id)) AND ((owner_id = auth.uid()) OR (visibility = ANY (ARRAY['public'::text, 'travelers_nearby'::text])) OR ${CIRCLE_BRANCH} OR ${TRIP_ONLY_SELF_JOIN}))`;

const TRI_MEMBER_READ = `((EXISTS ( SELECT 1
   FROM trip_members tm
  WHERE ((tm.trip_id = trip_readiness_items.trip_id) AND (tm.user_id = auth.uid()) AND (tm.role = ANY (ARRAY['owner'::member_role, 'co_host'::member_role, 'member'::member_role, 'viewer'::member_role])) AND ((tm.status IS NULL) OR (tm.status = 'accepted'::text))))) OR (EXISTS ( SELECT 1
   FROM trips t
  WHERE ((t.id = trip_readiness_items.trip_id) AND (t.owner_id = auth.uid())))))`;

const TRIP_MEMBERS_INSERT_CHECK = `(EXISTS ( SELECT 1
   FROM trips t
  WHERE ((t.id = trip_members.trip_id) AND (t.owner_id = auth.uid()))))`;

const CREW_SESSION_OWNER_SELECT_0041 = `((auth.uid() = user_id) OR (auth.uid() = ANY (allowed_member_ids)))`;
const CREW_SESSION_OWNER_SELECT_2531 = `(auth.uid() = user_id)`;
const CREW_SESSIONS_RECIPIENTS_READ_2337 =
  `((status = 'active'::text) AND (expires_at > now()) AND (auth.uid() = ANY (allowed_member_ids)) AND authz.is_trip_crew(trip_id))`;
const TA_TRIP_MEMBERS_SELECT_2337 = `(authz.is_trip_crew(trip_id) AND authz.is_accepted_trip_member(trip_id, user_id))`;

const row = (
  tablename: string,
  policyname: string,
  cmd: string,
  qual: string | null,
  with_check: string | null = null,
  roles = "{public}",
): PolicySnapshotRow => ({ tablename, policyname, cmd, roles, permissive: "PERMISSIVE", qual, with_check });

/* ── Rule 1: trip_members reachability ─────────────────────────────────────── */

describe("rule 1 — trip_members without role AND status", () => {
  it("the live highlights_select_active (both shapes) is ungated_direct", () => {
    assert.deepEqual(tripMembersVerdict(row("highlights", "highlights_select_active", "SELECT", HIGHLIGHTS_CI, null, "{authenticated}")), { kind: "ungated_direct" });
    assert.deepEqual(tripMembersVerdict(row("highlights", "highlights_select_active", "SELECT", HIGHLIGHTS_PROD, null, "{authenticated}")), { kind: "ungated_direct" });
  });

  it("after 2530 the same policy is gated_by_helper via authz.shares_accepted_trip", () => {
    const fixed = HIGHLIGHTS_CI.replace(TRIP_ONLY_SELF_JOIN, TRIP_ONLY_HELPER);
    assert.ok(!/trip_members/.test(fixed));
    assert.deepEqual(tripMembersVerdict(row("highlights", "highlights_select_active", "SELECT", fixed)), {
      kind: "gated_by_helper",
      via: "authz.shares_accepted_trip",
    });
  });

  it("tri_member_read spells out role AND status inline: gated_inline", () => {
    assert.deepEqual(tripMembersVerdict(row("trip_readiness_items", "tri_member_read", "SELECT", TRI_MEMBER_READ)), { kind: "gated_inline" });
  });

  it("role without status, and status without role, are both ungated (the two encodings of pending)", () => {
    const roleOnly = TRI_MEMBER_READ.replace(` AND ((tm.status IS NULL) OR (tm.status = 'accepted'::text))`, "");
    assert.ok(!/status/.test(roleOnly));
    assert.deepEqual(tripMembersVerdict(row("t", "p", "SELECT", roleOnly)), { kind: "ungated_direct" });
    const statusOnly = TRI_MEMBER_READ.replace(` AND (tm.role = ANY (ARRAY['owner'::member_role, 'co_host'::member_role, 'member'::member_role, 'viewer'::member_role]))`, "");
    assert.ok(!/\brole\b/.test(statusOnly));
    assert.deepEqual(tripMembersVerdict(row("t", "p", "SELECT", statusOnly)), { kind: "ungated_direct" });
  });

  it("a policy ON trip_members itself names the table through its own columns and is ungated_direct — hence the reviewed allowlist", () => {
    const r = row("trip_members", "trip_members_insert", "INSERT", null, TRIP_MEMBERS_INSERT_CHECK);
    assert.deepEqual(tripMembersVerdict(r), { kind: "ungated_direct" });
    assert.ok(TRIP_MEMBERS_REVIEWED_ALLOWLIST.some((e) => e.key === policyKey(r)));
  });

  it("the ungated-function RULE: qualified or not, whole-name only", () => {
    // The rule is exercised against an EXPLICIT list, not the shipped one. It
    // used to be tested through tripMembersVerdict with `can_see_trip` in
    // UNGATED_TRIP_MEMBERS_FUNCTIONS; that list is now empty because 2534
    // repaired the function, and a rule whose test depends on today's data
    // cannot survive the data being fixed.
    const re = ungatedFunctionPattern(["can_see_trip", "shares_trip_with"])!;
    assert.equal("can_see_trip(id)".match(re)?.[1], "can_see_trip");
    assert.equal("public.can_see_trip(trip_id)".match(re)?.[1], "can_see_trip");
    assert.equal("shares_trip_with(owner_id)".match(re)?.[1], "shares_trip_with");
    // A function that merely CONTAINS the name is not the function.
    assert.equal("my_can_see_trip_wrapper(id)".match(re), null);
  });

  it("AN EMPTY LIST MATCHES NOTHING — the trap the shrink-only rule walks into", () => {
    // `new RegExp("\\b(?:public\\.)?()\\s*\\(")` has an empty alternation group and
    // matches ANY expression containing a `(`. That is what the builder produced
    // once 2533 and 2534 emptied the list, so every policy in the database would
    // have read as ungated_via_function at exactly the moment the functions were
    // fixed. Null is the only correct answer for "match one of no functions".
    assert.equal(ungatedFunctionPattern([]), null);
  });

  it("2534's result, through the SHIPPED list: calling can_see_trip is no longer a trip_members reach", () => {
    assert.deepEqual(tripMembersVerdict(row("trips", "trips_select", "SELECT", "can_see_trip(id)")), { kind: "not_applicable" });
    assert.deepEqual(tripMembersVerdict(row("x", "y", "SELECT", "shares_trip_with(owner_id)")), { kind: "not_applicable" });
  });

  it("the captured function list is EMPTY, because 2533 and 2534 landed on CI", () => {
    // Measured 2026-09-09: pg_trip_members_readers_snapshot() on portava-ci
    // returns one row, authz.is_trip_crew, with mentions_role AND
    // mentions_status — and in `authz`, not `public`. compareUngatedFunctionList
    // looks for PUBLIC functions with no status gate, so the live set is empty
    // and the captured list must equal it. The live suite reported both former
    // entries stale by name.
    assert.deepEqual([...UNGATED_TRIP_MEMBERS_FUNCTIONS], []);
  });

  it("compareUngatedFunctionList: the CI catalog today matches; 2533 and 2534 each make an entry stale; a new reader is unlisted", () => {
    const ciToday: TripMembersReaderRow[] = [
      { schema_name: "authz", function_name: "is_trip_crew", mentions_role: true, mentions_status: true },
      { schema_name: "public", function_name: "can_see_trip", mentions_role: true, mentions_status: false },
      { schema_name: "public", function_name: "shares_trip_with", mentions_role: false, mentions_status: false },
    ];
    // The historical list, passed explicitly — the shipped one is now empty.
    const THEN = ["can_see_trip", "shares_trip_with"];
    assert.deepEqual(compareUngatedFunctionList(ciToday, THEN), { unlisted: [], stale: [] });

    // 2533 drops shares_trip_with.
    const after2533 = ciToday.filter((r) => r.function_name !== "shares_trip_with");
    assert.deepEqual(compareUngatedFunctionList(after2533, THEN), { unlisted: [], stale: ["shares_trip_with"] });

    // 2534 routes can_see_trip through authz.is_trip_crew, so it no longer reads trip_members at all.
    const after2534 = after2533.filter((r) => r.function_name !== "can_see_trip");
    assert.deepEqual(compareUngatedFunctionList(after2534, THEN), { unlisted: [], stale: ["can_see_trip", "shares_trip_with"] });

    // AND WHERE THE DATABASE ACTUALLY IS, against the SHIPPED empty list: the
    // live catalogue is authz.is_trip_crew alone, gated, and outside `public`.
    assert.deepEqual(compareUngatedFunctionList(after2534), { unlisted: [], stale: [] });

    // A gated reader (mentions status) is not ungated; an ungated newcomer is —
    // and this is now the ONLY way a function re-enters the list.
    const gatedNew = [...after2534, { schema_name: "public", function_name: "is_on_trip", mentions_role: true, mentions_status: true }];
    assert.deepEqual(compareUngatedFunctionList(gatedNew).unlisted, []);
    const ungatedNew = [...after2534, { schema_name: "public", function_name: "is_on_trip", mentions_role: true, mentions_status: false }];
    assert.deepEqual(compareUngatedFunctionList(ungatedNew).unlisted, ["is_on_trip"]);

    // authz functions are not PostgREST-exposed and are the helpers themselves;
    // never "unlisted". Built on `after2534` — the live shape — rather than on
    // `ciToday`, whose two PUBLIC ungated functions would be unlisted against
    // the shipped empty list and would mask what this case is checking.
    const authzUngated = [...after2534, { schema_name: "authz", function_name: "x", mentions_role: false, mentions_status: false }];
    assert.deepEqual(compareUngatedFunctionList(authzUngated).unlisted, []);
  });

  it("2337's helper-routed policies are gated_by_helper", () => {
    assert.deepEqual(tripMembersVerdict(row("trip_availability", "ta_trip_members_select", "SELECT", TA_TRIP_MEMBERS_SELECT_2337)), { kind: "gated_by_helper", via: "authz.is_trip_crew" });
    assert.deepEqual(tripMembersVerdict(row("trip_crew_location_sessions", "crew_sessions_recipients_read", "SELECT", CREW_SESSIONS_RECIPIENTS_READ_2337)), { kind: "gated_by_helper", via: "authz.is_trip_crew" });
  });

  it("MUTATION: a helper call does not launder a direct ungated reference beside it", () => {
    const both = `(authz.is_trip_crew(trip_id) OR (EXISTS (SELECT 1 FROM trip_members m WHERE m.user_id = auth.uid())))`;
    assert.deepEqual(tripMembersVerdict(row("t", "p", "SELECT", both)), { kind: "ungated_direct" });
  });

  it("a policy that never touches trip_members is not_applicable", () => {
    assert.deepEqual(tripMembersVerdict(row("profiles", "profiles_select", "SELECT", "(auth.uid() = id)")), { kind: "not_applicable" });
  });
});

/* ── Rule 2: FOR ALL without WITH CHECK ─────────────────────────────────────── */

describe("rule 2 — FOR ALL without WITH CHECK", () => {
  it("returns every verdict on real rows", () => {
    assert.equal(forAllWriteCheckVerdict(row("trip_crew_location_sessions", "crew_loc_sessions_own", "ALL", "(auth.uid() = user_id)", "(auth.uid() = user_id)")), "has_with_check");
    assert.equal(forAllWriteCheckVerdict(row("trip_crew_location_sessions", "crew_sessions_self", "ALL", "(auth.uid() = user_id)")), "reuses_using");
    assert.equal(forAllWriteCheckVerdict(row("trip_crew_location_sessions", "crew_loc_sessions_service", "ALL", "true", null, "{service_role}")), "exempt_service_role_only");
    assert.equal(forAllWriteCheckVerdict(row("buddy_availability_exceptions", "bae_svc", "ALL", "(auth.role() = 'service_role'::text)")), "exempt_service_predicate");
    assert.equal(forAllWriteCheckVerdict(row("content_distribution_stats", "cds_deny_public", "ALL", "false")), "exempt_deny_all");
    assert.equal(forAllWriteCheckVerdict(row("highlights", "highlights_select_active", "SELECT", HIGHLIGHTS_CI)), "not_applicable");
  });

  it("MUTATION: `true` for a non-service role is NOT exempt — it is the blanket write 2337 found on reads", () => {
    assert.equal(forAllWriteCheckVerdict(row("t", "p", "ALL", "true")), "reuses_using");
    assert.equal(forAllWriteCheckVerdict(row("t", "p", "ALL", "(auth.uid() IS NOT NULL)")), "reuses_using");
    // {anon,service_role} is not service-only.
    assert.equal(forAllWriteCheckVerdict(row("t", "p", "ALL", "true", null, "{anon,service_role}")), "reuses_using");
  });

  it("the write hole trip_checklists_members / trip_checklist_items_members had is CLOSED, and the rule that found it still bites", () => {
    // These two were in the baseline as the hole it REPORTED rather than
    // excused: FOR ALL with no WITH CHECK, so the read predicate doubled as the
    // write check. 2534 moved the write half onto the API's write rules and both
    // are now cmd=SELECT with USING can_see_trip(trip_id) — measured on
    // portava-ci — so they are neither FOR ALL nor reusing anything, and the
    // live suite reported them stale by name.
    assert.ok(!FOR_ALL_WITHOUT_WITH_CHECK_BASELINE.includes("trip_checklists::trip_checklists_members"));
    assert.ok(!FOR_ALL_WITHOUT_WITH_CHECK_BASELINE.includes("trip_checklist_items::trip_checklist_items_members"));

    // The RULE is what deserves the assertion, and it is unchanged: the shape
    // they USED to have is still reported. Stated over the shape rather than
    // over the list, so closing the next hole cannot break this test.
    assert.equal(
      forAllWriteCheckVerdict(row("trip_checklists", "trip_checklists_members", "ALL", "can_see_trip(trip_id)", null)),
      "reuses_using",
    );
    // And the repaired shape is not.
    assert.notEqual(
      forAllWriteCheckVerdict(row("trip_checklists", "trip_checklists_members", "SELECT", "can_see_trip(trip_id)", null)),
      "reuses_using",
    );
  });
});

/* ── Rule 3: array-column grants ───────────────────────────────────────────── */

describe("rule 3 — array-column grants without a crew gate", () => {
  it("the 0041 crew_session_owner_select is array_grant_ungated; the 2337 recipients policy is gated; the 2531 form is not a grant", () => {
    assert.equal(arrayGrantVerdict(row("trip_crew_location_sessions", "crew_session_owner_select", "SELECT", CREW_SESSION_OWNER_SELECT_0041)), "array_grant_ungated");
    assert.equal(arrayGrantVerdict(row("trip_crew_location_sessions", "crew_sessions_recipients_read", "SELECT", CREW_SESSIONS_RECIPIENTS_READ_2337)), "array_grant_with_crew_gate");
    assert.equal(arrayGrantVerdict(row("trip_crew_location_sessions", "crew_session_owner_select", "SELECT", CREW_SESSION_OWNER_SELECT_2531)), "not_applicable");
  });

  it("an ARRAY[...] literal is a role/visibility list, not a grant column", () => {
    assert.equal(arrayGrantVerdict(row("posts", "p", "SELECT", `(visibility = ANY (ARRAY['public'::text]))`)), "not_applicable");
    assert.equal(arrayGrantVerdict(row("t", "p", "SELECT", `(auth.uid() = ANY (ARRAY[owner_id, editor_id]))`)), "not_applicable");
  });

  it("only SELECT/ALL for non-service roles are in scope", () => {
    assert.equal(arrayGrantVerdict(row("t", "p", "INSERT", null, CREW_SESSION_OWNER_SELECT_0041)), "not_applicable");
    assert.equal(arrayGrantVerdict(row("t", "p", "SELECT", CREW_SESSION_OWNER_SELECT_0041, null, "{service_role}")), "not_applicable");
    assert.equal(arrayGrantVerdict(row("t", "p", "ALL", CREW_SESSION_OWNER_SELECT_0041)), "array_grant_ungated");
  });
});

/* ── Evaluation over a CI-like snapshot, and the mutations that must fail ──── */

/** A snapshot shaped like portava-ci on 2026-09-07: every allowlisted policy present with its claimed shape. */
function ciLikeSnapshot(): PolicySnapshotRow[] {
  // Keyed, because two policies live in TWO lists at once:
  // trip_checklists::trip_checklists_members and
  // trip_checklist_items::trip_checklist_items_members are FOR ALL, no WITH
  // CHECK, USING (can_see_trip(trip_id)) — in the FOR ALL baseline AND in the
  // can_see_trip known-open list. One row must satisfy both, as it does on CI.
  const byKey = new Map<string, PolicySnapshotRow>();
  const put = (r: PolicySnapshotRow) => byKey.set(policyKey(r), r);
  put(row("trip_members", "trip_members_insert", "INSERT", null, TRIP_MEMBERS_INSERT_CHECK));
  put(row("trip_members", "trip_members_delete", "DELETE", TRIP_MEMBERS_INSERT_CHECK));
  put(row("trip_readiness_items", "tri_member_read", "SELECT", TRI_MEMBER_READ));
  put(row("trip_crew_location_sessions", "crew_sessions_recipients_read", "SELECT", CREW_SESSIONS_RECIPIENTS_READ_2337));
  put(row("trip_crew_location_sessions", "crew_loc_sessions_own", "ALL", "(auth.uid() = user_id)", "(auth.uid() = user_id)"));
  put(row("trip_crew_location_sessions", "crew_loc_sessions_service", "ALL", "true", null, "{service_role}"));
  put(row("buddy_availability_exceptions", "bae_svc", "ALL", "(auth.role() = 'service_role'::text)"));
  put(row("content_distribution_stats", "cds_deny_public", "ALL", "false"));
  put(row("profiles", "profiles_select", "SELECT", "(auth.uid() = id)"));
  for (const e of TRIP_MEMBERS_KNOWN_OPEN) {
    const [t, p] = e.key.split("::");
    if (e.kind === "ungated_direct") put(row(t, p, "SELECT", HIGHLIGHTS_CI, null, "{authenticated}"));
    else put(row(t, p, "SELECT", "can_see_trip(trip_id)"));
  }
  for (const e of ARRAY_GRANT_KNOWN_OPEN) {
    const [t, p] = e.key.split("::");
    put(row(t, p, "SELECT", CREW_SESSION_OWNER_SELECT_0041));
  }
  for (const k of FOR_ALL_WITHOUT_WITH_CHECK_BASELINE) {
    const [t, p] = k.split("::");
    const existing = byKey.get(k);
    put(existing ? { ...existing, cmd: "ALL", with_check: null } : row(t, p, "ALL", "(auth.uid() = user_id)"));
  }
  return [...byKey.values()];
}

describe("evaluatePolicySnapshot — allowlists are consistent with the rules, and every mutation surfaces", () => {
  it("a CI-like snapshot reports no offenders and no stale entries", () => {
    const report = evaluatePolicySnapshot(ciLikeSnapshot());
    assert.ok(report.examined > 60);
    assert.deepEqual(report.tripMembersOffenders, []);
    assert.deepEqual(report.tripMembersStaleKnownOpen, []);
    assert.deepEqual(report.tripMembersMissingReviewed, []);
    assert.deepEqual(report.forAllOffenders, []);
    assert.deepEqual(report.forAllStaleBaseline, []);
    assert.deepEqual(report.arrayGrantOffenders, []);
    assert.deepEqual(report.arrayGrantStaleKnownOpen, []);
  });

  it("MUTATION: a NEW policy that self-joins trip_members is an offender", () => {
    const rows = [...ciLikeSnapshot(), row("new_table", "new_policy", "SELECT", TRIP_ONLY_SELF_JOIN)];
    assert.deepEqual(evaluatePolicySnapshot(rows).tripMembersOffenders, ["new_table::new_policy [ungated_direct]"]);
  });

  it("MUTATION: a policy calling an UNGATED function is an offender, named with the function", () => {
    // This used to run against the shipped list while it held `can_see_trip`.
    // 2534 gated that function and the list is empty, so the mutation is now
    // stated with the list it needs: the RULE is that reaching trip_members
    // through a listed function is an offence, not that any particular function
    // is listed.
    const rows = [...ciLikeSnapshot(), row("new_table", "new_policy", "SELECT", "can_see_trip(trip_id)")];
    const re = ungatedFunctionPattern(["can_see_trip"])!;
    assert.equal("can_see_trip(trip_id)".match(re)?.[1], "can_see_trip");

    // And against the SHIPPED list, the same policy is NOT an offender — which
    // is 2534's whole point, and would be a false green if the empty-list trap
    // above had not been closed.
    assert.deepEqual(evaluatePolicySnapshot(rows).tripMembersOffenders, []);
  });

  it("MUTATION: the empty list does not make every policy an offender", () => {
    // The regression the empty-alternation regex would have caused: every
    // policy whose expression contains a `(` reading as ungated_via_function.
    // ciLikeSnapshot() is full of such expressions.
    const report = evaluatePolicySnapshot(ciLikeSnapshot());
    assert.deepEqual(report.tripMembersOffenders, []);
  });

  it("MUTATION: the shrink-only mechanism — a repaired policy makes its known-open entry STALE", () => {
    // Stated with its OWN dispositions. The highlights entry was removed on
    // 2026-09-09 because 2530 landed on portava-ci and the live suite reported
    // it stale — which is this mechanism working. A test of the mechanism must
    // not need the entry to still be there; that coupling is why five tests in
    // this file broke when the lists legitimately emptied.
    const asItWas: PolicyDispositions = {
      reviewed: TRIP_MEMBERS_REVIEWED_ALLOWLIST,
      tripMembersKnownOpen: [{
        key: "highlights::highlights_select_active",
        kind: "ungated_direct",
        reason: "the pre-2530 trip_only self-join",
        since: "2026-09-07",
        removeWhen: "migration 2530 is applied to portava-ci",
      }],
      arrayGrantKnownOpen: ARRAY_GRANT_KNOWN_OPEN,
      forAllBaseline: FOR_ALL_WITHOUT_WITH_CHECK_BASELINE,
    };

    // The row is supplied here rather than taken from ciLikeSnapshot(), which
    // derives its trip_members rows FROM the shipped list and therefore no
    // longer contains this policy at all — the same coupling, one level down.
    const withPolicy = (qual: string): PolicySnapshotRow[] =>
      [...ciLikeSnapshot(), row("highlights", "highlights_select_active", "SELECT", qual, null, "{authenticated}")];

    // Before the repair the entry is live, and excuses the policy.
    const before = evaluatePolicySnapshot(withPolicy(HIGHLIGHTS_CI), asItWas);
    assert.deepEqual(before.tripMembersOffenders, []);
    assert.deepEqual(before.tripMembersStaleKnownOpen, []);

    // After it, the entry is STALE and the check demands its removal.
    const after = evaluatePolicySnapshot(
      withPolicy(HIGHLIGHTS_CI.replace(TRIP_ONLY_SELF_JOIN, TRIP_ONLY_HELPER)),
      asItWas,
    );
    assert.deepEqual(after.tripMembersOffenders, []);
    assert.deepEqual(after.tripMembersStaleKnownOpen, ["highlights::highlights_select_active"]);
  });

  it("MUTATION: applying 2531 makes the array-grant known-open entry STALE", () => {
    const rows = ciLikeSnapshot().map((r) =>
      policyKey(r) === "trip_crew_location_sessions::crew_session_owner_select"
        ? { ...r, qual: CREW_SESSION_OWNER_SELECT_2531 }
        : r,
    );
    const report = evaluatePolicySnapshot(rows);
    assert.deepEqual(report.arrayGrantOffenders, []);
    assert.deepEqual(report.arrayGrantStaleKnownOpen, ["trip_crew_location_sessions::crew_session_owner_select"]);
  });

  it("MUTATION: a NEW FOR ALL policy without WITH CHECK is an offender; a baseline entry that gains WITH CHECK is stale", () => {
    const added = [...ciLikeSnapshot(), row("new_table", "new_all", "ALL", "(auth.uid() = user_id)")];
    assert.deepEqual(evaluatePolicySnapshot(added).forAllOffenders, ["new_table::new_all USING (auth.uid() = user_id)"]);

    const fixedOne = ciLikeSnapshot().map((r) =>
      policyKey(r) === "trip_crew_location_sessions::crew_sessions_self" ? { ...r, with_check: "(auth.uid() = user_id)" } : r,
    );
    assert.deepEqual(evaluatePolicySnapshot(fixedOne).forAllStaleBaseline, ["trip_crew_location_sessions::crew_sessions_self"]);
  });

  it("MUTATION: a NEW ungated array grant is an offender", () => {
    const rows = [...ciLikeSnapshot(), row("stories", "stories_allowed", "SELECT", "(auth.uid() = ANY (allowed_user_ids))")];
    assert.deepEqual(evaluatePolicySnapshot(rows).arrayGrantOffenders, ["stories::stories_allowed"]);
  });

  it("MUTATION: a reviewed-allowlist policy that disappears is reported", () => {
    const rows = ciLikeSnapshot().filter((r) => policyKey(r) !== "trip_members::trip_members_delete");
    assert.deepEqual(evaluatePolicySnapshot(rows).tripMembersMissingReviewed, ["trip_members::trip_members_delete"]);
  });
});

describe("vacuity is failure", () => {
  it("assertSnapshotExamined throws on an empty snapshot", () => {
    assert.throws(() => assertSnapshotExamined([]), /ZERO policies/);
  });

  it("assertSnapshotExamined throws when the sentinel policies are absent (wrong database, truncated page)", () => {
    const rows = [row("profiles", "profiles_select", "SELECT", "(auth.uid() = id)")];
    assert.throws(() => assertSnapshotExamined(rows), /sentinel/);
  });

  it("assertSnapshotExamined passes a snapshot carrying both sentinels", () => {
    assertSnapshotExamined(ciLikeSnapshot());
    assert.deepEqual([...SNAPSHOT_SENTINELS].sort(), ["trip_members::trip_members_insert", "trip_readiness_items::tri_member_read"]);
  });

  it("evaluatePolicySnapshot over nothing examines nothing (the live test asserts examined > 0)", () => {
    assert.equal(evaluatePolicySnapshot([]).examined, 0);
  });
});

/* ── Migration 2530's rewrite, applied to both live shapes ─────────────────── */

describe("migration 2530 rewrites exactly one branch of either live shape", () => {
  function declared(): { re: RegExp; repl: string } {
    const sql = readFileSync(MIGRATION_2530, "utf8");
    const re = sql.match(/frag_re\s+constant\s+text\s*:=\s*\$re\$([\s\S]*?)\$re\$;/);
    const rp = sql.match(/repl\s+constant\s+text\s*:=\s*\$rp\$([\s\S]*?)\$rp\$;/);
    assert.ok(re && rp, "2530 no longer declares frag_re / repl the way this test reads them");
    return { re: new RegExp(re![1], "g"), repl: rp![1] };
  }

  for (const [label, shape] of [["CI (2313)", HIGHLIGHTS_CI], ["production (0026)", HIGHLIGHTS_PROD]] as const) {
    it(`on the ${label} shape: one match, no trip_members left, everything else byte-identical`, () => {
      const { re, repl } = declared();
      const matches = shape.match(re) ?? [];
      assert.equal(matches.length, 1, `expected exactly one match, got ${matches.length}`);
      const out = shape.replace(re, repl);
      assert.ok(!/trip_members/.test(out), "rewritten qual still names trip_members");
      assert.ok(out.includes("authz.shares_accepted_trip(owner_id)"));
      assert.equal(shape.replace(re, "<branch>"), out.replace(repl, "<branch>"), "the rewrite touched something outside the branch");
      assert.deepEqual(tripMembersVerdict(row("highlights", "highlights_select_active", "SELECT", out)), {
        kind: "gated_by_helper",
        via: "authz.shares_accepted_trip",
      });
    });
  }

  it("refuses (matches zero times) a shape whose branch has already been rewritten", () => {
    const { re } = declared();
    const already = HIGHLIGHTS_CI.replace(TRIP_ONLY_SELF_JOIN, TRIP_ONLY_HELPER);
    assert.equal((already.match(re) ?? []).length, 0);
  });
});
