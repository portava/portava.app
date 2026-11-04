/**
 * Migration 3940 EXECUTED on a real database (census-telegraph T72/T73; verifier finding on #786):
 * no client role can read a receipt cursor — another member's or its own.
 *
 * THE LEAK THIS CLOSES. delivered_sequence moves when a member's open connection takes a live message.
 * With the table-level client SELECT production had, policy mtm_select let any active member read every
 * row of their thread, so a group member could poll a co-member's cursor and learn when they were
 * online. The receipt rules allow a group only a COUNT (src/test/telegraphDeliveryReceipts.test.ts).
 *
 * Pinned, as the PostgREST roles themselves:
 *   - a CO-MEMBER reading another member's delivered_sequence or seen_sequence: permission denied;
 *   - a member reading their OWN cursor: permission denied (the column, not the row, is refused);
 *   - a STRANGER and anon: permission denied;
 *   - `select *` (what an embed would ask for): permission denied, so no shape reaches them;
 *   - control: the same co-member still reads the columns they held before (left_at,
 *     removed_at), so membership and history reads are unchanged;
 *   - the API's service role (the receipts route's client) still reads both cursors.
 *
 * MUTANT (tgprod/mutants-786.txt): CP1 the table-level SELECT restored → every denial case red.
 *
 * Skips without LOCAL_DB_URL; scripts/local-db/run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, deleteUser, exec, psql, scalar, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;

function svc(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}

function asRole(role: "authenticated" | "anon", userId: string | null, sql: string) {
  return psql(
    [
      ...(userId ? [`SELECT set_config('request.jwt.claim.sub', '${userId}', true);`] : []),
      `SELECT set_config('request.jwt.claim.role', '${role}', true);`,
      `SET LOCAL ROLE ${role};`,
      sql,
    ].join("\n"),
    { single: true },
  );
}

describe("3940 — the receipt cursors are no client role's to read, on a real database", { skip: SKIP }, () => {
  let alice = "";
  let bob = "";
  let eve = "";
  let t = "";

  before(() => {
    alice = seedUser("cp_alice");
    bob = seedUser("cp_bob");
    eve = seedUser("cp_eve");
    const out = svc(`INSERT INTO public.message_threads (thread_type, status, created_by) VALUES ('group', 'active', '${alice}') RETURNING id;`);
    t = out[out.length - 1]!;
    svc(`INSERT INTO public.message_thread_members (thread_id, user_id, role) VALUES ('${t}', '${alice}', 'admin'), ('${t}', '${bob}', 'member');`);
    svc(`UPDATE public.message_thread_members SET delivered_sequence = 7, seen_sequence = 5 WHERE thread_id = '${t}' AND user_id = '${bob}';`);
  });
  after(() => {
    if (t) svc(`DELETE FROM public.message_threads WHERE id = '${t}';`);
    for (const u of [alice, bob, eve]) if (u) deleteUser(u);
  });

  const denied = (r: { status: number; stderr: string }, what: string) => {
    assert.notEqual(r.status, 0, `${what} was answered`);
    assert.match(r.stderr, /permission denied/, `${what}: ${r.stderr}`);
  };

  it("a co-member cannot read another member's delivered_sequence or seen_sequence", () => {
    denied(asRole("authenticated", alice, `SELECT delivered_sequence FROM public.message_thread_members WHERE thread_id = '${t}' AND user_id = '${bob}';`), "co-member delivered_sequence");
    denied(asRole("authenticated", alice, `SELECT seen_sequence FROM public.message_thread_members WHERE thread_id = '${t}' AND user_id = '${bob}';`), "co-member seen_sequence");
  });

  it("a member cannot read their OWN cursors either — the column is refused, not the row", () => {
    denied(asRole("authenticated", bob, `SELECT delivered_sequence, seen_sequence FROM public.message_thread_members WHERE thread_id = '${t}' AND user_id = '${bob}';`), "own cursors");
  });

  it("a stranger and anon are refused; `select *` (an embed's shape) is refused for everyone", () => {
    denied(asRole("authenticated", eve, `SELECT delivered_sequence FROM public.message_thread_members WHERE thread_id = '${t}';`), "stranger");
    denied(asRole("anon", null, `SELECT seen_sequence FROM public.message_thread_members;`), "anon");
    denied(asRole("authenticated", alice, `SELECT * FROM public.message_thread_members WHERE thread_id = '${t}';`), "select *");
  });

  it("control: the co-member still reads what they read before — membership and its history columns", () => {
    const r = asRole("authenticated", alice, `SELECT user_id || ':' || coalesce(left_at::text, 'active') || ':' || coalesce(role::text, 'none') FROM public.message_thread_members WHERE thread_id = '${t}' ORDER BY user_id;`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split("\n").filter((l) => l.includes(":active:")).length, 2, r.stdout);
    for (const col of ["thread_id", "user_id", "role", "joined_at", "left_at", "visible_from_at"]) {
      assert.equal(scalar(`SELECT has_column_privilege('authenticated', 'public.message_thread_members', '${col}', 'SELECT')`), "t", col);
    }
    if (scalar(`SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.message_thread_members'::regclass AND attname = 'removed_at' AND NOT attisdropped`) === "1") {
      assert.equal(scalar(`SELECT has_column_privilege('authenticated', 'public.message_thread_members', 'removed_at', 'SELECT')`), "t", "removed_at (3934) stays readable");
    }
  });

  it("the API's service role — the receipts route's client — still reads both cursors", () => {
    const out = svc(`SELECT delivered_sequence || '/' || seen_sequence FROM public.message_thread_members WHERE thread_id = '${t}' AND user_id = '${bob}';`);
    assert.equal(out[out.length - 1], "7/5");
  });
});
