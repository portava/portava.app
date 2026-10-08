/**
 * profileAuthorityColumns — migration 3742, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/profileAuthorityColumns.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT (verifier F5 on PR #647; confirmed in production by the lead's
 * read-only catalog query): anon and authenticated held column UPDATE on
 * profiles.verified, verified_at, trust_score, trust_label,
 * verification_method, featured_count, created_at and account_status, no
 * trigger guarded them, and profiles_update admits a user's own row — so a
 * signed-in user could PATCH their own verified badge, trust score, featured
 * count or account age.
 *
 * HOW THESE PROPERTIES BITE: up.sh replays 3742 with the chain, so the database
 * under test already carries its effect. PA5 rebuilds the PRE-3742 posture in a
 * transaction, proves the hole is open there, applies 3742's body and proves it
 * closed; every transaction that changes privileges rolls back.
 *
 * PROPERTIES
 *   PA0  3742 is in force on the replayed chain: no client role can UPDATE any
 *        of the 19 authority columns, ordinary columns stay writable, the
 *        trigger is installed and its function is not SECURITY DEFINER.
 *   PA1  a signed-in user cannot set verified, verified_at, trust_score,
 *        trust_label, verification_method, featured_count or created_at on
 *        their own row ("permission denied"), and the row is unchanged.
 *   PA2  the trigger holds on its own: after a careless table-level
 *        `GRANT UPDATE ON profiles TO authenticated`, each of the seven is
 *        refused 42501 by the trigger, and an ordinary edit still lands.
 *   PA3  INSERT (an upsert is an INSERT first): a signup with the column
 *        defaults is untouched; one carrying verified, verified_at, trust_score
 *        or an old created_at is refused 42501.
 *   PA4  service_role writes all seven (the admin verify route, the featured
 *        counter, the verification flow).
 *   PA5  the pre-3742 posture lets the user set verified / verified_at /
 *        trust_score; 3742's body, applied over it, refuses them again.
 *   PA6  3742's postcondition raises over each kind of regression: a column
 *        re-granted to anon, a grant to PUBLIC, the trigger dropped, disabled,
 *        set to ENABLE REPLICA or re-created WHEN (false), a function that
 *        stopped comparing a column or RETURNs before its refusal, and the
 *        predicate caller_may_write_profile_role() redefined to return true —
 *        plainly, or still naming the role GUC and session_user (the executed
 *        probe) (verifier G3 F1-F4).
 *   PA7  3742 is idempotent: its body runs twice in one transaction.
 *   PA8  the postcondition passes alone on the committed database (what
 *        certify:migrations stage 4 sends after COMMIT).
 *   PA9  3740 then 3742 (the chain order) leaves the authority columns closed,
 *        and 3740's own postcondition still passes after 3742 — certify
 *        re-runs it on a full-chain build (verifier F5 / F1 lesson).
 *   PA10 3742 refuses to apply while a client role holds TABLE-level UPDATE on
 *        profiles (a column REVOKE could not narrow it).
 *   PA11 the inert-barrier shapes of PA6 (WHEN (false), ENABLE REPLICA, an
 *        early RETURN NEW, a predicate returning true) are real holes: after a
 *        table-level re-grant the user's self-write of verified lands.
 */
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, deleteUser, psql, rows, seedUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3742_profiles_authority_columns_server_only.sql");
const MIGRATION_3740 = resolve(__dir, "../../migrations/3740_client_grant_excess_boundary.sql");

/** The seven columns 3742's trigger guards, with a value a self-promoting user would write. */
const GUARDED: ReadonlyArray<[string, string]> = [
  ["verified", "true"],
  ["verified_at", "'2026-01-01T00:00:00Z'"],
  ["trust_score", "99"],
  ["trust_label", "'Legend'"],
  ["verification_method", "'passport'"],
  ["featured_count", "999"],
  ["created_at", "'2020-01-01T00:00:00Z'"],
];
const REVOKED = [
  ...GUARDED.map(([c]) => c),
  "account_status", "role", "is_official", "verification_status", "verification_level", "verified_since",
  "id_verified_at", "selfie_verified_at", "home_country_verified_at", "host_verified_at", "buddy_verified_at",
  "safety_flags_count",
];

function body(path = MIGRATION): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n";
}

function postcondition(path = MIGRATION): string {
  const sql = readFileSync(path, "utf8");
  const at = sql.indexOf("DO $post$");
  const end = sql.indexOf("END $post$;", at);
  assert.ok(at >= 0 && end > at, `${path}: no DO $post$ block`);
  return sql.slice(at, end + "END $post$;".length) + "\n";
}

/** 3742's CREATE OR REPLACE FUNCTION statement, for building a regressed copy. */
function functionDdl(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const at = sql.indexOf("CREATE OR REPLACE FUNCTION public.enforce_profile_authority_privileged()");
  const end = sql.indexOf("$fn$;", at);
  assert.ok(at >= 0 && end > at, "3742: no trigger function");
  return sql.slice(at, end + "$fn$;".length) + "\n";
}

const inRolledBackTx = (script: string) => psql(`BEGIN;\n${script}\nROLLBACK;\n`);

/** 3742's function with `RETURN NEW;` as its first statement: every comparison kept, all of it dead code. */
function returnFirst(): string {
  const ddl = functionDdl();
  const out = ddl.replace(/\$fn\$\nDECLARE\n  v_changed text;\nBEGIN\n/, "$&  RETURN NEW;\n");
  assert.notEqual(out, ddl, "could not build the early-return function");
  return out;
}

/** The trigger re-created with a WHEN clause that is never true. */
const WHEN_FALSE =
  "DROP TRIGGER trg_profiles_authority_privileged ON public.profiles;\n" +
  "CREATE TRIGGER trg_profiles_authority_privileged BEFORE INSERT OR UPDATE ON public.profiles\n" +
  "  FOR EACH ROW WHEN (false) EXECUTE FUNCTION public.enforce_profile_authority_privileged();\n";

/** The predicate redefined to admit everyone. */
const PREDICATE_TRUE =
  "CREATE OR REPLACE FUNCTION public.caller_may_write_profile_role() RETURNS boolean LANGUAGE sql STABLE AS $p$ SELECT true $p$;\n";

/** The same, still mentioning both things the textual check looks for. */
const PREDICATE_TRUE_DISGUISED =
  "CREATE OR REPLACE FUNCTION public.caller_may_write_profile_role() RETURNS boolean LANGUAGE sql STABLE AS " +
  "$p$ SELECT true OR (current_setting('role', true) = 'x' AND session_user = 'y') $p$;\n";

/** As a signed-in user (the PostgREST path): the role plus the JWT GUC auth.uid() reads. */
const asUserSql = (userId: string, sql: string) =>
  `SELECT set_config('request.jwt.claim.sub', '${userId}', true);\n` +
  `SELECT set_config('request.jwt.claim.role', 'authenticated', true);\nSET LOCAL ROLE authenticated;\n${sql}\nRESET ROLE;\n`;

describe("3742: profiles authority columns are server-only (database privilege boundary)", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  let me = "";
  const readRow = () =>
    rows<Record<string, unknown>>(
      `SELECT verified, verified_at, trust_score::text AS trust_score, trust_label, verification_method, featured_count, created_at::text AS created_at
         FROM public.profiles WHERE id = '${me}'`,
    )[0]!;
  let pristine: Record<string, unknown> = {};

  before(() => {
    me = seedUser("pa_self");
    pristine = readRow();
    assert.equal(pristine["verified"], false, "the fixture must start unverified");
  });
  after(() => {
    if (me) deleteUser(me);
  });

  it("PA0: 3742 is in force on the replayed chain", () => {
    const writable = rows<{ role: string; col: string }>(`
      SELECT r.role, c.col FROM unnest(ARRAY['anon','authenticated']) AS r(role)
       CROSS JOIN unnest(ARRAY[${REVOKED.map((c) => `'${c}'`).join(",")}]) AS c(col)
       WHERE has_column_privilege(r.role, 'public.profiles', c.col, 'UPDATE')
       ORDER BY 1, 2`);
    assert.deepEqual(writable, [], "a client role can still UPDATE an authority column");
    const ordinary = rows<{ ok: boolean }>(`
      SELECT has_column_privilege('authenticated', 'public.profiles', 'bio', 'UPDATE')
         AND has_column_privilege('authenticated', 'public.profiles', 'name', 'UPDATE') AS ok`)[0]!;
    assert.equal(ordinary.ok, true, "3742 took an ordinary profile column away");
    const trig = rows<{ n: number; definer: boolean }>(`
      SELECT count(*)::int AS n, bool_or(p.prosecdef) AS definer
        FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'public.profiles'::regclass AND t.tgname = 'trg_profiles_authority_privileged'
         AND NOT t.tgisinternal AND t.tgenabled = 'O'`)[0]!;
    assert.equal(trig.n, 1, "trg_profiles_authority_privileged is not installed");
    assert.equal(trig.definer, false, "the trigger function must observe the caller (SECURITY INVOKER)");
  });

  it("PA1: a signed-in user cannot set any of the seven on their own row", () => {
    for (const [col, value] of GUARDED) {
      const r = inRolledBackTx(asUserSql(me, `UPDATE public.profiles SET ${col} = ${value} WHERE id = '${me}';`));
      assert.notEqual(r.status, 0, `${col}: the self-write was accepted`);
      assert.match(r.stderr, /permission denied for table profiles/, `${col}: ${r.stderr}`);
    }
    assert.deepEqual(readRow(), pristine, "a refused write changed the row");
  });

  it("PA2: the trigger holds after a careless table-level re-grant, and ordinary edits still land", () => {
    const REGRANT = "GRANT UPDATE ON public.profiles TO authenticated;\n";
    for (const [col, value] of GUARDED) {
      const r = inRolledBackTx(REGRANT + asUserSql(me, `UPDATE public.profiles SET ${col} = ${value} WHERE id = '${me}';`));
      assert.notEqual(r.status, 0, `${col}: the trigger let a client write it`);
      assert.match(r.stderr, new RegExp(`ERROR:\\s+profiles authority column\\(s\\) ${col} cannot be set by this caller`), `${col}: ${r.stderr}`);
    }
    const bio = inRolledBackTx(
      REGRANT + asUserSql(me, `UPDATE public.profiles SET bio = 'pa2 edit' WHERE id = '${me}';`) +
        `SELECT 'BIO=' || bio FROM public.profiles WHERE id = '${me}';`,
    );
    assert.equal(bio.status, 0, `an ordinary edit was refused: ${bio.stderr}`);
    assert.match(bio.stdout, /BIO=pa2 edit/);
    // Writing the value already there is not a change.
    const same = inRolledBackTx(REGRANT + asUserSql(me, `UPDATE public.profiles SET verified = false, featured_count = 0 WHERE id = '${me}';`));
    assert.equal(same.status, 0, `an unchanged value tripped the trigger: ${same.stderr}`);
  });

  it("PA3: a signup with the defaults is untouched; one carrying an authority value is refused", () => {
    const fresh = randomUUID();
    const signup = (cols: string, vals: string) =>
      inRolledBackTx(
        `INSERT INTO auth.users (id, email) VALUES ('${fresh}', 'pa3_${fresh.slice(0, 8)}@local.test');\n` +
          asUserSql(fresh, `INSERT INTO public.profiles (id, handle, name${cols}) VALUES ('${fresh}', 'pa3_${fresh.slice(0, 8)}', 'pa3'${vals});`) +
          `SELECT 'ROW=' || count(*) FROM public.profiles WHERE id = '${fresh}';`,
      );
    const ok = signup("", "");
    assert.equal(ok.status, 0, `an ordinary signup was refused: ${ok.stderr}`);
    assert.match(ok.stdout, /ROW=1/);
    for (const [col, value] of [["verified", "true"], ["verified_at", "now()"], ["trust_score", "100"], ["created_at", "'2020-01-01T00:00:00Z'"]] as const) {
      const r = signup(`, ${col}`, `, ${value}`);
      assert.notEqual(r.status, 0, `${col}: a signup arrived already carrying it`);
      assert.match(r.stderr, new RegExp(`profiles authority column\\(s\\) ${col} cannot be set by this caller`), `${col}: ${r.stderr}`);
    }
  });

  it("PA4: service_role writes all seven", () => {
    const sets = GUARDED.map(([c, v]) => `${c} = ${v}`).join(", ");
    const r = inRolledBackTx(
      `SET LOCAL ROLE service_role;\nUPDATE public.profiles SET ${sets} WHERE id = '${me}';\nRESET ROLE;\n` +
        `SELECT 'GOT=' || verified || '|' || trust_score || '|' || featured_count || '|' || verification_method FROM public.profiles WHERE id = '${me}';`,
    );
    assert.equal(r.status, 0, `the service path was refused: ${r.stderr}`);
    assert.match(r.stdout, /GOT=true\|99(\.00)?\|999\|passport/);
  });

  it("PA5: the pre-3742 posture is open; 3742's body closes it again", () => {
    const PRE_3742 =
      "DROP TRIGGER trg_profiles_authority_privileged ON public.profiles;\n" +
      `GRANT UPDATE (${GUARDED.map(([c]) => c).join(", ")}) ON public.profiles TO anon, authenticated;\n`;
    const open = inRolledBackTx(
      PRE_3742 +
        asUserSql(me, `UPDATE public.profiles SET verified = true, verified_at = now(), trust_score = 99 WHERE id = '${me}';`) +
        `SELECT 'OPEN=' || verified || '|' || trust_score FROM public.profiles WHERE id = '${me}';`,
    );
    assert.equal(open.status, 0, `the pre-3742 posture: ${open.stderr}`);
    assert.match(open.stdout, /OPEN=true\|99/, "the self-write did not land before 3742, so this property proves nothing");
    const closed = inRolledBackTx(PRE_3742 + body() + asUserSql(me, `UPDATE public.profiles SET verified = true WHERE id = '${me}';`));
    assert.notEqual(closed.status, 0, "3742's body did not close the self-write");
    assert.match(closed.stderr, /permission denied for table profiles/, closed.stderr);
  });

  it("PA6: the postcondition raises over each kind of regression", () => {
    const fnWithoutTrustLabel = functionDdl().replace(
      /^\s*CASE WHEN NEW\.trust_label IS DISTINCT FROM OLD\.trust_label THEN 'trust_label' END,\n/m,
      "",
    );
    assert.notEqual(fnWithoutTrustLabel, functionDdl(), "could not build the regressed function");
    const cases: Array<[string, string, RegExp]> = [
      ["a column re-granted to anon", "GRANT UPDATE (verified_at) ON public.profiles TO anon;", /anon can UPDATE public\.profiles\.verified_at/],
      ["a column granted to PUBLIC", "GRANT UPDATE (featured_count) ON public.profiles TO PUBLIC;", /(anon|authenticated) can UPDATE public\.profiles\.featured_count/],
      ["a table-level re-grant", "GRANT UPDATE ON public.profiles TO authenticated;", /authenticated can UPDATE public\.profiles\.\w+/],
      ["the trigger dropped", "DROP TRIGGER trg_profiles_authority_privileged ON public.profiles;", /trg_profiles_authority_privileged is not an enabled BEFORE INSERT OR UPDATE row trigger/],
      ["the trigger disabled", "ALTER TABLE public.profiles DISABLE TRIGGER trg_profiles_authority_privileged;", /trg_profiles_authority_privileged is not an enabled BEFORE INSERT OR UPDATE row trigger/],
      ["a column no longer compared", fnWithoutTrustLabel, /no longer compares trust_label/],
      // Verifier G3 F2: a trigger re-created WITH a WHEN clause is inert where the clause is false.
      ["the trigger re-created WHEN (false)", WHEN_FALSE, /trg_profiles_authority_privileged carries a WHEN condition/],
      // Verifier G3 F4: ENABLE REPLICA fires only under session_replication_role = replica.
      ["the trigger set to ENABLE REPLICA", "ALTER TABLE public.profiles ENABLE REPLICA TRIGGER trg_profiles_authority_privileged;", /trg_profiles_authority_privileged is not an enabled BEFORE INSERT OR UPDATE row trigger/],
      // Verifier G3 F3: every comparison kept, behind an early RETURN NEW.
      ["a function that returns before its refusal", returnFirst(), /returns before its refusal/],
      // Verifier G3 F1: the predicate every profiles guard trusts, replaced.
      ["the predicate replaced by SELECT true", PREDICATE_TRUE, /caller_may_write_profile_role\(\) no longer decides on current_setting\('role'\) and session_user/],
      ["the predicate true while still naming the role GUC and session_user", PREDICATE_TRUE_DISGUISED, /caller_may_write_profile_role\(\) returns true for role anon/],
    ];
    for (const [what, breakIt, expected] of cases) {
      const out = inRolledBackTx(`${breakIt}\n${postcondition()}`);
      assert.notEqual(out.status, 0, `the postcondition passed over ${what}`);
      assert.match(out.stderr, /ERROR:\s+3742 POSTCONDITION FAILED/, `${what}: ${out.stderr}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }
  });

  it("PA11: each inert-barrier shape PA6 refuses is a real hole: after a table-level re-grant the self-write lands", () => {
    const REGRANT = "GRANT UPDATE ON public.profiles TO authenticated;\n";
    for (const [what, breakIt] of [
      ["WHEN (false)", WHEN_FALSE],
      ["ENABLE REPLICA", "ALTER TABLE public.profiles ENABLE REPLICA TRIGGER trg_profiles_authority_privileged;\n"],
      ["RETURN NEW first", returnFirst()],
      ["predicate true", PREDICATE_TRUE],
    ] as const) {
      const r = inRolledBackTx(
        breakIt + REGRANT + asUserSql(me, `UPDATE public.profiles SET verified = true, trust_score = 99 WHERE id = '${me}';`) +
          `SELECT 'SELF=' || verified || '|' || trust_score FROM public.profiles WHERE id = '${me}';`,
      );
      assert.equal(r.status, 0, `${what}: ${r.stderr}`);
      assert.match(r.stdout, /SELF=true\|99/, `${what}: the self-write did not land, so PA6's case proves nothing`);
    }
  });

  it("PA7: 3742 is idempotent", () => {
    const out = inRolledBackTx(`${body()}\n${body()}`);
    assert.equal(out.status, 0, out.stderr);
  });

  it("PA8: the postcondition passes alone on the committed database (certify:migrations stage 4)", () => {
    const out = inRolledBackTx(postcondition());
    assert.equal(out.status, 0, `the postcondition cannot be re-run after COMMIT: ${out.stderr}`);
  });

  it("PA9: 3740 then 3742 leaves the authority columns closed, and 3740's postcondition still passes after 3742", () => {
    const out = inRolledBackTx(
      `${body(MIGRATION_3740)}\n${body()}\n${postcondition(MIGRATION_3740)}\n${postcondition()}\n` +
        `SELECT 'OPEN=' || count(*) FROM unnest(ARRAY[${REVOKED.map((c) => `'${c}'`).join(",")}]) AS c(col)
          WHERE has_column_privilege('authenticated', 'public.profiles', c.col, 'UPDATE');`,
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /OPEN=0/, "3740's re-grant survived 3742");
  });

  it("PA10: 3742 refuses to apply over a client's table-level UPDATE", () => {
    const out = inRolledBackTx(`GRANT UPDATE ON public.profiles TO authenticated;\n${body()}`);
    assert.notEqual(out.status, 0, "3742 applied over a table-level grant it cannot narrow");
    assert.match(out.stderr, /3742 PRECONDITION FAILED: authenticated hold\(s\) TABLE-level UPDATE on public\.profiles/, out.stderr);
  });
});
