/**
 * userAccountStatesContract — the moderation state's table contract, executed
 * against real PostgreSQL (the harness replays the canonical chain, so this is
 * the table migration 0063 :155 + 0130 create, with 2033's RLS).
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/userAccountStatesContract.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * WHY: lib/accountStateGate.ts and lib/accountModeration.ts make
 * `user_account_states` the ONE authoritative ban / suspension state (owner
 * decision 2026-10-03). Their unit suite (moderationAccountState.test.ts) runs
 * against a fake, and a fake enforces only what its author remembered. These
 * properties pin what the code relies on in the real schema — and the fact
 * that forced the decision.
 *
 * PROPERTIES
 *   UA0  profiles_account_status_check REJECTS 'banned' and 'suspended' — the
 *        reason the old admin writes never landed and the moderation state lives
 *        in user_account_states — and admits the four lifecycle values.
 *   UA1  the shape the code writes: user_id FK → profiles ON DELETE CASCADE,
 *        expires_at nullable, no CHECK on state, and the foreign key the gate's
 *        embed names (`user_account_states_user_id_fkey`) exists by that name.
 *   UA2  one row per (user_id, state): a second plain INSERT is 23505, and the
 *        writer's upsert ON CONFLICT (user_id, state) re-bans in place.
 *   UA3  the active-row rule and revocation, as SQL: the writer's revocation
 *        (expires_at := now WHERE in force) lifts exactly the in-force banned /
 *        suspended rows, keeps every row (history), leaves an already-ended row's
 *        end and other states alone, and the gate's in-force predicate then
 *        finds nothing.
 *   UA4  RLS: a signed-in user reads ONLY their own rows, and can neither
 *        insert, update nor delete them — a banned user cannot lift their own
 *        ban through PostgREST — while service_role (the API) can.
 *   UA5  anon reads nothing.
 *   UA6  deleting the profile cascades its moderation rows away (the deletion
 *        executor's tombstone path is unaffected).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { HAVE_DB, exec, psql, rows, scalar, asUser, seedUser, deleteUser } from "./localDb.js";

const skip = !HAVE_DB ? "LOCAL_DB_URL not set" : false;

/** As service_role (BYPASSRLS — the API's client), in one transaction. */
function svc(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}

/** The in-force predicate lib/accountStateGate.ts applies (isRestrictionRowInForce), as SQL. */
const IN_FORCE = `state IN ('banned','suspended') AND (expires_at IS NULL OR expires_at > now())`;

describe("user_account_states — the moderation state's real table contract", { skip }, () => {
  let alice = "";
  let bob = "";
  before(() => {
    alice = seedUser("uas_alice");
    bob = seedUser("uas_bob");
  });
  after(() => {
    for (const id of [alice, bob]) if (id) { try { deleteUser(id); } catch { /* already gone (UA6) */ } }
  });

  it("UA0 — profiles.account_status cannot hold 'banned' or 'suspended'; the lifecycle values are legal", () => {
    for (const v of ["banned", "suspended"]) {
      const r = psql(`BEGIN; SET LOCAL ROLE service_role; UPDATE public.profiles SET account_status = '${v}' WHERE id = '${alice}'; ROLLBACK;`);
      assert.notEqual(r.status, 0, `'${v}' must be rejected`);
      assert.match(r.stderr, /profiles_account_status_check/);
    }
    for (const v of ["active", "deactivated", "pending_deletion", "deleted"]) {
      const r = psql(`BEGIN; SET LOCAL ROLE service_role; UPDATE public.profiles SET account_status = '${v}' WHERE id = '${alice}'; ROLLBACK;`);
      assert.equal(r.status, 0, `'${v}': ${r.stderr}`);
    }
  });

  it("UA1 — shape: cascade FK named as the gate's embed names it, nullable expires_at, no CHECK on state", () => {
    const fk = rows<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.user_account_states'::regclass AND contype = 'f'`,
    );
    const userFk = fk.find((r) => r.conname === "user_account_states_user_id_fkey");
    assert.ok(userFk, `the embed hint names this FK; found ${fk.map((r) => r.conname).join(", ")}`);
    assert.match(userFk!.def, /FOREIGN KEY \(user_id\) REFERENCES (public\.)?profiles\(id\) ON DELETE CASCADE/);
    const cols = rows<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_account_states'`,
    );
    const col = (n: string) => cols.find((c) => c.column_name === n);
    for (const n of ["id", "user_id", "state", "reason", "expires_at", "set_by", "created_at", "updated_at"]) assert.ok(col(n), `column ${n}`);
    assert.equal(col("expires_at")!.is_nullable, "YES", "NULL = open-ended (a permanent ban)");
    assert.equal(col("state")!.is_nullable, "NO");
    assert.equal(
      scalar(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.user_account_states'::regclass AND contype = 'c'`),
      "0",
      "no CHECK on state: the writers' vocabulary (banned, suspended, restricted, deactivated, deleted) all lands",
    );
  });

  it("UA2 — one row per (user_id, state); the writer's upsert re-bans in place", () => {
    const r = psql(
      `BEGIN; SET LOCAL ROLE service_role;
       INSERT INTO public.user_account_states (user_id, state) VALUES ('${alice}', 'banned');
       INSERT INTO public.user_account_states (user_id, state) VALUES ('${alice}', 'banned');
       ROLLBACK;`,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /user_account_states_user_id_state_key|duplicate key/);

    const out = svc(
      `INSERT INTO public.user_account_states (user_id, state, reason, expires_at, set_by)
         VALUES ('${alice}', 'banned', 'first', now() - interval '1 hour', '${bob}');
       INSERT INTO public.user_account_states (user_id, state, reason, expires_at, set_by)
         VALUES ('${alice}', 'banned', 'second', NULL, '${bob}')
         ON CONFLICT (user_id, state) DO UPDATE SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, set_by = EXCLUDED.set_by;
       SELECT count(*) || '|' || max(reason) || '|' || coalesce(max(expires_at)::text, 'null')
         FROM public.user_account_states WHERE user_id = '${alice}' AND state = 'banned';
       DELETE FROM public.user_account_states WHERE user_id = '${alice}';`,
    );
    assert.ok(out.includes("1|second|null"), out.join(" / "));
  });

  it("UA3 — revocation lifts exactly the in-force restriction rows and keeps every row", () => {
    const out = svc(
      `INSERT INTO public.user_account_states (user_id, state, reason, expires_at) VALUES
         ('${alice}', 'banned', 'b', NULL),
         ('${alice}', 'suspended', 's', now() + interval '2 days'),
         ('${alice}', 'deactivated', NULL, NULL),
         ('${bob}', 'suspended', 'old', '2020-01-01T00:00:00Z');
       SELECT 'before:' || count(*) FROM public.user_account_states WHERE user_id = '${alice}' AND ${IN_FORCE};
       -- lib/accountModeration.ts revokeAccountRestrictions, as the SQL PostgREST runs for it
       WITH rev AS (
         UPDATE public.user_account_states SET expires_at = now(), updated_at = now()
          WHERE user_id = '${alice}' AND state IN ('banned','suspended')
            AND (expires_at IS NULL OR expires_at > now())
          RETURNING id)
       SELECT 'revoked:' || count(*) FROM rev;
       UPDATE public.user_account_states SET expires_at = now(), updated_at = now()
        WHERE user_id = '${bob}' AND state IN ('banned','suspended') AND (expires_at IS NULL OR expires_at > now());
       SELECT 'after:' || count(*) FROM public.user_account_states WHERE user_id = '${alice}' AND ${IN_FORCE};
       SELECT 'kept:' || count(*) FROM public.user_account_states WHERE user_id = '${alice}';
       SELECT 'reasons:' || string_agg(coalesce(reason, '-'), ',' ORDER BY state) FROM public.user_account_states WHERE user_id = '${alice}';
       SELECT 'deactivated_end:' || coalesce(expires_at::text, 'null') FROM public.user_account_states WHERE user_id = '${alice}' AND state = 'deactivated';
       SELECT 'bob_end:' || to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM public.user_account_states WHERE user_id = '${bob}';
       DELETE FROM public.user_account_states WHERE user_id IN ('${alice}', '${bob}');`,
    );
    const get = (k: string) => out.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1);
    assert.equal(get("before"), "2");
    assert.equal(get("revoked"), "2");
    assert.equal(get("after"), "0", "nothing in force after the unban");
    assert.equal(get("kept"), "3", "no row deleted — the history stays");
    assert.equal(get("reasons"), "b,-,s", "the sanctions' reasons survive");
    assert.equal(get("deactivated_end"), "null", "a non-moderation row is untouched");
    assert.equal(get("bob_end"), "2020-01-01", "an already-ended row keeps its own end");
  });

  it("UA4 — RLS: own rows readable, NOT writable by the user; service_role writes", () => {
    svc(
      `INSERT INTO public.user_account_states (user_id, state, reason) VALUES ('${alice}', 'banned', 'x'), ('${bob}', 'suspended', 'y');`,
    );
    try {
      const seen = asUser(alice, `SELECT user_id || ':' || state FROM public.user_account_states ORDER BY state;`);
      assert.deepEqual(seen, [`${alice}:banned`], "a user sees only their own row");

      const lift = asUser(alice, `WITH u AS (UPDATE public.user_account_states SET expires_at = now() WHERE user_id = '${alice}' RETURNING 1) SELECT 'updated:' || count(*) FROM u;`);
      assert.ok(lift.includes("updated:0"), `a banned user cannot revoke their own ban: ${lift.join(" / ")}`);
      const del = asUser(alice, `WITH d AS (DELETE FROM public.user_account_states WHERE user_id = '${alice}' RETURNING 1) SELECT 'deleted:' || count(*) FROM d;`);
      assert.ok(del.includes("deleted:0"), `nor delete it: ${del.join(" / ")}`);
      const ins = psql(
        `BEGIN; SELECT set_config('request.jwt.claim.sub', '${bob}', true); SET LOCAL ROLE authenticated;
         INSERT INTO public.user_account_states (user_id, state) VALUES ('${bob}', 'active'); ROLLBACK;`,
      );
      assert.notEqual(ins.status, 0, "nor insert a row");
      assert.match(ins.stderr, /row-level security/);

      assert.equal(
        scalar(`SELECT count(*) FROM public.user_account_states WHERE user_id = '${alice}' AND ${IN_FORCE}`),
        "1",
        "the ban still stands after every client attempt",
      );
    } finally {
      svc(`DELETE FROM public.user_account_states WHERE user_id IN ('${alice}', '${bob}');`);
    }
  });

  it("UA5 — anon reads nothing", () => {
    svc(`INSERT INTO public.user_account_states (user_id, state) VALUES ('${alice}', 'banned');`);
    try {
      const out = exec(`SET LOCAL ROLE anon;\nSELECT 'n:' || count(*) FROM public.user_account_states;`, { single: true });
      assert.ok(out.includes("n:0"), out.join(" / "));
    } finally {
      svc(`DELETE FROM public.user_account_states WHERE user_id = '${alice}';`);
    }
  });

  it("UA6 — deleting the profile cascades its moderation rows away", () => {
    const carol = seedUser("uas_carol");
    svc(`INSERT INTO public.user_account_states (user_id, state) VALUES ('${carol}', 'banned');`);
    deleteUser(carol);
    assert.equal(scalar(`SELECT count(*) FROM public.user_account_states WHERE user_id = '${carol}'`), "0");
  });
});
