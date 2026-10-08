/**
 * postsReleaseTimingColumns — census-media §50.16 (verifier M3, N2b): migration
 * 3801 and its rollback, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/postsReleaseTimingColumns.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT: on a "Publish after I leave" post, updated_at is the instant the
 * author left the place, then the release instant (trg_posts_updated stamps
 * every UPDATE). The API tells a non-author the creation instant, but 3362
 * granted SELECT (updated_at) to anon and authenticated, so a signed-in
 * stranger read the real instant through PostgREST. 3801 withholds updated_at
 * and publish_at as well.
 *
 * The harness models PostgREST the way postsClientColumnGrants.db.test.ts does:
 * `SET LOCAL ROLE` plus the JWT GUCs auth.uid() reads; column privileges are
 * enforced by the executor, not by PostgREST.
 *
 * PROPERTIES
 *   R0  3801 is in force, or every refusal below would be vacuous.
 *   R1  the release-timing scenario: after the exit and release UPDATEs (as the
 *       API's role), a signed-in stranger, anon and the author's own client key
 *       are refused updated_at, publish_at and published_at — selected, filtered
 *       on, or through `*`; the API's role reads the real instants.
 *   R2  every column 3801 keeps is still readable, in one SELECT, by all three;
 *       post_media's policies (which read posts as the invoking role) still work.
 *   R3  the postcondition passes alone on the committed database (certify
 *       stage 4); 3362's postcondition, re-run here, FAILS — which is exactly
 *       why 3801 declares that it supersedes it — and so does 2148's.
 *   R4  the rollback restores 3362's end state exactly (and 3362's postcondition
 *       passes on it); 3801 re-applied on top reproduces today's catalog.
 *   R5  from 2148's state (production's, 2026-10-08) 3801 alone reaches the
 *       same catalog as 3362 + 3801.
 *   R6  the precondition refuses states nobody wrote down, and a second apply.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";
import { isAssertionOnlyDoBlock, isPreconditionDoBlock, topLevelStatements } from "../../scripts/lib/migrationSqlBlocks.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3801_posts_release_timing_columns_withheld.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-08-3801-posts-release-timing-columns-withheld-rollback.sql");
const M3362 = resolve(__dir, "../../migrations/3362_posts_client_column_grants.sql");
const M2148 = resolve(__dir, "../../migrations/2148_posts_write_boundary.sql");
const RB3362 = resolve(__dir, "../../../../../db/rollback/2026-09-27-3362-posts-client-column-grants-rollback.sql");

/** The columns a client role may read after 3801 (tombstoned_at only where 2141 created it). */
const KEPT = [
  "id", "author_id", "trip_id", "content", "media_urls", "visibility", "status",
  "created_by", "updated_by", "source", "created_at", "deleted_at",
  "media_type", "add_to_passport", "like_count", "comment_count", "share_count",
  "comments_setting", "likes_hidden", "sharing_disabled", "reposting_disabled",
  "category", "save_count", "media_thumbnail_url", "primary_media_type",
  "media_count", "has_video", "filter_id", "filter_intensity",
  "media_duration_seconds", "post_buckets", "bucket_classified",
  "original_language", "geo_restriction",
  "age_restriction_enabled", "age_min", "age_max", "tombstoned_at",
] as const;
/** When a post was released, or its author left: never client-readable. */
const RELEASE = ["updated_at", "publish_at", "published_at", "publish_eligible_at", "publish_after_exit", "publish_after_time", "exited_geofence_at", "post_status"] as const;

type Who = { role: "anon" } | { role: "authenticated"; uid: string };

let A = ""; // the author
let S = ""; // a signed-in stranger
let DELAYED = ""; // A's public "Publish after I leave" post, exited and released below
let MEDIA = ""; // a ready, approved post_media row on DELAYED
let COLS: string[] = [];

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
const runAs = (who: Who, sql: string) => psql(prelude(who) + sql, { single: true });
function asOk(who: Who, sql: string): string[] {
  const r = runAs(who, sql);
  assert.equal(r.status, 0, `expected success as ${who.role}:\n${sql}\n${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}
function assertDenied(who: Who, sql: string): void {
  const r = runAs(who, sql);
  assert.notEqual(r.status, 0, `expected a refusal as ${who.role}, got success:\n${sql}\n${r.stdout}`);
  assert.match(r.stderr, /permission denied for table posts/, `expected a privilege refusal as ${who.role}:\n${sql}\n${r.stderr}`);
}

/** Every column of posts, probed one statement per column as `who` (the shape PostgREST emits). */
function probe(who: Who, postId: string): { readable: string[]; denied: string[] } {
  const out = asOk(
    who,
    `DO $probe$
     DECLARE c text; readable text[] := '{}'; denied text[] := '{}';
     BEGIN
       FOR c IN SELECT attname::text FROM pg_attribute
                 WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum LOOP
         BEGIN
           EXECUTE format('SELECT %I FROM public.posts WHERE id = %L', c, '${postId}');
           readable := readable || c;
         EXCEPTION WHEN insufficient_privilege THEN
           denied := denied || c;
         END;
       END LOOP;
       PERFORM set_config('n2b.readable', array_to_string(readable, ','), true);
       PERFORM set_config('n2b.denied', array_to_string(denied, ','), true);
     END $probe$;
     SELECT 'R|' || current_setting('n2b.readable');
     SELECT 'D|' || current_setting('n2b.denied');`,
  );
  const pick = (tag: string) =>
    (out.find((l) => l.startsWith(tag)) ?? tag).slice(tag.length).split(",").filter((x) => x.length > 0).sort();
  return { readable: pick("R|"), denied: pick("D|") };
}

/** The file's body and its trailing postconditions, without its BEGIN/COMMIT. */
function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}
/** A file's re-runnable postcondition blocks, as certify:migrations stage 4 collects them. */
function postconditions(path: string): string[] {
  return topLevelStatements(readFileSync(path, "utf8")).filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
}
/** A file's $pre$ block. */
function precondition(path: string): string {
  const pre = topLevelStatements(readFileSync(path, "utf8")).filter((s) => isPreconditionDoBlock(s));
  assert.equal(pre.length, 1);
  return pre[0]!;
}

const SNAPSHOT = `SELECT json_build_object(
  'relacl', (SELECT relacl::text FROM pg_class WHERE oid = 'public.posts'::regclass),
  'attacl', (SELECT json_object_agg(attname, attacl::text ORDER BY attnum) FROM pg_attribute
              WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND NOT attisdropped),
  'policies', (SELECT json_agg(json_build_array(polname, polcmd::text, pg_get_expr(polqual, polrelid)) ORDER BY polname)
                 FROM pg_policy WHERE polrelid = 'public.posts'::regclass)
)::text;`;
const snaps = (out: string[]) => out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

describe("census-media §50.16 — 3801: no client role reads when a post was released", { skip: !HAVE_DB }, () => {
  before(() => {
    A = seedUser("n2bauthor");
    S = seedUser("n2bstranger");
    DELAYED = randomUUID();
    MEDIA = randomUUID();
    COLS = rows<{ attname: string }>(
      `SELECT attname FROM pg_attribute WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    ).map((r) => r.attname);
    // Created an hour ago, pending until the author leaves; then (as the API's
    // role) the geofence-exit UPDATE and the worker's release UPDATE, exactly
    // the columns routes/location.ts and lib/delayedPostPublisher.ts write.
    exec(`INSERT INTO public.posts (id, author_id, content, visibility, status, location_privacy_mode, post_status,
              publish_after_exit, location_name, location_city, original_lat, original_lng, created_at, updated_at)
            VALUES ('${DELAYED}', '${A}', 'n2b delayed', 'public', 'active', 'delayed_until_exit', 'pending_location_exit',
              true, 'N2b Bar', 'Paris', 48.85663, 2.35223, now() - interval '1 hour', now() - interval '1 hour');
          INSERT INTO public.post_media (id, post_id, user_id, media_type, mime_type, storage_path, processing_status, moderation_status)
            VALUES ('${MEDIA}', '${DELAYED}', '${A}', 'image', 'image/jpeg', '${A}/n2b-${MEDIA}.jpg', 'ready', 'approved');`);
    exec(`SET LOCAL ROLE service_role;
          UPDATE public.posts SET exited_geofence_at = now(), publish_eligible_at = now() + interval '15 minutes', post_status = 'pending_delay'
            WHERE id = '${DELAYED}' AND post_status = 'pending_location_exit';`, { single: true });
    exec(`SET LOCAL ROLE service_role;
          UPDATE public.posts SET post_status = 'published', published_at = now() WHERE id = '${DELAYED}';`, { single: true });
  });

  after(() => {
    if (!A) return;
    exec(`DELETE FROM public.post_media WHERE user_id IN ('${A}', '${S}');
          DELETE FROM public.posts WHERE author_id IN ('${A}', '${S}');`);
    for (const u of [A, S]) if (u) deleteUser(u);
  });

  const present = (list: readonly string[]) => list.filter((c) => COLS.includes(c)).sort();
  const WHO: () => Who[] = () => [{ role: "anon" }, { role: "authenticated", uid: S }, { role: "authenticated", uid: A }];

  it("R0 — 3801 is in force: no table-level client privilege, and updated_at is unreadable to both client roles", () => {
    assert.deepEqual(
      rows(`SELECT a.privilege_type FROM pg_class c, LATERAL aclexplode(c.relacl) a
             WHERE c.oid = 'public.posts'::regclass AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole))`),
      [],
    );
    assert.equal(scalar(`SELECT has_column_privilege('authenticated', 'public.posts', 'updated_at', 'SELECT')::text`), "false");
    assert.equal(scalar(`SELECT has_column_privilege('anon', 'public.posts', 'updated_at', 'SELECT')::text`), "false");
    assert.equal(scalar(`SELECT has_column_privilege('authenticated', 'public.posts', 'content', 'SELECT')::text`), "true");
  });

  it("R1 — after the exit and the release, nobody's client key reads when: updated_at, publish_at, published_at (selected, filtered, *); the API's role does", () => {
    // Anti-vacuity: the row really carries an exit and a release later than its creation.
    assert.equal(scalar(`SELECT (updated_at > created_at + interval '30 minutes' AND published_at IS NOT NULL AND exited_geofence_at IS NOT NULL)::text
                           FROM public.posts WHERE id = '${DELAYED}'`), "true");
    for (const who of WHO()) {
      for (const c of ["updated_at", "publish_at", "published_at", "publish_eligible_at", "exited_geofence_at"]) {
        assertDenied(who, `SELECT ${c} FROM public.posts WHERE id = '${DELAYED}';`);
        assertDenied(who, `SELECT id FROM public.posts WHERE ${c} IS NOT NULL AND id = '${DELAYED}';`);
      }
      assertDenied(who, `SELECT id FROM public.posts WHERE updated_at > now() - interval '1 minute';`);
      assertDenied(who, `SELECT id FROM public.posts ORDER BY updated_at DESC LIMIT 1;`);
      assertDenied(who, `SELECT * FROM public.posts WHERE id = '${DELAYED}';`);
    }
    // The row itself is still visible (the policy admits it); only the columns narrowed.
    assert.deepEqual(asOk({ role: "authenticated", uid: S }, `SELECT content FROM public.posts WHERE id = '${DELAYED}';`), ["n2b delayed"]);
    // The API's role (service_role) still reads the real instants, which it serves to the author alone.
    const svc = exec(`SET LOCAL ROLE service_role;
      SELECT (updated_at > created_at)::text || '|' || (published_at IS NOT NULL)::text FROM public.posts WHERE id = '${DELAYED}';`, { single: true });
    assert.deepEqual(svc, ["true|true"]);
  });

  it("R2 — exactly the kept columns are readable (one probe per column), and all of them in one SELECT, by anon, a stranger and the author; post_media's policies still work", () => {
    for (const who of WHO()) {
      const { readable, denied } = probe(who, DELAYED);
      assert.deepEqual(readable, present([...KEPT]), `${who.role}: exactly the kept columns are readable`);
      for (const c of present([...RELEASE])) assert.ok(denied.includes(c), `${who.role}: ${c} is refused`);
      const all = asOk(who, `SELECT count(*) FROM (SELECT ${present([...KEPT]).join(", ")} FROM public.posts WHERE id = '${DELAYED}') x;`);
      assert.deepEqual(all, ["1"], `${who.role}: the kept list in one SELECT returns the row`);
    }
    // The feed shape a client role would use (postLocationVerificationBoundary's anon read).
    assert.deepEqual(asOk({ role: "anon" }, `SELECT id FROM public.posts WHERE status = 'active' AND visibility = 'public' AND id = '${DELAYED}';`), [DELAYED]);
    // post_media_public_select subqueries posts (id, status, visibility, trip_id) as the invoking role.
    assert.deepEqual(asOk({ role: "anon" }, `SELECT id FROM public.post_media WHERE post_id = '${DELAYED}';`), [MEDIA]);
    assert.deepEqual(asOk({ role: "authenticated", uid: S }, `SELECT id FROM public.post_media WHERE post_id = '${DELAYED}';`), [MEDIA]);
    // post_media_owner_insert's WITH CHECK subqueries posts (id, author_id) as authenticated.
    const ownPath = `${A}/n2b-own-${randomUUID()}.jpg`;
    asOk({ role: "authenticated", uid: A },
      `INSERT INTO public.post_media (post_id, user_id, media_type, mime_type, storage_path)
       VALUES ('${DELAYED}', '${A}', 'image', 'image/jpeg', '${ownPath}');`);
    assert.equal(scalar(`SELECT count(*) FROM public.post_media WHERE storage_path = '${ownPath}'`), "1");
  });

  it("R3 — 3801's postcondition passes alone on the committed database; 3362's, re-run here, fails (why 3801 supersedes it)", () => {
    const own = postconditions(MIGRATION);
    assert.equal(own.length, 1);
    exec(own[0]!);
    const old = postconditions(M3362);
    assert.equal(old.length, 1);
    const r = psql(old[0]!);
    assert.notEqual(r.status, 0, "3362's postcondition must fail after 3801 — or the supersession would be unnecessary");
    assert.match(r.stderr, /POSTCONDITION FAILED \(3362\): a client role lost a column it must keep: .*updated_at/);
    // 2148's ("anon holds SELECT only", table-level) has failed every such re-run since 3362; 3801 supersedes it too.
    const p2148 = postconditions(M2148).find((b) => /expected SELECT only/.test(b));
    assert.ok(p2148, "anti-vacuity: 2148's table-level postcondition");
    const r2 = psql(p2148!);
    assert.notEqual(r2.status, 0);
    assert.match(r2.stderr, /POSTCONDITION FAILED: anon holds "\(none\)", expected SELECT only/);
  });

  it("R4 — the rollback restores 3362's end state exactly (3362's postcondition passes on it); 3801 re-applied reproduces today's catalog", () => {
    const old = postconditions(M3362)[0]!;
    const out = exec(`BEGIN;\n${SNAPSHOT}\n${unwrapped(ROLLBACK)}\n${SNAPSHOT}\n${old}\nSELECT 'post3362-ok';\n${unwrapped(MIGRATION)}\n${SNAPSHOT}\nROLLBACK;`);
    const [now, rolled, reapplied] = snaps(out);
    assert.ok(now && rolled && reapplied, "three snapshots");
    assert.ok(out.includes("post3362-ok"), "3362's postcondition passes on the rolled-back state");
    for (const c of ["updated_at", "publish_at"]) {
      assert.equal(now.attacl[c], null, `${c}: no client grant now`);
      assert.match(String(rolled.attacl[c]), /anon=r\/.*authenticated=r\//, `${c}: re-granted to both by the rollback`);
    }
    assert.equal(rolled.relacl, now.relacl, "the rollback never restores a table-level privilege");
    assert.deepEqual(reapplied, now, "3801 after its rollback is the state 3801 left");
    assert.deepEqual(rolled.policies, now.policies, "no policy changes");
    assert.deepEqual(JSON.parse(exec(SNAPSHOT)[0]!), now, "the test left the database as it found it");
    // The rollback deletes 3801's ledger row, so a later runner pass re-applies 3801.
    const led = exec(`BEGIN;
      INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes)
        VALUES ('3801_posts_release_timing_columns_withheld.sql', 'test', 'manual', 'postsReleaseTimingColumns.db.test.ts')
        ON CONFLICT (filename) DO NOTHING;
      SELECT 'ledger-before=' || count(*) FROM public.schema_migration_ledger WHERE filename = '3801_posts_release_timing_columns_withheld.sql';
      ${unwrapped(ROLLBACK)}
      SELECT 'ledger-after=' || count(*) FROM public.schema_migration_ledger WHERE filename = '3801_posts_release_timing_columns_withheld.sql';
      ROLLBACK;`);
    assert.ok(led.includes("ledger-before=1"), "anti-vacuity: the ledger row is there before the rollback");
    assert.ok(led.includes("ledger-after=0"), "the rollback deletes 3801's ledger row");
  });

  it("R5 — from 2148's state (production's on 2026-10-08), 3801 alone reaches the same catalog as 3362 then 3801", () => {
    // 3801's rollback, then 3362's: 2148's state (a table-level client SELECT, no column ACL). Then 3801 alone.
    const out = exec(`BEGIN;\n${SNAPSHOT}\n${unwrapped(ROLLBACK)}\n${unwrapped(RB3362)}\n${SNAPSHOT}\n${unwrapped(MIGRATION)}\n${SNAPSHOT}\nROLLBACK;`);
    const [now, s2, direct] = snaps(out);
    assert.ok(now && s2 && direct);
    assert.match(String(s2.relacl), /anon=r\/.*authenticated=r\//, "anti-vacuity: the middle state is 2148's table-level SELECT");
    assert.deepEqual(Object.values(s2.attacl).filter((v) => v !== null), [], "anti-vacuity: and no column ACL");
    assert.deepEqual(direct, now, "3801 from 2148's state = 3362 + 3801");
  });

  it("R6 — the precondition refuses a state nobody wrote down, and a second apply", () => {
    const pre = precondition(MIGRATION);
    const refuse = (setup: string, why: RegExp) => {
      const r = psql(`BEGIN;\n${setup}\n${pre}\nROLLBACK;`);
      assert.notEqual(r.status, 0, `the precondition must refuse after: ${setup}`);
      assert.match(r.stderr, why);
    };
    // A second apply: the end state is neither 2148's nor 3362's.
    refuse("", /the column grants are not exactly 3362's/);
    // From 3362's state with one extra column grant (a location).
    refuse(`${unwrapped(ROLLBACK)}\nGRANT SELECT (original_lat) ON TABLE public.posts TO anon;`, /column privileges 3362 never granted: anon\.original_lat:SELECT/);
    // PUBLIC holding a privilege.
    refuse(`${unwrapped(ROLLBACK)}\nGRANT SELECT ON TABLE public.posts TO PUBLIC;`, /PUBLIC:SELECT/);
    // Only one of the two client roles with a table-level SELECT.
    refuse(`${unwrapped(ROLLBACK)}\n${unwrapped(RB3362)}\nREVOKE SELECT ON TABLE public.posts FROM anon;`, /exactly one of anon\/authenticated holds a table-level SELECT/);
    // A grant option.
    refuse(`${unwrapped(ROLLBACK)}\n${unwrapped(RB3362)}\nREVOKE SELECT ON TABLE public.posts FROM anon;\nGRANT SELECT ON TABLE public.posts TO anon WITH GRANT OPTION;`, /anon:SELECT\+grant/);
    // And from 3362's exact end state, the precondition passes (control).
    const ok = psql(`BEGIN;\n${unwrapped(ROLLBACK)}\n${pre}\nROLLBACK;`);
    assert.equal(ok.status, 0, `control: 3362's end state is accepted:\n${ok.stderr}`);
  });
});
