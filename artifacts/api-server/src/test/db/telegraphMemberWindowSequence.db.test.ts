/**
 * Migration 3935 EXECUTED on a real database (census-telegraph T210, T139, §14.3 / §17.1):
 * `visible_from_sequence` WRITTEN — the membership window 2400's `visible_from_at`
 * bounds, in the envelope's own coordinate — and 2810's operator backfill made safe for
 * every sequence-coordinate column a member row carries.
 *
 * Pinned here, on PostgreSQL itself:
 *   · a member who joins a sequenced conversation is bounded at the NEXT sequence;
 *   · an earlier-timestamp window (a grant) is bounded at the first message it admits;
 *   · a rejoin opens a new window, and its sequence moves with it;
 *   · an UPDATE cannot clear the sequence statement of a window that exists;
 *   · the operator backfill renumbers as 2810 did AND rebases the member rows in the
 *     same transaction: the window bounds from their time bounds, the receipt cursors
 *     by MESSAGE IDENTITY — so a bound can never be left behind to admit
 *     pre-membership messages, and a delivered/seen cursor never moves to another message;
 *   · re-running the backfill changes nothing;
 *   · no client role can run the backfill or the trigger functions. · 3939 (one release unit with 3935): a client INSERT is refused BY ROW-LEVEL SECURITY, never by a function-permission error, and the trigger runs as its owner with search_path pg_catalog, pg_temp.
 *
 * MUTANTS (applied to the local database one at a time, each red, each restored by
 * re-applying 3935 — tgprod/mutants-b3.txt):
 *   WS1 the trigger never writes visible_from_sequence ............................ red
 *   WS2 a rejoin keeps the old window's sequence .................................. red
 *   WS3 the backfill does not rebase the window bound ............................. red
 *   WS4 the backfill does not carry the cursors by identity ....................... red
 *   WS5 the backfill executable by `authenticated` ................................ red · WD1 (3939) the trigger function back to SECURITY INVOKER ........ red
 *
 * Messages are sequenced by hand here (the kernel flag is OFF on the local database),
 * which is the "explicit sequence" path 2810's trigger respects.
 *
 * Skips without LOCAL_DB_URL; scripts/local-db/run-tests.sh refuses a run with
 * skipped > 0, so CI's local-db job is where this counts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, deleteUser, exec, psql, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;

function svc(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}

interface Member {
  visible_from_at: string | null;
  visible_from_sequence: string | number | null;
  visible_until_sequence: string | number | null;
  delivered_sequence: string | number | null;
  seen_sequence: string | number | null;
}
const n = (v: string | number | null) => (v === null ? null : Number(v));

describe("3935 — visible_from_sequence and a backfill that rebases what it renumbers, on a real database", { skip: SKIP }, () => {
  let alice = "";
  let bob = "";
  let carol = "";
  const threads: string[] = [];

  function thread(): string {
    const out = svc(`INSERT INTO public.message_threads (thread_type, status, created_by) VALUES ('group', 'active', '${alice}') RETURNING id;`);
    const id = out[out.length - 1]!;
    assert.match(id, /^[0-9a-f-]{36}$/);
    threads.push(id);
    return id;
  }
  /** A message at an explicit instant, optionally sequenced by hand (the explicit-sequence path). */
  function message(t: string, from: string, at: string, sequence: number | null): string {
    const out = svc(
      `INSERT INTO public.messages (thread_id, sender_id, body, created_at${sequence === null ? "" : ", sequence"}) ` +
        `VALUES ('${t}', '${from}', 'm', '${at}'${sequence === null ? "" : `, ${sequence}`}) RETURNING id;`,
    );
    return out[out.length - 1]!;
  }
  const setLast = (t: string, last: number) => svc(`UPDATE public.message_threads SET last_sequence = ${last} WHERE id = '${t}';`);
  const join = (t: string, u: string, extra = "") =>
    svc(`INSERT INTO public.message_thread_members (thread_id, user_id, role${extra ? ", visible_from_at" : ""}) VALUES ('${t}', '${u}', 'member'${extra ? `, '${extra}'` : ""});`);
  const member = (t: string, u: string): Member =>
    rows<Member>(`SELECT visible_from_at, visible_from_sequence, visible_until_sequence, delivered_sequence, seen_sequence FROM public.message_thread_members WHERE thread_id = '${t}' AND user_id = '${u}'`)[0]!;
  const seqOf = (id: string) => n(scalar(`SELECT sequence FROM public.messages WHERE id = '${id}'`));

  before(() => {
    alice = seedUser("ws_alice");
    bob = seedUser("ws_bob");
    carol = seedUser("ws_carol");
  });

  after(() => {
    for (const t of threads) svc(`DELETE FROM public.message_threads WHERE id = '${t}';`);
    for (const u of [alice, bob, carol]) if (u) deleteUser(u);
  });

  it("a member who joins a sequenced conversation is bounded at the next sequence", () => {
    const t = thread();
    message(t, alice, "2026-05-01T10:00:00Z", 1);
    message(t, alice, "2026-05-01T10:01:00Z", 2);
    setLast(t, 2);
    join(t, bob);
    assert.equal(n(member(t, bob).visible_from_sequence), 3);
  });

  it("an earlier-timestamp window is bounded at the first message it admits", () => {
    const t = thread();
    message(t, alice, "2026-05-01T09:00:00Z", 1);
    message(t, alice, "2026-05-01T10:00:00Z", 2);
    message(t, alice, "2026-05-01T11:00:00Z", 3);
    setLast(t, 3);
    join(t, bob, "2026-05-01T09:30:00Z");
    assert.equal(n(member(t, bob).visible_from_sequence), 2);
  });

  it("a rejoin opens a new window, and its sequence moves with it", () => {
    const t = thread();
    message(t, alice, "2026-05-01T09:00:00Z", 1);
    setLast(t, 1);
    join(t, bob);
    assert.equal(n(member(t, bob).visible_from_sequence), 2);
    svc(`UPDATE public.message_thread_members SET left_at = now() WHERE thread_id = '${t}' AND user_id = '${bob}';`);
    message(t, alice, "2026-05-01T09:10:00Z", 2);
    message(t, alice, "2026-05-01T09:20:00Z", 3);
    setLast(t, 3);
    svc(`UPDATE public.message_thread_members SET left_at = NULL WHERE thread_id = '${t}' AND user_id = '${bob}';`);
    assert.equal(n(member(t, bob).visible_from_sequence), 4, "the messages sent while out are not regained");
  });

  it("an UPDATE cannot clear the sequence statement of a window that exists", () => {
    const t = thread();
    setLast(t, 5);
    join(t, bob);
    svc(`UPDATE public.message_thread_members SET visible_from_sequence = NULL WHERE thread_id = '${t}' AND user_id = '${bob}';`);
    assert.equal(n(member(t, bob).visible_from_sequence), 6);
  });

  it("the backfill renumbers AND rebases: window bounds from their time, cursors by message identity", () => {
    const t = thread();
    // Two pre-kernel messages (no sequence), then three sequenced after the kernel went on.
    const l1 = message(t, alice, "2026-04-01T08:00:00Z", null);
    const l2 = message(t, alice, "2026-04-01T08:30:00Z", null);
    const k1 = message(t, alice, "2026-05-01T10:00:00Z", 1);
    const k2 = message(t, alice, "2026-05-01T10:01:00Z", 2);
    const k3 = message(t, alice, "2026-05-01T10:02:00Z", 3);
    setLast(t, 3);
    // Bob joined between l2 and k1: by time he sees k1.. only.
    join(t, bob, "2026-04-15T00:00:00Z");
    assert.equal(n(member(t, bob).visible_from_sequence), 1, "before the backfill, k1 is sequence 1");
    // Bob's receipts point at k2 (delivered) and k1 (seen).
    svc(`UPDATE public.message_thread_members SET delivered_sequence = 2, seen_sequence = 1 WHERE thread_id = '${t}' AND user_id = '${bob}';`);
    // Carol left after k2.
    join(t, carol, "2026-03-01T00:00:00Z");
    svc(`UPDATE public.message_thread_members SET left_at = '2026-05-01T10:01:30Z' WHERE thread_id = '${t}' AND user_id = '${carol}';`);

    assert.equal(n(scalar(`SELECT public.telegraph_backfill_message_sequences('${t}')`)), 5);
    assert.deepEqual([l1, l2, k1, k2, k3].map(seqOf), [1, 2, 3, 4, 5], "2810's numbering, unchanged");
    const b = member(t, bob);
    assert.equal(n(b.visible_from_sequence), 3, "the bound still admits k1 and nothing before it — never l1 or l2");
    assert.equal(n(b.delivered_sequence), seqOf(k2), "the delivered cursor stays on k2");
    assert.equal(n(b.seen_sequence), seqOf(k1), "the seen cursor stays on k1");
    assert.equal(n(member(t, carol).visible_until_sequence), seqOf(k2), "the closed interval ends at k2");

    const before = member(t, bob);
    scalar(`SELECT public.telegraph_backfill_message_sequences('${t}')`);
    assert.deepEqual(member(t, bob), before, "re-running changes nothing");
    assert.deepEqual([l1, l2, k1, k2, k3].map(seqOf), [1, 2, 3, 4, 5]);
  });

  it("no client role can run the backfill or the window functions", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const fn of ["public.telegraph_backfill_message_sequences(uuid)", "public.telegraph_member_window_sequence()", "public.telegraph_window_first_sequence(uuid, timestamptz)"]) {
        assert.equal(scalar(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE')`), "f", `${role} ${fn}`);
      }
    }
    const t = thread();
    const r = psql(
      [
        `SELECT set_config('request.jwt.claim.sub', '${bob}', true);`,
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true);`,
        `SET LOCAL ROLE authenticated;`,
        `SELECT public.telegraph_backfill_message_sequences('${t}');`,
      ].join("\n"),
      { single: true },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /permission denied/);
  });

  it("the trigger fires after 2400's window trigger (name order), so it states the window that trigger opened", () => {
    const names = rows<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.message_thread_members'::regclass AND NOT tgisinternal AND tgname LIKE 'telegraph_member_%' ORDER BY tgname`,
    ).map((r) => r.tgname);
    assert.ok(names.indexOf("telegraph_member_visibility_window") < names.indexOf("telegraph_member_window_sequence"), names.join(","));
  });

  it("3939: a client INSERT reaches the table's policy and is refused BY ROW-LEVEL SECURITY, not by a function-permission error", () => {
    // The row carries a window (visible_from_at), so the BEFORE trigger takes the helper path — the
    // path that, as INVOKER, failed on the helper's revoked EXECUTE before RLS was ever consulted.
    const t = thread();
    const r = psql(
      [
        `SELECT set_config('request.jwt.claim.sub', '${carol}', true);`,
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true);`,
        `SET LOCAL ROLE authenticated;`,
        `INSERT INTO public.message_thread_members (thread_id, user_id, role, visible_from_at) VALUES ('${t}', '${carol}', 'member', now());`,
      ].join("\n"),
      { single: true },
    );
    assert.notEqual(r.status, 0, "a client cannot add itself to a conversation");
    assert.doesNotMatch(r.stderr, /permission denied for function/, "refused by a helper's grant, not by the table's policy");
    assert.match(r.stderr, /new row violates row-level security policy/);
    assert.equal(scalar(`SELECT count(*) FROM public.message_thread_members WHERE thread_id = '${t}' AND user_id = '${carol}'`), "0");
    // The definer posture 3939 states: owner not a client role, search_path minimal, no client EXECUTE.
    const fn = rows<{ prosecdef: boolean; owner: string; config: string }>(
      `SELECT prosecdef, pg_get_userbyid(proowner) AS owner, array_to_string(proconfig, ';') AS config FROM pg_proc WHERE oid = 'public.telegraph_member_window_sequence()'::regprocedure`,
    )[0]!;
    assert.equal(fn.prosecdef, true);
    assert.equal(fn.config, "search_path=pg_catalog, pg_temp");
    assert.ok(!["anon", "authenticated", "authenticator"].includes(fn.owner), fn.owner);
  });
});
