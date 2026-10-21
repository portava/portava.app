/**
 * census-telegraph T220 §15 "No subsystem may independently 'rediscover' a blocked relationship" — the SQL layer's
 * three inline block checks move onto the definition of record, authz.is_blocked (independent verification pass 4's
 * boundary note; docs/ops/wave5-owner-decisions-20261018.md "Migrations"):
 *
 *   3903  public.project_user_memory      (2963 as amended by 2965)  — behaviour identical, by construction and executed
 *   3904  public.memory_public_feed       (2338)                     — behaviour identical, by construction and executed
 *   3905  post_media_public_select policy (2337)                     — the inline check was HALF BLIND (it ran through
 *                                                                      blocks' own RLS); a person the media's owner
 *                                                                      blocked now stops reading it. Nothing else moves.
 *
 * WHAT WOULD TURN THIS RED
 *   - any change outside the block predicate (another arm of the policy, a lane of the projector, a predicate, the ACL,
 *     SECURITY INVOKER, the signature) — checked on the text AND on what the functions return / the policy admits;
 *   - 3905 leaving the owner-blocked-the-viewer direction open, or closing anything else;
 *   - a file that is not re-runnable, whose postcondition is not load-bearing, or that writes over an installed
 *     definition it was not measured against.
 *
 * EXECUTED on PGlite (PostgreSQL 16.4 in-process; the repo's convention) over production's own baseline definitions of
 * the touched tables (baseline/20260819_baseline_structure.sql, extracted verbatim) and the REAL dependency files —
 * 2182 (is_blocked moved to authz), 2963 + 2965 (the projector), 2338 (the feed), 2337's post_media policy — not
 * restatements of them. Roles, auth.uid() and authz.is_trip_crew are stand-ins (named below).
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/sqlBlockChecksOfRecordMigrations.test.ts
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { postconditionBlocks, maskForKeywordScan } from "../scripts/lib/migrationSqlBlocks.js";

const mig = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8");
const F3903 = "3903_project_user_memory_block_check_of_record.sql";
const F3904 = "3904_memory_public_feed_block_check_of_record.sql";
const F3905 = "3905_post_media_public_select_block_check_of_record.sql";
const S3903 = mig(F3903);
const S3904 = mig(F3904);
const S3905 = mig(F3905);
const S2182 = mig("2182_close_authz_rpc_oracle.sql");
const S2337 = mig("2337_trip_crew_rls_membership_convergence.sql");
const S2338 = mig("2338_memory_location_precision.sql");
const S2963 = mig("2963_memory_projector_place_lane_union.sql");
const S2965 = mig("2965_memory_projector_canon_saves_delete_guard.sql");
const S2193 = mig("2193_memory_projector_provenance.sql");
const BASE = readFileSync(new URL("../../baseline/20260819_baseline_structure.sql", import.meta.url), "utf8");

// ── verbatim extraction ───────────────────────────────────────────────────────
function slice(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `${what}: no "${start}"`);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j > i, `${what}: no end "${JSON.stringify(end)}" after "${start}"`);
  return src.slice(i, j + end.length);
}
const baseTable = (t: string) => slice(BASE, `CREATE TABLE public.${t} (`, "\n);\n", `baseline ${t}`);
const baseType = (t: string) => slice(BASE, `CREATE TYPE public.${t} AS ENUM (`, "\n);\n", `baseline type ${t}`);
const baseLine = (start: string) => slice(BASE, start, "\n", `baseline "${start}"`);
/** 2182's applied body: everything between its first BEGIN; and COMMIT; (its verification section after is not part of an apply). */
const body2182 = slice(S2182, "\nBEGIN;\n", "\nCOMMIT;\n", "2182");
/** 2337's LANE F statements for post_media, verbatim. */
const policy2337 = slice(S2337, 'DROP POLICY IF EXISTS "post_media_public_select" ON public.post_media;', "\n  );\n", "2337 post_media policy");
/** The projector's ACL as 2193 last stated it. */
const acl2193 = [slice(S2193, "REVOKE ALL ON FUNCTION public.project_user_memory(uuid, boolean)", "\n", "2193 revoke"), slice(S2193, "GRANT EXECUTE ON FUNCTION public.project_user_memory(uuid, boolean)", "\n", "2193 grant")].join("\n");
const recipe = (sql: string) => sql.slice(sql.indexOf("-- ROLLBACK"), sql.indexOf("\nBEGIN;\n")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
const ws = (s: string) => s.replace(/\s+/g, " ").trim();

// ── the shared fixture: roles, auth.uid(), blocks with its baseline RLS, is_blocked moved by 2182 ─────────────────
const ROLES = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;`;
const BLOCKS = () => `
  ${baseTable("blocks")}
  ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;
  ${baseLine("CREATE POLICY blocks_select_own ON public.blocks")}
  ${baseLine("CREATE POLICY users_view_own_blocks ON public.blocks")}
  ${baseLine("GRANT ALL ON TABLE public.blocks TO anon;")}
  ${baseLine("GRANT ALL ON TABLE public.blocks TO authenticated;")}
  ${baseLine("GRANT ALL ON TABLE public.blocks TO service_role;")}
  ${slice(BASE, "CREATE FUNCTION public.is_blocked(a uuid, b uuid) RETURNS boolean", "\n$$;\n", "baseline is_blocked")}
  ${baseLine("GRANT ALL ON FUNCTION public.is_blocked(a uuid, b uuid) TO anon;")}
  ${baseLine("GRANT ALL ON FUNCTION public.is_blocked(a uuid, b uuid) TO authenticated;")}
  ${baseLine("GRANT ALL ON FUNCTION public.is_blocked(a uuid, b uuid) TO service_role;")}
  -- stand-ins with 2182's other two signatures (their bodies are not under test)
  CREATE FUNCTION public.in_accepted_circle(viewer uuid, target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT false $$;
  CREATE FUNCTION public.can_see_location(viewer uuid, target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $$ SELECT in_accepted_circle(viewer, target) $$;
  ${body2182.replace(/^\nBEGIN;\n/, "").replace(/\nCOMMIT;\n$/, "")}`;

type DB = { exec(s: string): Promise<unknown>; query(s: string, p?: unknown[]): Promise<{ rows: any[] }>; close(): Promise<void> };
async function pglite(): Promise<DB> {
  const { PGlite } = await import(process.env.DISCOVERY_PGLITE_MODULE ?? "@electric-sql/pglite");
  return new PGlite() as DB;
}
const one = async (db: DB, s: string) => (await db.query(s)).rows[0];
async function refuses(db: DB, sql: string, re: RegExp) {
  await assert.rejects(db.exec(sql), (e: any) => { assert.match(String(e?.message), re); return true; });
  await db.exec("ROLLBACK").catch(() => undefined); // the file's BEGIN is left open on this single session; psql would discard it at exit
}
const U = (n: number) => `39030000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ═════════════════════════════════════════════════════════════════════════════
// static: one transaction, $pre$ first, ONE re-runnable postcondition after the COMMIT, no data written
// ═════════════════════════════════════════════════════════════════════════════
describe("3903–3905 — static shape", () => {
  for (const [f, s] of [[F3903, S3903], [F3904, S3904], [F3905, S3905]] as const) {
    it(`${f}: one transaction; $pre$ first; one assertion-only postcondition after the COMMIT; no row written`, () => {
      assert.equal((s.match(/^BEGIN;$/gm) ?? []).length, 1);
      assert.equal((s.match(/^COMMIT;$/gm) ?? []).length, 1);
      assert.ok(s.indexOf("DO $pre$") > s.indexOf("\nBEGIN;\n"));
      const post = postconditionBlocks(s);
      assert.equal(post.length, 1, "exactly one re-runnable postcondition");
      assert.ok(s.indexOf(post[0]!.text) > s.lastIndexOf("\nCOMMIT;\n"));
      assert.doesNotMatch(maskForKeywordScan(s), /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i, "no data is written");
      assert.doesNotMatch(maskForKeywordScan(s), /CONCURRENTLY/i);
    });
  }

  it("3905's policy is 2337's, word for word, with the one block conjunct replaced", () => {
    const createOf = (src: string) => ws(slice(src, 'CREATE POLICY "post_media_public_select" ON public.post_media', "\n  );\n", "create"));
    const before = createOf(S2337);
    const after = createOf(S3905);
    const OLD = ws(`AND NOT EXISTS (
        SELECT 1 FROM public.blocks b
         WHERE (b.blocker_id = auth.uid() AND b.blocked_id = post_media.user_id)
            OR (b.blocker_id = post_media.user_id AND b.blocked_id = auth.uid())
      )`);
    const NEW = "AND NOT authz.is_blocked(auth.uid(), post_media.user_id)";
    assert.equal(before.split(OLD).length, 2, "anti-vacuity: 2337 carries the inline check once");
    assert.equal(after, before.replace(OLD, NEW));
  });

  it("3905's measured texts are 2337's and its own CREATE POLICY, so the in-server comparison compares the right things", () => {
    const using = (src: string) => ws(slice(src, 'CREATE POLICY "post_media_public_select" ON public.post_media', "\n  );\n", "create").replace(/^[\s\S]*?FOR SELECT USING \(/, "").replace(/\);\s*$/, ""));
    const constant = (tag: string) => ws(slice(S3905, `$${tag}$`, `$${tag}$;`, tag).slice(tag.length + 2, -(tag.length + 3)));
    assert.equal(constant("u2337"), using(S2337));
    assert.equal(constant("u3905"), using(S3905));
  });

  it("3903 and 3904 change no definition by retyping it: the installed text is amended (2965's method)", () => {
    for (const s of [S3903, S3904]) {
      assert.doesNotMatch(maskForKeywordScan(s), /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
      assert.match(s, /pg_get_functiondef\(/);
      assert.match(s, /IS DISTINCT FROM replace\(d_new, NEW_CALL, '<390[34]>'\)/, "the character-for-character minimality check");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3903 — project_user_memory
// ═════════════════════════════════════════════════════════════════════════════
const PROJECTOR_TABLES = () => `
  ${baseTable("feature_flags")} ALTER TABLE public.feature_flags ADD PRIMARY KEY (flag);
  ${baseTable("compass_graph_edges")}
  ${baseTable("user_follows")}
  ${baseTable("discovery_place_saves")}
  ${baseTable("wishlist_places")}
  CREATE TABLE public.compass_user_preferences (user_id uuid PRIMARY KEY, interests text[], travel_styles text[]);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, name text, handle text);
  CREATE TABLE public.discovery_places (id uuid PRIMARY KEY, canonical_location_id uuid, osm_id text, name text, city text);
  -- 2183's two tables, with the columns later files added (last_projected_at, visibility, source_event_ids) and no CHECKs
  CREATE TABLE public.memory_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, event_type text NOT NULL,
    occurred_at timestamptz NOT NULL, subject_type text, subject_id text, source text NOT NULL, visibility text NOT NULL DEFAULT 'private',
    source_ref jsonb NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX memory_events_dedupe_idx ON public.memory_events (user_id, event_type, subject_type, subject_id, occurred_at);
  CREATE TABLE public.memory_projections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, memory_type text NOT NULL,
    subject_type text, subject_id text, content text NOT NULL, valid_from timestamptz NOT NULL DEFAULT now(), valid_to timestamptz,
    confidence real NOT NULL DEFAULT 0.8, provenance jsonb NOT NULL DEFAULT '{}', sensitivity text NOT NULL DEFAULT 'normal',
    state text NOT NULL DEFAULT 'active', retention_class text NOT NULL DEFAULT 'derived_preference', last_supported_at timestamptz NOT NULL DEFAULT now(),
    last_projected_at timestamptz, visibility text NOT NULL DEFAULT 'private', source_event_ids uuid[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_projections_unique UNIQUE (user_id, memory_type, subject_type, subject_id));
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
  DO $g$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO service_role', current_database()); END $g$; -- Supabase's PUBLIC holds TEMP; PGlite's template1 does not`;

const ME = U(1), FA = U(2), FB = U(3), FC = U(4), FD = U(5), E = U(6), PL = U(7);
const PROJECTOR_SEED = `
  INSERT INTO public.profiles (id, name, handle) VALUES ('${FA}', 'Ana', 'ana'), ('${FB}', 'Ben', 'ben'), ('${FC}', 'Cy', 'cy'), ('${FD}', NULL, 'dee');
  INSERT INTO public.user_follows (follower_id, following_id, created_at) VALUES
    ('${ME}', '${FA}', '2026-09-01T00:00:00Z'), ('${ME}', '${FB}', '2026-09-02T00:00:00Z'),
    ('${ME}', '${FC}', '2026-09-03T00:00:00Z'), ('${ME}', '${FD}', '2026-09-04T00:00:00Z');
  -- I blocked Ben; Cy blocked me; Dee is in a block that is not mine.
  INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${ME}', '${FB}'), ('${FC}', '${ME}'), ('${E}', '${FD}');
  INSERT INTO public.compass_graph_edges (src_type, src_key, dst_type, dst_key, edge_type, first_seen, last_seen) VALUES ('person', '${ME}', 'city', 'lisbon', 'visited', '2026-08-01T00:00:00Z', '2026-08-03T00:00:00Z');
  INSERT INTO public.compass_user_preferences VALUES ('${ME}', ARRAY['food'], ARRAY['slow']);
  INSERT INTO public.discovery_places VALUES ('${PL}', NULL, NULL, 'Cafe', 'Lisbon');
  INSERT INTO public.discovery_place_saves VALUES ('${ME}', '${PL}', '2026-08-05T00:00:00Z');`;
const PROJECTED = `SELECT json_build_object(
  'events', (SELECT json_agg(json_build_array(event_type, subject_type, subject_id, occurred_at, source, visibility, source_ref, metadata) ORDER BY event_type, subject_id) FROM public.memory_events),
  'projections', (SELECT json_agg(json_build_array(memory_type, subject_type, subject_id, content, confidence, sensitivity, provenance, retention_class, visibility, state, cardinality(source_event_ids)) ORDER BY memory_type, subject_id) FROM public.memory_projections)
)::text AS j`;
const project = async (db: DB) => {
  await db.exec(`DELETE FROM public.memory_projections WHERE true; DELETE FROM public.memory_events WHERE true;
                 SET ROLE service_role; SELECT public.project_user_memory('${ME}'::uuid, false); RESET ROLE;`);
  return JSON.parse((await one(db, PROJECTED)).j);
};
const fnDef = async (db: DB, sig: string) => (await one(db, `SELECT pg_get_functiondef('${sig}'::regprocedure) AS d`)).d as string;

test("3903 executes: the projector asks authz.is_blocked, and projects exactly what it did", async (t) => { // PGlite is a devDependency: this always executes (never a counted skip)
  const build = async () => {
    const db = await pglite();
    await db.exec(ROLES); await db.exec(BLOCKS()); await db.exec(PROJECTOR_TABLES());
    await db.exec(S2963); await db.exec(S2965); await db.exec(acl2193);
    await db.exec(PROJECTOR_SEED);
    return db;
  };
  const db = await build();
  const before = await project(db);
  const defBefore = await fnDef(db, "public.project_user_memory(uuid,boolean)");
  const aclBefore = (await one(db, `SELECT proacl::text AS a FROM pg_proc WHERE oid = 'public.project_user_memory(uuid,boolean)'::regprocedure`)).a;

  await t.test("anti-vacuity: before 3903 the social lane reads blocks inline, and excludes BOTH directions", async () => {
    assert.equal((defBefore.match(/NOT EXISTS \(SELECT 1 FROM public\.blocks b/g) ?? []).length, 2);
    const social = before.projections.filter((p: any[]) => p[0] === "social").map((p: any[]) => p[2]);
    assert.deepEqual(social, [FA, FD].sort(), "Ben (I blocked) and Cy (blocked me) are not remembered; Dee's unrelated block does not hide her");
    assert.ok(before.projections.some((p: any[]) => p[0] === "episodic") && before.projections.some((p: any[]) => p[0] === "semantic") && before.projections.some((p: any[]) => p[0] === "place"), "all four lanes produce");
  });

  await db.exec(S3903);

  await t.test("after 3903: byte-identical output (events and projections), both directions still excluded", async () => {
    assert.deepEqual(await project(db), before);
  });

  await t.test("the definition changed in the two predicates and NOTHING else (line diff), and stays INVOKER with its ACL", async () => {
    const defAfter = await fnDef(db, "public.project_user_memory(uuid,boolean)");
    const a = defBefore.split("\n");
    const b = defAfter.split("\n");
    assert.equal(a.length, b.length);
    const changed = a.map((l, i) => [l, b[i]!] as const).filter(([x, y]) => x !== y);
    assert.equal(changed.length, 2);
    for (const [x, y] of changed) {
      assert.match(x, /NOT EXISTS \(SELECT 1 FROM public\.blocks b WHERE \(b\.blocker_id=p_user_id AND b\.blocked_id=uf\.following_id\) OR \(b\.blocker_id=uf\.following_id AND b\.blocked_id=p_user_id\)\)/);
      assert.equal(y, x.replace("NOT EXISTS (SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id) OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))", "NOT authz.is_blocked(p_user_id, uf.following_id)"));
    }
    assert.equal((await one(db, `SELECT proacl::text AS a FROM pg_proc WHERE oid = 'public.project_user_memory(uuid,boolean)'::regprocedure`)).a, aclBefore);
    assert.equal((await one(db, `SELECT prosecdef AS s FROM pg_proc WHERE oid = 'public.project_user_memory(uuid,boolean)'::regprocedure`)).s, false);
  });

  await t.test("re-applying is a no-op that says so", async () => {
    const d0 = await fnDef(db, "public.project_user_memory(uuid,boolean)");
    await db.exec(S3903);
    assert.equal(await fnDef(db, "public.project_user_memory(uuid,boolean)"), d0);
  });

  await t.test("the postcondition re-runs alone in a new session, and is load-bearing", async () => {
    const post = postconditionBlocks(S3903)[0]!.text;
    await db.exec("DISCARD ALL"); // a new session: PGlite's default search_path is then pg_catalog alone, so the block must not lean on it
    await db.exec(post);
    await db.exec("SET search_path TO public");
    await db.exec(`DO $x$ BEGIN EXECUTE replace(pg_get_functiondef('public.project_user_memory(uuid,boolean)'::regprocedure), 'NOT authz.is_blocked(p_user_id, uf.following_id)', 'NOT EXISTS (SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_user_id AND b.blocked_id=uf.following_id) OR (b.blocker_id=uf.following_id AND b.blocked_id=p_user_id))'); END $x$;`);
    await assert.rejects(db.exec(post), /POSTCONDITION FAILED \(3903\): the social lane asks authz\.is_blocked 0 time/);
  });

  await t.test("the header's rollback recipe returns the definition byte-identically", async () => {
    await db.exec(S3903);
    await db.exec(`CREATE TABLE public.schema_migration_ledger (filename text PRIMARY KEY); INSERT INTO public.schema_migration_ledger VALUES ('${F3903}');`);
    await db.exec(recipe(S3903));
    assert.equal(await fnDef(db, "public.project_user_memory(uuid,boolean)"), defBefore);
    assert.equal((await one(db, "SELECT count(*)::int AS n FROM public.schema_migration_ledger")).n, 0);
  });

  await t.test("refuses an installed definition it was not measured against (one inline read changed by hand), and changes nothing", async () => {
    await db.exec(`DO $x$ BEGIN EXECUTE regexp_replace(pg_get_functiondef('public.project_user_memory(uuid,boolean)'::regprocedure), 'NOT EXISTS \\(SELECT 1 FROM public\\.blocks b WHERE \\(b\\.blocker_id=p_user_id', 'NOT EXISTS (SELECT 1 FROM public.blocks bb, public.blocks b WHERE (b.blocker_id=p_user_id'); END $x$;`);
    const hand = await fnDef(db, "public.project_user_memory(uuid,boolean)");
    await refuses(db, S3903, /3903 PRECONDITION FAILED: expected exactly 2 inline blocks predicates and 0 authz\.is_blocked calls in the installed project_user_memory, found 1 and 0/);
    assert.equal(await fnDef(db, "public.project_user_memory(uuid,boolean)"), hand);
  });
  await db.close();

  await t.test("refuses without 2182 (authz.is_blocked absent)", async () => {
    const d = await pglite();
    await d.exec(ROLES);
    await d.exec(`${baseTable("blocks")}`); await d.exec(PROJECTOR_TABLES()); await d.exec(S2963); await d.exec(S2965);
    await refuses(d, S3903, /PRECONDITION FAILED \(3903\): authz\.is_blocked\(uuid, uuid\) is absent/);
    await d.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3904 — memory_public_feed
// ═════════════════════════════════════════════════════════════════════════════
const V = U(11), O1 = U(12), O2 = U(13), O3 = U(14), O4 = U(15), O5 = U(16), O6 = U(17), O7 = U(18);
const mem = (id: number, owner: string, over: string) => `('${U(100 + id)}', '${owner}', 'm${id}', ${over})`;
const FEED_SEED = `
  INSERT INTO public.memories (id, owner_id, title, visibility, state, hidden_user_ids, created_at) VALUES
    ${mem(1, O1, "'public', 'published', '{}', '2026-10-01T01:00:00Z'")},
    ${mem(2, O2, "'public', 'published', '{}', '2026-10-01T02:00:00Z'")},
    ${mem(3, O3, "'public', 'published', '{}', '2026-10-01T03:00:00Z'")},
    ${mem(4, O4, `'public', 'published', ARRAY['${V}']::uuid[], '2026-10-01T04:00:00Z'`)},
    ${mem(5, O5, "'friends_only', 'published', '{}', '2026-10-01T05:00:00Z'")},
    ${mem(6, O6, "'public', 'draft', '{}', '2026-10-01T06:00:00Z'")},
    ${mem(7, O7, "'public', 'published', '{}', '2026-10-01T07:00:00Z'")},
    ${mem(8, O1, "'public', 'published', '{}', '2026-10-01T08:00:00Z'")};
  -- I blocked O2; O3 blocked me; O7 is in a block that is not mine.
  INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${V}', '${O2}'), ('${O3}', '${V}'), ('${O1}', '${O7}');`;
const feed = async (db: DB, viewer: string | null, limit = 30, cursor: string | null = null) => {
  await db.exec("SET ROLE service_role");
  try {
    const r = await db.query(`SELECT id, owner_id, title, location_precision FROM public.memory_public_feed($1, $2, $3)`, [viewer, limit, cursor]);
    return r.rows.map((x: any) => x.title);
  } finally { await db.exec("RESET ROLE"); }
};

test("3904 executes: the feed asks authz.is_blocked, and returns exactly what it did", async (t) => {
  const db = await pglite();
  await db.exec(ROLES); await db.exec(BLOCKS());
  await db.exec(`${baseTable("memories")} ${baseTable("feature_flags")} ALTER TABLE public.feature_flags ADD PRIMARY KEY (flag);
                 GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
  await db.exec(S2338);
  await db.exec(FEED_SEED);
  const cases: Array<[string | null, number, string | null]> = [[V, 30, null], [V, 2, null], [V, 30, "2026-10-01T07:30:00Z"], [O3, 30, null], [O2, 30, null], [null, 30, null], [V, 0, null], [V, 500, null]];
  const before: string[][] = [];
  for (const c of cases) before.push(await feed(db, ...c));
  const fdef = "public.memory_public_feed(uuid,integer,timestamptz)";
  const defBefore = await fnDef(db, fdef);
  const meta = async () => one(db, `SELECT proacl::text AS acl, prosecdef, provolatile, proconfig::text AS cfg, obj_description(oid, 'pg_proc') AS cmt FROM pg_proc WHERE oid = '${fdef}'::regprocedure`);
  const metaBefore = await meta();

  await t.test("anti-vacuity: before 3904 the feed excludes both block directions and the hidden viewer", async () => {
    assert.deepEqual(before[0], ["m8", "m7", "m1"], "O2 (I blocked), O3 (blocked me), O4 (hid me), the private and the draft are out; O7's unrelated block does not hide them");
    assert.match(defBefore, /AND NOT EXISTS \(\n\s+SELECT 1 FROM public\.blocks b/);
  });

  await db.exec(S3904);

  await t.test("after 3904: every case returns the same rows in the same order", async () => {
    const after: string[][] = [];
    for (const c of cases) after.push(await feed(db, ...c));
    assert.deepEqual(after, before);
  });

  await t.test("the definition changed in the one predicate and nothing else; ACL, INVOKER, STABLE, search_path and comment kept", async () => {
    const defAfter = await fnDef(db, fdef);
    const OLD = /NOT EXISTS \(\s*SELECT 1 FROM public\.blocks b\s+WHERE \(b\.blocker_id = p_viewer\s+AND b\.blocked_id = m\.owner_id\)\s+OR \(b\.blocker_id = m\.owner_id\s+AND b\.blocked_id = p_viewer\)\s*\)/g;
    assert.equal((defBefore.match(OLD) ?? []).length, 1);
    assert.equal(defBefore.replace(OLD, "<B>"), defAfter.replace("NOT authz.is_blocked(p_viewer, m.owner_id)", "<B>"));
    assert.deepEqual(await meta(), metaBefore);
    assert.equal(metaBefore.prosecdef, false);
  });

  await t.test("re-applying is a no-op", async () => {
    const d0 = await fnDef(db, fdef);
    await db.exec(S3904);
    assert.equal(await fnDef(db, fdef), d0);
  });

  await t.test("the postcondition re-runs alone in a new session, and is load-bearing", async () => {
    const post = postconditionBlocks(S3904)[0]!.text;
    await db.exec("DISCARD ALL"); // a new session: PGlite's default search_path is then pg_catalog alone, so the block must not lean on it
    await db.exec(post);
    await db.exec("SET search_path TO public");
    await db.exec(`GRANT EXECUTE ON FUNCTION ${fdef} TO authenticated`);
    await assert.rejects(db.exec(post), /POSTCONDITION FAILED \(3904\): memory_public_feed's EXECUTE is no longer service_role only/);
    await db.exec(`REVOKE EXECUTE ON FUNCTION ${fdef} FROM authenticated`);
    await db.exec(post);
  });

  await t.test("the header's rollback recipe returns the definition byte-identically", async () => {
    await db.exec(`CREATE TABLE public.schema_migration_ledger (filename text PRIMARY KEY); INSERT INTO public.schema_migration_ledger VALUES ('${F3904}');`);
    await db.exec(recipe(S3904));
    assert.equal(await fnDef(db, fdef), defBefore);
    assert.equal((await one(db, "SELECT count(*)::int AS n FROM public.schema_migration_ledger")).n, 0);
  });
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════
// 3905 — post_media_public_select
// ═════════════════════════════════════════════════════════════════════════════
const OWNER = U(21), VIEWER = U(22), CREW = U(23), TRIP = U(24);
const P_PUB = U(31), P_TRIP = U(32), P_DEL = U(33);
const MEDIA = { ready: U(41), rejected: U(42), processing: U(43), trip: U(44), deleted: U(45), viewerOwn: U(46) } as const;
const name = (id: string) => (Object.entries(MEDIA).find(([, v]) => v === id) ?? [id])[0];
const POST_MEDIA_FIXTURE = () => `
  ${baseType("post_visibility")}
  ${baseType("post_status")}
  -- posts: the columns the policy reads, with the baseline enum types (the baseline table carries PostGIS columns PGlite has no type for)
  CREATE TABLE public.posts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), author_id uuid NOT NULL, trip_id uuid,
    visibility public.post_visibility DEFAULT 'public'::public.post_visibility NOT NULL, status public.post_status DEFAULT 'active'::public.post_status NOT NULL);
  ${baseTable("post_media")}
  -- stand-in for 2334's authz.is_trip_crew(uuid): a SECURITY DEFINER read of an accepted-crew list
  CREATE TABLE public._crew (trip_id uuid, user_id uuid);
  CREATE FUNCTION authz.is_trip_crew(p_trip uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
    AS $$ SELECT EXISTS (SELECT 1 FROM public._crew WHERE trip_id = p_trip AND user_id = auth.uid()) $$;
  GRANT EXECUTE ON FUNCTION authz.is_trip_crew(uuid) TO anon, authenticated, service_role;
  ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY posts_read_all ON public.posts FOR SELECT USING (true); -- isolates post_media's policy; posts' own policy is not under test
  ALTER TABLE public.post_media ENABLE ROW LEVEL SECURITY;
  GRANT SELECT ON public.posts, public.post_media TO anon, authenticated;
  ${policy2337}
  INSERT INTO public._crew VALUES ('${TRIP}', '${CREW}');
  INSERT INTO public.posts (id, author_id, trip_id, visibility, status) VALUES
    ('${P_PUB}', '${OWNER}', NULL, 'public', 'active'), ('${P_TRIP}', '${OWNER}', '${TRIP}', 'trip_only', 'active'), ('${P_DEL}', '${OWNER}', NULL, 'public', 'deleted');
  INSERT INTO public.post_media (id, post_id, user_id, media_type, mime_type, processing_status, moderation_status) VALUES
    ('${MEDIA.ready}', '${P_PUB}', '${OWNER}', 'image', 'image/jpeg', 'ready', 'approved'),
    ('${MEDIA.rejected}', '${P_PUB}', '${OWNER}', 'image', 'image/jpeg', 'ready', 'rejected'),
    ('${MEDIA.processing}', '${P_PUB}', '${OWNER}', 'image', 'image/jpeg', 'pending', 'pending'),
    ('${MEDIA.trip}', '${P_TRIP}', '${OWNER}', 'image', 'image/jpeg', 'ready', 'pending'),
    ('${MEDIA.deleted}', '${P_DEL}', '${OWNER}', 'image', 'image/jpeg', 'ready', 'approved'),
    ('${MEDIA.viewerOwn}', '${P_PUB}', '${VIEWER}', 'image', 'image/jpeg', 'pending', 'pending');`;
async function visible(db: DB, who: string | null): Promise<string[]> {
  await db.exec(who === null
    ? `BEGIN; SELECT set_config('request.jwt.claim.sub', '', true); SET LOCAL ROLE anon;`
    : `BEGIN; SELECT set_config('request.jwt.claim.sub', '${who}', true); SET LOCAL ROLE authenticated;`);
  try { return (await db.query("SELECT id FROM public.post_media")).rows.map((r: any) => name(r.id)).sort(); }
  finally { await db.exec("ROLLBACK"); }
}
const SCENARIOS = { none: "", viewerBlockedOwner: `('${VIEWER}', '${OWNER}')`, ownerBlockedViewer: `('${OWNER}', '${VIEWER}')` } as const;
async function matrix(db: DB) {
  const out: Record<string, Record<string, string[]>> = {};
  for (const [s, row] of Object.entries(SCENARIOS)) {
    await db.exec(`DELETE FROM public.blocks WHERE true;${row ? ` INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ${row};` : ""}`);
    out[s] = { owner: await visible(db, OWNER), viewer: await visible(db, VIEWER), crew: await visible(db, CREW), anon: await visible(db, null) };
  }
  await db.exec("DELETE FROM public.blocks WHERE true");
  return out;
}
const qual = async (db: DB) => (await one(db, `SELECT qual, permissive, roles::text AS roles, cmd, with_check FROM pg_policies WHERE tablename = 'post_media' AND policyname = 'post_media_public_select'`));

test("3905 executes: post_media_public_select hides a blocked person's media in BOTH directions, and nothing else changes", async (t) => {
  const db = await pglite();
  await db.exec(ROLES); await db.exec(BLOCKS()); await db.exec(POST_MEDIA_FIXTURE());
  const before = await matrix(db);
  const polBefore = await qual(db);

  await t.test("THE DEFECT (red on 2337): the owner blocked the viewer, and the viewer still reads the owner's media", async () => {
    assert.deepEqual(before.none!.viewer, ["ready", "viewerOwn"], "anti-vacuity: an unblocked viewer reads the ready, approved, public media");
    assert.deepEqual(before.viewerBlockedOwner!.viewer, ["viewerOwn"], "the direction the viewer made bites");
    assert.deepEqual(before.ownerBlockedViewer!.viewer, ["ready", "viewerOwn"], "2337's inline read runs through blocks' RLS and cannot see the owner's block");
  });

  await db.exec(S3905);
  const after = await matrix(db);

  await t.test("after 3905 the owner's block bites; every other reader and scenario reads exactly what it read before", async () => {
    assert.deepEqual(after.ownerBlockedViewer!.viewer, ["viewerOwn"], "the viewer the owner blocked reads nothing of the owner's");
    const expected = JSON.parse(JSON.stringify(before));
    expected.ownerBlockedViewer.viewer = ["viewerOwn"];
    assert.deepEqual(after, expected);
    assert.deepEqual(after.none!.crew, ["ready", "trip"], "trip-crew visibility through authz.is_trip_crew is unchanged");
    assert.deepEqual(after.none!.owner, ["deleted", "processing", "ready", "rejected", "trip"], "the owner arm is unchanged: every row of their own");
    assert.deepEqual(after.none!.anon, ["ready"], "anon reads the public ready media, as before");
  });

  await t.test("the stored policy differs from 2337's in the block conjunct only; FOR SELECT, PERMISSIVE, TO public, no WITH CHECK", async () => {
    const polAfter = await qual(db);
    assert.deepEqual({ ...polAfter, qual: null }, { ...polBefore, qual: null });
    assert.deepEqual([polAfter.permissive, polAfter.roles, polAfter.cmd, polAfter.with_check], ["PERMISSIVE", "{public}", "SELECT", null]);
    const OLD_CONJ = /\(NOT \(EXISTS \( SELECT 1\n\s+FROM blocks b\n\s+WHERE \(\(\(b\.blocker_id = auth\.uid\(\)\) AND \(b\.blocked_id = post_media\.user_id\)\) OR \(\(b\.blocker_id = post_media\.user_id\) AND \(b\.blocked_id = auth\.uid\(\)\)\)\)\)\)\)/;
    assert.match(polBefore.qual, OLD_CONJ);
    assert.equal(polBefore.qual.replace(OLD_CONJ, "<B>"), polAfter.qual.replace("(NOT authz.is_blocked(auth.uid(), user_id))", "<B>"));
  });

  await t.test("re-applying is a no-op", async () => {
    const q0 = (await qual(db)).qual;
    await db.exec(S3905);
    assert.equal((await qual(db)).qual, q0);
  });

  await t.test("the postcondition re-runs alone in a new session, and is load-bearing", async () => {
    const post = postconditionBlocks(S3905)[0]!.text;
    await db.exec("DISCARD ALL"); // a new session: PGlite's default search_path is then pg_catalog alone, so the block must not lean on it
    await db.exec(post);
    await db.exec("SET search_path TO public");
    await db.exec(policy2337);
    await assert.rejects(db.exec(post), /POSTCONDITION FAILED \(3905\): the policy does not ask authz\.is_blocked/);
    await db.exec(S3905);
  });

  await t.test("refuses an installed policy it was not measured against, and changes nothing", async () => {
    await db.exec(policy2337);
    await db.exec(`ALTER POLICY post_media_public_select ON public.post_media USING (user_id = auth.uid() OR processing_status = 'ready')`);
    const hand = (await qual(db)).qual;
    await refuses(db, S3905, /3905 PRECONDITION FAILED: the installed post_media_public_select is neither 2337's definition nor this file's/);
    assert.equal((await qual(db)).qual, hand);
    await db.exec(policy2337);
    await db.exec(S3905);
  });

  await t.test("refuses when a client role cannot reach authz.is_blocked (every client read would fail)", async () => {
    await db.exec("REVOKE EXECUTE ON FUNCTION authz.is_blocked(uuid, uuid) FROM PUBLIC, anon"); // anon also holds it through PUBLIC
    await refuses(db, S3905, /PRECONDITION FAILED \(3905\): anon or authenticated cannot reach authz\.is_blocked/);
    await db.exec("GRANT EXECUTE ON FUNCTION authz.is_blocked(uuid, uuid) TO PUBLIC, anon");
  });

  await t.test("the rollback the header names (2337's statement) brings the defect back — it is the inverse", async () => {
    await db.exec(policy2337);
    assert.deepEqual(await matrix(db), before);
    await db.exec(S3905);
    assert.deepEqual(await matrix(db), after);
  });
  await db.close();
});
