/**
 * postsClientColumnGrants — census-media §44 (lane G1): migration 3362 and its
 * rollback, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/postsClientColumnGrants.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT (census-media §42.6, item 5): anon and authenticated held
 * TABLE-level SELECT on public.posts, so the public key read every column of
 * every row the policies admit — the author's GPS, the exact point, the venue,
 * the geofence exit time — whatever location_privacy_mode the author chose.
 * 3362 replaces that with SELECT on 40 named columns.
 *
 * WHAT THE HARNESS MODELS, AND WHAT IT DOES NOT
 *   It has the three PostgREST roles and auth.uid() reading the same
 *   `request.jwt.claim.sub` GUC PostgREST sets (scripts/local-db/shim.sql), the
 *   real posts / post_media / user_follows tables, their real policies and the
 *   chain's real grants. A statement run here under `SET LOCAL ROLE anon` is
 *   checked by PostgreSQL exactly as PostgREST's would be: column privileges
 *   are enforced by the executor, not by PostgREST.
 *   It has NO PostgREST process: the HTTP shape (`select=*` expanding to
 *   `"posts".*`, `?col=gt.x` becoming a WHERE) is written here as the SQL
 *   PostgREST emits for it, not sent over HTTP.
 *
 * PROPERTIES (each seen red with the migration or rollback mutated; §44.6)
 *   G1-0  3362 is in force here, or every refusal below would be vacuous.
 *   G1-1  anon, a stranger and the author are refused every withheld column:
 *         selected, filtered on (a range oracle needs no SELECT list), or `*`.
 *   G1-2  every column a client-role reader uses is still readable, exactly
 *         the granted set; post_media's policies, which read posts as the
 *         invoking role, still admit and still refuse the same rows.
 *   G1-3  the row policies are unchanged: who sees which post, and the policy
 *         catalog across a rollback and re-apply.
 *   G1-4  the owner reads their own rows' granted columns as before; the
 *         private columns reach them only through the API's role, which reads
 *         every column.
 *   G1-5  the rollback restores 2148's grants exactly, and 3362 re-applies to
 *         the identical state. The rollback deletes 3362's ledger row (§44.11).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3362_posts_client_column_grants.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-09-27-3362-posts-client-column-grants-rollback.sql");

/** The 40 columns 3362 grants (tombstoned_at only where 2141 created it). */
const GRANTED = [
  "id", "author_id", "trip_id", "content", "media_urls", "visibility", "status",
  "created_by", "updated_by", "source", "created_at", "updated_at", "deleted_at",
  "media_type", "add_to_passport", "like_count", "comment_count", "share_count",
  "comments_setting", "likes_hidden", "sharing_disabled", "reposting_disabled",
  "category", "save_count", "media_thumbnail_url", "primary_media_type",
  "media_count", "has_video", "filter_id", "filter_intensity",
  "media_duration_seconds", "post_buckets", "bucket_classified",
  "original_language", "publish_at", "geo_restriction",
  "age_restriction_enabled", "age_min", "age_max", "tombstoned_at",
] as const;
/** Never readable by a client role in any mode: the §42.6 item 5 minimum. */
const NEVER = [
  "user_gps_lat", "user_gps_lng", "original_lat", "original_lng", "geog",
  "location_distance_meters", "exited_geofence_at", "delayed_location_reason",
] as const;
/** Everything 3362 withholds (perspective_vantage only where 3352 created it). */
const WITHHELD = [
  ...NEVER,
  "location_name", "location_place_id", "location_lat", "location_lng",
  "public_lat", "public_lng", "public_location_label", "venue_id", "venue_name",
  "canonical_location_id", "canonical_place_id", "perspective_vantage",
  "location_city", "location_country",
  "location_privacy_mode", "location_sensitivity_level", "post_status",
  "geofence_radius_meters", "publish_after_exit", "publish_after_time",
  "publish_eligible_at", "published_at",
  "location_source", "location_verified", "location_verified_at",
  "geotag_verified", "geotag_credit_awarded",
] as const;

type Who = { role: "anon" } | { role: "authenticated"; uid: string };

let A = ""; // the author
let F = ""; // follows A
let S = ""; // a stranger
let PUB = ""; // A's public active post, mode hidden, every location column filled
let FOL = ""; // A's followers_only active post
let OWN = ""; // A's public post with status 'hidden': only its author may see it
let PEND = ""; // A's public active post whose delayed release is still pending (author not yet out of the geofence)
let MEDIA = ""; // a ready, approved post_media row on PUB
let COLS: string[] = []; // posts' columns in this database

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

/** Run `sql` as `who`; it must be refused for lack of a privilege on posts. */
function assertDenied(who: Who, sql: string): void {
  const r = runAs(who, sql);
  assert.notEqual(r.status, 0, `expected a refusal as ${who.role}, got success:\n${sql}\n${r.stdout}`);
  assert.match(r.stderr, /permission denied for table posts/, `expected a privilege refusal as ${who.role}:\n${sql}\n${r.stderr}`);
}

/**
 * Every column of posts, probed one statement per column, as `who`, in the
 * shape PostgREST emits (`SELECT "col" FROM posts WHERE id = $1`), or as a
 * filter (`SELECT id FROM posts WHERE "col" IS NOT NULL`) when `filter` is set.
 */
function probe(who: Who, postId: string, filter = false): { readable: string[]; denied: string[] } {
  const stmt = filter
    ? `format('SELECT id FROM public.posts WHERE %I IS NOT NULL AND id = %L', c, '${postId}')`
    : `format('SELECT %I FROM public.posts WHERE id = %L', c, '${postId}')`;
  const out = asOk(
    who,
    `DO $probe$
     DECLARE c text; readable text[] := '{}'; denied text[] := '{}';
     BEGIN
       FOR c IN SELECT attname::text FROM pg_attribute
                 WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum LOOP
         BEGIN
           EXECUTE ${stmt};
           readable := readable || c;
         EXCEPTION WHEN insufficient_privilege THEN
           denied := denied || c;
         END;
       END LOOP;
       PERFORM set_config('g1.readable', array_to_string(readable, ','), true);
       PERFORM set_config('g1.denied', array_to_string(denied, ','), true);
     END $probe$;
     SELECT 'R|' || current_setting('g1.readable');
     SELECT 'D|' || current_setting('g1.denied');`,
  );
  const pick = (tag: string) =>
    (out.find((l) => l.startsWith(tag)) ?? tag).slice(tag.length).split(",").filter((s) => s.length > 0).sort();
  return { readable: pick("R|"), denied: pick("D|") };
}

/** Post ids from `ids` that `who` can see through the policies. */
function visible(who: Who, ids: string[]): string[] {
  const list = ids.map((i) => `'${i}'`).join(",");
  return asOk(who, `SELECT id FROM public.posts WHERE id IN (${list}) ORDER BY id;`).sort();
}

/** The file's body and its trailing postconditions, without its BEGIN/COMMIT. */
function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

/** One line of JSON: the table ACL, every column ACL, and the policy catalog of posts. */
const SNAPSHOT = `SELECT json_build_object(
  'relacl', (SELECT relacl::text FROM pg_class WHERE oid = 'public.posts'::regclass),
  'attacl', (SELECT json_object_agg(attname, attacl::text ORDER BY attnum) FROM pg_attribute
              WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND NOT attisdropped),
  'policies', (SELECT json_agg(json_build_array(polname, polcmd::text, polpermissive, polroles::regrole[]::text,
                                                pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)) ORDER BY polname)
                 FROM pg_policy WHERE polrelid = 'public.posts'::regclass),
  'rls', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.posts'::regclass)
)::text;`;

describe("census-media §44 — 3362: the columns of posts a client role may read", { skip: !HAVE_DB }, () => {
  before(() => {
    A = seedUser("g1author");
    F = seedUser("g1follower");
    S = seedUser("g1stranger");
    PUB = randomUUID();
    FOL = randomUUID();
    OWN = randomUUID();
    PEND = randomUUID();
    MEDIA = randomUUID();
    COLS = rows<{ attname: string }>(
      `SELECT attname FROM pg_attribute WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    ).map((r) => r.attname);
    exec(`INSERT INTO public.user_follows (follower_id, following_id) VALUES ('${F}', '${A}');
          INSERT INTO public.posts (id, author_id, content, visibility, status,
              location_name, location_place_id, location_city, location_country, location_lat, location_lng,
              user_gps_lat, user_gps_lng, location_source, location_verified, location_verified_at,
              location_distance_meters, location_privacy_mode, geotag_verified, original_lat, original_lng,
              public_lat, public_lng, venue_id, venue_name, public_location_label, publish_after_exit,
              exited_geofence_at, publish_eligible_at, published_at, location_sensitivity_level, post_status,
              delayed_location_reason)
            VALUES ('${PUB}', '${A}', 'g1 public', 'public', 'active',
              'G1 Secret Bar', 'g1-place', 'Paris', 'France', 48.8566, 2.3522,
              48.85661, 2.35221, 'gps', true, now(),
              12.5, 'hidden', true, 48.85662, 2.35222,
              48.86, 2.35, 'g1-venue', 'G1 Secret Bar', 'Paris, France', true,
              now(), now(), now(), 'high', 'published',
              'g1 reason');
          INSERT INTO public.posts (id, author_id, content, visibility, status)
            VALUES ('${FOL}', '${A}', 'g1 followers', 'followers_only', 'active'),
                   ('${OWN}', '${A}', 'g1 own hidden', 'public', 'hidden');
          INSERT INTO public.posts (id, author_id, content, visibility, status, location_privacy_mode, post_status,
              location_name, location_city, original_lat, original_lng, publish_after_exit)
            VALUES ('${PEND}', '${A}', 'g1 pending', 'public', 'active', 'delayed_until_exit', 'pending_location_exit',
              'G1 Pending Venue', 'Paris', 48.85663, 2.35223, true);
          INSERT INTO public.post_media (id, post_id, user_id, media_type, mime_type, storage_path, processing_status, moderation_status)
            VALUES ('${MEDIA}', '${PUB}', '${A}', 'image', 'image/jpeg', '${A}/g1-${MEDIA}.jpg', 'ready', 'approved');`);
  });

  after(() => {
    if (!A) return;
    exec(`DELETE FROM public.post_media WHERE user_id IN ('${A}', '${F}', '${S}');
          DELETE FROM public.posts WHERE author_id IN ('${A}', '${F}', '${S}');
          DELETE FROM public.user_follows WHERE follower_id = '${F}';`);
    for (const u of [A, F, S]) if (u) deleteUser(u);
  });

  const present = (list: readonly string[]) => list.filter((c) => COLS.includes(c)).sort();

  it("G1-0 — 3362 is in force: no client role holds a table-level privilege on posts", () => {
    const tableLevel = rows<{ grantee: string; privilege_type: string }>(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type
         FROM pg_class c, LATERAL aclexplode(c.relacl) a
        WHERE c.oid = 'public.posts'::regclass
          AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole))`,
    );
    assert.deepEqual(tableLevel, [], "anon/authenticated/PUBLIC must hold no table-level privilege on posts");
    assert.equal(COLS.length, GRANTED.filter((c) => COLS.includes(c)).length + WITHHELD.filter((c) => COLS.includes(c)).length,
      "every column of posts is classified, once");
  });

  it("G1-1 — anon, a stranger and the author are refused every withheld column: selected, filtered on, or through *", () => {
    for (const who of [{ role: "anon" }, { role: "authenticated", uid: S }, { role: "authenticated", uid: A }] as Who[]) {
      const sel = probe(who, PUB);
      assert.deepEqual(sel.denied, present(WITHHELD), `${who.role}${"uid" in who ? ` ${who.uid}` : ""}: exactly the withheld columns are refused`);
      for (const c of NEVER) assert.ok(sel.denied.includes(c), `${who.role}: private column ${c} must be refused`);
      const flt = probe(who, PUB, true);
      assert.deepEqual(flt.denied, present(WITHHELD), `${who.role}: a filter on a withheld column must be refused (range oracle)`);
      // The PostgREST shapes, as SQL: select=*, and ?original_lat=gt.48 with select=id.
      assertDenied(who, `SELECT * FROM public.posts WHERE id = '${PUB}';`);
      assertDenied(who, `SELECT id FROM public.posts WHERE original_lat > 48;`);
      assertDenied(who, `SELECT id FROM public.posts ORDER BY user_gps_lat LIMIT 1;`);
    }
    // Anti-vacuity: the row exists and the values are there to be refused.
    assert.equal(scalar(`SELECT original_lat || ',' || user_gps_lat || ',' || location_name FROM public.posts WHERE id = '${PUB}'`),
      "48.85662,48.85661,G1 Secret Bar");
  });

  it("G1-2 — every column a client-role reader uses is still readable, and post_media's policies still work", () => {
    for (const who of [{ role: "anon" }, { role: "authenticated", uid: S }, { role: "authenticated", uid: A }] as Who[]) {
      assert.deepEqual(probe(who, PUB).readable, present(GRANTED), `${who.role}: exactly the granted columns are readable`);
      const all = asOk(who, `SELECT count(*) FROM (SELECT ${present(GRANTED).join(", ")} FROM public.posts WHERE id = '${PUB}') x;`);
      assert.deepEqual(all, ["1"], `${who.role}: the whole granted list in one SELECT returns the row`);
    }
    // The one client-role read of posts in the tree's suites: postLocationVerificationBoundary's anon feed read.
    const feed = asOk({ role: "anon" }, `SELECT id FROM public.posts WHERE status = 'active' AND visibility = 'public' AND id = '${PUB}';`);
    assert.deepEqual(feed, [PUB]);
    // post_media_public_select subqueries posts (id, status, visibility, trip_id) AS anon.
    assert.deepEqual(asOk({ role: "anon" }, `SELECT id FROM public.post_media WHERE post_id = '${PUB}';`), [MEDIA]);
    assert.deepEqual(asOk({ role: "authenticated", uid: S }, `SELECT id FROM public.post_media WHERE post_id = '${PUB}';`), [MEDIA]);
    // post_media_owner_insert's WITH CHECK subqueries posts (id, author_id) AS authenticated:
    // the author may attach media to their own post; a stranger is refused by the POLICY, not by a privilege.
    // (id is not among authenticated's INSERT columns since 2158, so the row is found by its path.)
    const ownPath = `${A}/g1-own-${randomUUID()}.jpg`;
    asOk({ role: "authenticated", uid: A },
      `INSERT INTO public.post_media (post_id, user_id, media_type, mime_type, storage_path)
       VALUES ('${PUB}', '${A}', 'image', 'image/jpeg', '${ownPath}');`);
    assert.equal(scalar(`SELECT count(*) FROM public.post_media WHERE storage_path = '${ownPath}'`), "1");
    const r = runAs({ role: "authenticated", uid: S },
      `INSERT INTO public.post_media (post_id, user_id, media_type, mime_type, storage_path)
       VALUES ('${PUB}', '${S}', 'image', 'image/jpeg', '${S}/g1-stranger.jpg');`);
    assert.notEqual(r.status, 0, "a stranger must not attach media to another author's post");
    assert.match(r.stderr, /row-level security/, `the refusal must be the policy's:\n${r.stderr}`);
  });

  it("G1-3 — the row policies are unchanged: who sees which post, and the policy catalog", () => {
    const ids = [PUB, FOL, OWN, PEND];
    // PEND is admitted to everyone: no posts policy reads post_status, so a delayed post whose
    // author has not yet left the place is a visible ROW. 3362 narrows its COLUMNS only —
    // census-media §44.7 item 1 records the row gap, which a column grant cannot close.
    assert.deepEqual(visible({ role: "anon" }, ids), [PUB, PEND].sort(), "anon: the public posts only");
    assert.deepEqual(visible({ role: "authenticated", uid: S }, ids), [PUB, PEND].sort(), "a stranger: the public posts only");
    assert.deepEqual(visible({ role: "authenticated", uid: F }, ids), [PUB, FOL, PEND].sort(), "a follower: public + followers_only");
    assert.deepEqual(visible({ role: "authenticated", uid: A }, ids), [PUB, FOL, OWN, PEND].sort(), "the author: all four");
    // On that pending row, what anon gets is the post, not where or whether the author still is.
    assert.deepEqual(asOk({ role: "anon" }, `SELECT content FROM public.posts WHERE id = '${PEND}';`), ["g1 pending"]);
    for (const c of ["post_status", "location_privacy_mode", "location_name", "location_city", "original_lat", "publish_after_exit"]) {
      assertDenied({ role: "anon" }, `SELECT ${c} FROM public.posts WHERE id = '${PEND}';`);
    }
    // Across rollback → re-apply (in a transaction that is rolled back), the
    // policy catalog is byte-identical: 3362 touches no policy and no RLS flag.
    const out = exec(`BEGIN;\n${SNAPSHOT}\n${unwrapped(ROLLBACK)}\n${SNAPSHOT}\n${unwrapped(MIGRATION)}\n${SNAPSHOT}\nROLLBACK;`);
    const snaps = out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    assert.equal(snaps.length, 3);
    assert.deepEqual(snaps[1].policies, snaps[0].policies, "the rollback changes no policy");
    assert.deepEqual(snaps[2].policies, snaps[0].policies, "3362 changes no policy");
    assert.equal(snaps[0].policies.length, 5, "posts carries its five policies");
    assert.ok(snaps.every((s) => s.rls === true), "RLS stays enabled");
  });

  it("G1-4 — the owner reads their own rows' granted columns as before; the private columns only through the API's role", () => {
    const who: Who = { role: "authenticated", uid: A };
    // A row only its author may see (status 'hidden'): the granted columns come back.
    assert.deepEqual(asOk(who, `SELECT content || '|' || status || '|' || visibility FROM public.posts WHERE id = '${OWN}';`),
      ["g1 own hidden|hidden|public"]);
    // The author's own exact point is refused to the author's client too ...
    assertDenied(who, `SELECT original_lat FROM public.posts WHERE id = '${PUB}';`);
    // ... and reaches them through the API, whose client is service_role
    // (lib/supabase.ts); GET /posts/pending serves location_lat/lng + venue_name that way.
    const svc = exec(`SET LOCAL ROLE service_role;
      SELECT original_lat || '|' || user_gps_lat || '|' || location_name || '|' || venue_name || '|' || delayed_location_reason
             || '|' || (exited_geofence_at IS NOT NULL) || '|' || location_lat || '|' || location_lng
        FROM public.posts WHERE id = '${PUB}';`, { single: true });
    assert.deepEqual(svc, ["48.85662|48.85661|G1 Secret Bar|G1 Secret Bar|g1 reason|true|48.8566|2.3522"]);
    const svcCols = scalar(`SELECT count(*) FILTER (WHERE has_column_privilege('service_role', attrelid, attnum, 'SELECT')) || '/' || count(*)
                              FROM pg_attribute WHERE attrelid = 'public.posts'::regclass AND attnum > 0 AND NOT attisdropped`);
    assert.equal(svcCols, `${COLS.length}/${COLS.length}`, "service_role reads every column of posts");
  });

  it("G1-5 — the rollback restores 2148's grants exactly, and 3362 re-applies to the identical state", () => {
    const out = exec(`BEGIN;\n${SNAPSHOT}\n${unwrapped(ROLLBACK)}\n${SNAPSHOT}\n${unwrapped(MIGRATION)}\n${SNAPSHOT}\nROLLBACK;`);
    const [now, rolled, reapplied] = out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    assert.ok(now && rolled && reapplied, "three snapshots");
    // 2148's state: the table ACL as it is now plus anon=r and authenticated=r
    // from the table owner, in that order, and no column ACL at all.
    const owner = scalar(`SELECT relowner::regrole::text FROM pg_class WHERE oid = 'public.posts'::regclass`);
    const expected = String(now.relacl).replace(/\}$/, `,anon=r/${owner},authenticated=r/${owner}}`);
    assert.equal(rolled.relacl, expected, "the rollback restores table-level SELECT for anon and authenticated, exactly");
    assert.deepEqual(Object.values(rolled.attacl).filter((v) => v !== null), [], "the rollback leaves no column ACL");
    // And re-applying 3362 on top reproduces today's catalog byte for byte.
    assert.deepEqual(reapplied, now, "3362 after the rollback is the state 3362 left");
    // The DB is untouched by this test (it ran in a rolled-back transaction).
    assert.deepEqual(JSON.parse(exec(SNAPSHOT)[0]!), now);
    // The rollback deletes 3362's ledger row, which the runner writes in 3362's
    // own transaction, so a later runner pass re-applies 3362 (census-media §44.11).
    const led = exec(`BEGIN;
      INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes)
        VALUES ('3362_posts_client_column_grants.sql', 'test', 'manual', 'postsClientColumnGrants.db.test.ts')
        ON CONFLICT (filename) DO NOTHING;
      SELECT 'ledger-before=' || count(*) FROM public.schema_migration_ledger WHERE filename = '3362_posts_client_column_grants.sql';
      ${unwrapped(ROLLBACK)}
      SELECT 'ledger-after=' || count(*) FROM public.schema_migration_ledger WHERE filename = '3362_posts_client_column_grants.sql';
      ROLLBACK;`);
    assert.ok(led.includes("ledger-before=1"), "anti-vacuity: the ledger row is there before the rollback");
    assert.ok(led.includes("ledger-after=0"), "the rollback deletes 3362's ledger row");
  });
});
