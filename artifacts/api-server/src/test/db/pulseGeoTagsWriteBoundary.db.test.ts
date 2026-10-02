/**
 * pulseGeoTagsWriteBoundary — census-media §44.18 (lane G1): migration 3364 and
 * its rollback, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/pulseGeoTagsWriteBoundary.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT (census-media §44.16, item 1): anon and authenticated could write
 * pulse_geo_tags, and its policies check only `auth.uid() = user_id` — never
 * that the post is the caller's. A signed-in stranger could attach a geo tag,
 * with any venue, to another author's untagged post; Pulse serves its venue.
 * The one writer is the API, as service_role. 3364 revokes every write
 * privilege from anon, authenticated and PUBLIC.
 *
 * THE TWO STARTING SHAPES (census-media §44.15.1, §44.18.2)
 *   tree        the chain as replayed here: GRANT ALL (2490 cannot replay on
 *               PostgreSQL 16), 3363's column SELECT.
 *   production  as the integrator read it on 2026-09-27: SELECT, INSERT,
 *               UPDATE, DELETE — 2490 removed TRUNCATE/REFERENCES/TRIGGER —
 *               and 3363 not applied. Rebuilt here inside a rolled-back
 *               transaction.
 *
 * PROPERTIES (each seen red with the migration or rollback mutated; §44.18.4)
 *   G4-0  3364 is in force: no client role or PUBLIC holds a write privilege,
 *         and the comment carries the ACL record the rollback restores from.
 *   G4-1  the stranger's forged tag on another author's post is refused — and
 *         admitted with 3364 rolled back, so the property detects the defect.
 *   G4-2  the author's own direct writes (INSERT, UPDATE, DELETE), anon's, and
 *         TRUNCATE are refused.
 *   G4-3  the service role still writes: the writer's two INSERT shapes,
 *         UPDATE and DELETE.
 *   G4-4  SELECT and the policies are untouched: 3363's four columns stay
 *         readable, the rest stay refused, every row stays visible.
 *   G4-5  the rollback round-trips byte-identically on both shapes, restores
 *         no privilege the shape did not hold, and deletes 3364's ledger row;
 *         3364 re-applies identically.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3364_pulse_geo_tags_write_boundary.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-09-27-3364-pulse-geo-tags-write-boundary-rollback.sql");
const ROLLBACK_3363 = resolve(__dir, "../../../../../db/rollback/2026-09-27-3363-place-copies-client-column-grants-rollback.sql");
const LEDGER_NAME = "3364_pulse_geo_tags_write_boundary.sql";
/** 3363's grant on pulse_geo_tags. */
const READABLE = ["created_at", "id", "post_id", "user_id"];

type Who = { role: "anon" } | { role: "authenticated"; uid: string };

let A = ""; // an author whose post is tagged
let S = ""; // a stranger
let TAGGED = ""; // A's post, tagged by the API
let UNTAGGED = ""; // A's second post, not tagged yet (the forgery target)
let TAG = "";

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
function assertDenied(who: Who, sql: string): void {
  const r = runAs(who, sql);
  assert.notEqual(r.status, 0, `expected a refusal as ${who.role}, got success:\n${sql}\n${r.stdout}`);
  assert.match(r.stderr, /permission denied for table pulse_geo_tags/, `expected a privilege refusal as ${who.role}:\n${sql}\n${r.stderr}`);
}

/** The file's body and its trailing postconditions, without its BEGIN/COMMIT. */
function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

/** Inside a transaction, as the harness superuser: the production shape of pulse_geo_tags (§44.15.1). */
const TO_PRODUCTION_SHAPE = () =>
  `${unwrapped(ROLLBACK)}\n${unwrapped(ROLLBACK_3363)}\n` +
  `REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.pulse_geo_tags FROM anon, authenticated;\n`;

/** One line of JSON: pulse_geo_tags' ACL, column ACLs, comment, policies and 3364's ledger row. */
const SNAPSHOT = `SELECT json_build_object(
  'relacl', (SELECT relacl::text FROM pg_class WHERE oid = 'public.pulse_geo_tags'::regclass),
  'attacl', (SELECT coalesce(string_agg(attname || '=' || attacl::text, ';' ORDER BY attnum), '') FROM pg_attribute
              WHERE attrelid = 'public.pulse_geo_tags'::regclass AND attnum > 0 AND attacl IS NOT NULL),
  'comment', obj_description('public.pulse_geo_tags'::regclass, 'pg_class'),
  'policies', (SELECT json_agg(json_build_array(polname, polcmd::text, polpermissive, polroles::regrole[]::text,
                                                pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)) ORDER BY polname)
                 FROM pg_policy WHERE polrelid = 'public.pulse_geo_tags'::regclass),
  'clientWrites', (SELECT coalesce(json_agg(r || ':' || p ORDER BY r, p), '[]'::json)
                     FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                    WHERE has_table_privilege(r, 'public.pulse_geo_tags', p)
                       OR (p IN ('INSERT','UPDATE','REFERENCES') AND has_any_column_privilege(r, 'public.pulse_geo_tags', p))),
  'ledger', (SELECT count(*) FROM public.schema_migration_ledger WHERE filename = '${LEDGER_NAME}')
)::text;`;
const snaps = (out: string[]) => out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

const forge = (uid: string, post: string) =>
  `INSERT INTO public.pulse_geo_tags (post_id, user_id, venue_name, location_visibility, hotel_blur_applied)
   VALUES ('${post}', '${uid}', 'Forged Venue', 'exact', false);`;

describe("census-media §44.18 — 3364: no client role writes pulse_geo_tags", { skip: !HAVE_DB }, () => {
  before(() => {
    A = seedUser("g4author");
    S = seedUser("g4stranger");
    TAGGED = randomUUID();
    UNTAGGED = randomUUID();
    TAG = randomUUID();
    exec(`INSERT INTO public.posts (id, author_id, content, visibility, status)
            VALUES ('${TAGGED}', '${A}', 'g4 tagged', 'public', 'active'),
                   ('${UNTAGGED}', '${A}', 'g4 untagged', 'public', 'active');
          SET LOCAL ROLE service_role;
          INSERT INTO public.pulse_geo_tags (id, post_id, user_id, location_visibility, city, country, venue_name, hotel_blur_applied)
            VALUES ('${TAG}', '${TAGGED}', '${A}', 'city', 'Paris', 'France', 'G4 Real Venue', false);`, { single: true });
  });

  after(() => {
    if (!A) return;
    exec(`DELETE FROM public.pulse_geo_tags WHERE post_id IN ('${TAGGED}', '${UNTAGGED}');
          DELETE FROM public.posts WHERE author_id IN ('${A}', '${S}');`);
    for (const u of [A, S]) if (u) deleteUser(u);
  });

  it("G4-0 — 3364 is in force: no client role or PUBLIC holds a write privilege, and the ACL record is there", () => {
    const [now] = snaps(exec(SNAPSHOT));
    assert.deepEqual(now.clientWrites, [], "anon and authenticated hold no write privilege on pulse_geo_tags");
    assert.equal(scalar(`SELECT count(*) FROM pg_class c, LATERAL aclexplode(c.relacl) x
                          WHERE c.oid = 'public.pulse_geo_tags'::regclass AND x.grantee = 0`), "0", "PUBLIC holds nothing");
    assert.match(String(now.comment), /ACL before 3364, which its rollback restores: \{[^}]*authenticated=[a-zA-Z]*a[a-zA-Z]*\/[a-z_]+[^}]*\}$/,
      "the recorded pre-3364 ACL, with authenticated's INSERT, ends the table comment");
  });

  it("G4-1 — the stranger's forged tag on another author's post is refused, and admitted with 3364 rolled back", () => {
    assertDenied({ role: "authenticated", uid: S }, forge(S, UNTAGGED));
    assert.equal(scalar(`SELECT count(*) FROM public.pulse_geo_tags WHERE post_id = '${UNTAGGED}'`), "0");
    // The defect, shown in the same database with 3364 rolled back (and the transaction discarded):
    const out = exec(`BEGIN;
      ${unwrapped(ROLLBACK)}
      ${prelude({ role: "authenticated", uid: S })}
      ${forge(S, UNTAGGED)}
      RESET ROLE;
      SELECT 'forged=' || venue_name || '|by-stranger=' || (user_id = '${S}') FROM public.pulse_geo_tags WHERE post_id = '${UNTAGGED}';
      ROLLBACK;`);
    assert.ok(out.includes(`forged=Forged Venue|by-stranger=true`), `without 3364 the stranger's tag is written:\n${out.join("\n")}`);
    assert.equal(scalar(`SELECT count(*) FROM public.pulse_geo_tags WHERE post_id = '${UNTAGGED}'`), "0");
  });

  it("G4-2 — the author's own direct writes, anon's, and TRUNCATE are refused", () => {
    const author: Who = { role: "authenticated", uid: A };
    assertDenied(author, forge(A, UNTAGGED));
    assertDenied(author, `UPDATE public.pulse_geo_tags SET venue_name = 'Rewritten', hotel_blur_applied = false WHERE id = '${TAG}';`);
    assertDenied(author, `DELETE FROM public.pulse_geo_tags WHERE id = '${TAG}';`);
    assertDenied({ role: "anon" }, forge(A, UNTAGGED));
    for (const who of [author, { role: "anon" } as Who]) assertDenied(who, `TRUNCATE public.pulse_geo_tags;`);
    assert.equal(scalar(`SELECT venue_name FROM public.pulse_geo_tags WHERE id = '${TAG}'`), "G4 Real Venue");
  });

  it("G4-3 — the service role still writes: the writer's two INSERT shapes, UPDATE and DELETE", () => {
    const out = exec(`SET LOCAL ROLE service_role;
      INSERT INTO public.pulse_geo_tags (post_id, user_id, location_visibility, hotel_blur_applied)
        VALUES ('${UNTAGGED}', '${A}', 'no_location', false);
      SELECT 'stub=' || location_visibility FROM public.pulse_geo_tags WHERE post_id = '${UNTAGGED}';
      DELETE FROM public.pulse_geo_tags WHERE post_id = '${UNTAGGED}';
      INSERT INTO public.pulse_geo_tags (post_id, user_id, location_visibility, city, district, country, country_code, venue_name, hotel_blur_applied)
        VALUES ('${UNTAGGED}', '${A}', 'neighborhood', 'Paris', NULL, 'France', 'FR', 'G4 Venue', true);
      UPDATE public.pulse_geo_tags SET venue_name = 'G4 Venue 2' WHERE post_id = '${UNTAGGED}';
      SELECT 'tag=' || venue_name || '|' || hotel_blur_applied FROM public.pulse_geo_tags WHERE post_id = '${UNTAGGED}';
      DELETE FROM public.pulse_geo_tags WHERE post_id = '${UNTAGGED}';
      SELECT 'left=' || count(*) FROM public.pulse_geo_tags WHERE post_id = '${UNTAGGED}';`, { single: true });
    assert.deepEqual(out, ["stub=no_location", "tag=G4 Venue 2|true", "left=0"]);
  });

  it("G4-4 — SELECT and the policies are untouched: 3363's four columns stay readable, every row stays visible", () => {
    for (const who of [{ role: "anon" }, { role: "authenticated", uid: S }, { role: "authenticated", uid: A }] as Who[]) {
      const readable = rows<{ attname: string }>(
        `SELECT attname FROM pg_attribute WHERE attrelid = 'public.pulse_geo_tags'::regclass AND attnum > 0 AND NOT attisdropped
            AND has_column_privilege('${who.role}', attrelid, attnum, 'SELECT') ORDER BY attname`,
      ).map((r) => r.attname);
      assert.deepEqual(readable, READABLE, `${who.role}: exactly 3363's columns`);
      assert.deepEqual(asOk(who, `SELECT post_id FROM public.pulse_geo_tags WHERE id = '${TAG}';`), [TAGGED]);
    }
    const out = exec(`BEGIN;\n${SNAPSHOT}\n${unwrapped(ROLLBACK)}\n${SNAPSHOT}\nROLLBACK;`);
    const [now, rolled] = snaps(out);
    assert.equal(now.policies.length, 5, "pulse_geo_tags keeps its five policies");
    assert.deepEqual(rolled.policies, now.policies, "3364 changes no policy");
    assert.equal(rolled.attacl, now.attacl, "3364 changes no column ACL (3363's SELECT)");
  });

  it("G4-5 — the rollback round-trips byte-identically on both shapes, never widens, and deletes the ledger row", () => {
    // Tree shape: the database as it stands, rolled back and re-applied.
    const tree = snaps(exec(`BEGIN;
      INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes)
        VALUES ('${LEDGER_NAME}', 'test', 'manual', 'pulseGeoTagsWriteBoundary.db.test.ts') ON CONFLICT (filename) DO NOTHING;
      ${SNAPSHOT}
      ${unwrapped(ROLLBACK)}
      ${SNAPSHOT}
      ${unwrapped(MIGRATION)}
      ${SNAPSHOT}
      ROLLBACK;`));
    const [now, rolled, reapplied] = tree;
    assert.ok(now && rolled && reapplied, "three snapshots");
    assert.equal(now.ledger, 1, "anti-vacuity: the ledger row the runner writes is there");
    assert.equal(rolled.ledger, 0, "the rollback deletes 3364's ledger row");
    const recorded = String(now.comment).match(/ACL before 3364, which its rollback restores: (\{[^}]*\})$/)![1];
    assert.equal(rolled.relacl, recorded, "the rollback restores the recorded ACL, byte for byte");
    assert.equal(rolled.comment, null, "the comment returns to what it was (none)");
    assert.deepEqual(rolled.clientWrites.length, 12, "tree shape: GRANT ALL's six writes, for both roles");
    assert.deepEqual(reapplied, { ...now, ledger: 0 }, "3364 after its rollback is the state 3364 left");

    // Production shape: built from the tree inside the transaction, then 3364 and its rollback.
    const prod = snaps(exec(`BEGIN;
      ${TO_PRODUCTION_SHAPE()}
      ${SNAPSHOT}
      ${unwrapped(MIGRATION)}
      ${SNAPSHOT}
      ${unwrapped(ROLLBACK)}
      ${SNAPSHOT}
      ROLLBACK;`));
    const [pre, applied, back] = prod;
    assert.deepEqual(pre.clientWrites, ["anon:DELETE", "anon:INSERT", "anon:UPDATE", "authenticated:DELETE", "authenticated:INSERT", "authenticated:UPDATE"],
      "anti-vacuity: the production shape is what the integrator read");
    assert.deepEqual(applied.clientWrites, [], "3364 closes the production shape too");
    assert.equal(back.relacl, pre.relacl, "production shape: the rollback restores the ACL byte for byte");
    assert.equal(back.attacl, pre.attacl);
    assert.equal(back.comment, pre.comment);
    assert.deepEqual(back.clientWrites, pre.clientWrites, "…and never widens: no TRUNCATE, REFERENCES or TRIGGER comes back");

    // The database is untouched by this test.
    assert.deepEqual(snaps(exec(SNAPSHOT))[0], { ...now, ledger: 0 });
  });
});
