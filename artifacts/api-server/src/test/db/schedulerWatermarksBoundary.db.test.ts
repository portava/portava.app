/**
 * schedulerWatermarksBoundary — migration 3505, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/schedulerWatermarksBoundary.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT (found at the integration of #561, 2026-10-04, by running the
 * repository's own `certify:migrations` over the applied file on a local
 * PostgreSQL 16): 3505 created `public.scheduler_watermarks`, enabled RLS and
 * named no role. Supabase's default ACL hands `anon` and `authenticated` every
 * privilege on a table created in `public`, so the table was born
 * client-writable behind RLS — the exact shape 3504 exists to remove from 53
 * older tables, and one `certify:migrations` refuses at stage 3:
 *
 *   ✖ 3505_scheduler_watermarks.sql: role 'anon' holds INSERT on
 *     public.scheduler_watermarks, and no migration in scope grants it.
 *
 * On `main` that is a red `schema drift` job on the first run after the merge.
 * 3505 now revokes the client roles and PUBLIC by name, grants `service_role`
 * the four DML privileges `lib/schedulerWatermark.ts` uses, and asserts all of
 * it in a `$post$` block that reads only the catalogue, so certify can re-run
 * it after the commit.
 *
 * HOW THESE PROPERTIES BITE: up.sh replays 3505 with the chain, so the database
 * under test already carries its effect. SW0 is red on a chain built with the
 * file as #561 wrote it. The mutation properties rebuild a broken posture
 * inside a transaction that always rolls back.
 *
 * PROPERTIES
 *   SW0  3505 is in force: the table exists with RLS on and no policy, and
 *        grants anon, authenticated and PUBLIC nothing.
 *   SW1  service_role does what lib/schedulerWatermark.ts does — read a mark,
 *        and upsert one on (job) — and reads back what it wrote.
 *   SW2  a client role is REFUSED on every verb (permission denied), which is
 *        not the same as succeeding and matching no row: over the default ACL
 *        the same statements run and RLS hides the rows.
 *   SW3  3505's postcondition raises over each broken claim: a grant left to
 *        anon, authenticated or PUBLIC; RLS off; a permissive policy;
 *        service_role missing one of the four. And it PASSES on the real state,
 *        so it is not a block that always raises.
 *   SW4  3505 is idempotent: the whole file runs twice.
 *   SW5  the rollback removes the table and 3505's ledger row, says how many
 *        marks went with it, runs twice, and 3505 re-applies afterwards.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, psql, rows } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3505_scheduler_watermarks.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-04-3505-scheduler-watermarks-rollback.sql");
const T = "public.scheduler_watermarks";

const migration = () => readFileSync(MIGRATION, "utf8");

/** 3505's `DO $post$ … $post$;` block alone. */
function postcondition(): string {
  const sql = migration();
  const at = sql.indexOf("DO $post$");
  const end = sql.indexOf("$post$;", at + 9);
  assert.ok(at >= 0 && end > at, "3505: no DO $post$ block");
  return sql.slice(at, end + "$post$;".length) + "\n";
}

/** The rollback without its own BEGIN … COMMIT, so a test can run it inside a transaction it rolls back. */
function rollbackBody(): string {
  const sql = readFileSync(ROLLBACK, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.search(/^COMMIT;\s*$/m);
  assert.ok(begin >= 0 && commit > begin, "3505 rollback: no BEGIN … COMMIT wrapper");
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n";
}

/** Run a script in one transaction that always rolls back; return psql's status, stdout and stderr. */
function inRolledBackTx(script: string) {
  return psql(`BEGIN;\n${script}\nROLLBACK;\n`);
}

/** Supabase's posture on a table born in public with no role named, which is what #561's 3505 left. */
const DEFAULT_ACL = `GRANT ALL ON TABLE ${T} TO anon, authenticated;\n`;

describe("3505: scheduler_watermarks is server state — no client role holds anything on it", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  it("SW0: 3505 is in force on the replayed chain", () => {
    const meta = rows<{ present: boolean; rls: boolean; policies: number }>(`
      SELECT to_regclass('${T}') IS NOT NULL AS present,
             coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('${T}')), false) AS rls,
             (SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('${T}')) AS policies`)[0]!;
    assert.equal(meta.present, true, "3505 did not create the table: the harness did not replay the chain through it");
    assert.equal(meta.rls, true, "RLS is off on scheduler_watermarks");
    assert.equal(meta.policies, 0, "3505 declares NO policy; one has appeared");
    const offending = rows<{ grantee: string; privilege_type: string }>(`
      SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee, x.privilege_type
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
       WHERE c.oid = to_regclass('${T}')
         AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon','authenticated'))
       ORDER BY 1, 2`);
    assert.deepEqual(offending, [], "scheduler_watermarks grants a client role or PUBLIC something");
  });

  it("SW1: service_role reads a mark and upserts one on (job), as lib/schedulerWatermark.ts does", () => {
    const out = inRolledBackTx(`
SET LOCAL ROLE service_role;
INSERT INTO ${T} (job, processed_through) VALUES ('zz_sw1', '2026-01-01T00:00:00Z')
  ON CONFLICT (job) DO UPDATE SET processed_through = EXCLUDED.processed_through, updated_at = now();
INSERT INTO ${T} (job, processed_through) VALUES ('zz_sw1', '2026-01-02T00:00:00Z')
  ON CONFLICT (job) DO UPDATE SET processed_through = EXCLUDED.processed_through, updated_at = now();
SELECT 'MARK=' || to_char(processed_through AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' ROWS=' || (SELECT count(*) FROM ${T} WHERE job = 'zz_sw1')
  FROM ${T} WHERE job = 'zz_sw1';
DELETE FROM ${T} WHERE job = 'zz_sw1';`);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /MARK=2026-01-02 ROWS=1/, `the second upsert did not advance the one row: ${out.stdout}`);
  });

  it("SW2: a client role is refused on every verb, where over the default ACL the same statements run", () => {
    const verbs = [
      `SELECT count(*) FROM ${T}`,
      `INSERT INTO ${T} (job, processed_through) VALUES ('zz_sw2', now())`,
      `UPDATE ${T} SET processed_through = now() WHERE false`,
      `DELETE FROM ${T} WHERE false`,
    ];
    for (const role of ["anon", "authenticated"]) {
      // The posture the file used to leave: the privilege is held, RLS (no
      // policy) hides every row, so a read SUCCEEDS and returns nothing.
      const open = inRolledBackTx(`${DEFAULT_ACL}SET LOCAL ROLE ${role};\nSELECT 'SELECTED=' || count(*) FROM ${T};`);
      assert.equal(open.status, 0, `${role} over the default ACL: ${open.stderr}`);
      assert.match(open.stdout, /SELECTED=0/, `${role} could not select over the default ACL, so the refusals below prove nothing`);
      for (const verb of verbs) {
        const shut = inRolledBackTx(`SET LOCAL ROLE ${role};\n${verb};`);
        assert.notEqual(shut.status, 0, `${role} ran "${verb}"`);
        assert.match(shut.stderr, /permission denied for table scheduler_watermarks/, `${role} ${verb}: ${shut.stderr}`);
      }
    }
  });

  it("SW3: 3505's postcondition raises over each broken claim, and passes on the real state", () => {
    const real = inRolledBackTx(postcondition());
    assert.equal(real.status, 0, `the postcondition raises on the database 3505 produced: ${real.stderr}`);

    const cases: Array<[string, string, RegExp]> = [
      ["anon holds a privilege", `GRANT SELECT ON TABLE ${T} TO anon;`, /3505 POSTCONDITION FAILED: .*anon/],
      ["authenticated holds a privilege", `GRANT INSERT ON TABLE ${T} TO authenticated;`, /3505 POSTCONDITION FAILED: .*authenticated/],
      ["PUBLIC holds a privilege", `GRANT SELECT ON TABLE ${T} TO PUBLIC;`, /3505 POSTCONDITION FAILED: .*PUBLIC/],
      ["RLS is off", `ALTER TABLE ${T} DISABLE ROW LEVEL SECURITY;`, /3505 POSTCONDITION FAILED: row level security is not enabled/],
      ["a permissive policy appeared", `CREATE POLICY zz_sw3 ON ${T} FOR SELECT TO authenticated USING (true);`, /3505 POSTCONDITION FAILED: .*permissive/],
      ["service_role lost UPDATE", `REVOKE UPDATE ON TABLE ${T} FROM service_role;`, /3505 POSTCONDITION FAILED: service_role lacks/],
    ];
    for (const [what, breakIt, expected] of cases) {
      const out = inRolledBackTx(`${breakIt}\n${postcondition()}`);
      assert.notEqual(out.status, 0, `the postcondition passed although ${what}`);
      assert.match(out.stderr, /ERROR:/, `${what}: not an error — ${out.stderr}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }
  });

  it("SW4: 3505 is idempotent, and repairs the default ACL when it is re-run over it", () => {
    const out = inRolledBackTx(`${DEFAULT_ACL}${migration()}\n${migration()}
SELECT 'ANON=' || has_table_privilege('anon', '${T}', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    || ' AUTH=' || has_table_privilege('authenticated', '${T}', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE');`);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /ANON=false AUTH=false/, out.stdout);
  });

  it("SW5: the rollback drops the table and the ledger row, counts the marks it drops, and 3505 re-applies", () => {
    const out = inRolledBackTx(`
INSERT INTO ${T} (job, processed_through) VALUES ('zz_sw5_a', now()), ('zz_sw5_b', now());
INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes)
  VALUES ('3505_scheduler_watermarks.sql', repeat('0', 64), 'manual', 'SW5 fixture') ON CONFLICT (filename) DO NOTHING;
${rollbackBody()}
SELECT 'TABLE=' || coalesce(to_regclass('${T}')::text, 'gone')
    || ' LEDGER=' || (SELECT count(*) FROM public.schema_migration_ledger WHERE filename = '3505_scheduler_watermarks.sql');
${rollbackBody()}
${migration()}
SELECT 'AGAIN=' || coalesce(to_regclass('${T}')::text, 'gone') || ' ROWS=' || (SELECT count(*) FROM ${T});`);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /TABLE=gone LEDGER=0/, out.stdout);
    assert.match(out.stderr, /3505 rollback: dropping public\.scheduler_watermarks with \d+ mark\(s\)/, `the rollback did not say what it dropped: ${out.stderr}`);
    assert.match(out.stdout, /AGAIN=(public\.)?scheduler_watermarks ROWS=0/, out.stdout);
  });
});
