/**
 * postMediaWriteBoundary — census-media §44.18.3 (lane G1): migration 3365 and
 * its rollback, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/postMediaWriteBoundary.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT (census-media §44.15.1): production's ledger records 2158 as
 * `backfill`, but its grants are not in force. anon and authenticated hold
 * table-level INSERT and DELETE on post_media, and the owner-insert policy does
 * not pin processing_status, canonical_place_id or stamp_overlay. An owner can
 * insert their own media as 'ready', skipping processing, with a place id and a
 * stamp label, and other users read it. 2158 itself cannot be the fix after
 * 3363 (it re-grants table-level SELECT) and would widen production (it grants
 * UPDATE production's clients do not hold). 3365 is 2158's end state for
 * writes, intersected with what is held; SELECT is not touched.
 *
 * THE STARTING SHAPES (census-media §44.18.3)
 *   tree        2158 in force, 3363 applied — 3365 is a byte-identical no-op.
 *   production  2158 not in force (table-level INSERT, DELETE for anon and
 *               authenticated; no column write grants), 3363 applied — the
 *               order the approval step proposes. Rebuilt inside a
 *               rolled-back transaction.
 *
 * PROPERTIES (each seen red with the migration or rollback mutated; §44.18.4)
 *   G5-0  3365 is in force: anon writes nothing; authenticated has no
 *         table-level write and writes only 2158's descriptor columns; the
 *         comment carries the record.
 *   G5-1  on the production shape the owner's self-set 'ready' insert (with a
 *         place id and a stamp label) is admitted and read by another user —
 *         and after 3365 it is refused, while a plain descriptor insert still
 *         lands as pending/pending.
 *   G5-2  no server-owned column is client-writable, and nothing is widened:
 *         on the production shape UPDATE stays absent.
 *   G5-3  the service role still writes post_media in full.
 *   G5-4  SELECT and the policies are untouched on both shapes.
 *   G5-5  the rollback round-trips byte-identically on both shapes and deletes
 *         3365's ledger row; on the tree 3365 is a byte-identical no-op.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, scalar, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3365_post_media_write_boundary.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-09-27-3365-post-media-write-boundary-rollback.sql");
const LEDGER_NAME = "3365_post_media_write_boundary.sql";
const INSERT_OK = ["post_id", "user_id", "media_type", "storage_bucket", "storage_path", "public_url", "thumbnail_url",
  "thumbnail_storage_path", "mime_type", "file_size_bytes", "duration_seconds", "width", "height", "sort_order"];
const UPDATE_OK = INSERT_OK.filter((c) => c !== "post_id" && c !== "user_id");
const SERVER_OWNED = ["id", "processing_status", "moderation_status", "created_at", "updated_at", "stamp_overlay",
  "canonical_place_id", "phash", "dedup_processed", "feed_storage_path", "feed_url"];

let A = ""; // the owner
let V = ""; // another signed-in user
let POST = "";
let PLACE = "";

function as(uid: string | null): string {
  return uid === null
    ? `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.role', 'anon', true); END $p$;\nSET LOCAL ROLE anon;\n`
    : `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${uid}', true); PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\nSET LOCAL ROLE authenticated;\n`;
}

/** The file's body and its trailing postconditions, without its BEGIN/COMMIT. */
function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

/** Inside a transaction: post_media as production holds it (§44.15.1), with 3363 applied. */
const TO_PRODUCTION_SHAPE = () =>
  `${unwrapped(ROLLBACK)}
   REVOKE INSERT, UPDATE ON TABLE public.post_media FROM authenticated;
   GRANT INSERT, DELETE ON TABLE public.post_media TO anon;
   GRANT INSERT, DELETE ON TABLE public.post_media TO authenticated;\n`;

const SNAPSHOT = `SELECT json_build_object(
  'relacl', (SELECT relacl::text FROM pg_class WHERE oid = 'public.post_media'::regclass),
  'attacl', (SELECT coalesce(string_agg(attname || '=' || attacl::text, ';' ORDER BY attnum), '') FROM pg_attribute
              WHERE attrelid = 'public.post_media'::regclass AND attnum > 0 AND attacl IS NOT NULL),
  'comment', obj_description('public.post_media'::regclass, 'pg_class'),
  'policies', (SELECT json_agg(json_build_array(polname, polcmd::text, polpermissive, polroles::regrole[]::text,
                                                pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)) ORDER BY polname)
                 FROM pg_policy WHERE polrelid = 'public.post_media'::regclass),
  'select', (SELECT json_object_agg(r, (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.post_media'::regclass
                                          AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT')))
               FROM unnest(ARRAY['anon','authenticated']) r),
  'writes', (SELECT json_object_agg(r, json_build_object(
                'insert', (SELECT coalesce(json_agg(a.attname ORDER BY a.attnum), '[]') FROM pg_attribute a WHERE a.attrelid = 'public.post_media'::regclass
                             AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(r, a.attrelid, a.attnum, 'INSERT')),
                'update', (SELECT coalesce(json_agg(a.attname ORDER BY a.attnum), '[]') FROM pg_attribute a WHERE a.attrelid = 'public.post_media'::regclass
                             AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(r, a.attrelid, a.attnum, 'UPDATE')),
                'table', (SELECT coalesce(json_agg(p ORDER BY p), '[]') FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                            WHERE has_table_privilege(r, 'public.post_media', p))))
               FROM unnest(ARRAY['anon','authenticated']) r),
  'ledger', (SELECT count(*) FROM public.schema_migration_ledger WHERE filename = '${LEDGER_NAME}')
)::text;`;
const snaps = (out: string[]) => out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

/** The owner's self-set 'ready' insert, then what another user reads of it. Run inside a transaction. */
const selfReady = (tag: string) => `
  SAVEPOINT ${tag};
  ${as(A)}
  INSERT INTO public.post_media (post_id, user_id, media_type, mime_type, storage_path, processing_status, canonical_place_id, stamp_overlay)
  VALUES ('${POST}', '${A}', 'image', 'image/jpeg', '${A}/g5-ready-${tag}.jpg', 'ready', '${PLACE}', '{"label":"Forged Stamp"}'::jsonb);
  ${as(V)}
  SELECT '${tag}:seen-by-other=' || count(*) FROM public.post_media WHERE storage_path = '${A}/g5-ready-${tag}.jpg';
  RESET ROLE;
  RELEASE SAVEPOINT ${tag};`;

describe("census-media §44.18.3 — 3365: post_media's client writes, 2158's end state as a narrowing", { skip: !HAVE_DB }, () => {
  before(() => {
    A = seedUser("g5owner");
    V = seedUser("g5viewer");
    POST = randomUUID();
    PLACE = randomUUID();
    exec(`INSERT INTO public.places (id, name, normalized_name) VALUES ('${PLACE}', 'G5 Place', 'g5 place');
          INSERT INTO public.posts (id, author_id, content, visibility, status) VALUES ('${POST}', '${A}', 'g5 post', 'public', 'active');`);
  });

  after(() => {
    if (!A) return;
    exec(`DELETE FROM public.post_media WHERE user_id IN ('${A}', '${V}');
          DELETE FROM public.posts WHERE author_id IN ('${A}', '${V}');
          DELETE FROM public.places WHERE id = '${PLACE}';`);
    for (const u of [A, V]) if (u) deleteUser(u);
  });

  it("G5-0 — 3365 is in force: anon writes nothing, authenticated writes only 2158's descriptor columns", () => {
    const [now] = snaps(exec(SNAPSHOT));
    assert.deepEqual(now.writes.anon, { insert: [], update: [], table: [] }, "anon writes nothing");
    assert.deepEqual(now.writes.authenticated.table, [], "authenticated holds no table-level write");
    assert.deepEqual(now.writes.authenticated.insert, INSERT_OK, "authenticated inserts exactly 2158's 14 columns");
    assert.deepEqual(now.writes.authenticated.update, UPDATE_OK, "authenticated updates exactly 2158's 12 columns");
    assert.match(String(now.comment), /Column writes before 3365: \{.*\} ACL before 3365, which its rollback restores: \{[^}]*\}$/);
  });

  it("G5-1 — production shape: the self-set 'ready' insert is admitted and read by others; after 3365 it is refused", () => {
    // Before 3365 (the defect), inside a discarded transaction.
    const before = exec(`BEGIN;\n${TO_PRODUCTION_SHAPE()}\n${selfReady("pre")}\nROLLBACK;`);
    assert.ok(before.includes("pre:seen-by-other=1"), `production shape admits the self-set ready row:\n${before.join("\n")}`);
    // After 3365, on the same shape.
    const r = psql(`BEGIN;\n${TO_PRODUCTION_SHAPE()}\n${unwrapped(MIGRATION)}\n${selfReady("post")}\nROLLBACK;`);
    assert.notEqual(r.status, 0, "after 3365 the self-set ready insert must fail");
    assert.match(r.stderr, /permission denied for table post_media/);
    // …and the owner's plain descriptor insert still lands, as pending/pending.
    const plain = exec(`BEGIN;\n${TO_PRODUCTION_SHAPE()}\n${unwrapped(MIGRATION)}
      ${as(A)}
      INSERT INTO public.post_media (post_id, user_id, media_type, mime_type, storage_path)
      VALUES ('${POST}', '${A}', 'image', 'image/jpeg', '${A}/g5-plain.jpg')
      RETURNING 'plain=' || processing_status || '/' || moderation_status;
      ROLLBACK;`);
    assert.ok(plain.includes("plain=pending/pending"), plain.join("\n"));
  });

  it("G5-2 — no server-owned column is client-writable, and nothing is widened on the production shape", () => {
    const [tree] = snaps(exec(SNAPSHOT));
    const [pre, post] = snaps(exec(`BEGIN;\n${TO_PRODUCTION_SHAPE()}\n${SNAPSHOT}\n${unwrapped(MIGRATION)}\n${SNAPSHOT}\nROLLBACK;`));
    for (const s of [tree, post]) {
      for (const c of SERVER_OWNED) {
        assert.ok(!s.writes.authenticated.insert.includes(c) && !s.writes.authenticated.update.includes(c), `${c} is server-owned`);
      }
      assert.deepEqual(s.writes.authenticated.table, []);
      assert.deepEqual(s.writes.anon, { insert: [], update: [], table: [] });
    }
    assert.deepEqual(pre.writes.authenticated.update, [], "anti-vacuity: production's clients hold no UPDATE");
    assert.deepEqual(post.writes.authenticated.update, [], "3365 grants no UPDATE production did not hold (2158 would have granted 12)");
    assert.deepEqual(post.writes.authenticated.insert, INSERT_OK, "INSERT narrows from every column to 2158's 14");
    assert.deepEqual(pre.writes.authenticated.table, ["DELETE", "INSERT"], "anti-vacuity: the production shape is what the integrator read");
  });

  it("G5-3 — the service role still writes post_media in full", () => {
    const out = exec(`SET LOCAL ROLE service_role;
      INSERT INTO public.post_media (post_id, user_id, media_type, mime_type, storage_path, processing_status, moderation_status, canonical_place_id, feed_url)
      VALUES ('${POST}', '${A}', 'image', 'image/jpeg', '${A}/g5-svc.jpg', 'ready', 'approved', '${PLACE}', 'f');
      UPDATE public.post_media SET processing_status = 'failed' WHERE storage_path = '${A}/g5-svc.jpg';
      SELECT 'svc=' || processing_status || '/' || moderation_status || '/' || (canonical_place_id IS NOT NULL) FROM public.post_media WHERE storage_path = '${A}/g5-svc.jpg';
      DELETE FROM public.post_media WHERE storage_path = '${A}/g5-svc.jpg';
      SELECT 'left=' || count(*) FROM public.post_media WHERE storage_path = '${A}/g5-svc.jpg';`, { single: true });
    assert.deepEqual(out, ["svc=failed/approved/true", "left=0"]);
  });

  it("G5-4 — SELECT and the policies are untouched on both shapes", () => {
    const [treeNow, treeRolled] = snaps(exec(`BEGIN;\n${SNAPSHOT}\n${unwrapped(ROLLBACK)}\n${SNAPSHOT}\nROLLBACK;`));
    assert.deepEqual(treeRolled.select, treeNow.select);
    assert.deepEqual(treeNow.select, { anon: 23, authenticated: 23 }, "3363's 23 readable columns");
    assert.deepEqual(treeRolled.policies, treeNow.policies);
    const [pre, post] = snaps(exec(`BEGIN;\n${TO_PRODUCTION_SHAPE()}\n${SNAPSHOT}\n${unwrapped(MIGRATION)}\n${SNAPSHOT}\nROLLBACK;`));
    assert.deepEqual(post.select, pre.select, "production shape: 3365 changes no SELECT");
    assert.deepEqual(post.policies, pre.policies);
    assert.equal(treeNow.policies.length, 5, "post_media keeps its five policies");
    assert.equal(scalar(`SELECT count(*) FROM public.post_media WHERE post_id = '${POST}'`), "0");
  });

  it("G5-5 — the rollback round-trips byte-identically on both shapes and deletes the ledger row; on the tree 3365 is a no-op", () => {
    const [now, rolled, reapplied] = snaps(exec(`BEGIN;
      INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes)
        VALUES ('${LEDGER_NAME}', 'test', 'manual', 'postMediaWriteBoundary.db.test.ts') ON CONFLICT (filename) DO NOTHING;
      ${SNAPSHOT}
      ${unwrapped(ROLLBACK)}
      ${SNAPSHOT}
      ${unwrapped(MIGRATION)}
      ${SNAPSHOT}
      ROLLBACK;`));
    assert.equal(now.ledger, 1, "anti-vacuity: the ledger row is there");
    assert.equal(rolled.ledger, 0, "the rollback deletes 3365's ledger row");
    const recorded = String(now.comment).match(/ACL before 3365, which its rollback restores: (\{[^}]*\})$/)![1];
    assert.equal(rolled.relacl, recorded, "tree: the recorded ACL, byte for byte");
    assert.equal(rolled.relacl, now.relacl, "tree: 3365 changed no table ACL");
    assert.equal(rolled.attacl, now.attacl, "tree: 3365 changed no column ACL — a byte-identical no-op");
    assert.equal(rolled.comment, null);
    assert.deepEqual(reapplied, { ...now, ledger: 0 }, "3365 after its rollback is the state 3365 left");

    const [pre, applied, back] = snaps(exec(`BEGIN;
      ${TO_PRODUCTION_SHAPE()}
      ${SNAPSHOT}
      ${unwrapped(MIGRATION)}
      ${SNAPSHOT}
      ${unwrapped(ROLLBACK)}
      ${SNAPSHOT}
      ROLLBACK;`));
    assert.notEqual(applied.relacl, pre.relacl, "anti-vacuity: on the production shape 3365 changes the ACL");
    assert.equal(back.relacl, pre.relacl, "production shape: the table ACL comes back byte for byte");
    assert.equal(back.attacl, pre.attacl, "production shape: the column ACLs come back byte for byte");
    assert.equal(back.comment, pre.comment);
    assert.deepEqual(back.writes, pre.writes);
    assert.deepEqual(snaps(exec(SNAPSHOT))[0], { ...now, ledger: 0 }, "the database is untouched by this test");
  });
});
