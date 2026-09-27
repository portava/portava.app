/**
 * placeCopiesClientColumnGrants — census-media §44.11–§44.16 (lane G1):
 * migration 3363 and its rollback, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/placeCopiesClientColumnGrants.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT (census-media §44.7, item 2): 3362 withheld posts' place columns
 * from the client roles, but three tables hold a COPY of the same place and
 * were readable in full: pulse_geo_tags (every row, to every role), passport_
 * postcards (every row can_see_postcard admits) and post_media (every row
 * post_media_public_select admits). 3363 replaces each table-level SELECT with
 * SELECT on the columns that carry no place.
 *
 * WHAT THE HARNESS MODELS, AND WHAT IT DOES NOT: as postsClientColumnGrants.db
 * .test.ts says — the PostgREST roles, auth.uid() from the GUC PostgREST sets,
 * the real tables, policies and grants; column privileges are enforced by the
 * executor, so `SET LOCAL ROLE anon` is checked as PostgREST's request would
 * be. There is no PostgREST process: `select=*` and `?col=…` are written as
 * the SQL PostgREST emits for them.
 *
 * PROPERTIES (each seen red with the migration or rollback mutated; §44.14)
 *   G3-0  3363 is in force on all three tables, and every column is classified.
 *   G3-1  anon, a stranger and the owner are refused every withheld column of
 *         each table: selected, filtered on, or through *.
 *   G3-2  exactly the granted columns stay readable, and each table's row
 *         policy admits and refuses the same rows as before.
 *   G3-3  no write path moved: every INSERT/UPDATE/DELETE privilege, table- or
 *         column-level, is what it was; the owner still updates their own
 *         postcard and attaches media to their own post.
 *   G3-4  the API's role reads every column of the three.
 *   G3-5  the rollback restores the prior SELECT grants exactly and deletes
 *         3363's ledger row; 3363 re-applies to the identical state.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3363_place_copies_client_column_grants.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-09-27-3363-place-copies-client-column-grants-rollback.sql");
const LEDGER_NAME = "3363_place_copies_client_column_grants.sql";

type Table = "pulse_geo_tags" | "passport_postcards" | "post_media";
const TABLES: Table[] = ["pulse_geo_tags", "passport_postcards", "post_media"];

const GRANTED: Record<Table, readonly string[]> = {
  pulse_geo_tags: ["id", "post_id", "user_id", "created_at"],
  passport_postcards: [
    "id", "post_id", "user_id", "media_url", "caption", "stamp_style",
    "stamp_revoked", "stamp_revoked_reason", "stamp_revoked_at",
    "stamp_revoked_by", "visibility", "status", "created_at", "updated_at",
    "deleted_at", "primary_media_type", "media_count", "has_video",
    "pinned_at", "note",
  ],
  post_media: [
    "id", "post_id", "user_id", "media_type", "storage_bucket",
    "storage_path", "public_url", "thumbnail_url", "thumbnail_storage_path",
    "mime_type", "file_size_bytes", "duration_seconds", "width", "height",
    "processing_status", "moderation_status", "sort_order", "created_at",
    "updated_at", "phash", "dedup_processed", "feed_storage_path", "feed_url",
  ],
};
const WITHHELD: Record<Table, readonly string[]> = {
  pulse_geo_tags: [
    "venue_name", "display_label", "district", "city", "country",
    "country_code", "geo_zone_id", "tag_type", "approx_distance_label",
    "location_visibility", "hotel_blur_applied", "source", "confidence_score",
  ],
  passport_postcards: [
    "location_name", "location_city", "location_country",
    "location_verified", "verification_method", "verified_distance_meters",
    "verified_at", "stamp_eligible", "stamp_reason",
  ],
  post_media: ["canonical_place_id", "stamp_overlay"],
};
/** One withheld column per table that a filter-oracle probe names. */
const ORACLE: Record<Table, string> = {
  pulse_geo_tags: "venue_name",
  passport_postcards: "verified_distance_meters",
  post_media: "canonical_place_id",
};

type Who = { role: "anon" } | { role: "authenticated"; uid: string };

let A = ""; // the author / owner
let S = ""; // a stranger
let PUB = ""; // A's public active post
let PRIVPOST = ""; // A's second post, for the private postcard (postcards are unique per post)
let TAG = ""; // the geo tag on PUB
let CARD = ""; // A's public postcard on PUB
let PRIVCARD = ""; // A's private postcard on PRIVPOST
let MEDIA = ""; // a ready, approved post_media row on PUB
let PLACE = ""; // a places row for post_media.canonical_place_id
let IDS: Record<Table, string> = { pulse_geo_tags: "", passport_postcards: "", post_media: "" };

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
function runAs(who: Who, sql: string) {
  return psql(prelude(who) + sql, { single: true });
}
function asOk(who: Who, sql: string): string[] {
  const r = runAs(who, sql);
  assert.equal(r.status, 0, `expected success as ${who.role}:\n${sql}\n${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}
function assertDenied(who: Who, table: Table, sql: string): void {
  const r = runAs(who, sql);
  assert.notEqual(r.status, 0, `expected a refusal as ${who.role}, got success:\n${sql}\n${r.stdout}`);
  assert.match(r.stderr, new RegExp(`permission denied for table ${table}`), `expected a privilege refusal as ${who.role}:\n${sql}\n${r.stderr}`);
}

/** Every column of `table`, probed one statement per column as `who` (SELECT list, or a filter). */
function probe(who: Who, table: Table, rowId: string, filter = false): { readable: string[]; denied: string[] } {
  const stmt = filter
    ? `format('SELECT id FROM public.${table} WHERE %I IS NOT NULL AND id = %L', c, '${rowId}')`
    : `format('SELECT %I FROM public.${table} WHERE id = %L', c, '${rowId}')`;
  const out = asOk(
    who,
    `DO $probe$
     DECLARE c text; readable text[] := '{}'; denied text[] := '{}';
     BEGIN
       FOR c IN SELECT attname::text FROM pg_attribute
                 WHERE attrelid = 'public.${table}'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum LOOP
         BEGIN
           EXECUTE ${stmt};
           readable := readable || c;
         EXCEPTION WHEN insufficient_privilege THEN
           denied := denied || c;
         END;
       END LOOP;
       PERFORM set_config('g3.readable', array_to_string(readable, ','), true);
       PERFORM set_config('g3.denied', array_to_string(denied, ','), true);
     END $probe$;
     SELECT 'R|' || current_setting('g3.readable');
     SELECT 'D|' || current_setting('g3.denied');`,
  );
  const pick = (tag: string) =>
    (out.find((l) => l.startsWith(tag)) ?? tag).slice(tag.length).split(",").filter((s) => s.length > 0).sort();
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

const TABLE_LIST = TABLES.map((t) => `'public.${t}'::regclass`).join(", ");
/**
 * One line of JSON: every privilege on the three tables, table- and
 * column-level, as aclexplode rows; the raw ACL text; the policies; the ledger row.
 */
const SNAPSHOT = `SELECT json_build_object(
  'privs', (SELECT json_agg(p ORDER BY p) FROM (
      SELECT c.relname || '|' || '' || '|' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END
             || '|' || x.privilege_type || '|' || x.is_grantable AS p
        FROM pg_class c, LATERAL aclexplode(c.relacl) x WHERE c.oid IN (${TABLE_LIST})
      UNION ALL
      SELECT c.relname || '|' || a.attname || '|' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END
             || '|' || x.privilege_type || '|' || x.is_grantable
        FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid, LATERAL aclexplode(a.attacl) x
       WHERE c.oid IN (${TABLE_LIST}) AND a.attnum > 0) s),
  'acltext', (SELECT json_agg(c.relname || ' ' || c.relacl::text || ' ' ||
                 coalesce((SELECT string_agg(a.attname || '=' || a.attacl::text, ';' ORDER BY a.attnum)
                             FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND a.attacl IS NOT NULL), '')
                 ORDER BY c.relname) FROM pg_class c WHERE c.oid IN (${TABLE_LIST})),
  'policies', (SELECT json_agg(json_build_array(polrelid::regclass::text, polname, polcmd::text, polpermissive, polroles::regrole[]::text,
                                                pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)) ORDER BY polrelid::regclass::text, polname)
                 FROM pg_policy WHERE polrelid IN (${TABLE_LIST})),
  'ledger', (SELECT count(*) FROM public.schema_migration_ledger WHERE filename = '${LEDGER_NAME}')
)::text;`;

describe("census-media §44.11 — 3363: the place columns of pulse_geo_tags, passport_postcards and post_media", { skip: !HAVE_DB }, () => {
  before(() => {
    A = seedUser("g3author");
    S = seedUser("g3stranger");
    PUB = randomUUID();
    PRIVPOST = randomUUID();
    TAG = randomUUID();
    CARD = randomUUID();
    PRIVCARD = randomUUID();
    MEDIA = randomUUID();
    PLACE = randomUUID();
    IDS = { pulse_geo_tags: TAG, passport_postcards: CARD, post_media: MEDIA };
    exec(`INSERT INTO public.places (id, name, normalized_name) VALUES ('${PLACE}', 'G3 Place', 'g3 place');
          INSERT INTO public.posts (id, author_id, content, visibility, status)
            VALUES ('${PUB}', '${A}', 'g3 public', 'public', 'active'),
                   ('${PRIVPOST}', '${A}', 'g3 second', 'public', 'active');
          INSERT INTO public.pulse_geo_tags (id, post_id, user_id, tag_type, display_label, source, confidence_score,
              location_visibility, city, district, country, country_code, venue_name, approx_distance_label, hotel_blur_applied)
            VALUES ('${TAG}', '${PUB}', '${A}', 'venue', 'G3 Label', 'gps', 0.9,
              'exact', 'Paris', 'Le Marais', 'France', 'FR', 'G3 Tag Venue', '200 m', true);
          INSERT INTO public.passport_postcards (id, post_id, user_id, media_url, caption, location_name, location_city,
              location_country, location_verified, stamp_eligible, stamp_reason, verification_method,
              verified_distance_meters, verified_at, visibility, status)
            VALUES ('${CARD}', '${PUB}', '${A}', 'post-media/${A}/g3.jpg', 'g3 card', 'G3 Postcard Venue', 'Paris',
              'France', true, true, 'gps_within_radius', 'gps_current_location',
              12.5, now(), 'public', 'active'),
                   ('${PRIVCARD}', '${PRIVPOST}', '${A}', NULL, 'g3 private card', 'G3 Private Venue', 'Paris',
              'France', false, false, NULL, 'manual_only', NULL, NULL, 'private', 'active');
          INSERT INTO public.post_media (id, post_id, user_id, media_type, mime_type, storage_path, processing_status,
              moderation_status, canonical_place_id, stamp_overlay)
            VALUES ('${MEDIA}', '${PUB}', '${A}', 'image', 'image/jpeg', '${A}/g3-${MEDIA}.jpg', 'ready',
              'approved', '${PLACE}', '{"label":"G3 Stamp","city":"Paris","country":"France"}'::jsonb);`);
  });

  after(() => {
    if (!A) return;
    exec(`DELETE FROM public.post_media WHERE user_id IN ('${A}', '${S}');
          DELETE FROM public.passport_postcards WHERE user_id IN ('${A}', '${S}');
          DELETE FROM public.pulse_geo_tags WHERE user_id IN ('${A}', '${S}');
          DELETE FROM public.posts WHERE author_id IN ('${A}', '${S}');
          DELETE FROM public.places WHERE id = '${PLACE}';`);
    for (const u of [A, S]) if (u) deleteUser(u);
  });

  const cols = (t: Table) =>
    rows<{ attname: string }>(
      `SELECT attname FROM pg_attribute WHERE attrelid = 'public.${t}'::regclass AND attnum > 0 AND NOT attisdropped`,
    ).map((r) => r.attname).sort();
  const everyone = (): Who[] => [{ role: "anon" }, { role: "authenticated", uid: S }, { role: "authenticated", uid: A }];

  it("G3-0 — 3363 is in force on all three tables, and every column is classified once", () => {
    for (const t of TABLES) {
      const tableSelect = rows<{ g: string }>(
        `SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END AS g
           FROM pg_class c, LATERAL aclexplode(c.relacl) x
          WHERE c.oid = 'public.${t}'::regclass AND x.privilege_type = 'SELECT'
            AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))`,
      );
      assert.deepEqual(tableSelect, [], `${t}: no client role or PUBLIC may hold table-level SELECT`);
      assert.deepEqual(cols(t), [...GRANTED[t], ...WITHHELD[t]].sort(), `${t}: every column is granted or withheld, once`);
    }
  });

  it("G3-1 — anon, a stranger and the owner are refused every withheld column: selected, filtered on, or through *", () => {
    for (const t of TABLES) {
      for (const who of everyone()) {
        const label = `${t} as ${who.role}${"uid" in who ? ` ${who.uid === A ? "(owner)" : "(stranger)"}` : ""}`;
        const sel = probe(who, t, IDS[t]);
        assert.deepEqual(sel.denied, [...WITHHELD[t]].sort(), `${label}: exactly the withheld columns are refused`);
        const flt = probe(who, t, IDS[t], true);
        assert.deepEqual(flt.denied, [...WITHHELD[t]].sort(), `${label}: a filter on a withheld column is refused`);
        assertDenied(who, t, `SELECT * FROM public.${t} WHERE id = '${IDS[t]}';`);
        assertDenied(who, t, `SELECT id FROM public.${t} WHERE ${ORACLE[t]} IS NOT NULL;`);
      }
    }
    // Anti-vacuity: the values are there to be refused.
    assert.equal(scalar(`SELECT venue_name || '|' || district || '|' || hotel_blur_applied FROM public.pulse_geo_tags WHERE id = '${TAG}'`), "G3 Tag Venue|Le Marais|true");
    assert.equal(scalar(`SELECT location_name || '|' || verified_distance_meters FROM public.passport_postcards WHERE id = '${CARD}'`), "G3 Postcard Venue|12.5");
    assert.equal(scalar(`SELECT canonical_place_id || '|' || (stamp_overlay ->> 'label') FROM public.post_media WHERE id = '${MEDIA}'`), `${PLACE}|G3 Stamp`);
  });

  it("G3-2 — exactly the granted columns stay readable, and each row policy admits and refuses the same rows", () => {
    for (const t of TABLES) {
      for (const who of everyone()) {
        assert.deepEqual(probe(who, t, IDS[t]).readable, [...GRANTED[t]].sort(), `${t} as ${who.role}: exactly the granted columns`);
        assert.deepEqual(asOk(who, `SELECT count(*) FROM (SELECT ${GRANTED[t].join(", ")} FROM public.${t} WHERE id = '${IDS[t]}') x;`), ["1"]);
      }
    }
    // pulse_geo_tags: `USING (true)` — every role sees the tag.
    for (const who of everyone()) assert.deepEqual(asOk(who, `SELECT id FROM public.pulse_geo_tags WHERE id = '${TAG}';`), [TAG]);
    // passport_postcards: can_see_postcard — the public card to all, the private one to its owner only.
    const cards = [CARD, PRIVCARD].map((i) => `'${i}'`).join(",");
    assert.deepEqual(asOk({ role: "anon" }, `SELECT id FROM public.passport_postcards WHERE id IN (${cards});`), [CARD]);
    assert.deepEqual(asOk({ role: "authenticated", uid: S }, `SELECT id FROM public.passport_postcards WHERE id IN (${cards});`), [CARD]);
    assert.deepEqual(asOk({ role: "authenticated", uid: A }, `SELECT id FROM public.passport_postcards WHERE id IN (${cards}) ORDER BY id;`), [CARD, PRIVCARD].sort());
    // post_media_public_select (which also reads posts, under 3362's grants): the ready media of a public post, to all.
    for (const who of everyone()) assert.deepEqual(asOk(who, `SELECT id FROM public.post_media WHERE id = '${MEDIA}';`), [MEDIA]);
  });

  it("G3-3 — no write path moved: every non-SELECT privilege is unchanged, and the owner's writes still pass their policies", () => {
    const out = exec(`BEGIN;\n${SNAPSHOT}\n${unwrapped(ROLLBACK)}\n${SNAPSHOT}\nROLLBACK;`);
    const [now, rolled] = out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    const nonSelect = (privs: string[]) => privs.filter((p) => p.split("|")[3] !== "SELECT");
    assert.ok(nonSelect(now.privs).length > 0, "anti-vacuity: the tables carry write privileges to compare");
    assert.deepEqual(nonSelect(now.privs), nonSelect(rolled.privs), "the rollback moves no INSERT/UPDATE/DELETE/… privilege");
    // And 3363 moved none: the client roles' write privileges are exactly the ones
    // 2151/2152 (postcards) and 2158 (post_media) left. UPDATED ON PURPOSE by 3364
    // (census-media §44.18): pulse_geo_tags' GRANT ALL, pinned here before as the
    // write gap §44.16 recorded, is revoked, so no client role writes it any more.
    const pmIns = ["post_id", "user_id", "media_type", "storage_bucket", "storage_path", "public_url", "thumbnail_url",
      "thumbnail_storage_path", "mime_type", "file_size_bytes", "duration_seconds", "width", "height", "sort_order"];
    const pcUpd = ["media_url", "caption", "location_name", "location_city", "location_country", "visibility", "pinned_at", "note"];
    const expectedWrites = [
      ...pmIns.map((c) => `post_media|${c}|authenticated|INSERT|false`),
      ...pmIns.filter((c) => c !== "post_id" && c !== "user_id").map((c) => `post_media|${c}|authenticated|UPDATE|false`),
      ...["post_id", "user_id", ...pcUpd].map((c) => `passport_postcards|${c}|authenticated|INSERT|false`),
      ...pcUpd.map((c) => `passport_postcards|${c}|authenticated|UPDATE|false`),
      // (was: pulse_geo_tags' six table-level writes for anon and authenticated, until 3364)
      ...([] as string[]),
    ].sort();
    const clientWrites = nonSelect(now.privs).filter((p: string) => ["anon", "authenticated", "PUBLIC"].includes(p.split("|")[2]!));
    assert.deepEqual([...clientWrites].sort(), expectedWrites, "the client roles' write privileges are exactly 2151/2152's and 2158's: 3363 moved none, 3364 removed pulse_geo_tags'");
    // The owner updates their own postcard's note (column UPDATE from 2151) …
    asOk({ role: "authenticated", uid: A }, `UPDATE public.passport_postcards SET note = 'g3 owner note' WHERE id = '${CARD}';`);
    assert.equal(scalar(`SELECT note FROM public.passport_postcards WHERE id = '${CARD}'`), "g3 owner note");
    // … and a stranger's identical UPDATE matches no row (the policy, not a privilege).
    asOk({ role: "authenticated", uid: S }, `UPDATE public.passport_postcards SET note = 'g3 stranger' WHERE id = '${CARD}';`);
    assert.equal(scalar(`SELECT note FROM public.passport_postcards WHERE id = '${CARD}'`), "g3 owner note");
    // The owner still attaches media to their own post (column INSERT from 2158, owner policy's WITH CHECK),
    // and reads back what postMediaModerationBoundary.test.ts's live insert selects (id, moderation_status, processing_status).
    const path = `${A}/g3-own-${randomUUID()}.jpg`;
    const back = asOk({ role: "authenticated", uid: A },
      `INSERT INTO public.post_media (post_id, user_id, media_type, mime_type, storage_path)
       VALUES ('${PUB}', '${A}', 'image', 'image/jpeg', '${path}')
       RETURNING moderation_status || '|' || processing_status || '|' || (id IS NOT NULL);`);
    assert.deepEqual(back, ["pending|pending|true"]);
    assert.equal(scalar(`SELECT count(*) FROM public.post_media WHERE storage_path = '${path}'`), "1");
  });

  it("G3-4 — the API's role reads every column of the three", () => {
    for (const t of TABLES) {
      const n = scalar(`SELECT count(*) FILTER (WHERE has_column_privilege('service_role', attrelid, attnum, 'SELECT')) || '/' || count(*)
                          FROM pg_attribute WHERE attrelid = 'public.${t}'::regclass AND attnum > 0 AND NOT attisdropped`);
      const total = cols(t).length;
      assert.equal(n, `${total}/${total}`, `service_role reads every column of ${t}`);
    }
    const svc = exec(`SET LOCAL ROLE service_role;
      SELECT (SELECT venue_name FROM public.pulse_geo_tags WHERE id = '${TAG}') || '|' ||
             (SELECT location_name FROM public.passport_postcards WHERE id = '${CARD}') || '|' ||
             (SELECT stamp_overlay ->> 'label' FROM public.post_media WHERE id = '${MEDIA}');`, { single: true });
    assert.deepEqual(svc, ["G3 Tag Venue|G3 Postcard Venue|G3 Stamp"]);
  });

  it("G3-5 — the rollback restores the prior SELECT grants exactly and deletes 3363's ledger row; 3363 re-applies identically", () => {
    const out = exec(`BEGIN;
      INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes)
        VALUES ('${LEDGER_NAME}', 'test', 'manual', 'placeCopiesClientColumnGrants.db.test.ts')
        ON CONFLICT (filename) DO NOTHING;
      ${SNAPSHOT}
      ${unwrapped(ROLLBACK)}
      ${SNAPSHOT}
      ${unwrapped(MIGRATION)}
      ${SNAPSHOT}
      ROLLBACK;`);
    const [now, rolled, reapplied] = out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    assert.ok(now && rolled && reapplied, "three snapshots");
    assert.equal(now.ledger, 1, "anti-vacuity: the ledger row the runner writes is there before the rollback");
    assert.equal(rolled.ledger, 0, "the rollback deletes 3363's ledger row");
    // The prior state is fully determined: 3363 touched only the client roles' SELECT.
    // Rolled back = today's privileges, minus every client-role column SELECT,
    // plus table-level SELECT for anon and authenticated, nothing else.
    const isClientColSelect = (p: string) => {
      const [, col, who, priv] = p.split("|");
      return col !== "" && priv === "SELECT" && (who === "anon" || who === "authenticated");
    };
    const expected = [
      ...now.privs.filter((p: string) => !isClientColSelect(p)),
      ...TABLES.flatMap((t) => [`${t}||anon|SELECT|false`, `${t}||authenticated|SELECT|false`]),
    ].sort();
    assert.deepEqual([...rolled.privs].sort(), expected, "the rollback restores exactly the pre-3363 privilege set");
    assert.deepEqual(reapplied.privs, now.privs, "3363 after the rollback grants exactly what it granted");
    assert.deepEqual(reapplied.acltext, now.acltext, "… and leaves the ACLs byte-identical");
    assert.deepEqual(rolled.policies, now.policies, "the rollback changes no policy");
    assert.deepEqual(reapplied.policies, now.policies, "3363 changes no policy");
    // The database is untouched by this test.
    assert.deepEqual(JSON.parse(exec(SNAPSHOT)[0]!).acltext, now.acltext);
  });
});
