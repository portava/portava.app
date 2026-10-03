/**
 * clientTablePrivileges — migration 3504, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/clientTablePrivileges.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT: Supabase's default privileges hand `anon` and `authenticated`
 * SELECT, INSERT, UPDATE and DELETE on every table created in public, and 2490
 * deliberately left those four alone ("narrowing them table-by-table is
 * per-surface work with per-surface evidence"). Measured 2026-10-03 on both
 * hosted databases: 53 named tables that no client code path reaches still
 * carry them — inert on the testing database, where RLS is on with zero
 * policies, but NOT inert on portava-ci, where eleven of them have RLS off and
 * the anon key can read and write them outright. 3504 revokes the client-role
 * and PUBLIC privileges on those 53, naming `service_role` nowhere.
 *
 * HOW THESE PROPERTIES BITE: up.sh replays 3504 with the chain, so the database
 * under test already carries its effect. Each property therefore rebuilds the
 * PRE-3504 posture inside a transaction (the grants Supabase's default ACL
 * issues), proves the hole is open there, applies 3504's body, and asserts the
 * hole is closed; the transaction always rolls back. CT0 is red on a chain
 * built without 3504 (LOCAL_DB_TO=3504), and a copy of 3504 with its REVOKE
 * removed fails CT0, CT1, CT3 and CT5.
 *
 * Note what "open" looks like before the fix, because it is the point of the
 * migration: with RLS on and zero policies a client-role SELECT SUCCEEDS and
 * returns no rows. The privilege is what makes it a refusal instead of a
 * silent empty read, and a refusal is what survives someone adding a policy.
 *
 * PROPERTIES
 *   CT0  3504 is in force on the replayed chain: no named table that exists
 *        grants anon, authenticated or PUBLIC anything, and 45+ of the 53 are
 *        present (a sweep over nothing proves nothing).
 *   CT1  over the pre-3504 grants a client role reads and writes a target;
 *        after 3504's body every verb is refused, for both roles.
 *   CT2  service_role keeps all four DML privileges on every present target.
 *        (One has_table_privilege call per privilege: the comma form is OR, not
 *        AND, and CT8's mutation case caught 3504 getting that wrong.)
 *   CT3  telegraph_outbox (2810), the table this lane was opened for: client
 *        DML granted before, none after, service_role untouched.
 *   CT4  a table created AFTER 3504 still carries the client grants — 3504
 *        does not alter the table default ACL, which is why it must run after
 *        2810 and why its header names that as out of reach.
 *   CT5  3504's postcondition raises over a client grant left behind, for each
 *        client grantee.
 *   CT6  3504's precondition refuses a target that has acquired a permissive
 *        RLS policy, and a restrictive one does not trip it.
 *   CT7  3504's postcondition refuses a sweep over no present tables.
 *   CT8  each of 3504's other postconditions raises over its own broken claim.
 *   CT9  the ten deliberately excluded tables are not touched: their ACLs are
 *        byte-identical before and after the body.
 *   CTA  3504 is idempotent: its body runs twice in one transaction.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3504_client_table_privilege_boundary.sql");

/** 3504's statements without its own BEGIN … COMMIT, so a test can run them inside its transaction. */
function body(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, "3504: no BEGIN … COMMIT wrapper");
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n";
}

/** 3504's postcondition block alone (the last DO $$ … $$; in the file). */
function postcondition(): string {
  const b = body();
  const at = b.lastIndexOf("DO $$");
  assert.ok(at >= 0, "3504: no postcondition block");
  return b.slice(at);
}

/** 3504's precondition block alone (the FIRST DO $$ … $$; in the file). */
function precondition(): string {
  const b = body();
  const at = b.indexOf("DO $$");
  assert.ok(at >= 0, "3504: no precondition block");
  const end = b.indexOf("END $$;", at);
  assert.ok(end > at, "3504: precondition block is not terminated");
  return b.slice(at, end + "END $$;".length) + "\n";
}

/** Everything up to and including the target list, so a test can read _p3504_targets without revoking. */
function targetsOnly(): string {
  const b = body();
  const at = b.indexOf("DO $$");
  assert.ok(at >= 0, "3504: no DO block after the target list");
  return b.slice(0, at);
}

/** The 53 names, read out of the migration rather than restated here. */
function targets(): string[] {
  const list = targetsOnly();
  const names = [...list.matchAll(/^\s*\('([a-z0-9_]+)'\)/gm)].map((m) => m[1]!);
  assert.ok(names.length === 53, `3504: expected 53 named targets, parsed ${names.length}`);
  return names;
}

/** The tables 3504's header deliberately excludes; CT9 proves it leaves them alone. */
const EXCLUDED = [
  "memory_events", "memory_feedback", "memory_policy", "memory_projections",
  "portava_featured", "generated_visuals", "rent_buddy_review_notes",
  "user_recent_places", "compass_analytics", "user_trust_scores",
];

/** Supabase's pre-3504 posture on one table, as its default ACL issues it. */
function pre3504(table: string): string {
  return `GRANT SELECT, INSERT, UPDATE, DELETE ON public.${table} TO anon, authenticated;\n`;
}

/** Run a script in one transaction that always rolls back; return psql's status, stdout and stderr. */
function inRolledBackTx(script: string) {
  return psql(`BEGIN;\n${script}\nROLLBACK;\n`);
}

/** Named targets that exist on this database. */
function presentTargets(): string[] {
  const all = targets();
  const r = rows<{ rel: string }>(`
    SELECT t.rel FROM (VALUES ${all.map((n) => `('${n}')`).join(",")}) AS t(rel)
     WHERE to_regclass('public.' || t.rel) IS NOT NULL
     ORDER BY t.rel`);
  return r.map((x) => x.rel);
}

/** One target that exists on every replayed chain, for the single-table properties. */
function aTarget(): string {
  const present = presentTargets();
  assert.ok(present.length >= 45, `only ${present.length} of 53 targets exist: the harness did not replay the chain`);
  return present[0]!;
}

describe("3504: client roles hold no DML on 53 service-role-only tables (census: database privilege boundary)", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  it("CT0: 3504 is in force on the replayed chain", () => {
    const names = targets();
    const offending = rows<{ rel: string; grantee: string; privilege_type: string }>(`
      SELECT t.rel, pg_get_userbyid(x.grantee) AS grantee, x.privilege_type
        FROM (VALUES ${names.map((n) => `('${n}')`).join(",")}) AS t(rel)
        JOIN pg_class c ON c.oid = to_regclass('public.' || t.rel)
        CROSS JOIN LATERAL aclexplode(c.relacl) x
       WHERE x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon','authenticated')
       ORDER BY 1, 2, 3`);
    assert.deepEqual(offending, [], "a named table still grants a client role or PUBLIC something");
    const present = presentTargets();
    assert.ok(present.length >= 45, `only ${present.length} of ${names.length} targets present: a sweep over nothing proves nothing`);
  });

  it("CT1: over the pre-3504 grants a client role reads and writes a target; after 3504 every verb is refused", () => {
    const t = aTarget();
    for (const role of ["anon", "authenticated"]) {
      // The hole, open: the default ACL's grants restored, then the client role reads.
      // With RLS on and zero policies this SUCCEEDS and returns no rows — which is
      // exactly the posture 3504 replaces with a refusal.
      const open = inRolledBackTx(`${pre3504(t)}
SET LOCAL ROLE ${role};
SELECT 'SELECTED=' || count(*) FROM public.${t};`);
      assert.equal(open.status, 0, `${role} on the pre-3504 posture: ${open.stderr}`);
      assert.match(open.stdout, /SELECTED=\d+/, `${role} could not select before 3504, so this property proves nothing`);

      // The hole, closed: same posture, then 3504's body, then every verb is refused.
      const verbs = [
        `SELECT count(*) FROM public.${t}`,
        `DELETE FROM public.${t} WHERE false`,
      ];
      for (const verb of verbs) {
        const shut = inRolledBackTx(`${pre3504(t)}
${body()}
SET LOCAL ROLE ${role};
${verb};`);
        assert.notEqual(shut.status, 0, `${role} ran "${verb}" after 3504`);
        assert.match(shut.stderr, new RegExp(`permission denied for table ${t}`), `${role} ${verb}: ${shut.stderr}`);
      }
    }
  });

  it("CT2: service_role keeps all four DML privileges on every present target after 3504", () => {
    const present = presentTargets();
    const grantBack = present.map((n) => pre3504(n)).join("");
    const probe = `SELECT 'MISSING=' || coalesce(string_agg(t.rel, ',' ORDER BY t.rel), '')
  FROM (VALUES ${present.map((n) => `('${n}')`).join(",")}) AS t(rel)
 WHERE NOT (has_table_privilege('service_role', to_regclass('public.' || t.rel), 'SELECT')
        AND has_table_privilege('service_role', to_regclass('public.' || t.rel), 'INSERT')
        AND has_table_privilege('service_role', to_regclass('public.' || t.rel), 'UPDATE')
        AND has_table_privilege('service_role', to_regclass('public.' || t.rel), 'DELETE'));`;
    const out = inRolledBackTx(`${grantBack}${body()}\n${probe}`);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^MISSING=$/m, `service_role lost a DML privilege: ${out.stdout}`);
  });

  it("CT3: telegraph_outbox grants client DML before 3504 and none after; service_role keeps it", () => {
    const present = rows<{ ok: boolean }>(`SELECT to_regclass('public.telegraph_outbox') IS NOT NULL AS ok`)[0]!.ok;
    assert.ok(present, "2810's telegraph_outbox is absent: the harness did not replay the chain through 2810");
    const probe = `SELECT 'ANON=' || has_table_privilege('anon', 'public.telegraph_outbox', 'SELECT,INSERT,UPDATE,DELETE')
    || ' AUTH=' || has_table_privilege('authenticated', 'public.telegraph_outbox', 'SELECT,INSERT,UPDATE,DELETE')
    || ' SVC=' || (has_table_privilege('service_role', 'public.telegraph_outbox', 'SELECT')
               AND has_table_privilege('service_role', 'public.telegraph_outbox', 'INSERT')
               AND has_table_privilege('service_role', 'public.telegraph_outbox', 'UPDATE')
               AND has_table_privilege('service_role', 'public.telegraph_outbox', 'DELETE'));`;
    const before = inRolledBackTx(`${pre3504("telegraph_outbox")}${probe}`);
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /ANON=true AUTH=true SVC=true/);
    const after = inRolledBackTx(`${pre3504("telegraph_outbox")}${body()}\n${probe}`);
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /ANON=false AUTH=false SVC=true/);
  });

  it("CT4: a table created after 3504 still carries the client grants, which is why order matters", () => {
    // 3504 deliberately does NOT alter the table default ACL (its header says so
    // and why). This property pins that choice: if someone adds an
    // ALTER DEFAULT PRIVILEGES … REVOKE … ON TABLES here, this goes red and the
    // header has to be rewritten rather than quietly contradicted.
    const out = inRolledBackTx(`${body()}
CREATE TABLE public.zz_3504_probe (id int);
SELECT 'ANON=' || has_table_privilege('anon', 'public.zz_3504_probe', 'SELECT,INSERT,UPDATE,DELETE')
    || ' AUTH=' || has_table_privilege('authenticated', 'public.zz_3504_probe', 'SELECT,INSERT,UPDATE,DELETE');`);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /ANON=true AUTH=true/, "the table default ACL no longer issues client DML: 3504's header must be updated");
  });

  it("CT5: 3504's postcondition raises over a client grant left behind, for each client grantee", () => {
    const t = aTarget();
    for (const grantee of ["anon", "authenticated", "PUBLIC"]) {
      const out = inRolledBackTx(`${body()}
GRANT SELECT ON public.${t} TO ${grantee};
${postcondition()}`);
      assert.notEqual(out.status, 0, `the postcondition passed over a table grant to ${grantee}`);
      assert.match(out.stderr, /3504 postcondition FAILED/, `${grantee}: ${out.stderr}`);
    }
  });

  it("CT6: 3504's precondition refuses a target with a permissive policy, and ignores a restrictive one", () => {
    const t = aTarget();
    // The precondition ALONE, so this cannot be satisfied by a later block
    // raising, and `ERROR:` rather than a bare match, so downgrading the
    // RAISE EXCEPTION to a NOTICE (whose text psql also writes to stderr)
    // fails this property instead of passing it.
    const permissive = inRolledBackTx(`
CREATE POLICY zz_3504_permissive ON public.${t} FOR SELECT TO authenticated USING (true);
${targetsOnly()}
${precondition()}`);
    assert.notEqual(permissive.status, 0, "3504's precondition allowed a target with a permissive policy");
    assert.match(permissive.stderr, /ERROR:\s+3504 PRECONDITION FAILED/, permissive.stderr);
    assert.match(permissive.stderr, new RegExp(t), `the precondition did not name ${t}: ${permissive.stderr}`);

    // And the whole body refuses, so the revoke never runs behind that policy.
    const whole = inRolledBackTx(`
CREATE POLICY zz_3504_permissive ON public.${t} FOR SELECT TO authenticated USING (true);
${body()}`);
    assert.notEqual(whole.status, 0, "3504 revoked the privilege behind a permissive policy");

    const restrictive = inRolledBackTx(`
CREATE POLICY zz_3504_restrictive ON public.${t} AS RESTRICTIVE FOR SELECT TO authenticated USING (false);
${body()}`);
    assert.equal(restrictive.status, 0, `a restrictive policy tripped the precondition: ${restrictive.stderr}`);
  });

  it("CT7: 3504's postcondition refuses a sweep over no present tables", () => {
    const out = inRolledBackTx(`${body()}
DELETE FROM _p3504_targets;
${postcondition()}`);
    assert.notEqual(out.status, 0, "the postcondition reported success over an empty sweep");
    assert.match(out.stderr, /3504 postcondition VACUOUS/, out.stderr);
  });

  it("CT8: each of 3504's other postconditions raises over its own broken claim", () => {
    const t = aTarget();
    const cases: Array<[string, string, RegExp]> = [
      ["service_role loses a DML privilege on a target",
       `REVOKE UPDATE ON public.${t} FROM service_role;`,
       /service_role lacks one of SELECT\/INSERT\/UPDATE\/DELETE/],
      ["a target acquires a permissive policy after the revoke",
       `CREATE POLICY zz_3504_late ON public.${t} FOR SELECT TO anon USING (true);`,
       /carries a permissive RLS policy whose client surface/],
    ];
    for (const [what, breakIt, expected] of cases) {
      const out = inRolledBackTx(`${body()}\n${breakIt}\n${postcondition()}`);
      assert.notEqual(out.status, 0, `the postcondition passed although ${what}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }
  });

  it("CT9: the ten deliberately excluded tables are not touched", () => {
    const excluded = rows<{ rel: string }>(`
      SELECT t.rel FROM (VALUES ${EXCLUDED.map((n) => `('${n}')`).join(",")}) AS t(rel)
       WHERE to_regclass('public.' || t.rel) IS NOT NULL ORDER BY t.rel`).map((x) => x.rel);
    assert.ok(excluded.length >= 8, `only ${excluded.length} of the excluded tables exist: the harness did not replay the chain`);
    for (const name of EXCLUDED) {
      assert.ok(!targets().includes(name), `${name} is both excluded in this test and named in 3504's list`);
    }
    const probe = `SELECT t.rel || '=' || coalesce(array_to_string(c.relacl, ','), '(default)')
  FROM (VALUES ${excluded.map((n) => `('${n}')`).join(",")}) AS t(rel)
  JOIN pg_class c ON c.oid = to_regclass('public.' || t.rel)
 ORDER BY t.rel;`;
    const before = inRolledBackTx(probe);
    const after = inRolledBackTx(`${body()}\n${probe}`);
    assert.equal(before.status, 0, before.stderr);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, before.stdout, "3504 changed the ACL of a table its header excludes");
  });

  it("CTA: 3504 is idempotent", () => {
    const out = inRolledBackTx(`${pre3504(aTarget())}${body()}\n${body()}`);
    assert.equal(out.status, 0, out.stderr);
    exec("SELECT 1;");
  });
});
