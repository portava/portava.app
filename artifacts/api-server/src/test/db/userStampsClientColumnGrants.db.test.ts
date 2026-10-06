/**
 * userStampsClientColumnGrants — migration 3520 and its rollback, executed
 * against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/userStampsClientColumnGrants.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT: 0081_stamp_system_v2.sql:226-235 protects the coordinates on a
 * passport stamp with
 *
 *     REVOKE SELECT (lat, lng) ON user_stamps FROM authenticated;
 *     REVOKE SELECT (lat, lng) ON user_stamps FROM anon;
 *
 * above a comment asserting that "column-level REVOKE takes precedence over
 * table-level GRANT". It does not. PostgreSQL privileges are ADDITIVE: the
 * table-level SELECT both roles hold still covers every column, and a
 * column-level REVOKE only removes column-specific grants, of which there were
 * none. Both statements were no-ops, and 0081 has no postcondition, so nothing
 * failed. Measured on production 2026-10-03: has_column_privilege is true on
 * lat and lng for both client roles, user_stamps_public_read admits all 47
 * rows to any signed-in user, and 20 of them carry coordinates.
 *
 * 3520 replaces the table-level SELECT with SELECT on 17 named columns,
 * withholding lat, lng and metadata.
 *
 * WHAT THE HARNESS MODELS, AND WHAT IT DOES NOT
 *   It has the three PostgREST roles and auth.uid() reading the same
 *   `request.jwt.claim.sub` GUC PostgREST sets (scripts/local-db/shim.sql), the
 *   real user_stamps table, its four real policies and the chain's real grants —
 *   the baseline's GRANT ALL narrowed by 2972 to SELECT, which is production's
 *   shape exactly. A statement run here under `SET LOCAL ROLE authenticated` is
 *   checked by PostgreSQL as PostgREST's would be: column privileges are
 *   enforced by the executor, not by PostgREST.
 *   It has NO PostgREST process: the HTTP shapes (`select=*` expanding to
 *   `"user_stamps".*`, `?lat=gt.x` becoming a WHERE) are written here as the SQL
 *   PostgREST emits for them, not sent over HTTP.
 *
 * PROPERTIES
 *   US-0  3520 is in force on the replayed chain — no client role holds a
 *         table-level privilege on user_stamps, and every column is classified
 *         exactly once — or every refusal below would be vacuous. This is also
 *         the standing watch for a table-level GRANT coming back out of band.
 *   US-1  anon and a signed-in stranger are refused lat, lng and metadata:
 *         selected, filtered on (a range oracle needs no SELECT list), and
 *         through `*`. Non-vacuous by construction: the same probe reports the
 *         granted columns readable in the same statement, and a control read
 *         of the row's coordinates succeeds as the table owner.
 *   US-2  exactly the 17 granted columns are readable by both client roles —
 *         nothing more (a leak), nothing less (a reader 3520 broke).
 *   US-3  THE DEFECT, reproduced: with the pre-3520 grant restored and 0081's
 *         two REVOKE statements run verbatim on top, a signed-in stranger
 *         reads lat and lng. So the hole was open, and 0081's form does not
 *         close it.
 *   US-4  the owner's own row: they read its granted columns and are refused
 *         its coordinates; those reach them only through service_role, which
 *         reads every column.
 *   US-5  the rows are unchanged. Who sees which stamp is the same before and
 *         after, and the policy catalog survives a rollback and re-apply.
 *   US-6  3520's postcondition is not decorative: a table-level SELECT handed
 *         back, lat granted back, or service_role narrowed each makes it raise.
 *   US-7  3520 refuses to apply over a column it does not classify, and a
 *         column added after 3520 is readable by no client role.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3520_user_stamps_client_column_grants.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-03-3520-user-stamps-client-column-grants-rollback.sql");

/** The 17 columns 3520 grants (catalog_id only where 0121 added it). */
const GRANTED = [
  "id", "user_id", "stamp_definition_id", "source_type", "source_id", "earned_at",
  "city", "country", "title_override", "visibility", "display_on_passport",
  "is_revoked", "revoked_at", "revoked_reason", "awarded_by_admin_id",
  "created_at", "catalog_id",
] as const;
/** Readable by no client role: the position 0081:49 says must never be exposed, plus the unaudited jsonb. */
const WITHHELD = ["lat", "lng", "metadata"] as const;

/** 0081's two statements, verbatim from the file, as US-3's counter-proof. */
const REVOKE_0081 = `
REVOKE SELECT (lat, lng) ON user_stamps FROM authenticated;
REVOKE SELECT (lat, lng) ON user_stamps FROM anon;
`;

type Who = { role: "anon" } | { role: "authenticated"; uid: string };

const LAT = "51.5007000";
const LNG = "-0.1246000";

let OWNER = ""; // holds the stamp
let VIEWER = ""; // a signed-in stranger: exactly the role the defect exposes
let DEFN = ""; // the stamp definition
let STAMP = ""; // OWNER's public, unrevoked stamp, coordinates filled
let PRIVATE = ""; // OWNER's private stamp: no policy admits it to VIEWER
let COLS: string[] = []; // user_stamps' columns in this database

/** The transaction prelude PostgREST's role switch amounts to. */
function prelude(who: Who): string {
  if (who.role === "anon") {
    return `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.role', 'anon', true); END $p$;\nSET LOCAL ROLE anon;\n`;
  }
  return (
    `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${who.uid}', true);` +
    ` PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\n` +
    `SET LOCAL ROLE authenticated;\n`
  );
}

/** Run `sql` as `who` in one transaction; return psql's result (never throws). */
function runAs(who: Who, sql: string) {
  return psql(prelude(who) + sql, { single: true });
}

/** Run `sql` as `who`; it must succeed. Returns stdout lines. */
function asOk(who: Who, sql: string): string[] {
  const r = runAs(who, sql);
  assert.equal(r.status, 0, `expected success as ${who.role}:\n${sql}\n${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

/** Run `sql` as `who`; it must be refused for lack of a privilege on user_stamps. */
function assertDenied(who: Who, sql: string): void {
  const r = runAs(who, sql);
  assert.notEqual(r.status, 0, `expected a refusal as ${who.role}, got success:\n${sql}\n${r.stdout}`);
  assert.match(
    r.stderr,
    /permission denied for table user_stamps/,
    `expected a privilege refusal as ${who.role}:\n${sql}\n${r.stderr}`,
  );
}

/** Run a script in one transaction that always rolls back; return psql's result. */
function inRolledBackTx(script: string) {
  return psql(`BEGIN;\n${script}\nROLLBACK;\n`);
}

/**
 * Every column of user_stamps, probed one statement per column, as `who`, in
 * the shape PostgREST emits (`SELECT "col" FROM user_stamps WHERE id = $1`), or
 * as a filter (`SELECT id FROM user_stamps WHERE "col" IS NOT NULL`) when
 * `filter` is set. One statement per column is what makes the result a
 * partition rather than a single pass/fail: the readable list in the same
 * output is this property's non-vacuity control.
 */
function probe(who: Who, stampId: string, filter = false): { readable: string[]; denied: string[] } {
  const stmt = filter
    ? `format('SELECT id FROM public.user_stamps WHERE %I IS NOT NULL AND id = %L', c, '${stampId}')`
    : `format('SELECT %I FROM public.user_stamps WHERE id = %L', c, '${stampId}')`;
  const out = asOk(
    who,
    `DO $probe$
     DECLARE c text; readable text[] := '{}'; denied text[] := '{}';
     BEGIN
       FOR c IN SELECT attname::text FROM pg_attribute
                 WHERE attrelid = 'public.user_stamps'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum LOOP
         BEGIN
           EXECUTE ${stmt};
           readable := readable || c;
         EXCEPTION WHEN insufficient_privilege THEN
           denied := denied || c;
         END;
       END LOOP;
       PERFORM set_config('us.readable', array_to_string(readable, ','), true);
       PERFORM set_config('us.denied', array_to_string(denied, ','), true);
     END $probe$;
     SELECT 'R|' || current_setting('us.readable');
     SELECT 'D|' || current_setting('us.denied');`,
  );
  const pick = (tag: string) =>
    (out.find((l) => l.startsWith(tag)) ?? tag).slice(tag.length).split(",").filter((s) => s.length > 0).sort();
  return { readable: pick("R|"), denied: pick("D|") };
}

/** Stamp ids from `ids` that `who` can see through the policies. */
function visible(who: Who, ids: string[]): string[] {
  const list = ids.map((i) => `'${i}'`).join(",");
  return asOk(who, `SELECT id FROM public.user_stamps WHERE id IN (${list}) ORDER BY id;`).sort();
}

/** The file's body and its trailing postconditions, without its BEGIN/COMMIT. */
function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

/** 3520's postcondition block alone (the trailing DO $post$ … $post$;). */
function postcondition(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const at = sql.lastIndexOf("DO $post$");
  assert.ok(at >= 0, "3520: no DO $post$ postcondition block");
  return sql.slice(at);
}

/** One line of JSON: the table ACL, every column ACL, and the policy catalog of user_stamps. */
const SNAPSHOT = `SELECT json_build_object(
  'relacl', (SELECT relacl::text FROM pg_class WHERE oid = 'public.user_stamps'::regclass),
  'attacl', (SELECT json_object_agg(attname, attacl::text ORDER BY attnum) FROM pg_attribute
              WHERE attrelid = 'public.user_stamps'::regclass AND attnum > 0 AND NOT attisdropped),
  'policies', (SELECT json_agg(json_build_array(polname, polcmd::text, polpermissive, polroles::regrole[]::text,
                                                pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)) ORDER BY polname)
                 FROM pg_policy WHERE polrelid = 'public.user_stamps'::regclass),
  'rls', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_stamps'::regclass)
)::text;`;

describe("3520: the columns of user_stamps a client role may read (census: database privilege boundary)", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  before(() => {
    OWNER = seedUser("us3520owner");
    VIEWER = seedUser("us3520viewer");
    DEFN = randomUUID();
    STAMP = randomUUID();
    PRIVATE = randomUUID();
    COLS = rows<{ attname: string }>(
      `SELECT attname FROM pg_attribute WHERE attrelid = 'public.user_stamps'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    ).map((r) => r.attname);
    // 2076's user_stamps_live_award_unique keys unrevoked rows on
    // (user_id, stamp_definition_id, source_type, source_id), so the two rows
    // below carry distinct source_ids. source_id is also a granted column, so
    // the probes read it.
    exec(`INSERT INTO public.stamp_definitions (id, slug, name, stamp_type, category, is_active)
            VALUES ('${DEFN}', 'us3520-probe-${DEFN.slice(0, 8)}', 'US3520 Probe', 'location', 'probe', true);
          INSERT INTO public.user_stamps (id, user_id, stamp_definition_id, source_type, source_id, lat, lng, city, country,
                                          visibility, display_on_passport, is_revoked, metadata)
            VALUES ('${STAMP}', '${OWNER}', '${DEFN}', 'trips', '${STAMP}', ${LAT}, ${LNG}, 'London', 'United Kingdom',
                    'public', true, false, '{"us3520":"probe"}'::jsonb),
                   ('${PRIVATE}', '${OWNER}', '${DEFN}', 'trips', '${PRIVATE}', ${LAT}, ${LNG}, 'London', 'United Kingdom',
                    'private', true, false, NULL);`);
  });

  after(() => {
    if (!OWNER) return;
    exec(`DELETE FROM public.user_stamps WHERE user_id IN ('${OWNER}', '${VIEWER}');
          DELETE FROM public.stamp_definitions WHERE id = '${DEFN}';`);
    for (const u of [OWNER, VIEWER]) if (u) deleteUser(u);
  });

  const present = (list: readonly string[]) => list.filter((c) => COLS.includes(c)).sort();

  it("US-0 — 3520 is in force: no table-level SELECT reaches a client role on user_stamps", () => {
    // A table-level SELECT covers every column, so its presence restores the
    // whole defect and makes every column grant below it decorative. The
    // client roles' remaining table-level WRITE grants are 2490's and 2972's
    // business: 2490 is in KNOWN_UNREPLAYABLE.json here (PostgreSQL 16 has no
    // MAINTAIN privilege), so REFERENCES and TRIGGER survive on this harness,
    // and on production 2972 has not run, so INSERT, UPDATE and DELETE do.
    // Neither reaches a row — user_stamps has no client-role write policy —
    // and neither lets a client read a column.
    const readable = rows<{ grantee: string; privilege_type: string }>(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type
         FROM pg_class c, LATERAL aclexplode(c.relacl) a
        WHERE c.oid = 'public.user_stamps'::regclass
          AND ((a.grantee = 0) OR (a.grantee IN ('anon'::regrole, 'authenticated'::regrole) AND a.privilege_type = 'SELECT'))`,
    );
    assert.deepEqual(
      readable,
      [],
      "a table-level SELECT (or any PUBLIC grant) on user_stamps silently restores the whole defect",
    );
    // Every column-level privilege that does exist is a plain SELECT.
    assert.deepEqual(
      rows(`SELECT 1 FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
             WHERE a.attrelid = 'public.user_stamps'::regclass AND a.attnum > 0 AND NOT a.attisdropped
               AND (x.privilege_type <> 'SELECT' OR x.is_grantable)`),
      [],
      "a column-level privilege on user_stamps is not a plain SELECT",
    );
    // RLS stays the row boundary; column grants are not a substitute for it.
    assert.equal(scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_stamps'::regclass`), "t");
    assert.ok(COLS.length >= 19, `only ${COLS.length} columns on user_stamps: the harness did not replay the chain`);
    assert.equal(
      COLS.length,
      present(GRANTED).length + present(WITHHELD).length,
      "every column of user_stamps is classified, once",
    );
    // lat and lng must actually exist, or every claim below is about nothing.
    for (const c of ["lat", "lng"]) assert.ok(COLS.includes(c), `user_stamps has no ${c} column`);
  });

  it("US-1 — anon and a signed-in stranger are refused lat, lng and metadata: selected, filtered on, or through *", () => {
    // CONTROL, from a role that is not under test: the row is there and its
    // coordinates are readable, so a refusal below cannot be emptiness.
    assert.equal(scalar(`SELECT lat::text FROM public.user_stamps WHERE id = '${STAMP}'`), LAT);
    assert.equal(scalar(`SELECT lng::text FROM public.user_stamps WHERE id = '${STAMP}'`), LNG);

    for (const who of [{ role: "anon" }, { role: "authenticated", uid: VIEWER }] as Who[]) {
      const sel = probe(who, STAMP);
      assert.deepEqual(sel.denied, present(WITHHELD), `${who.role}: wrong columns refused when selected`);
      // The same statement's readable list is this property's control: the
      // probe really did run, and it really did reach the table.
      assert.deepEqual(sel.readable, present(GRANTED), `${who.role}: wrong columns readable when selected`);

      // A filter needs the column privilege too, so `?lat=gt.48.85` is closed
      // as well. Without this, the coordinates leak one bit at a time.
      const flt = probe(who, STAMP, true);
      assert.deepEqual(flt.denied, present(WITHHELD), `${who.role}: wrong columns refused when filtered on`);
      assert.deepEqual(flt.readable, present(GRANTED), `${who.role}: wrong columns readable when filtered on`);

      // `select=*` is a table-level read, which no client role may do now.
      assertDenied(who, `SELECT user_stamps.* FROM public.user_stamps WHERE id = '${STAMP}';`);
      assertDenied(who, `SELECT * FROM public.user_stamps WHERE id = '${STAMP}';`);
      // And neither does naming the columns get round it.
      assertDenied(who, `SELECT lat, lng FROM public.user_stamps WHERE id = '${STAMP}';`);
      assertDenied(who, `SELECT id FROM public.user_stamps WHERE lat > 48.85;`);
      assertDenied(who, `SELECT max(lat) FROM public.user_stamps;`);
      assertDenied(who, `SELECT id FROM public.user_stamps ORDER BY lng;`);
    }
  });

  it("US-2 — a client role reads exactly the granted columns, and still reads the rows it could before", () => {
    for (const who of [{ role: "anon" }, { role: "authenticated", uid: VIEWER }] as Who[]) {
      for (const col of present(GRANTED)) {
        asOk(who, `SELECT ${col} FROM public.user_stamps WHERE id = '${STAMP}';`);
      }
    }
    // The coarse place a stamp surface renders is unaffected; the point is not.
    assert.deepEqual(
      asOk({ role: "authenticated", uid: VIEWER }, `SELECT city || '/' || country FROM public.user_stamps WHERE id = '${STAMP}';`),
      ["London/United Kingdom"],
    );
    // 3520 narrows columns, not rows: the stranger still sees the public stamp
    // and still does not see the private one.
    assert.deepEqual(visible({ role: "authenticated", uid: VIEWER }, [STAMP, PRIVATE]), [STAMP]);
    assert.deepEqual(visible({ role: "anon" }, [STAMP, PRIVATE]), []);
  });

  it("US-3 — the defect, reproduced: over the pre-3520 grant a signed-in stranger reads lat and lng, and 0081's REVOKE does not stop them", () => {
    // 0081 + 2972's state restored, then 0081's own two statements on top.
    // If the comment at 0081:229-230 were true, the read below would fail.
    const open = inRolledBackTx(`${unwrapped(ROLLBACK)}
${REVOKE_0081}
-- the owner's control read, so a refusal could not pass as emptiness
SELECT 'OWNER_CONTROL lat=' || lat || ' lng=' || lng FROM public.user_stamps WHERE id = '${STAMP}';
${prelude({ role: "authenticated", uid: VIEWER })}
SELECT 'STRANGER_READ lat=' || lat || ' lng=' || lng FROM public.user_stamps WHERE id = '${STAMP}';`);
    assert.equal(open.status, 0, `the pre-3520 posture could not be rebuilt: ${open.stderr}`);
    assert.match(open.stdout, new RegExp(`OWNER_CONTROL lat=${LAT} lng=${LNG}`), "the control row was not readable");
    assert.match(
      open.stdout,
      new RegExp(`STRANGER_READ lat=${LAT} lng=${LNG}`),
      "a signed-in stranger could NOT read the coordinates over the pre-3520 grant, so every refusal in this suite proves nothing — re-establish the defect before trusting US-1",
    );
    // And the column privilege really is still there, as 0081 claimed it was not.
    assert.match(
      inRolledBackTx(`${unwrapped(ROLLBACK)}\n${REVOKE_0081}
SELECT 'AUTH_LAT=' || has_column_privilege('authenticated', 'public.user_stamps', 'lat', 'SELECT');`).stdout,
      /AUTH_LAT=true/,
      "0081's column REVOKE did remove the privilege here; this harness no longer reproduces the production state",
    );

    // Now the same posture plus 3520: the read is refused.
    const shut = inRolledBackTx(`${unwrapped(ROLLBACK)}
${REVOKE_0081}
${unwrapped(MIGRATION)}
SELECT 'AUTH_LAT=' || has_column_privilege('authenticated', 'public.user_stamps', 'lat', 'SELECT')
    || ' ANON_LNG=' || has_column_privilege('anon', 'public.user_stamps', 'lng', 'SELECT')
    || ' AUTH_CITY=' || has_column_privilege('authenticated', 'public.user_stamps', 'city', 'SELECT');`);
    assert.equal(shut.status, 0, `3520 did not apply over the pre-3520 posture: ${shut.stderr}`);
    assert.match(shut.stdout, /AUTH_LAT=false ANON_LNG=false AUTH_CITY=true/, shut.stdout);
  });

  it("US-4 — the owner is refused their own coordinates through a client token; service_role reads them", () => {
    const own = probe({ role: "authenticated", uid: OWNER }, STAMP);
    assert.deepEqual(own.denied, present(WITHHELD), "the owner must be refused the same columns: a column privilege cannot tell rows apart");
    assert.deepEqual(own.readable, present(GRANTED), "the owner lost a granted column");
    // Nothing in the product reads an owner's own lat/lng with a client token
    // (routes/stamps.ts:82-84 OWNER_STAMP_COLS omits them), so this breaks no
    // reader. The server's path is the one that keeps them:
    const missing = rows<{ attname: string }>(
      `SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = 'public.user_stamps'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND NOT has_column_privilege('service_role', a.attrelid, a.attnum, 'SELECT')`,
    );
    assert.deepEqual(missing, [], "service_role lost a column: the award pipeline and every stamp route read this table");
    const asService = asOk(
      { role: "authenticated", uid: OWNER },
      `RESET ROLE;\nSET LOCAL ROLE service_role;\nSELECT 'SVC lat=' || lat || ' lng=' || lng FROM public.user_stamps WHERE id = '${STAMP}';`,
    );
    assert.deepEqual(asService, [`SVC lat=${LAT} lng=${LNG}`]);
  });

  it("US-5 — the rollback restores the pre-3520 grants exactly, and 3520 re-applies to the identical state", () => {
    const before = scalar(SNAPSHOT);
    const back = inRolledBackTx(`${unwrapped(ROLLBACK)}
SELECT 'ROLLED_BACK|' || (${SNAPSHOT.replace(/;$/, "")});
${unwrapped(MIGRATION)}
SELECT 'REAPPLIED|' || (${SNAPSHOT.replace(/;$/, "")});`);
    assert.equal(back.status, 0, back.stderr);
    const line = (tag: string) =>
      back.stdout.split("\n").find((l) => l.includes(`${tag}|`))?.split(`${tag}|`)[1]?.trim() ?? "";
    const rolled = JSON.parse(line("ROLLED_BACK"));
    const again = JSON.parse(line("REAPPLIED"));
    // The rollback really does restore the table-level grant (and so the defect).
    // relacl renders each grantee's privileges as one letter string, so the
    // match allows the REFERENCES and TRIGGER the harness still carries (2490
    // is known-unreplayable here) and the writes production still carries
    // (2972 has not run there). `r` is SELECT, and that is the claim.
    assert.match(String(rolled.relacl), /anon=r[a-zA-Z*]*\//, "the rollback did not restore anon's table-level SELECT");
    assert.match(String(rolled.relacl), /authenticated=r[a-zA-Z*]*\//, "the rollback did not restore authenticated's table-level SELECT");
    assert.deepEqual(
      Object.values(rolled.attacl ?? {}).filter((v) => v !== null),
      [],
      "a column-level privilege survived the rollback",
    );
    // Re-applying lands on the same state as the chain's own apply, policies included.
    const chain = JSON.parse(before ?? "{}");
    assert.deepEqual(again, chain, "3520 re-applied to a different state than the chain left");
    assert.deepEqual(again.policies, chain.policies, "the policy catalog moved");
    assert.equal(again.rls, true, "RLS was left off");
  });

  it("US-6 — 3520's postcondition raises over each broken claim rather than passing", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["a table-level SELECT was handed back to authenticated",
       "GRANT SELECT ON TABLE public.user_stamps TO authenticated;",
       /a table-level privilege that covers every column survives/],
      ["a table-level SELECT was handed back to anon",
       "GRANT SELECT ON TABLE public.user_stamps TO anon;",
       /a table-level privilege that covers every column survives/],
      ["PUBLIC was granted a read",
       "GRANT SELECT ON TABLE public.user_stamps TO PUBLIC;",
       /a table-level privilege that covers every column survives/],
      ["lat was granted back to authenticated",
       "GRANT SELECT (lat) ON TABLE public.user_stamps TO authenticated;",
       /can still read a private user_stamps column/],
      ["lng was granted back to anon",
       "GRANT SELECT (lng) ON TABLE public.user_stamps TO anon;",
       /can still read a private user_stamps column/],
      ["metadata was granted back",
       "GRANT SELECT (metadata) ON TABLE public.user_stamps TO anon;",
       /can still read a private user_stamps column/],
      ["a client role gained a column-level write",
       "GRANT UPDATE (city) ON TABLE public.user_stamps TO authenticated;",
       /a column-level privilege on user_stamps is not a plain SELECT/],
      ["a column-level read was made re-grantable",
       "GRANT SELECT (city) ON TABLE public.user_stamps TO anon WITH GRANT OPTION;",
       /a column-level privilege on user_stamps is not a plain SELECT/],
      ["a granted column was taken from a client role",
       "REVOKE SELECT (city) ON TABLE public.user_stamps FROM anon;",
       /lost a column it must keep/],
      // Narrowing service_role takes the SAME two statements this migration
      // uses, for the same reason: service_role holds table-level SELECT, so
      // a bare `REVOKE SELECT (lat) ... FROM service_role` is the no-op 0081
      // shipped. Writing it the working way here is what makes this case
      // exercise the claim instead of passing on an unchanged database.
      ["service_role lost a column",
       "REVOKE SELECT ON TABLE public.user_stamps FROM service_role;\n" +
       "GRANT SELECT (id, city) ON TABLE public.user_stamps TO service_role;",
       /service_role cannot read user_stamps column/],
    ];
    for (const [what, breakIt, expected] of cases) {
      const out = inRolledBackTx(`${breakIt}\n${postcondition()}`);
      assert.notEqual(out.status, 0, `the postcondition passed although ${what}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }
    // And it passes on the state the chain actually left, so the eight
    // refusals above are not an always-raising block.
    const clean = inRolledBackTx(postcondition());
    assert.equal(clean.status, 0, `3520's postcondition fails on the replayed chain: ${clean.stderr}`);
  });

  it("US-7 — 3520 refuses an unclassified column, and a column added after it reaches no client role", () => {
    // An unclassified column may be a position. Refusing is the point.
    const unknown = inRolledBackTx(`${unwrapped(ROLLBACK)}
ALTER TABLE public.user_stamps ADD COLUMN zz_3520_probe_lat numeric(10,7);
${unwrapped(MIGRATION)}`);
    assert.notEqual(unknown.status, 0, "3520 applied over a column it does not classify");
    assert.match(unknown.stderr, /does not classify: zz_3520_probe_lat/, unknown.stderr);

    // 3520 also refuses a starting state that is not the one its rollback restores.
    const wrongStart = inRolledBackTx(unwrapped(MIGRATION));
    assert.notEqual(wrongStart.status, 0, "3520 applied twice over its own output; its precondition is decorative");
    assert.match(wrongStart.stderr, /PRECONDITION FAILED \(3520\)/, wrongStart.stderr);

    // A column added AFTER 3520 is closed by default: granting it is a
    // deliberate statement in a later migration.
    const added = inRolledBackTx(`ALTER TABLE public.user_stamps ADD COLUMN zz_3520_new text;
SELECT 'ANON=' || has_column_privilege('anon', 'public.user_stamps', 'zz_3520_new', 'SELECT')
    || ' AUTH=' || has_column_privilege('authenticated', 'public.user_stamps', 'zz_3520_new', 'SELECT')
    || ' SVC=' || has_column_privilege('service_role', 'public.user_stamps', 'zz_3520_new', 'SELECT');`);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /ANON=false AUTH=false SVC=true/, added.stdout);
  });
});
