/**
 * undeclaredObjectsCodified4001And4002 — migrations 4001 (production's chunked-upload store) and 4002 (production's
 * deletion execution lease), codified on the owner's 2026-11-04 decision, executed against real PostgreSQL
 * (CI's postgis/postgis:16-3.4 service, scripts/local-db/up.sh).
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/undeclaredObjectsCodified4001And4002.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every src/test/db suite;
 *      scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE STARTING SHAPES
 *   production                  every object exists (written by code outside this tree); both files must change nothing.
 *   portava-ci / this harness   the 2026-08-19 baseline and the chain from 0001 carry none of them, so 4001 and 4002
 *                               are what creates them here. Production's shape is what the replayed chain holds AFTER
 *                               they ran; portava-ci's pre-apply shape is rebuilt inside a rolled-back transaction.
 *
 * PROPERTIES
 *   U0  on the replayed chain, both files' own postconditions hold: every object present, the function's
 *       pg_get_functiondef digest is production's (016ffeae860d57898841514512beabb1), privileges are production's.
 *   U1  re-running both bodies on that shape is a no-op: every table, index, constraint and function keeps its oid,
 *       and the definition fingerprint (columns, defaults, constraints, indexes, RLS, client privileges, function
 *       text, settings and ACL) is unchanged.
 *   U2  on portava-ci's shape (the objects dropped) both bodies create them and the postconditions then hold.
 *   U3  the commit function behaves as production's: the first chunk is accepted and advances the offset, an
 *       identical re-send is a replay, a chunk past total_bytes is invalid, and a stranger's call is invalid.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(__dir, "../../migrations");

function split(filename: string): { body: string; postconditions: string } {
  const file = readFileSync(resolve(MIGRATIONS, filename), "utf8");
  const b = file.indexOf("\nBEGIN;\n");
  const c = file.indexOf("\nCOMMIT;\n");
  assert.ok(b >= 0 && c > b, `${filename} is BEGIN … COMMIT with a postcondition tail`);
  return { body: file.slice(b + "\nBEGIN;\n".length, c), postconditions: file.slice(c + "\nCOMMIT;\n".length) };
}
const M4001 = split("4001_media_upload_store_codified.sql");
const M4002 = split("4002_user_deletion_execution_lease_codified.sql");
const BODIES = `${M4001.body}\n${M4002.body}`;
const POSTCONDITIONS = `${M4001.postconditions}\n${M4002.postconditions}`;

const FN = "public.commit_media_upload_chunk(uuid, uuid, bigint, integer, text, text)";
const TABLES = ["media_upload_sessions", "media_upload_chunks", "media_assets", "user_deletion_requests"];

/** Object identity (oids) and a definition fingerprint, one row each, for everything 4001 and 4002 touch. */
const CATALOG = `
  SELECT 'class:' || c.relname || '@' || c.oid FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND (c.relname IN (${TABLES.map((t) => `'${t}'`).join(", ")})
          OR c.relname IN ('media_upload_sessions_expiry_idx', 'media_upload_sessions_owner_idx',
                           'user_deletion_requests_execution_lease_idx'))
  UNION ALL SELECT 'constraint:' || k.conname || '@' || k.oid FROM pg_constraint k
   WHERE k.conrelid IN (${TABLES.map((t) => `'public.${t}'::regclass`).join(", ")})
  UNION ALL SELECT 'proc:commit_media_upload_chunk@' || p.oid FROM pg_proc p WHERE p.oid = to_regprocedure('${FN}')
  UNION ALL SELECT 'fingerprint:' || md5(concat_ws('|',
    (SELECT string_agg(c.relname || ':' || c.relrowsecurity::text || ':' ||
            coalesce((SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
                                        || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attnum)
                        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                       WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '') || ':' ||
            coalesce((SELECT string_agg(k.conname || '=' || pg_get_constraintdef(k.oid), ',' ORDER BY k.conname)
                        FROM pg_constraint k WHERE k.conrelid = c.oid), '') || ':' ||
            coalesce((SELECT string_agg(pg_get_indexdef(i.indexrelid), ',' ORDER BY pg_get_indexdef(i.indexrelid))
                        FROM pg_index i WHERE i.indrelid = c.oid), '') || ':' ||
            has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')::text || ':' ||
            has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')::text || ':' ||
            has_table_privilege('service_role', c.oid, 'SELECT, INSERT, UPDATE, DELETE')::text,
            ';' ORDER BY c.relname)
       FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${TABLES.map((t) => `'${t}'`).join(", ")})),
    (SELECT md5(pg_get_functiondef(p.oid)) || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || coalesce(p.proacl::text, '')
       FROM pg_proc p WHERE p.oid = to_regprocedure('${FN}'))))
  ORDER BY 1`;

/** portava-ci's pre-apply shape: none of the objects exist. */
const PORTAVA_CI_SHAPE = `
  DROP FUNCTION ${FN};
  DROP TABLE public.media_upload_chunks;
  DROP TABLE public.media_upload_sessions;
  ALTER TABLE public.media_assets DROP COLUMN hls_path, DROP COLUMN subtitle_paths, DROP COLUMN subtitle_processing_status;
  ALTER TABLE public.user_deletion_requests DROP CONSTRAINT user_deletion_requests_execution_claim_check;
  DROP INDEX public.user_deletion_requests_execution_lease_idx;
  ALTER TABLE public.user_deletion_requests DROP COLUMN execution_token, DROP COLUMN execution_started_at, DROP COLUMN execution_lease_expires_at;`;

const PRESENT = `
  SELECT 'present=' || (to_regclass('public.media_upload_sessions') IS NOT NULL)::text
    || ',' || (to_regclass('public.media_upload_chunks') IS NOT NULL)::text
    || ',' || (to_regprocedure('${FN}') IS NOT NULL)::text
    || ',' || (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media_assets'
                 AND column_name IN ('hls_path', 'subtitle_paths', 'subtitle_processing_status'))::text
    || ',' || (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_deletion_requests'
                 AND column_name IN ('execution_token', 'execution_started_at', 'execution_lease_expires_at'))::text;`;

let OWNER = "";
let STRANGER = "";

describe("4001 + 4002 — production's chunked-upload store and deletion execution lease, codified", { skip: !HAVE_DB }, () => {
  before(() => {
    OWNER = seedUser("u4001owner");
    STRANGER = seedUser("u4001stranger");
  });

  after(() => {
    if (OWNER) deleteUser(OWNER);
    if (STRANGER) deleteUser(STRANGER);
  });

  it("U0 — on the replayed chain both files' postconditions hold (objects, production's function digest, production's privileges)", () => {
    exec(POSTCONDITIONS);
  });

  it("U1 — re-running both bodies on that shape keeps every oid and the definition fingerprint (a no-op, as on production)", () => {
    const out = exec(`BEGIN;\n${CATALOG};\nSELECT '---';\n${BODIES}\n${CATALOG};\nROLLBACK;`);
    const sep = out.indexOf("---");
    assert.ok(sep > 0, out.join("\n"));
    assert.ok(sep >= 20, `anti-vacuity: the snapshot read the objects (${sep} rows)`);
    assert.ok(out.slice(0, sep).some((l) => l.startsWith("proc:")), "the function was in the snapshot");
    assert.deepEqual(out.slice(sep + 1), out.slice(0, sep), "no oid changed and the fingerprint is identical");
  });

  it("U2 — on portava-ci's shape both bodies create the objects and the postconditions then hold", () => {
    const out = exec(`BEGIN;\n${PORTAVA_CI_SHAPE}\n${PRESENT}\n${BODIES}\n${POSTCONDITIONS}\n${PRESENT}\nROLLBACK;`);
    assert.deepEqual(out.filter((l) => l.startsWith("present=")), ["present=false,false,false,0,0", "present=true,true,true,3,3"]);
  });

  it("U3 — the commit function: accepted, replay, invalid past the end, invalid for a stranger", () => {
    const session = "00000000-0000-4000-a000-0000000400a1";
    const sha = "b".repeat(64);
    const call = (who: string, offset: number, bytes: number, label: string) =>
      `SELECT '${label}=' || (public.commit_media_upload_chunk('${session}', '${who}', ${offset}, ${bytes}, '${sha}', 'p/${label}')::text);`;
    const out = exec(`BEGIN;
      INSERT INTO public.media_upload_sessions (id, owner_user_id, resume_token_hash, total_bytes, declared_mime, expected_sha256, expires_at)
      VALUES ('${session}', '${OWNER}', 'h', 100, 'video/mp4', repeat('a', 64), now() + interval '1 hour');
      ${call(OWNER, 0, 60, "first")}
      ${call(OWNER, 0, 60, "again")}
      ${call(OWNER, 60, 50, "overflow")}
      ${call(STRANGER, 60, 40, "stranger")}
      SELECT 'offset=' || offset_bytes::text FROM public.media_upload_sessions WHERE id = '${session}';
      ROLLBACK;`);
    const got = Object.fromEntries(out.filter((l) => /^(first|again|overflow|stranger|offset)=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    assert.equal(got["first"], '{"offset": 60, "result": "accepted"}');
    assert.equal(got["again"], '{"offset": 60, "result": "replay"}');
    assert.equal(got["overflow"], '{"offset": 60, "result": "invalid"}');
    assert.equal(got["stranger"], '{"offset": 0, "result": "invalid"}');
    assert.equal(got["offset"], "60");
  });
});
