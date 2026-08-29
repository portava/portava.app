/**
 * RLS policy SHAPE guard — two defect classes that make a policy fail closed on
 * the whole table, or silently stop discriminating.
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
 * A one-off sweep found them. This test makes the sweep permanent, so the next
 * hand-written policy of either shape fails in CI instead of in production.
 *
 * THE ALLOWLIST SHRINKS, NEVER GROWS. The two message-thread policies are
 * recorded as known-open with their tracking context; anything else is a
 * failure. Adding a row here to make CI green is the one thing this file exists
 * to prevent.
 *
 * Run: node --import tsx/esm --env-file-if-exists=.env --test src/test/rlsPolicyShapeLive.test.ts
 */
import "../lib/ciSupabaseGuard.mjs";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CREDS = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

const sc = CREDS
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : (null as any);

/**
 * Known-open offenders, as `table::policy`. ONE entry, and it may only shrink.
 *
 * mtm_select carries BOTH defects and is being fixed separately — deliberately
 * both at once, because fixing the recursion alone would convert a hard 42P17
 * into a silent cross-thread message leak.
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
  "message_thread_members::mtm_select",
]);

/** One row per public-schema policy, via the service-role-only snapshot RPC. */
async function policies(): Promise<Array<{ tablename: string; policyname: string; expr: string }>> {
  const { data, error } = await sc.rpc("pg_policies_snapshot");
  if (error) throw new Error(`pg_policies_snapshot: ${error.message} (apply migration 2199)`);
  return (data ?? []) as Array<{ tablename: string; policyname: string; expr: string }>;
}

const SELF_REF = (t: string) => new RegExp(`(FROM|JOIN)\\s+(public\\.)?${t}\\M`);
const TAUTOLOGY = /\(([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*) = \1\.\2\)/;

describe("RLS policy shapes — recursion and tautology", () => {
  it("no policy selects FROM its own table (42P17 infinite recursion)", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    let rows;
    try { rows = await policies(); } catch (e) { return t.skip(`snapshot unavailable: ${(e as Error).message}`); }

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

  it("no policy compares a column to itself (always-true predicate)", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    let rows;
    try { rows = await policies(); } catch (e) { return t.skip(`snapshot unavailable: ${(e as Error).message}`); }

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

  it("the allowlist only holds entries that are still genuinely broken", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    let rows;
    try { rows = await policies(); } catch (e) { return t.skip(`snapshot unavailable: ${(e as Error).message}`); }

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
  });
});
