/**
 * postMediaBlockCheckOfRecord — census-telegraph T220 §15 (independent verification pass 4's SQL-layer boundary):
 * migrations 3903, 3904 and 3905 on the replayed chain, executed against real PostgreSQL (CI's postgis/postgis:16-3.4
 * service, scripts/local-db/up.sh). The definition-level proofs (byte-identical outputs, minimal diffs, refusals) are
 * src/test/sqlBlockChecksOfRecordMigrations.test.ts on PGlite; this suite proves the client-visible change on the
 * REAL post_media and posts — their real policies, column grants and the authz helpers the chain installed.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/postMediaBlockCheckOfRecord.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every src/test/db suite;
 *      scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * PROPERTIES
 *   B0  the chain's definitions ask authz.is_blocked: post_media_public_select, project_user_memory (twice) and
 *       memory_public_feed, and none of the three reads public.blocks itself.
 *   B1  RED BEFORE: with 2337's policy re-created inside a rolled-back transaction, a signed-in person whom the
 *       media's owner blocked still reads the owner's ready public media (the inline read runs through blocks' RLS).
 *   B2  after 3905 that person reads none of it; the direction the viewer made still bites; an unblocked viewer and
 *       anon read it as before; the owner reads their own.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const S2337 = readFileSync(resolve(__dir, "../../migrations/2337_trip_crew_rls_membership_convergence.sql"), "utf8");
/** 2337's post_media statements, verbatim (its LANE F). */
const POLICY_2337 = (() => {
  const start = S2337.indexOf('DROP POLICY IF EXISTS "post_media_public_select" ON public.post_media;');
  const end = S2337.indexOf("\n  );\n", start);
  assert.ok(start >= 0 && end > start, "2337's post_media policy statements");
  return S2337.slice(start, end + "\n  );\n".length);
})();

let OWNER = "";
let VIEWER = "";
let POST = "";
let MEDIA = "";

function as(uid: string | null): string {
  return uid === null
    ? `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.role', 'anon', true); END $p$;\nSET LOCAL ROLE anon;\n`
    : `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${uid}', true); PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\nSET LOCAL ROLE authenticated;\n`;
}
/** How many of the owner's media rows `who` reads, as PostgREST's role would; `prelude` runs first in the same transaction. */
function reads(who: string | null, prelude = ""): number {
  const out = exec(`BEGIN;\n${prelude}\n${as(who)}SELECT 'n=' || count(*) FROM public.post_media WHERE id = '${MEDIA}';\nROLLBACK;`);
  const line = out.find((l) => l.startsWith("n="));
  assert.ok(line, out.join("\n"));
  return Number(line!.slice(2));
}
const block = (blocker: string, blocked: string) => `INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${blocker}', '${blocked}');`;

describe("census-telegraph T220 — 3903/3904/3905: the SQL layer asks authz.is_blocked", { skip: !HAVE_DB }, () => {
  before(() => {
    OWNER = seedUser("b0owner");
    VIEWER = seedUser("b0viewer");
    POST = randomUUID();
    MEDIA = randomUUID();
    exec(`INSERT INTO public.posts (id, author_id, content, visibility, status) VALUES ('${POST}', '${OWNER}', 'b0 post', 'public', 'active');`);
    exec(`SET LOCAL ROLE service_role;
      INSERT INTO public.post_media (id, post_id, user_id, media_type, mime_type, storage_path, processing_status, moderation_status)
      VALUES ('${MEDIA}', '${POST}', '${OWNER}', 'image', 'image/jpeg', '${OWNER}/b0-ready.jpg', 'ready', 'approved');`, { single: true });
  });

  after(() => {
    if (!OWNER) return;
    exec(`DELETE FROM public.blocks WHERE blocker_id IN ('${OWNER}', '${VIEWER}') OR blocked_id IN ('${OWNER}', '${VIEWER}');
          DELETE FROM public.post_media WHERE user_id IN ('${OWNER}', '${VIEWER}');
          DELETE FROM public.posts WHERE author_id IN ('${OWNER}', '${VIEWER}');`);
    for (const u of [OWNER, VIEWER]) if (u) deleteUser(u);
  });

  it("B0 — the chain's three definitions ask authz.is_blocked and read no blocks table themselves", () => {
    // Multi-line texts come back whole through rows() (json), never through scalar() (its first line only).
    const text = (q: string) => rows<{ t: string }>(q)[0]?.t ?? "";
    const qual = text(`SELECT qual AS t FROM pg_policies WHERE schemaname = 'public' AND tablename = 'post_media' AND policyname = 'post_media_public_select'`);
    assert.match(qual, /\(NOT authz\.is_blocked\(auth\.uid\(\), user_id\)\)/);
    assert.match(qual, /authz\.is_trip_crew\(p\.trip_id\)/, "anti-vacuity: the whole qual was read");
    assert.doesNotMatch(qual, /\bblocks\b/);
    const puml = text(`SELECT pg_get_functiondef('public.project_user_memory(uuid,boolean)'::regprocedure) AS t`);
    assert.equal((puml.match(/NOT authz\.is_blocked\(p_user_id, uf\.following_id\)/g) ?? []).length, 2);
    assert.doesNotMatch(puml.replace(/--[^\n]*/g, ""), /\bblocks\b/);
    const feed = text(`SELECT prosrc AS t FROM pg_proc WHERE oid = 'public.memory_public_feed(uuid,integer,timestamptz)'::regprocedure`);
    assert.equal((feed.match(/NOT authz\.is_blocked\(p_viewer, m\.owner_id\)/g) ?? []).length, 1);
    assert.doesNotMatch(feed.replace(/--[^\n]*/g, ""), /\bblocks\b/);
  });

  it("B1 — RED BEFORE: under 2337's policy the person the owner blocked still reads the owner's media", () => {
    assert.equal(reads(VIEWER, POLICY_2337), 1, "anti-vacuity: an unblocked viewer reads it under 2337");
    assert.equal(reads(VIEWER, `${POLICY_2337}\n${block(OWNER, VIEWER)}`), 1, "2337's inline read runs through blocks' RLS and cannot see the owner's block");
    assert.equal(reads(VIEWER, `${POLICY_2337}\n${block(VIEWER, OWNER)}`), 0, "the direction the viewer made bites under 2337");
  });

  it("B2 — after 3905: the owner's block bites; nothing else moved", () => {
    assert.equal(reads(VIEWER), 1, "an unblocked viewer reads the ready public media");
    assert.equal(reads(VIEWER, block(OWNER, VIEWER)), 0, "the person the owner blocked reads none of it");
    assert.equal(reads(VIEWER, block(VIEWER, OWNER)), 0, "the direction the viewer made still bites");
    assert.equal(reads(null), 1, "anon reads it as before");
    assert.equal(reads(null, block(OWNER, VIEWER)), 1, "anon has no identity to be blocked");
    assert.equal(reads(OWNER, block(OWNER, VIEWER)), 1, "the owner reads their own");
    assert.equal(scalar(`SELECT count(*) FROM public.blocks WHERE blocker_id IN ('${OWNER}', '${VIEWER}');`), "0", "every block above was rolled back");
  });
});
