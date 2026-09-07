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
 * Known-open offenders, as `table::policy`. It may only shrink, and as of
 * migration 2402 it is EMPTY.
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

/** One row per public-schema policy, via the service-role-only snapshot RPC. */
async function policies(): Promise<Array<{ tablename: string; policyname: string; expr: string }>> {
  const { data, error } = await sc.rpc("pg_policies_snapshot");
  if (error) throw new Error(`pg_policies_snapshot: ${error.message} (apply migration 2199)`);
  return (data ?? []) as Array<{ tablename: string; policyname: string; expr: string }>;
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

  it("no cross-table policy cycle (42P17 by mutual reference)", async (t) => {
    if (!CREDS) return t.skip("credentials absent");
    let rows;
    try { rows = await policies(); } catch (e) { return t.skip(`snapshot unavailable: ${(e as Error).message}`); }

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

    const liveCycles = new Set(policyCycles(rows));
    const staleCycles = [...KNOWN_CYCLES].filter((c) => !liveCycles.has(c));
    assert.deepEqual(
      staleCycles, [],
      "These KNOWN_CYCLES entries are FIXED on this database. Remove them:\n  " + staleCycles.join("\n  "),
    );
  });
});
