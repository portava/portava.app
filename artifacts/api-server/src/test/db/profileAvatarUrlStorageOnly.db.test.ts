/**
 * profileAvatarUrlStorageOnly — migration 3827, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/profileAvatarUrlStorageOnly.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT (lane PRIV-FIX-3; B58 lane TM-2's adjacent finding): anon and
 * authenticated held column UPDATE on profiles.avatar_url (the baseline's list,
 * re-issued by 3740), no trigger guarded it, and profiles_update admits a user's
 * own row — so a signed-in user could PATCH their avatar to a host of their
 * choosing, and every viewer's device fetched it.
 *
 * up.sh replays 3827 with the chain, so the database under test already carries
 * its effect; every transaction that changes privileges rolls back.
 *
 * PROPERTIES
 *   AV0  3827 is in force: no client role can UPDATE avatar_url, an ordinary
 *        column stays writable, the trigger is installed and enabled, its
 *        function is SECURITY INVOKER and no client role may EXECUTE it.
 *   AV1  a signed-in user cannot set their own avatar_url at all through
 *        PostgREST ("permission denied"): an outside URL and even their own
 *        upload path; the row is unchanged, and an ordinary edit still lands.
 *   AV2  the trigger holds on its own, after a careless table-level
 *        `GRANT UPDATE ON profiles TO authenticated`: an outside URL, another
 *        person's avatar path and the person's own path spelled as an absolute
 *        URL are refused 42501; the person's own upload path and NULL land; an
 *        edit of another column on a row that already holds an outside URL
 *        lands (only a CHANGED value is judged).
 *   AV3  INSERT (the trigger is the only barrier there): a signup with no avatar
 *        and one carrying the person's own upload path land; one carrying an
 *        outside URL is refused 42501.
 *   AV4  service_role writes any value (admin and seed writes are unchanged).
 *   AV5  the pre-3827 posture is open (the user's self-write of an outside URL
 *        lands); 3827's body, applied over it, closes it again.
 *   AV6  3827's postcondition raises over each regression: the column
 *        re-granted, a table-level re-grant, the trigger dropped / disabled /
 *        ENABLE REPLICA / WHEN (false) / BEFORE UPDATE only, the function made
 *        SECURITY DEFINER or stripped of the owner path or the predicate.
 *   AV7  3827 is idempotent (its body runs twice in one transaction), and its
 *        postcondition passes alone on the committed database.
 *   AV8  3827 refuses to apply while a client role holds TABLE-level UPDATE on
 *        profiles (a column REVOKE could not narrow it).
 */
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, deleteUser, psql, rows, seedUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3827_profiles_avatar_url_storage_only.sql");
const OUTSIDE = "https://tracker.example/p.gif?u=1";

function body(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, "3827: no BEGIN … COMMIT wrapper");
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n";
}

function block(open: string, close: string): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const at = sql.indexOf(open);
  const end = sql.indexOf(close, at);
  assert.ok(at >= 0 && end > at, `3827: no ${open} block`);
  return sql.slice(at, end + close.length) + "\n";
}
const postcondition = () => block("DO $post$", "END $post$;");
const precondition = () => block("DO $pre$", "END $pre$;");

/** 3827's CREATE OR REPLACE FUNCTION statement with `from` replaced by `to` (asserting it happened). */
function fnWith(what: string, from: RegExp | string, to: string): string {
  const ddl = block("CREATE OR REPLACE FUNCTION public.enforce_profile_avatar_url_storage_only()", "$fn$;");
  const out = ddl.replace(from, to);
  assert.notEqual(out, ddl, `could not build: ${what}`);
  return out;
}

const inRolledBackTx = (script: string) => psql(`BEGIN;\n${script}\nROLLBACK;\n`);

/** As a signed-in user (the PostgREST path): the role plus the JWT GUC auth.uid() reads. */
const asUserSql = (userId: string, sql: string) =>
  `SELECT set_config('request.jwt.claim.sub', '${userId}', true);\n` +
  `SELECT set_config('request.jwt.claim.role', 'authenticated', true);\nSET LOCAL ROLE authenticated;\n${sql}\nRESET ROLE;\n`;

const REGRANT = "GRANT UPDATE ON public.profiles TO authenticated;\n";
const TRIGGER = "trg_profiles_avatar_url_storage_only";
const recreate = (spec: string) =>
  `DROP TRIGGER ${TRIGGER} ON public.profiles;\nCREATE TRIGGER ${TRIGGER} ${spec} ON public.profiles\n  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_avatar_url_storage_only();\n`;
const recreateWhen = `DROP TRIGGER ${TRIGGER} ON public.profiles;\nCREATE TRIGGER ${TRIGGER} BEFORE INSERT OR UPDATE ON public.profiles\n  FOR EACH ROW WHEN (false) EXECUTE FUNCTION public.enforce_profile_avatar_url_storage_only();\n`;

describe("3827: a person's avatar is their own upload or nothing (database privilege boundary)", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  let me = "";
  let other = "";
  const own = () => `profile-media/avatars/${me}/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jpg`;
  const avatarOf = (id: string) => rows<{ a: string | null }>(`SELECT avatar_url AS a FROM public.profiles WHERE id = '${id}'`)[0]!.a;

  before(() => {
    me = seedUser("av_self");
    other = seedUser("av_other");
    assert.equal(avatarOf(me), null, "the fixture must start with no avatar");
  });
  after(() => {
    if (me) deleteUser(me);
    if (other) deleteUser(other);
  });

  it("AV0: 3827 is in force on the replayed chain", () => {
    const g = rows<{ anon: boolean; auth: boolean; bio: boolean; svc: boolean; exec_auth: boolean }>(`
      SELECT has_column_privilege('anon', 'public.profiles', 'avatar_url', 'UPDATE') AS anon,
             has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'UPDATE') AS auth,
             has_column_privilege('authenticated', 'public.profiles', 'bio', 'UPDATE') AS bio,
             has_column_privilege('service_role', 'public.profiles', 'avatar_url', 'UPDATE') AS svc,
             has_function_privilege('authenticated', 'public.enforce_profile_avatar_url_storage_only()', 'EXECUTE') AS exec_auth`)[0]!;
    assert.deepEqual(g, { anon: false, auth: false, bio: true, svc: true, exec_auth: false });
    const t = rows<{ n: number; definer: boolean }>(`
      SELECT count(*)::int AS n, bool_or(p.prosecdef) AS definer
        FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'public.profiles'::regclass AND t.tgname = '${TRIGGER}' AND NOT t.tgisinternal AND t.tgenabled = 'O'`)[0]!;
    assert.equal(t.n, 1, `${TRIGGER} is not installed and enabled`);
    assert.equal(t.definer, false, "the trigger function must observe the caller (SECURITY INVOKER)");
  });

  it("AV1: a signed-in user cannot set their own avatar_url through PostgREST; an ordinary edit still lands", () => {
    for (const value of [OUTSIDE, own()]) {
      const r = inRolledBackTx(asUserSql(me, `UPDATE public.profiles SET avatar_url = '${value}' WHERE id = '${me}';`));
      assert.notEqual(r.status, 0, `${value}: the self-write was accepted`);
      assert.match(r.stderr, /permission denied for table profiles/, `${value}: ${r.stderr}`);
    }
    assert.equal(avatarOf(me), null, "a refused write changed the row");
    const bio = inRolledBackTx(asUserSql(me, `UPDATE public.profiles SET bio = 'av1 edit' WHERE id = '${me}';`) + `SELECT 'BIO=' || bio FROM public.profiles WHERE id = '${me}';`);
    assert.equal(bio.status, 0, `an ordinary edit was refused: ${bio.stderr}`);
    assert.match(bio.stdout, /BIO=av1 edit/);
  });

  it("AV2: the trigger holds after a careless table-level re-grant", () => {
    const write = (value: string, extra = "") =>
      inRolledBackTx(REGRANT + extra + asUserSql(me, `UPDATE public.profiles SET avatar_url = ${value} WHERE id = '${me}';`) + `SELECT 'AV=' || coalesce(avatar_url, '<null>') FROM public.profiles WHERE id = '${me}';`);
    for (const value of [
      OUTSIDE,
      `profile-media/avatars/${other}/a.jpg`,
      `https://abc.supabase.co/storage/v1/object/public/profile-media/avatars/${me}/a.jpg`,
      `profile-media/avatars/${me}/../${other}/a.jpg`,
      `profile-media/avatars/${me}/a..jpg`,
      `profile-media/covers/${me}/cover.jpg`,
    ]) {
      const r = write(`'${value}'`);
      assert.notEqual(r.status, 0, `${value}: the trigger let a client write it`);
      assert.match(r.stderr, /profiles\.avatar_url must be the owner's own upload/, `${value}: ${r.stderr}`);
    }
    const ok = write(`'${own()}'`);
    assert.equal(ok.status, 0, `the person's own upload was refused: ${ok.stderr}`);
    assert.match(ok.stdout, new RegExp(`AV=${own()}`));
    const cleared = write("NULL", `SET LOCAL ROLE service_role;\nUPDATE public.profiles SET avatar_url = '${OUTSIDE}' WHERE id = '${me}';\nRESET ROLE;\n`);
    assert.equal(cleared.status, 0, `clearing an outside URL was refused: ${cleared.stderr}`);
    assert.match(cleared.stdout, /AV=<null>/);
    // A row that already holds an outside URL keeps it through an edit of another column.
    const keep = inRolledBackTx(
      REGRANT + `SET LOCAL ROLE service_role;\nUPDATE public.profiles SET avatar_url = '${OUTSIDE}' WHERE id = '${me}';\nRESET ROLE;\n` +
        asUserSql(me, `UPDATE public.profiles SET bio = 'kept', avatar_url = avatar_url WHERE id = '${me}';`) +
        `SELECT 'BIO=' || bio FROM public.profiles WHERE id = '${me}';`,
    );
    assert.equal(keep.status, 0, `an unchanged stored value tripped the trigger: ${keep.stderr}`);
    assert.match(keep.stdout, /BIO=kept/);
  });

  it("AV3: INSERT — no avatar and the person's own upload land; an outside URL is refused", () => {
    const fresh = randomUUID();
    const signup = (cols: string, vals: string) =>
      inRolledBackTx(
        `INSERT INTO auth.users (id, email) VALUES ('${fresh}', 'av3_${fresh.slice(0, 8)}@local.test');\n` +
          asUserSql(fresh, `INSERT INTO public.profiles (id, handle, name${cols}) VALUES ('${fresh}', 'av3_${fresh.slice(0, 8)}', 'av3'${vals});`) +
          `SELECT 'ROW=' || count(*) FROM public.profiles WHERE id = '${fresh}';`,
      );
    const plain = signup("", "");
    assert.equal(plain.status, 0, `an ordinary signup was refused: ${plain.stderr}`);
    assert.match(plain.stdout, /ROW=1/);
    const withOwn = signup(", avatar_url", `, 'profile-media/avatars/${fresh}/a.jpg'`);
    assert.equal(withOwn.status, 0, `a signup carrying its own upload was refused: ${withOwn.stderr}`);
    const outside = signup(", avatar_url", `, '${OUTSIDE}'`);
    assert.notEqual(outside.status, 0, "a signup arrived carrying an outside avatar");
    assert.match(outside.stderr, /profiles\.avatar_url must be the owner's own upload/, outside.stderr);
  });

  it("AV4: service_role writes any value", () => {
    const r = inRolledBackTx(`SET LOCAL ROLE service_role;\nUPDATE public.profiles SET avatar_url = '${OUTSIDE}' WHERE id = '${me}';\nRESET ROLE;\nSELECT 'GOT=' || avatar_url FROM public.profiles WHERE id = '${me}';`);
    assert.equal(r.status, 0, `the service path was refused: ${r.stderr}`);
    assert.ok(r.stdout.includes(`GOT=${OUTSIDE}`), r.stdout);
  });

  it("AV5: the pre-3827 posture is open; 3827's body closes it again", () => {
    const PRE = `DROP TRIGGER ${TRIGGER} ON public.profiles;\nGRANT UPDATE (avatar_url) ON public.profiles TO anon, authenticated;\n`;
    const open = inRolledBackTx(PRE + asUserSql(me, `UPDATE public.profiles SET avatar_url = '${OUTSIDE}' WHERE id = '${me}';`) + `SELECT 'OPEN=' || avatar_url FROM public.profiles WHERE id = '${me}';`);
    assert.equal(open.status, 0, `the pre-3827 posture: ${open.stderr}`);
    assert.ok(open.stdout.includes(`OPEN=${OUTSIDE}`), "the self-write did not land before 3827, so this property proves nothing");
    const closed = inRolledBackTx(PRE + body() + asUserSql(me, `UPDATE public.profiles SET avatar_url = '${OUTSIDE}' WHERE id = '${me}';`));
    assert.notEqual(closed.status, 0, "3827's body did not close the self-write");
    assert.match(closed.stderr, /permission denied for table profiles/, closed.stderr);
  });

  it("AV6: the postcondition raises over each kind of regression", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["the column re-granted to authenticated", "GRANT UPDATE (avatar_url) ON public.profiles TO authenticated;", /authenticated can still UPDATE public\.profiles\.avatar_url/],
      ["the column granted to PUBLIC", "GRANT UPDATE (avatar_url) ON public.profiles TO PUBLIC;", /(anon|authenticated) can still UPDATE public\.profiles\.avatar_url/],
      ["a table-level re-grant", REGRANT, /authenticated can still UPDATE public\.profiles\.avatar_url/],
      ["the trigger dropped", `DROP TRIGGER ${TRIGGER} ON public.profiles;`, /is not an enabled, unconditional BEFORE INSERT OR UPDATE row trigger/],
      ["the trigger disabled", `ALTER TABLE public.profiles DISABLE TRIGGER ${TRIGGER};`, /is not an enabled, unconditional BEFORE INSERT OR UPDATE row trigger/],
      ["the trigger set to ENABLE REPLICA", `ALTER TABLE public.profiles ENABLE REPLICA TRIGGER ${TRIGGER};`, /is not an enabled, unconditional BEFORE INSERT OR UPDATE row trigger/],
      ["the trigger re-created WHEN (false)", recreateWhen, /is not an enabled, unconditional BEFORE INSERT OR UPDATE row trigger/],
      ["the trigger re-created BEFORE UPDATE only", recreate("BEFORE UPDATE"), /is not an enabled, unconditional BEFORE INSERT OR UPDATE row trigger/],
      ["the trigger re-created on UPDATE OF a column list", recreate("BEFORE INSERT OR UPDATE OF bio"), /is not an enabled, unconditional BEFORE INSERT OR UPDATE row trigger/],
      ["the function made SECURITY DEFINER", fnWith("definer", "SECURITY INVOKER", "SECURITY DEFINER"), /is not SECURITY INVOKER with search_path public, pg_catalog/],
      ["the function stripped of the predicate", fnWith("no predicate", "IF NOT public.caller_may_write_profile_role() THEN", "IF true THEN"), /no longer states the owner's own upload path, the changed-value test and the 2078 predicate/],
      ["the function stripped of the owner path", fnWith("no owner path", "'^profile-media/avatars/' || NEW.id::text || '/", "'^profile-media/avatars/[^/]+/"), /no longer states the owner's own upload path/],
      ["EXECUTE granted to authenticated", "GRANT EXECUTE ON FUNCTION public.enforce_profile_avatar_url_storage_only() TO authenticated;", /authenticated can EXECUTE enforce_profile_avatar_url_storage_only/],
    ];
    for (const [what, breakIt, expected] of cases) {
      const out = inRolledBackTx(`${breakIt}\n${postcondition()}`);
      assert.notEqual(out.status, 0, `the postcondition passed over ${what}`);
      assert.match(out.stderr, /POSTCONDITION FAILED \(3827\)/, `${what}: ${out.stderr}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }
  });

  it("AV7: 3827 is idempotent, and its postcondition passes alone on the committed database", () => {
    const twice = inRolledBackTx(body() + body() + postcondition());
    assert.equal(twice.status, 0, `3827 applied twice: ${twice.stderr}`);
    const alone = psql(postcondition());
    assert.equal(alone.status, 0, `the postcondition failed on the committed database: ${alone.stderr}`);
  });

  it("AV8: 3827 refuses to apply while a client role holds TABLE-level UPDATE on profiles", () => {
    const r = inRolledBackTx(`${REGRANT}${precondition()}`);
    assert.notEqual(r.status, 0, "the precondition passed over a table-level UPDATE");
    assert.match(r.stderr, /PRECONDITION FAILED \(3827\): authenticated hold\(s\) TABLE-level UPDATE on public\.profiles/, r.stderr);
  });
});
