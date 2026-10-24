/**
 * Migration 3934 EXECUTED on a real database (census-telegraph T389, §30A.4):
 * `message_thread_members.removed_at`, and `visible_until_sequence` WRITTEN when
 * a membership interval ends.
 *
 * Pinned here, on PostgreSQL itself (the route's own tests pin the API half,
 * src/test/telegraphGroupControls.test.ts "§30A.4 removed_at"):
 *   · the route's one statement (left_at + removed_at) is accepted and closes
 *     the interval at the conversation's last_sequence;
 *   · a departure that is not a removal carries no removed_at;
 *   · an unsequenced conversation gets NULL, never 0; an explicit bound is kept;
 *   · a removal is a departure: removed_at on an active member is REFUSED (23514);
 *   · a rejoin is a new interval: removed_at and visible_until_sequence clear;
 *   · NO CLIENT WRITES IT: as `authenticated`, an UPDATE touches no row and an
 *     INSERT is refused (RLS: mtm_insert WITH CHECK false, no UPDATE policy);
 *     the trigger function is not executable by a client role;
 *   · members READ it as they read left_at: the removed person's own row, and a
 *     co-member's view of it.
 *
 * Threads are `group` (3660 widened chk_thread_context for it).
 *
 * MUTANTS (applied to the local database one at a time, each red, each restored
 * by re-applying 3934 — tgprod/mutants-b2.txt):
 *   RM1 the departure never writes visible_until_sequence ........................ red
 *   RM2 an unsequenced conversation gets 0 ...................................... red
 *   RM3 an explicit bound is overwritten ......................................... red
 *   RM4 a rejoin keeps the closed interval's bound ............................... red
 *   RM5 the removed-is-a-departure CHECK dropped ................................. red
 *   RM6 the trigger function executable by `authenticated` ....................... red
 *
 * Skips without LOCAL_DB_URL; scripts/local-db/run-tests.sh refuses a run with
 * skipped > 0, so CI's local-db job is where this counts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, asUser, deleteUser, exec, psql, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;

function svc(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}

interface Member { left_at: string | null; removed_at: string | null; visible_until_sequence: string | number | null }

describe("3934 — removed_at and the closed interval's sequence bound, on a real database", { skip: SKIP }, () => {
  let host = "";
  let bob = "";
  let carol = "";
  let dave = ""; // in no thread: an INSERT of his row can only be refused by RLS, never by a duplicate key
  const threads: string[] = [];

  function group(lastSequence: number, members: string[]): string {
    const out = svc(`INSERT INTO public.message_threads (thread_type, status, created_by) VALUES ('group', 'active', '${host}') RETURNING id;`);
    const id = out[out.length - 1]!;
    assert.match(id, /^[0-9a-f-]{36}$/);
    threads.push(id);
    svc(
      `UPDATE public.message_threads SET last_sequence = ${lastSequence} WHERE id = '${id}';\n` +
        members.map((m) => `INSERT INTO public.message_thread_members (thread_id, user_id, role) VALUES ('${id}', '${m}', '${m === host ? "admin" : "member"}');`).join("\n"),
    );
    return id;
  }

  const member = (t: string, u: string): Member =>
    rows<Member>(`SELECT left_at, removed_at, visible_until_sequence FROM public.message_thread_members WHERE thread_id = '${t}' AND user_id = '${u}'`)[0]!;

  /** The route's own statement (routes/telegraphGroups.ts POST …/moderation/:userId/remove). */
  const remove = (t: string, u: string) =>
    svc(`UPDATE public.message_thread_members SET left_at = now(), removed_at = now() WHERE thread_id = '${t}' AND user_id = '${u}' AND left_at IS NULL;`);

  before(() => {
    host = seedUser("rm_host");
    bob = seedUser("rm_bob");
    carol = seedUser("rm_carol");
    dave = seedUser("rm_dave");
  });

  after(() => {
    for (const t of threads) svc(`DELETE FROM public.message_threads WHERE id = '${t}';`);
    for (const u of [host, bob, carol, dave]) if (u) deleteUser(u);
  });

  it("the catalog carries what 3934 promises, and no client role can execute the trigger function", () => {
    assert.equal(scalar(`SELECT format_type(atttypid, atttypmod) || '/' || attnotnull FROM pg_attribute WHERE attrelid = 'public.message_thread_members'::regclass AND attname = 'removed_at' AND NOT attisdropped`), "timestamp with time zone/false");
    assert.equal(scalar(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.message_thread_members'::regclass AND conname = 'message_thread_members_removed_is_a_departure'`), "CHECK (((removed_at IS NULL) OR (left_at IS NOT NULL)))");
    assert.match(scalar(`SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.message_thread_members'::regclass AND tgname = 'telegraph_member_interval_bounds'`) ?? "", /BEFORE UPDATE OF left_at ON public\.message_thread_members FOR EACH ROW/);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.telegraph_member_interval_bounds()', 'EXECUTE')`), "f", role);
    }
  });

  it("a removal: one statement writes left_at and removed_at, and the interval closes at last_sequence", () => {
    const t = group(7, [host, bob, carol]);
    remove(t, bob);
    const b = member(t, bob);
    assert.ok(b.left_at);
    assert.equal(b.removed_at, b.left_at, "the same instant");
    assert.equal(Number(b.visible_until_sequence), 7);
    const c = member(t, carol);
    assert.equal(c.left_at, null);
    assert.equal(c.removed_at, null, "nobody else is touched");
    assert.equal(c.visible_until_sequence, null);
  });

  it("a departure that is not a removal carries no removed_at, and still closes the interval", () => {
    const t = group(3, [host, bob]);
    svc(`UPDATE public.message_thread_members SET left_at = now() WHERE thread_id = '${t}' AND user_id = '${bob}';`);
    const b = member(t, bob);
    assert.ok(b.left_at);
    assert.equal(b.removed_at, null);
    assert.equal(Number(b.visible_until_sequence), 3);
  });

  it("an unsequenced conversation gets NULL, never 0; an explicit bound is kept", () => {
    const t = group(0, [host, bob, carol]);
    remove(t, bob);
    assert.equal(member(t, bob).visible_until_sequence, null);
    const t2 = group(9, [host, bob]);
    svc(`UPDATE public.message_thread_members SET left_at = now(), visible_until_sequence = 4 WHERE thread_id = '${t2}' AND user_id = '${bob}';`);
    assert.equal(Number(member(t2, bob).visible_until_sequence), 4);
  });

  it("a removal is a departure: removed_at on an ACTIVE member is refused", () => {
    const t = group(2, [host, bob]);
    const r = psql(`SET ROLE service_role;\nUPDATE public.message_thread_members SET removed_at = now() WHERE thread_id = '${t}' AND user_id = '${bob}';`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /message_thread_members_removed_is_a_departure/);
    assert.equal(member(t, bob).removed_at, null);
  });

  it("a rejoin is a new interval: removed_at and visible_until_sequence go with the closed one", () => {
    const t = group(5, [host, bob]);
    remove(t, bob);
    assert.ok(member(t, bob).removed_at);
    svc(`UPDATE public.message_thread_members SET left_at = NULL WHERE thread_id = '${t}' AND user_id = '${bob}';`);
    const b = member(t, bob);
    assert.equal(b.left_at, null);
    assert.equal(b.removed_at, null);
    assert.equal(b.visible_until_sequence, null);
  });

  it("NO CLIENT WRITES IT: as the removed person, an UPDATE touches no row and an INSERT is refused", () => {
    const t = group(4, [host, bob, carol]);
    remove(t, bob);
    const before = member(t, bob);
    // Erase one's own removal record (keep left_at, so the CHECK is not what stops it).
    const upd = asUser(bob, `UPDATE public.message_thread_members SET removed_at = NULL WHERE thread_id = '${t}' AND user_id = '${bob}' RETURNING 1;`);
    assert.deepEqual(upd.filter((l) => l === "1"), [], "RLS: no UPDATE policy, so no row is touched");
    assert.deepEqual(member(t, bob), before, "the record is unchanged");
    // Forge a removal for a co-member.
    asUser(host, `UPDATE public.message_thread_members SET left_at = now(), removed_at = now() WHERE thread_id = '${t}' AND user_id = '${carol}';`);
    assert.equal(member(t, carol).removed_at, null, "even a host's client cannot write it: only the API's service role does");
    const ins = psql(
      [
        `SELECT set_config('request.jwt.claim.sub', '${dave}', true);`,
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true);`,
        `SET LOCAL ROLE authenticated;`,
        `INSERT INTO public.message_thread_members (thread_id, user_id, role, left_at, removed_at) VALUES ('${t}', '${dave}', 'member', now(), now());`,
      ].join("\n"),
      { single: true },
    );
    assert.notEqual(ins.status, 0);
    assert.match(ins.stderr, /new row violates row-level security policy/);
    assert.equal(scalar(`SELECT count(*) FROM public.message_thread_members WHERE thread_id = '${t}' AND user_id = '${dave}'`), "0");
  });

  it("members READ it as they read left_at: the removed person's own row, and an active co-member's view", () => {
    const t = group(6, [host, bob, carol]);
    remove(t, bob);
    const own = asUser(bob, `SELECT (removed_at IS NOT NULL)::text FROM public.message_thread_members WHERE thread_id = '${t}' AND user_id = '${bob}';`);
    assert.ok(own.includes("true"), JSON.stringify(own));
    const peer = asUser(carol, `SELECT (removed_at IS NOT NULL)::text FROM public.message_thread_members WHERE thread_id = '${t}' AND user_id = '${bob}';`);
    assert.ok(peer.includes("true"), JSON.stringify(peer));
  });
});
