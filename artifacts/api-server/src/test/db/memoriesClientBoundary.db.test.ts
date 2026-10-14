/**
 * memoriesClientBoundary — verifier V-716 fix 2 / owner question OQ-716-1
 * (census-highlights-memories §BJ): migration 3813 and its rollback, executed
 * against real PostgreSQL on the chain CI's local-db job replays.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/memoriesClientBoundary.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *      NOT RUN ON THE AUTHORING MACHINE, which has no PostgreSQL: the same
 *      properties were executed there on PGlite (PG 17) over a fixture of the
 *      touched objects, red without 3813 and green with it (lane report).
 *
 * THE DEFECT: the baseline's GRANT ALL on public.memories to anon and
 * authenticated, with memories_public_read (any signed-in non-owner reads every
 * column of a published public Memory) and memories_owner_all (the owner writes
 * every column of their own rows). Through PostgREST — `SET LOCAL ROLE` plus the
 * JWT GUCs auth.uid() reads, modelled here as in postsReleaseTimingColumns —
 * a stranger read exact coordinates, place references and the owner's audience
 * lists past every rule the API applies, and an owner wrote what the API derives.
 *
 * PROPERTIES
 *   M0  3813 is in force: no client or PUBLIC ACL entry, table or column; no
 *       effective privilege; service_role keeps its four DML verbs; RLS and both
 *       baseline policies unchanged.
 *   M1  the read door is shut: a stranger, the owner's own client key and anon
 *       are refused every shape of read (columns, `*`, a filter, a count); the
 *       API's role reads the row.
 *   M2  the write door is shut: the owner cannot un-remove a moderated Memory,
 *       set a precision rung, insert, or hard-delete — and nothing changed.
 *   M3  the policies on other tables that read memories as the invoking role now
 *       fail closed (42501), and the API's role still reads those tables.
 *   M4  the postcondition passes alone on the committed database (certify
 *       stage 4), and the precondition accepts this chain as it is — its
 *       function and view checks find nothing real to refuse — and names the
 *       dependent policies 3813's header lists.
 *   M5  the rollback restores 2490's four privileges for both client roles and
 *       nothing more, and clears the ledger row; 3813 re-applied reproduces
 *       today's catalog; the database is left as found.
 *   M6  the precondition refuses what it says it refuses (a non-owner or
 *       grantable client privilege, a client-readable view, a client-callable
 *       SECURITY INVOKER function that reads memories) and accepts a definer
 *       function and the rollback's state.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, deleteUser, exec, psql, rows, scalar, seedUser } from "./localDb.js";
import { isAssertionOnlyDoBlock, isPreconditionDoBlock, topLevelStatements } from "../../scripts/lib/migrationSqlBlocks.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3813_memories_client_privileges_revoked.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-14-3813-memories-client-privileges-revoked-rollback.sql");

type Who = { role: "anon" } | { role: "authenticated"; uid: string };

let A = ""; // the owner
let S = ""; // a signed-in stranger
let PUB = ""; // A's published, public Memory with a place and exact coordinates
let RMV = ""; // A's Memory a moderator removed
let ITEM = ""; // a photo on PUB

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
function assertDenied(who: Who, sql: string, table = "memories"): void {
  const r = psql(prelude(who) + sql, { single: true });
  assert.notEqual(r.status, 0, `expected a refusal as ${who.role}, got success:\n${sql}\n${r.stdout}`);
  assert.match(r.stderr, new RegExp(`permission denied for table ${table}`), `expected a privilege refusal as ${who.role}:\n${sql}\n${r.stderr}`);
}
const asService = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });

/** The file's body and its trailing postconditions, without its BEGIN/COMMIT. */
function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}
const postconditions = (path: string) =>
  topLevelStatements(readFileSync(path, "utf8")).filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
function precondition(path: string): string {
  const pre = topLevelStatements(readFileSync(path, "utf8")).filter((s) => isPreconditionDoBlock(s));
  assert.equal(pre.length, 1);
  return pre[0]!;
}

/** memories' ACL (as sorted aclexplode tuples, so entry order cannot differ), policies and RLS. */
const SNAPSHOT = `SELECT json_build_object(
  'relacl', (SELECT json_agg(e ORDER BY e) FROM (
               SELECT format('%s=%s/%s%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
                             x.privilege_type, x.grantor::regrole::text, CASE WHEN x.is_grantable THEN '*' ELSE '' END) AS e
                 FROM pg_class c, LATERAL aclexplode(c.relacl) x WHERE c.oid = 'public.memories'::regclass) q),
  'attacl', (SELECT json_object_agg(attname, attacl::text ORDER BY attnum) FROM pg_attribute
              WHERE attrelid = 'public.memories'::regclass AND attnum > 0 AND NOT attisdropped AND attacl IS NOT NULL),
  'policies', (SELECT json_agg(json_build_array(polname, polcmd::text, pg_get_expr(polqual, polrelid)) ORDER BY polname)
                 FROM pg_policy WHERE polrelid = 'public.memories'::regclass),
  'rls', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memories'::regclass)
)::text;`;
const snaps = (out: string[]) => out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const clientEntries = (snap: { relacl: string[] | null }) =>
  (snap.relacl ?? []).filter((e) => /^(anon|authenticated|PUBLIC)=/.test(e)).sort();

describe("V-716 fix 2 — 3813: public.memories refuses every client role", { skip: !HAVE_DB }, () => {
  before(() => {
    A = seedUser("memacl_owner");
    S = seedUser("memacl_stranger");
    PUB = randomUUID();
    RMV = randomUUID();
    ITEM = randomUUID();
    exec(`INSERT INTO public.memories (id, owner_id, title, visibility, state, place_id, canonical_location_id,
                                       location_lat, location_lng, location_precision, hidden_user_ids)
            VALUES ('${PUB}', '${A}', 'memacl public', 'public', 'published', 'fsq:memacl-ramen', '${randomUUID()}',
                    35.6812345, 139.7671234, 'city', ARRAY['${S}'::uuid]),
                   ('${RMV}', '${A}', 'memacl removed', 'public', 'removed', NULL, NULL, NULL, NULL, 'exact', '{}');
          INSERT INTO public.memory_items (id, memory_id, media_url) VALUES ('${ITEM}', '${PUB}', 'https://example.test/memacl.jpg');`);
  });

  after(() => {
    if (!A) return;
    exec(`DELETE FROM public.memories WHERE owner_id IN ('${A}', '${S}');`);
    for (const u of [A, S]) if (u) deleteUser(u);
  });

  it("M0 — 3813 is in force: no client or PUBLIC privilege, table or column, effective or written; service_role keeps its DML; RLS and policies unchanged", () => {
    assert.deepEqual(clientEntries(JSON.parse(exec(SNAPSHOT)[0]!)), []);
    assert.equal(
      scalar(`SELECT count(*) FROM pg_attribute a, LATERAL aclexplode(a.attacl) x
               WHERE a.attrelid = 'public.memories'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
                 AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))`),
      "0",
    );
    for (const r of ["anon", "authenticated"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${r}', 'public.memories', '${p}')::text`), "false", `${r} ${p}`);
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        assert.equal(scalar(`SELECT has_any_column_privilege('${r}', 'public.memories', '${p}')::text`), "false", `${r} column ${p}`);
      }
    }
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      assert.equal(scalar(`SELECT has_table_privilege('service_role', 'public.memories', '${p}')::text`), "true", `service_role ${p}`);
    }
    assert.equal(scalar(`SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.memories'::regclass`), "true");
    assert.deepEqual(
      rows<{ polname: string }>(`SELECT polname FROM pg_policy WHERE polrelid = 'public.memories'::regclass ORDER BY polname`).map((r) => r.polname),
      ["memories_owner_all", "memories_public_read"],
    );
  });

  it("M1 — the read door is shut: a stranger, the owner's own key and anon are refused every shape of read; the API's role reads it", () => {
    const WHO: Who[] = [{ role: "authenticated", uid: S }, { role: "authenticated", uid: A }, { role: "anon" }];
    for (const who of WHO) {
      assertDenied(who, `SELECT place_id, canonical_location_id, location_lat, location_lng, location_precision FROM public.memories WHERE id = '${PUB}';`);
      assertDenied(who, `SELECT allowed_user_ids, hidden_user_ids FROM public.memories WHERE id = '${PUB}';`);
      assertDenied(who, `SELECT * FROM public.memories WHERE id = '${PUB}';`);
      assertDenied(who, `SELECT id FROM public.memories WHERE location_lat > 35 AND id = '${PUB}';`);
      assertDenied(who, `SELECT count(*) FROM public.memories;`);
    }
    // Anti-vacuity: the row really carries what the door used to give away, and the API's role reads it.
    assert.deepEqual(
      asService(`SELECT place_id || '|' || location_precision || '|' || (location_lat IS NOT NULL)::text FROM public.memories WHERE id = '${PUB}';`),
      ["fsq:memacl-ramen|city|true"],
    );
  });

  it("M2 — the write door is shut: the owner cannot un-remove, set a rung, insert or hard-delete — and nothing changed", () => {
    const owner: Who = { role: "authenticated", uid: A };
    assertDenied(owner, `UPDATE public.memories SET state = 'published' WHERE id = '${RMV}';`);
    assertDenied(owner, `UPDATE public.memories SET location_precision = 'exact', place_id = 'fsq:elsewhere' WHERE id = '${PUB}';`);
    assertDenied(owner, `INSERT INTO public.memories (owner_id, title, visibility, state) VALUES ('${A}', 'direct', 'public', 'published');`);
    assertDenied(owner, `DELETE FROM public.memories WHERE id = '${PUB}';`);
    assert.deepEqual(
      rows(`SELECT id::text, state, location_precision, place_id FROM public.memories WHERE owner_id = '${A}' ORDER BY title DESC`),
      [
        { id: RMV, state: "removed", location_precision: "exact", place_id: null },
        { id: PUB, state: "published", location_precision: "city", place_id: "fsq:memacl-ramen" },
      ],
    );
  });

  it("M3 — policies that read memories as the invoking role now fail closed (42501), and the API's role still reads those tables", () => {
    assertDenied({ role: "authenticated", uid: S }, `SELECT media_url FROM public.memory_items WHERE memory_id = '${PUB}';`);
    assertDenied({ role: "authenticated", uid: S }, `SELECT count(*) FROM public.memory_likes WHERE memory_id = '${PUB}';`);
    assertDenied({ role: "authenticated", uid: S }, `SELECT count(*) FROM public.memory_tags WHERE memory_id = '${PUB}';`);
    assertDenied({ role: "authenticated", uid: A }, `SELECT count(*) FROM public.memory_domain_events WHERE memory_id = '${PUB}';`);
    assert.deepEqual(asService(`SELECT media_url FROM public.memory_items WHERE id = '${ITEM}';`), ["https://example.test/memacl.jpg"]);
  });

  it("M4 — the postcondition passes alone; the precondition accepts this chain and names the dependent policies", () => {
    const post = postconditions(MIGRATION);
    assert.equal(post.length, 1);
    exec(post[0]!);
    const r = psql(`BEGIN;\n${precondition(MIGRATION)}\nROLLBACK;`);
    assert.equal(r.status, 0, `the precondition refuses the chain as it is:\n${r.stderr}`);
    const notice = /3813: policies on other tables that read public\.memories as the invoking role: ([^\n]*)/.exec(r.stderr);
    assert.ok(notice, `no NOTICE:\n${r.stderr}`);
    const named = notice[1]!.split(", ").map((s) => s.trim()).sort();
    for (const p of [
      "memory_domain_events.memory_domain_events_owner_select",
      "memory_items.memory_items_public_read",
      "memory_items.memory_items_via_memory",
      "memory_likes.memory_likes_read",
      "memory_tags.memory_tags_owner_delete",
      "memory_tags.memory_tags_owner_insert",
      "memory_tags.memory_tags_owner_read",
    ]) {
      assert.ok(named.includes(p), `3813's header lists ${p}; the catalog does not: ${named.join(", ")}`);
    }
  });

  it("M5 — the rollback restores 2490's four privileges and nothing more, clears the ledger row; 3813 re-applied is today's catalog", () => {
    const out = exec(`BEGIN;\n${SNAPSHOT}\n${unwrapped(ROLLBACK)}\n${SNAPSHOT}\n${unwrapped(MIGRATION)}\n${SNAPSHOT}\nROLLBACK;`);
    const [now, rolled, reapplied] = snaps(out);
    assert.ok(now && rolled && reapplied, "three snapshots");
    const owner = scalar(`SELECT relowner::regrole::text FROM pg_class WHERE oid = 'public.memories'::regclass`);
    assert.deepEqual(
      clientEntries(rolled),
      ["anon", "authenticated"].flatMap((r) => ["DELETE", "INSERT", "SELECT", "UPDATE"].map((p) => `${r}=${p}/${owner}`)).sort(),
      "exactly SELECT, INSERT, UPDATE, DELETE for both client roles — never TRUNCATE/REFERENCES/TRIGGER",
    );
    assert.deepEqual(rolled.policies, now.policies, "no policy changes");
    assert.equal(rolled.rls, true);
    assert.deepEqual(reapplied, now, "3813 after its rollback is the state 3813 left");
    assert.deepEqual(JSON.parse(exec(SNAPSHOT)[0]!), now, "the test left the database as it found it");
    const led = exec(`BEGIN;
      INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes)
        VALUES ('3813_memories_client_privileges_revoked.sql', 'test', 'manual', 'memoriesClientBoundary.db.test.ts')
        ON CONFLICT (filename) DO NOTHING;
      SELECT 'ledger-before=' || count(*) FROM public.schema_migration_ledger WHERE filename = '3813_memories_client_privileges_revoked.sql';
      ${unwrapped(ROLLBACK)}
      SELECT 'ledger-after=' || count(*) FROM public.schema_migration_ledger WHERE filename = '3813_memories_client_privileges_revoked.sql';
      ROLLBACK;`);
    assert.ok(led.includes("ledger-before=1"), "anti-vacuity: the ledger row is there before the rollback");
    assert.ok(led.includes("ledger-after=0"), "the rollback deletes 3813's ledger row");
  });

  it("M6 — the precondition refuses what it says it refuses, and accepts a definer function and the rollback's state", () => {
    const pre = precondition(MIGRATION);
    const tag = randomUUID().replace(/-/g, "").slice(0, 8);
    const refuse = (setup: string, why: RegExp) => {
      const r = psql(`BEGIN;\n${setup}\n${pre}\nROLLBACK;`);
      assert.notEqual(r.status, 0, `the precondition must refuse after: ${setup}`);
      assert.match(r.stderr, why);
    };
    const accept = (setup: string) => {
      const r = psql(`BEGIN;\n${setup}\n${pre}\nROLLBACK;`);
      assert.equal(r.status, 0, `the precondition must accept after: ${setup}\n${r.stderr}`);
    };
    refuse(`GRANT SELECT ON public.memories TO authenticated WITH GRANT OPTION;`, /with a grant option: authenticated:SELECT\+grant option/);
    refuse(
      `CREATE ROLE memacl_g_${tag};\nGRANT SELECT ON public.memories TO memacl_g_${tag} WITH GRANT OPTION;\nSET LOCAL ROLE memacl_g_${tag};\nGRANT SELECT (place_id) ON public.memories TO authenticated;\nRESET ROLE;`,
      new RegExp(`authenticated:SELECT by memacl_g_${tag}`),
    );
    refuse(
      `CREATE VIEW public.memacl_v_${tag} AS SELECT id, location_lat FROM public.memories;\nGRANT SELECT ON public.memacl_v_${tag} TO authenticated;`,
      // The local-db replica's default ACL hands anon the new view too, so the list may name both roles.
      new RegExp(`a view over public\\.memories is readable by a client role: .*memacl_v_${tag} \\(authenticated\\)`),
    );
    refuse(
      `CREATE FUNCTION public.memacl_f_${tag}() RETURNS bigint LANGUAGE sql SECURITY INVOKER AS $f$ SELECT count(*) FROM public.memories $f$;\nGRANT EXECUTE ON FUNCTION public.memacl_f_${tag}() TO authenticated;`,
      new RegExp(`SECURITY INVOKER function a client role may call reads public\\.memories: .*memacl_f_${tag}\\(\\)`),
    );
    accept(`CREATE FUNCTION public.memacl_d_${tag}() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $f$ SELECT count(*) FROM public.memories $f$;\nGRANT EXECUTE ON FUNCTION public.memacl_d_${tag}() TO authenticated;`);
    accept(unwrapped(ROLLBACK).replace(/DO \$post\$[\s\S]*END \$post\$;/, ""));
  });
});
