/**
 * Migration 3941 EXECUTED on a real database: no client role can read a thread member's private
 * per-member state — last_read_at, archived_at, muted_at (and 3760's notification_level / muted_until).
 *
 * THE LEAK THIS CLOSES (found on main at ffdf6428c while fixing PR #786). anon and authenticated held a
 * TABLE-level SELECT on message_thread_members and policy mtm_select admits every row of a thread to
 * every active member of it, so a group member could read, for every co-member, when they last read the
 * thread, whether they archived it and whether they muted it — through PostgREST, with the anon key.
 *
 * HOW THESE PROPERTIES BITE: up.sh replays 3941 with the chain, so the database under test already
 * carries its effect (PS0, PS1). PS2–PS6 rebuild an EARLIER posture inside a transaction that always
 * rolls back, prove the hole is open there, run 3941's own blocks (read from the migration file), and
 * assert it is closed.
 *
 *   PS0  chain end, as the PostgREST roles: a co-member, the member themselves, a stranger and anon are
 *        refused each private column ("permission denied"); `select *` and a FILTER on last_read_at are
 *        refused too (a range oracle needs no select list). Control: the co-member still reads the
 *        membership columns, both rows.
 *   PS1  the API's service role still reads every private column (the routes that serve them).
 *   PS2  MUTANT — the baseline's table-level SELECT restored (the pre-3941 state, production today):
 *        the co-member READS the other member's last_read_at, archived_at and muted_at. Then 3941's body
 *        runs over that state and every one is refused again, membership still readable.
 *   PS3  composition with #786's 3940 (cursor columns withheld) applied FIRST: 3941 over 3940's end state
 *        keeps the cursors withheld (it only narrows) and withholds its own five.
 *   PS4  3941's postcondition raises over the pre-3941 state — so certify:migrations stage 4 goes red if
 *        anything applied later (3940 as written at #786 head 19e6e6f68, applied after 3941) re-grants a
 *        private column.
 *   PS5  3941's body is idempotent: twice over the same state, same end state, postcondition passes.
 *   PS6  the rollback file restores exactly the private columns to both client roles and leaves every
 *        other column's privilege as it found it.
 *
 * MUTANTS (run 2026-10-24 on the local harness; 7 tests):
 *   MA  3941 not in force (the table-level grant committed back) → PS0, PS4, PS6 red (3 of 7).
 *   MB  archived_at dropped from 3941's narrow block → PS2, PS3, PS5 red (3 of 7).
 *   MC  the narrow block derives its list from the catalog instead of current privileges (3940's own
 *       shape) → PS3 red: the cursors 3940 withheld are re-granted.
 *
 * Skips without LOCAL_DB_URL; scripts/local-db/run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HAVE_DB, deleteUser, exec, psql, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;
const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3941_telegraph_member_private_state_column_privileges.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-24-3941-telegraph-member-private-state-column-privileges-rollback.sql");

const PRIVATE = ["last_read_at", "archived_at", "muted_at"] as const;
const MEMBERSHIP = ["thread_id", "user_id", "role", "joined_at", "left_at"] as const;

/** One `DO $tag$ … $tag$;` block of a file, verbatim. */
function block(sql: string, tag: string): string {
  const start = sql.indexOf(`DO $${tag}$`);
  const end = sql.indexOf(`END $${tag}$;`, start);
  assert.ok(start >= 0 && end > start, `block $${tag}$ not found`);
  return sql.slice(start, end + `END $${tag}$;`.length);
}

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

/**
 * pg_temp.probe(user, role, sql): runs `sql` as that PostgREST role inside a subtransaction and answers
 * 'denied' or 'ok:<rows>' — so one rolled-back transaction can probe several postures in turn.
 */
const PROBE_FN = `
CREATE FUNCTION pg_temp.probe(p_user uuid, p_role text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  PERFORM set_config('request.jwt.claim.role', p_role, true);
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE 'SELECT string_agg(x::text, ''|'' ORDER BY x::text) FROM (' || p_sql || ') x' INTO v;
    SET LOCAL ROLE postgres;
    RETURN 'ok:' || coalesce(v, '');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN 'denied';
  END;
END $f$;`;

describe("3941 — a member's private state is no client role's to read, on a real database", { skip: SKIP }, () => {
  let alice = "";
  let bob = "";
  let eve = "";
  let t = "";
  const migration = SKIP ? "" : readFileSync(MIGRATION, "utf8");

  before(() => {
    alice = seedUser("ps_alice");
    bob = seedUser("ps_bob");
    eve = seedUser("ps_eve");
    const out = svc(`INSERT INTO public.message_threads (thread_type, status, created_by) VALUES ('group', 'active', '${alice}') RETURNING id;`);
    t = out[out.length - 1]!;
    svc(`INSERT INTO public.message_thread_members (thread_id, user_id, role) VALUES ('${t}', '${alice}', 'admin'), ('${t}', '${bob}', 'member');`);
    svc(`UPDATE public.message_thread_members
            SET last_read_at = '2026-10-24 09:15:00+00', archived_at = '2026-10-24 09:16:00+00', muted_at = '2026-10-24 09:17:00+00'
          WHERE thread_id = '${t}' AND user_id = '${bob}';`);
  });
  after(() => {
    if (t) svc(`DELETE FROM public.message_threads WHERE id = '${t}';`);
    for (const u of [alice, bob, eve]) if (u) deleteUser(u);
  });

  const denied = (r: { status: number; stderr: string }, what: string) => {
    assert.notEqual(r.status, 0, `${what} was answered`);
    assert.match(r.stderr, /permission denied/, `${what}: ${r.stderr}`);
  };
  const bobRow = () => `FROM public.message_thread_members WHERE thread_id = '${t}' AND user_id = '${bob}'`;

  /** Run `body` (postgres) in a transaction that always rolls back; return the labelled probe answers. */
  function inTx(body: string): Record<string, string> {
    const out = exec(`BEGIN;\n${PROBE_FN}\n${body}\nROLLBACK;`);
    const res: Record<string, string> = {};
    for (const line of out) {
      const i = line.indexOf("=");
      if (i > 0) res[line.slice(0, i)] = line.slice(i + 1);
    }
    return res;
  }
  const probe = (label: string, user: string | null, role: string, sql: string) =>
    `SELECT '${label}=' || pg_temp.probe(${user ? `'${user}'` : "NULL"}, '${role}', $q$${sql}$q$);`;

  it("PS0 chain end: co-member, self, stranger and anon are refused each private column; select * and a filter too", () => {
    for (const col of PRIVATE) {
      denied(asRole("authenticated", alice, `SELECT ${col} ${bobRow()};`), `co-member ${col}`);
      denied(asRole("authenticated", bob, `SELECT ${col} ${bobRow()};`), `own ${col}`);
      denied(asRole("authenticated", eve, `SELECT ${col} FROM public.message_thread_members;`), `stranger ${col}`);
      denied(asRole("anon", null, `SELECT ${col} FROM public.message_thread_members;`), `anon ${col}`);
    }
    denied(asRole("authenticated", alice, `SELECT * FROM public.message_thread_members WHERE thread_id = '${t}';`), "select *");
    denied(asRole("authenticated", alice, `SELECT user_id FROM public.message_thread_members WHERE thread_id = '${t}' AND last_read_at > '2026-01-01';`), "filter on last_read_at");
    // Control: membership is still the co-member's to read — both rows.
    const r = asRole("authenticated", alice, `SELECT ${MEMBERSHIP.join(", ")} FROM public.message_thread_members WHERE thread_id = '${t}';`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split("\n").filter((l) => l.includes(t)).length, 2, r.stdout);
  });

  it("PS1 the API's service role still reads every private column", () => {
    const out = svc(`SELECT last_read_at::text || '/' || archived_at::text || '/' || muted_at::text ${bobRow()};`);
    assert.equal(out[out.length - 1], "2026-10-24 09:15:00+00/2026-10-24 09:16:00+00/2026-10-24 09:17:00+00");
  });

  it("PS2 MUTANT: with the baseline's table-level SELECT the co-member reads them; 3941's body closes it again", () => {
    const sel = (col: string) => `SELECT ${col} ${bobRow()}`;
    const res = inTx([
      `REVOKE SELECT ON public.message_thread_members FROM anon, authenticated;`,
      `GRANT SELECT ON public.message_thread_members TO anon, authenticated;`,
      ...PRIVATE.map((c) => probe(`before_${c}`, alice, "authenticated", sel(c))),
      block(migration, "narrow"),
      block(migration, "post"),
      ...PRIVATE.map((c) => probe(`after_${c}`, alice, "authenticated", sel(c))),
      probe("after_membership", alice, "authenticated", `SELECT user_id FROM public.message_thread_members WHERE thread_id = '${t}'`),
    ].join("\n"));
    for (const c of PRIVATE) {
      assert.match(res[`before_${c}`] ?? "", /^ok:.+/, `the hole is open before 3941 (${c}): ${res[`before_${c}`]}`);
      assert.equal(res[`after_${c}`], "denied", `${c} after 3941's body`);
    }
    assert.equal((res.after_membership ?? "").split("|").length, 2, `membership after: ${res.after_membership}`);
  });

  it("PS3 composition: over 3940's end state (cursors withheld) 3941 keeps the cursors withheld and withholds its own", () => {
    const res = inTx([
      `REVOKE SELECT ON public.message_thread_members FROM anon, authenticated;`,
      // 3940's body, as written at #786 head 19e6e6f68: every column but the two cursors.
      `DO $s$ DECLARE v text; BEGIN
         SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v FROM pg_attribute
          WHERE attrelid = 'public.message_thread_members'::regclass AND attnum > 0 AND NOT attisdropped
            AND attname NOT IN ('delivered_sequence', 'seen_sequence');
         EXECUTE format('GRANT SELECT (%s) ON public.message_thread_members TO anon, authenticated', v);
       END $s$;`,
      block(migration, "narrow"),
      block(migration, "post"),
      ...["delivered_sequence", "seen_sequence", ...PRIVATE].map((c) => probe(`col_${c}`, alice, "authenticated", `SELECT ${c} ${bobRow()}`)),
      ...MEMBERSHIP.map((c) => probe(`mem_${c}`, alice, "authenticated", `SELECT ${c} ${bobRow()}`)),
    ].join("\n"));
    for (const c of ["delivered_sequence", "seen_sequence", ...PRIVATE]) assert.equal(res[`col_${c}`], "denied", c);
    for (const c of MEMBERSHIP) assert.match(res[`mem_${c}`] ?? "", /^ok:.+/, c);
  });

  it("PS4 3941's postcondition raises over the pre-3941 state, and passes at the chain end", () => {
    const pre = psql(`BEGIN;
      REVOKE SELECT ON public.message_thread_members FROM anon, authenticated;
      GRANT SELECT ON public.message_thread_members TO anon, authenticated;
      ${block(migration, "post")}
      ROLLBACK;`);
    assert.notEqual(pre.status, 0, "the postcondition passed over a table-level grant");
    assert.match(pre.stderr, /POSTCONDITION FAILED \(3941\)/, pre.stderr);
    const one = psql(`BEGIN;
      GRANT SELECT (last_read_at) ON public.message_thread_members TO authenticated;
      ${block(migration, "post")}
      ROLLBACK;`);
    assert.match(one.stderr, /authenticated can read message_thread_members\.last_read_at/, `one column re-granted: ${one.stderr}`);
    const end = psql(block(migration, "post"));
    assert.equal(end.status, 0, end.stderr);
  });

  it("PS5 idempotent: the body twice over the baseline state leaves the same end state", () => {
    const grants = `SELECT 'g=' || string_agg(attname || ':' || has_column_privilege('authenticated', 'public.message_thread_members', attname, 'SELECT'), ',' ORDER BY attnum)
                      FROM pg_attribute WHERE attrelid = 'public.message_thread_members'::regclass AND attnum > 0 AND NOT attisdropped;`;
    const once = exec(`BEGIN;\nREVOKE SELECT ON public.message_thread_members FROM anon, authenticated;\nGRANT SELECT ON public.message_thread_members TO anon, authenticated;\n${block(migration, "narrow")}\n${grants}\nROLLBACK;`);
    const twice = exec(`BEGIN;\nREVOKE SELECT ON public.message_thread_members FROM anon, authenticated;\nGRANT SELECT ON public.message_thread_members TO anon, authenticated;\n${block(migration, "narrow")}\n${block(migration, "narrow")}\n${block(migration, "post")}\n${grants}\nROLLBACK;`);
    assert.equal(once.at(-1), twice.at(-1));
    assert.match(once.at(-1) ?? "", /last_read_at:false/);
  });

  it("PS6 the rollback restores exactly the private columns and touches no other column", () => {
    const rb = readFileSync(ROLLBACK, "utf8");
    const snap = (label: string) => `SELECT '${label}=' || string_agg(r || '.' || attname || ':' || has_column_privilege(r, 'public.message_thread_members', attname, 'SELECT'), ',' ORDER BY r, attnum)
        FROM pg_attribute, unnest(ARRAY['anon', 'authenticated']) r
       WHERE attrelid = 'public.message_thread_members'::regclass AND attnum > 0 AND NOT attisdropped;`;
    const res = inTx([
      // Start from 3940-then-3941 so "touches no other column" has a withheld column to leave alone.
      `REVOKE SELECT (delivered_sequence, seen_sequence) ON public.message_thread_members FROM anon, authenticated;`,
      snap("before"),
      block(rb, "restore"),
      block(rb, "post"),
      snap("after"),
    ].join("\n"));
    const parse = (s: string) => new Map(s.split(",").map((kv) => kv.split(":") as [string, string]));
    const before = parse(res.before ?? ""), afterRb = parse(res.after ?? "");
    assert.ok(before.size >= 26, `anti-vacuity: ${before.size} role.column pairs`);
    for (const [k, v] of afterRb) {
      const col = k.split(".")[1]!;
      if ((PRIVATE as readonly string[]).includes(col) || col === "notification_level" || col === "muted_until") {
        assert.equal(v, "true", `${k} restored`);
      } else {
        assert.equal(v, before.get(k), `${k} changed by the rollback`);
      }
    }
    assert.equal(afterRb.get("authenticated.delivered_sequence"), "false", "a cursor withheld by 3940 stays withheld");
  });
});
