/**
 * RLS policy SHAPE guard — defect classes that make a policy fail closed on the
 * whole table, silently stop discriminating, or admit people it was never meant
 * to admit. Evaluated against the CI database's LIVE pg_policies.
 *
 * WHY THIS EXISTS (2026-08-28)
 * ----------------------------
 * Two live production defects were found on the same day, and the second was
 * found only by mechanising the pattern of the first.
 *
 *   1. SELF-REFERENTIAL POLICY -> 42P17. A policy on table T whose expression
 *      selects FROM T re-enters itself; Postgres detects the cycle and raises
 *      rather than looping, so EVERY read of that table fails. Verified live on
 *      production: `SELECT count(*) FROM public.call_participants` as
 *      authenticated raised 42P17, and so did message_thread_members. Because
 *      other policies subquery those tables, the blast radius is larger than the
 *      table itself — call_sessions and messages were dead too.
 *
 *   2. TAUTOLOGICAL SELF-COMPARISON, e.g. `(self.thread_id = self.thread_id)`.
 *      A column compared to itself is always true, so the predicate that was
 *      meant to correlate the subquery with the outer row correlates nothing.
 *      This is worse than an error: once the recursion in (1) is fixed, the
 *      check reads "is this user a member of ANY thread" rather than "of THIS
 *      thread" — a silent cross-tenant read.
 *
 * EXTENDED (2026-09-07, lane B5) with three membership-shape classes that 2334,
 * 2337, 2530 and 2531 repaired by hand, so the NEXT policy of the same shape is
 * caught here rather than by an audit:
 *
 *   3. A policy that reaches trip_members without BOTH a role gate and a status
 *      gate — directly, or through a public function that carries the defect.
 *   4. A FOR ALL policy with no WITH CHECK (Postgres reuses USING as the write
 *      check), outside a captured, shrink-only baseline.
 *   5. A SELECT policy that admits on `auth.uid() = ANY(<array column>)` with no
 *      crew gate — a grant list is not a membership.
 *
 * Rules 3-5 are TEXTUAL and say so; the rules, the captured function list and
 * every allowlist live in src/scripts/rlsDispositions.ts, and
 * src/test/rlsPolicyShapeRules.test.ts proves each rule on real policy text
 * without a database. This file only feeds them the live snapshot.
 *
 * A one-off sweep found them. This test makes the sweep permanent.
 *
 * THE ALLOWLISTS SHRINK, NEVER GROW. Anything not named is a failure. Adding a
 * row to make CI green is the one thing this file exists to prevent, which is
 * why every known-open row names the event that removes it and the stale-entry
 * checks fail the moment that event has happened.
 *
 * VACUITY IS FAILURE. Credentials absent, snapshot RPC missing, zero rows, or
 * a snapshot without the sentinel policies — each is a FAIL, never a skip.
 * (ciSupabaseGuard already exits 2 before any of this runs when the target is
 * not the sanctioned CI project; the assertions here are the second line.)
 *
 * Run: node --import tsx/esm --env-file-if-exists=.env --test src/test/rlsPolicyShapeLive.test.ts
 */
import "../lib/ciSupabaseGuard.mjs";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import {
  ARRAY_GRANT_KNOWN_OPEN,
  FOR_ALL_WITHOUT_WITH_CHECK_BASELINE,
  TRIP_MEMBERS_KNOWN_OPEN,
  TRIP_MEMBERS_REVIEWED_ALLOWLIST,
  assertSnapshotExamined,
  evaluatePolicySnapshot,
  type PolicySnapshotRow,
} from "../scripts/rlsDispositions.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CREDS = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

const sc = CREDS
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : (null as any);

/**
 * Known-open offenders for rules 1-2, as `table::policy`. It may only shrink,
 * and as of migration 2402 it is EMPTY.
 *
 * mtm_select carried BOTH defects and was fixed exactly as this note asked —
 * both at once (2401 then 2402), because fixing the recursion alone would have
 * converted a hard 42P17 into a silent cross-thread message leak.
 *
 * NOTE ON SCOPE, so the next reader is not misled: this suite runs against the
 * CI database, and CI and PRODUCTION are not identical here. Production's
 * `messages::msg_select` carries the tautology `mtm.thread_id = mtm.thread_id`,
 * while CI's is correctly correlated as `mtm.thread_id = messages.thread_id`.
 * The correct policy therefore already exists — production simply never received
 * it. That divergence is exactly why this guard cannot be the only check on
 * production, and why the same sweep was run directly against prod by hand
 * (2026-08-28) rather than inferred from CI being green.
 */
const KNOWN_OPEN = new Set<string>([
  // message_thread_members::mtm_select — FIXED by migration 2402 (2026-09-07),
  // together with 2401, which had to land first: 2401 corrected the msg_select
  // tautology and made messages_hide_blocked_sender RESTRICTIVE, so that
  // repairing the recursion could not turn a hard 42P17 into a silent grant of
  // every message to every caller. The allowlist is now EMPTY. Keep it so.
]);

/**
 * Known-open CROSS-TABLE cycles, as the sorted member tables joined by " <-> ".
 * A cycle of length two — A's policy reads B, B's policy reads A — raises the
 * same 42P17 as a self-reference and neither sweep above can see it, which is
 * how the meetup cycle survived the 2026-08-28 sweep. Same rule: it may only
 * shrink.
 */
const KNOWN_CYCLES = new Set<string>([
  // meetups.meetups_invitee_select reads meetup_invites; four meetup_invites
  // policies read meetups. FIXED by 2461 (with 2460 first, which hardens the
  // self-insertable mi_own the repair would otherwise expose). REMOVE THIS
  // ENTRY once 2460 + 2461 are applied to CI — the stale-allowlist case below
  // fails by design until you do.
  "meetup_invites <-> meetups",
]);

/** A missing credential is a failure of THIS suite, not a reason to report green. */
function requireCreds(): void {
  if (!CREDS) {
    assert.fail(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absent. This suite examines a live database; " +
        "without one it examines nothing, and a check that examines nothing must fail. A skip is not a pass.",
    );
  }
}

/** One row per public-schema policy, via the service-role-only snapshot RPC (2199). */
async function policies(): Promise<Array<{ tablename: string; policyname: string; expr: string }>> {
  const { data, error } = await sc.rpc("pg_policies_snapshot");
  if (error) throw new Error(`pg_policies_snapshot: ${error.message} (apply migration 2199)`);
  const rows = (data ?? []) as Array<{ tablename: string; policyname: string; expr: string }>;
  if (rows.length === 0) throw new Error("pg_policies_snapshot returned zero rows");
  return rows;
}

/**
 * The v2 snapshot (2532) keeps USING and WITH CHECK apart. Rules 3-5 need it:
 * the fused v1 string cannot say whether a FOR ALL policy wrote WITH CHECK, and
 * a rule that cannot see the column it judges must not report green.
 */
async function policiesV2(): Promise<PolicySnapshotRow[]> {
  const { data, error } = await sc.rpc("pg_policies_snapshot_v2");
  if (error) {
    throw new Error(`pg_policies_snapshot_v2: ${error.message} — apply migration 2532 to the CI database`);
  }
  const rows = (data ?? []) as PolicySnapshotRow[];
  assertSnapshotExamined(rows);
  return rows;
}

async function snapshotOrFail<T>(fn: () => Promise<T>): Promise<T> {
  requireCreds();
  try {
    return await fn();
  } catch (e) {
    assert.fail(`live policy snapshot unavailable: ${(e as Error).message}`);
  }
}

const SELF_REF = (t: string) => new RegExp(`(FROM|JOIN)\\s+(public\\.)?${t}\\M`);
const TAUTOLOGY = /\(([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*) = \1\.\2\)/;

/**
 * Strongly connected components of size > 1 in the policy-reference graph:
 * an edge A -> B whenever a policy on A selects FROM (or JOINs) B, B being any
 * other table that itself carries policies. Each component is rendered as its
 * sorted members joined by " <-> ".
 */
function policyCycles(rows: Array<{ tablename: string; expr: string }>): string[] {
  const tables = [...new Set(rows.map((r) => r.tablename))];
  const edges = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const r of rows) {
    for (const t of tables) {
      if (t !== r.tablename && SELF_REF(t).test(r.expr)) edges.get(r.tablename)!.add(t);
    }
  }
  // Tarjan.
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[] = [];
  const visit = (v: string) => {
    idx.set(v, index); low.set(v, index); index += 1;
    stack.push(v); onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp.sort().join(" <-> "));
    }
  };
  for (const t of tables) if (!idx.has(t)) visit(t);
  return out.sort();
}

describe("RLS policy shapes — recursion and tautology", () => {
  it("no policy selects FROM its own table (42P17 infinite recursion)", async () => {
    const rows = await snapshotOrFail(policies);

    const offenders = rows
      .filter((r) => SELF_REF(r.tablename).test(r.expr))
      .map((r) => `${r.tablename}::${r.policyname}`)
      .filter((k) => !KNOWN_OPEN.has(k));

    assert.deepEqual(
      offenders, [],
      "A policy's expression selects FROM the table it protects. Postgres re-enters the policy and\n" +
        "raises 42P17, so EVERY read of that table fails — and any other policy that subqueries it\n" +
        "fails too. Resolve membership through a SECURITY DEFINER helper with a pinned search_path\n" +
        "(see authz.viewer_in_call, migration 2199) instead. Offenders:\n  " + offenders.join("\n  "),
    );
  });

  it("no policy compares a column to itself (always-true predicate)", async () => {
    const rows = await snapshotOrFail(policies);

    const offenders = rows
      .filter((r) => TAUTOLOGY.test(r.expr))
      .map((r) => `${r.tablename}::${r.policyname}`)
      .filter((k) => !KNOWN_OPEN.has(k));

    assert.deepEqual(
      offenders, [],
      "A policy compares a column to ITSELF, which is always true. The correlation that was meant to\n" +
        "tie the subquery to the outer row is absent, so the check answers a much broader question\n" +
        "than intended — typically 'is this user a member of ANY row' instead of 'of THIS row'.\n" +
        "Offenders:\n  " + offenders.join("\n  "),
    );
  });

  it("no cross-table policy cycle (42P17 by mutual reference)", async () => {
    const rows = await snapshotOrFail(policies);

    const offenders = policyCycles(rows).filter((c) => !KNOWN_CYCLES.has(c));
    assert.deepEqual(
      offenders, [],
      "Policies on these tables read each other in a cycle. Postgres re-enters the first policy while\n" +
        "expanding the second and raises 42P17, so EVERY read of every table in the cycle fails — and no\n" +
        "self-reference sweep can see it. Break the cycle with a SECURITY DEFINER helper in authz that\n" +
        "reads the membership table as its owner (see authz.is_meetup_invitee, migration 2460/2461, and\n" +
        "authz.is_active_thread_member, 2402). Cycles:\n  " + offenders.join("\n  "),
    );
  });

  it("the allowlist only holds entries that are still genuinely broken", async () => {
    const rows = await snapshotOrFail(policies);

    const stillBroken = new Set(
      rows
        .filter((r) => SELF_REF(r.tablename).test(r.expr) || TAUTOLOGY.test(r.expr))
        .map((r) => `${r.tablename}::${r.policyname}`),
    );

    const stale = [...KNOWN_OPEN].filter((k) => !stillBroken.has(k));
    assert.deepEqual(
      stale, [],
      "These allowlist entries are FIXED. Remove them, so the allowlist keeps shrinking and a future\n" +
        "regression on the same policy is caught rather than permanently excused:\n  " + stale.join("\n  "),
    );

    const liveCycles = new Set(policyCycles(rows));
    const staleCycles = [...KNOWN_CYCLES].filter((c) => !liveCycles.has(c));
    assert.deepEqual(
      staleCycles, [],
      "These KNOWN_CYCLES entries are FIXED on this database. Remove them:\n  " + staleCycles.join("\n  "),
    );
  });
});

describe("RLS policy shapes — membership gates (textual; rules in scripts/rlsDispositions.ts)", () => {
  it("the snapshot examined something real (v1 and v2 agree, sentinels present)", async () => {
    const [v1, v2] = await snapshotOrFail(() => Promise.all([policies(), policiesV2()]));
    assert.ok(v2.length > 0, "v2 snapshot is empty");
    assert.equal(
      v2.length, v1.length,
      `pg_policies_snapshot (${v1.length}) and pg_policies_snapshot_v2 (${v2.length}) disagree on the policy count — one of them is not reading the whole catalog`,
    );
    // assertSnapshotExamined already ran inside policiesV2(); it is repeated here
    // so the failure, if any, is reported under this test's name.
    assertSnapshotExamined(v2);
  });

  it("no policy reaches trip_members without BOTH a role gate and a status gate", async () => {
    const rows = await snapshotOrFail(policiesV2);
    const report = evaluatePolicySnapshot(rows);
    assert.ok(report.examined > 0, "examined nothing");
    assert.deepEqual(
      report.tripMembersOffenders, [],
      "A policy reaches trip_members (directly, or through a public function that reads it) without a\n" +
        "predicate on BOTH role and status. trip_members encodes 'pending' in two columns — the legacy\n" +
        "role='invited' and the current status='invited' — so reading one of them admits pending invitees\n" +
        "(2334, 2337, 2530 each measured it). Route the question through authz.is_trip_crew /\n" +
        "authz.shares_accepted_trip (2334/2337), which encode lib/http.ts requireTripMember exactly.\n" +
        "This check is TEXTUAL: it cannot see a function it has not been told about, so the captured list\n" +
        "UNGATED_TRIP_MEMBERS_FUNCTIONS must be recaptured from pg_proc when functions change.\n" +
        "Offenders:\n  " + report.tripMembersOffenders.join("\n  "),
    );
  });

  it("no FOR ALL policy without WITH CHECK exists outside the captured baseline", async () => {
    const rows = await snapshotOrFail(policiesV2);
    const report = evaluatePolicySnapshot(rows);
    assert.ok(report.examined > 0, "examined nothing");
    assert.deepEqual(
      report.forAllOffenders, [],
      "A FOR ALL policy with no WITH CHECK reuses its USING clause as the write check. That is only\n" +
        "correct when USING already IS the intended write predicate; a read-oriented USING (a crew test,\n" +
        "a visibility test) silently becomes a write grant. Write WITH CHECK explicitly (see\n" +
        "plan_geofences_update_accepted in 2337). Exempt by rule: TO service_role only, USING (false),\n" +
        "USING (auth.role() = 'service_role'). Everything else must be named in\n" +
        "FOR_ALL_WITHOUT_WITH_CHECK_BASELINE, which only shrinks. Offenders:\n  " +
        report.forAllOffenders.join("\n  "),
    );
  });

  it("no SELECT policy admits on an array column without a crew gate", async () => {
    const rows = await snapshotOrFail(policiesV2);
    const report = evaluatePolicySnapshot(rows);
    assert.ok(report.examined > 0, "examined nothing");
    assert.deepEqual(
      report.arrayGrantOffenders, [],
      "A policy admits on `auth.uid() = ANY(<array column>)` and nothing else. An array of ids is a grant\n" +
        "list, not a membership: 2337 measured a STRANGER listed in trip_crew_location_sessions.\n" +
        "allowed_member_ids reading the session, and that branch dominated the careful recipients policy\n" +
        "beside it. Gate the grant on authz.is_trip_crew(trip_id) (see crew_sessions_recipients_read).\n" +
        "Offenders:\n  " + report.arrayGrantOffenders.join("\n  "),
    );
  });

  it("every known-open, reviewed and baseline entry is still exactly what it claims (shrink-only)", async () => {
    const rows = await snapshotOrFail(policiesV2);
    const report = evaluatePolicySnapshot(rows);
    assert.ok(report.examined > 0, "examined nothing");

    assert.deepEqual(
      report.tripMembersMissingReviewed, [],
      "TRIP_MEMBERS_REVIEWED_ALLOWLIST names policies that do not exist on this database:\n  " +
        report.tripMembersMissingReviewed.join("\n  "),
    );
    assert.deepEqual(
      report.tripMembersStaleKnownOpen, [],
      "These TRIP_MEMBERS_KNOWN_OPEN entries are FIXED (or gone) on this database. Remove them — each row's\n" +
        "removeWhen names the event:\n  " +
        report.tripMembersStaleKnownOpen
          .map((k) => `${k}: ${TRIP_MEMBERS_KNOWN_OPEN.find((e) => e.key === k)?.removeWhen ?? ""}`)
          .join("\n  "),
    );
    assert.deepEqual(
      report.forAllStaleBaseline, [],
      "These FOR_ALL_WITHOUT_WITH_CHECK_BASELINE entries now carry WITH CHECK, are service-only, or are gone.\n" +
        "Remove them so the baseline keeps shrinking:\n  " + report.forAllStaleBaseline.join("\n  "),
    );
    assert.deepEqual(
      report.arrayGrantStaleKnownOpen, [],
      "These ARRAY_GRANT_KNOWN_OPEN entries are FIXED on this database. Remove them:\n  " +
        report.arrayGrantStaleKnownOpen
          .map((k) => `${k}: ${ARRAY_GRANT_KNOWN_OPEN.find((e) => e.key === k)?.removeWhen ?? ""}`)
          .join("\n  "),
    );
    // Belt and braces: the lists themselves are non-empty as committed, so a
    // future edit that empties one by accident is visible here rather than
    // making every rule above trivially true.
    assert.ok(TRIP_MEMBERS_REVIEWED_ALLOWLIST.length > 0);
    assert.ok(FOR_ALL_WITHOUT_WITH_CHECK_BASELINE.length > 0);
  });
});
