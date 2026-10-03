/**
 * clientSequencePrivileges — migration 3503, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/clientSequencePrivileges.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT: Supabase's default privileges hand `anon` and `authenticated`
 * USAGE, SELECT and UPDATE on every sequence created in public, and RLS has no
 * notion of a sequence. Measured 2026-10-03 on both hosted databases: every
 * sequence in public (10 on the testing database, 12 on portava-ci) let a
 * client key `setval` it, so moving an ID counter back made the server's next
 * INSERT on that table collide on its primary key. 3503 revokes every client
 * sequence privilege, stops the postgres default ACL re-issuing them, and drops
 * the client roles' inert DML grants on telegraph_report_evidence (2812).
 *
 * HOW THESE PROPERTIES BITE: the harness's shim.sql reproduces Supabase's
 * default ACL, and up.sh replays 3503 with the chain, so the database under
 * test already carries 3503's effect. Each property therefore rebuilds the
 * PRE-3503 posture inside a transaction (the grants Supabase issues), proves
 * the hole is open there, applies 3503's body, and asserts the hole is closed;
 * the transaction always rolls back. A copy of 3503 with any of its three
 * statements removed fails the matching property.
 *
 * PROPERTIES
 *   SQ0  3503 is in force on the replayed chain: no non-extension sequence in
 *        public grants anon, authenticated or PUBLIC anything; postgres's
 *        default ACL for sequences in public names neither client role.
 *   SQ1  over Supabase's pre-3503 grants, anon and authenticated can setval
 *        and nextval; after 3503's body both are refused on every sequence.
 *   SQ2  service_role still draws from every sequence after 3503 (the server
 *        writes every row these sequences feed).
 *   SQ3  a sequence created after 3503 grants the client roles nothing, and
 *        service_role still gets USAGE.
 *   SQ4  telegraph_report_evidence: client DML granted before, none after;
 *        service_role keeps SELECT and INSERT.
 *   SQ5  3503's postcondition is not decorative: a client grant left behind
 *        makes it raise.
 *   SQ6  3503 is idempotent: its body runs twice in one transaction.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3503_client_sequence_privilege_boundary.sql");

/** 3503's statements without its own BEGIN … COMMIT, so a test can run them inside its transaction. */
function body(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, "3503: no BEGIN … COMMIT wrapper");
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n";
}

/** 3503's postcondition block alone (the last DO $$ … $$; in the file). */
function postcondition(): string {
  const b = body();
  const at = b.lastIndexOf("DO $$");
  assert.ok(at >= 0, "3503: no postcondition block");
  return b.slice(at);
}

/** Supabase's pre-3503 posture, as its default ACL issues it, re-created inside the test's transaction. */
const PRE_3503 = `
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
`;

const NON_EXTENSION_SEQUENCES = `
  SELECT c.oid, c.relname
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = c.oid AND d.deptype = 'e' AND d.classid = 'pg_class'::regclass)`;

/** Run a script in one transaction that always rolls back; return psql's status, stdout and stderr. */
function inRolledBackTx(script: string) {
  return psql(`BEGIN;\n${script}\nROLLBACK;\n`);
}

/** One sequence that exists on every replayed chain (the testing database's first, alphabetically). */
function aSequence(): string {
  const r = rows<{ relname: string }>(`${NON_EXTENSION_SEQUENCES} ORDER BY c.relname LIMIT 1`);
  assert.ok(r.length === 1, "no non-extension sequence in public: the harness did not replay the chain");
  return r[0]!.relname;
}

describe("3503: client roles hold no sequence privilege (census: database privilege boundary)", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  it("SQ0: 3503 is in force on the replayed chain", () => {
    const offending = rows<{ relname: string }>(`
      SELECT DISTINCT s.relname FROM (${NON_EXTENSION_SEQUENCES}) s
        JOIN pg_class c ON c.oid = s.oid
        CROSS JOIN LATERAL aclexplode(c.relacl) x
       WHERE x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon','authenticated')`);
    assert.deepEqual(offending, [], "a sequence in public still grants a client role something");
    const defaults = rows(`
      SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
       WHERE d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'S'
         AND pg_get_userbyid(d.defaclrole) = 'postgres'
         AND pg_get_userbyid(x.grantee) IN ('anon','authenticated')`);
    assert.deepEqual(defaults, [], "postgres's default ACL still issues sequence privileges to a client role");
    const n = Number(rows<{ n: number }>(`SELECT count(*)::int AS n FROM (${NON_EXTENSION_SEQUENCES}) s`)[0]!.n);
    assert.ok(n >= 5, `only ${n} sequences examined: a sweep over nothing proves nothing`);
  });

  it("SQ1: over Supabase's pre-3503 grants a client key moves a counter; after 3503 it cannot", () => {
    const seq = aSequence();
    for (const role of ["anon", "authenticated"]) {
      // The hole, open: PRE_3503 restored, then the client role resets the counter.
      const open = inRolledBackTx(`${PRE_3503}
SET LOCAL ROLE ${role};
SELECT 'SETVAL=' || setval('public.${seq}', 1000000);
SELECT 'NEXTVAL=' || nextval('public.${seq}');`);
      assert.equal(open.status, 0, `${role} on the pre-3503 posture: ${open.stderr}`);
      assert.match(open.stdout, /SETVAL=1000000/, `${role} could not setval before 3503, so this property proves nothing`);

      // The hole, closed: same posture, then 3503's body, then every client verb is refused.
      for (const verb of [`setval('public.${seq}', 1000000)`, `nextval('public.${seq}')`, `currval('public.${seq}')`]) {
        const shut = inRolledBackTx(`${PRE_3503}
${body()}
SET LOCAL ROLE ${role};
SELECT ${verb};`);
        assert.notEqual(shut.status, 0, `${role} ran ${verb} after 3503`);
        assert.match(shut.stderr, /permission denied for sequence/, `${role} ${verb}: ${shut.stderr}`);
      }
    }
  });

  it("SQ2: service_role still draws from every sequence after 3503", () => {
    const out = inRolledBackTx(`${PRE_3503}
${body()}
SELECT 'MISSING=' || coalesce(string_agg(s.relname, ','), '')
  FROM (${NON_EXTENSION_SEQUENCES}) s
 WHERE CASE WHEN (SELECT relkind FROM pg_class WHERE oid = s.oid) = 'S'
            THEN NOT has_sequence_privilege('service_role', s.oid, 'USAGE') ELSE false END;
SET LOCAL ROLE service_role;
SELECT 'NEXTVAL=' || nextval('public.${aSequence()}');`);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^MISSING=$/m, `service_role lost USAGE: ${out.stdout}`);
    assert.match(out.stdout, /NEXTVAL=\d+/);
  });

  it("SQ3: a sequence created after 3503 grants the client roles nothing", () => {
    const out = inRolledBackTx(`${PRE_3503}
${body()}
CREATE SEQUENCE public.zz_3503_probe_seq;
SELECT 'ANON=' || has_sequence_privilege('anon', 'public.zz_3503_probe_seq', 'USAGE,SELECT,UPDATE')
    || ' AUTH=' || has_sequence_privilege('authenticated', 'public.zz_3503_probe_seq', 'USAGE,SELECT,UPDATE')
    || ' SVC=' || has_sequence_privilege('service_role', 'public.zz_3503_probe_seq', 'USAGE');`);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /ANON=false AUTH=false SVC=true/);
  });

  it("SQ4: telegraph_report_evidence grants client DML before 3503 and none after; service_role keeps it", () => {
    const present = rows<{ ok: boolean }>(`SELECT to_regclass('public.telegraph_report_evidence') IS NOT NULL AS ok`)[0]!.ok;
    assert.ok(present, "2812's telegraph_report_evidence is absent: the harness did not replay the chain through 2812");
    const probe = `SELECT 'ANON=' || has_table_privilege('anon', 'public.telegraph_report_evidence', 'SELECT,INSERT,UPDATE,DELETE')
    || ' AUTH=' || has_table_privilege('authenticated', 'public.telegraph_report_evidence', 'SELECT,INSERT,UPDATE,DELETE')
    || ' SVC=' || (has_table_privilege('service_role', 'public.telegraph_report_evidence', 'SELECT')
               AND has_table_privilege('service_role', 'public.telegraph_report_evidence', 'INSERT'));`;
    const before = inRolledBackTx(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegraph_report_evidence TO anon, authenticated;\n${probe}`);
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /ANON=true AUTH=true SVC=true/);
    const after = inRolledBackTx(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegraph_report_evidence TO anon, authenticated;\n${body()}\n${probe}`);
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /ANON=false AUTH=false SVC=true/);
  });

  it("SQ5: 3503's postcondition raises over a client grant left behind, for each client grantee", () => {
    for (const grantee of ["anon", "authenticated", "PUBLIC"]) {
      const out = inRolledBackTx(`${PRE_3503}
${body()}
GRANT UPDATE ON SEQUENCE public.${aSequence()} TO ${grantee};
${postcondition()}`);
      assert.notEqual(out.status, 0, `the postcondition passed over a sequence grant to ${grantee}`);
      assert.match(out.stderr, /3503 postcondition FAILED/, `${grantee}: ${out.stderr}`);
    }
  });

  it("SQ8: each of 3503's other postconditions raises over its own broken claim", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["the postgres default ACL re-grants sequences to a client role",
       "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE ON SEQUENCES TO authenticated;",
       /default ACL for sequences in public still grants/],
      ["service_role loses USAGE on a sequence",
       `REVOKE USAGE ON SEQUENCE public.${aSequence()} FROM service_role;`,
       /service_role lacks USAGE/],
      ["telegraph_report_evidence grants authenticated DML again",
       "GRANT SELECT ON public.telegraph_report_evidence TO authenticated;",
       /telegraph_report_evidence still grants DML/],
      ["telegraph_report_evidence grants anon DML again",
       "GRANT INSERT ON public.telegraph_report_evidence TO anon;",
       /telegraph_report_evidence still grants DML/],
    ];
    for (const [what, breakIt, expected] of cases) {
      const out = inRolledBackTx(`${PRE_3503}\n${body()}\n${breakIt}\n${postcondition()}`);
      assert.notEqual(out.status, 0, `the postcondition passed although ${what}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }
  });

  it("SQ7: 3503's postcondition refuses a sweep over no sequences", () => {
    // The postcondition pointed at a schema created empty inside the
    // transaction. (Dropping public's sequences is not possible: identity
    // sequences belong to their column.) Every 'public'::regnamespace in the
    // block is replaced, so each of its checks reads the empty schema.
    const block = postcondition();
    const retargeted = block.replaceAll("'public'::regnamespace", "'zz_3503_empty'::regnamespace");
    assert.notEqual(retargeted, block, "the postcondition no longer names 'public'::regnamespace; retarget this test");
    const out = inRolledBackTx(`CREATE SCHEMA zz_3503_empty;\n${retargeted}`);
    assert.notEqual(out.status, 0, "the postcondition reported success over an empty sweep");
    assert.match(out.stderr, /3503 postcondition VACUOUS/, out.stderr);
  });

  it("SQ6: 3503 is idempotent", () => {
    const out = inRolledBackTx(`${PRE_3503}\n${body()}\n${body()}`);
    assert.equal(out.status, 0, out.stderr);
    exec("SELECT 1;");
  });
});
