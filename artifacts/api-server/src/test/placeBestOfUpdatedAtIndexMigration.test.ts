/**
 * census-highlights-memories, the place stale sweep's "Not done": "place_best_of has no index on updated_at, so the
 * count and each page scan a table with one row per precomputed place." Migration 3902 adds the walk's key,
 * (updated_at, place_id).
 *
 * WHAT WOULD TURN THIS RED
 *   - an index whose key is not the sweep's walk key (the worker's ORDER BY and WHERE are read from its source here,
 *     so a change to the walk that the index no longer serves is red too);
 *   - any of the sweep's four reads still scanning and sorting the table once the index exists (EXPLAIN, executed);
 *   - a file that is not re-runnable, builds on a same-named index it did not make, or whose postcondition is not
 *     load-bearing.
 *
 * EXECUTED on PGlite (PostgreSQL 16.4 in-process; the repo's convention) over the baseline definition of
 * public.place_best_of (baseline/20260819_baseline_structure.sql, verbatim). The plans are PostgreSQL's planner on
 * 20 000 rows with a 5% backlog and enable_seqscan ON (PGlite ships it OFF); production's planner decides on its own
 * statistics, which this cannot reproduce.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/placeBestOfUpdatedAtIndexMigration.test.ts
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { maskForKeywordScan, postconditionBlocks } from "../scripts/lib/migrationSqlBlocks.js";

const FILE = "3902_place_best_of_updated_at_index.sql";
const sql = readFileSync(new URL(`../migrations/${FILE}`, import.meta.url), "utf8");
const worker = readFileSync(new URL("../lib/places/placeCollectionsWorker.ts", import.meta.url), "utf8");
const BASE = readFileSync(new URL("../../baseline/20260819_baseline_structure.sql", import.meta.url), "utf8");
const INDEX = "place_best_of_updated_at_place_id_idx";

function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `no "${start}"`);
  return src.slice(i, src.indexOf(end, i) + end.length);
}

describe("3902 — static shape", () => {
  it("the index key is the sweep's walk key, read from the worker: WHERE on updated_at, ORDER BY updated_at then place_id", () => {
    const walk = slice(worker, "async function readOverduePage(", "\n}\n");
    const orders = [...walk.matchAll(/\.order\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(orders, ["updated_at", "place_id", "place_id", "updated_at", "place_id"], "first page, ties, later page");
    assert.match(walk, /\.lt\("updated_at", cutoffIso\)/);
    assert.match(walk, /\.eq\("updated_at", after\.updated_at\)\n\s+\.gt\("place_id", after\.place_id\)/);
    const count = slice(worker, '.select("place_id", { count: "exact", head: true })', ";");
    assert.match(count, /\.lt\("updated_at", cutoff\)/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS place_best_of_updated_at_place_id_idx\n {2}ON public\.place_best_of \(updated_at, place_id\);/);
  });

  it("is one transaction: $pre$ first, ONE assertion-only postcondition after the COMMIT, no row written", () => {
    assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1);
    assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1);
    assert.ok(sql.indexOf("DO $pre$") < sql.indexOf("CREATE INDEX IF NOT EXISTS"));
    const post = postconditionBlocks(sql);
    assert.equal(post.length, 1);
    assert.ok(sql.indexOf(post[0]!.text) > sql.lastIndexOf("\nCOMMIT;\n"));
    assert.doesNotMatch(maskForKeywordScan(sql), /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
    assert.doesNotMatch(maskForKeywordScan(sql), /CONCURRENTLY/i, "the applier refuses a file it cannot wrap in one transaction");
  });
});

const TABLE = `CREATE TABLE public.places (id uuid PRIMARY KEY);
  ${slice(BASE, "CREATE TABLE public.place_best_of (", "\n);\n")}
  ALTER TABLE ONLY public.place_best_of ADD CONSTRAINT place_best_of_pkey PRIMARY KEY (place_id);
  ALTER TABLE ONLY public.place_best_of ADD CONSTRAINT place_best_of_place_id_fkey FOREIGN KEY (place_id) REFERENCES public.places(id) ON DELETE CASCADE;`;
const CUTOFF = "2026-10-18T06:00:00.000Z"; // staleCacheCutoffIso: a literal instant, as the worker sends it
const READS = {
  count: `SELECT count(*) FROM public.place_best_of WHERE updated_at < '${CUTOFF}'`,
  first: `SELECT place_id, updated_at FROM public.place_best_of WHERE updated_at < '${CUTOFF}' ORDER BY updated_at ASC, place_id ASC LIMIT 100`,
  ties: `SELECT place_id, updated_at FROM public.place_best_of WHERE updated_at = '2026-10-10T00:00:00.000Z' AND place_id > '00000000-0000-4000-8000-000000000000' ORDER BY place_id ASC LIMIT 100`,
  later: `SELECT place_id, updated_at FROM public.place_best_of WHERE updated_at < '${CUTOFF}' AND updated_at > '2026-10-10T00:00:00.000Z' ORDER BY updated_at ASC, place_id ASC LIMIT 100`,
} as const;

test("3902 executes on PostgreSQL (PGlite): every sweep read uses the index, none scans and sorts the table", async (t) => { // PGlite is a devDependency: this always executes (never a counted skip)
  const { PGlite } = await import(process.env.DISCOVERY_PGLITE_MODULE ?? "@electric-sql/pglite");
  const fresh = async () => {
    const db = new PGlite();
    await db.exec(`SET enable_seqscan = on; ${TABLE}`);
    return db;
  };
  const plan = async (db: any, q: string) => (await db.query(`EXPLAIN ${q}`)).rows.map((r: any) => r["QUERY PLAN"]).join("\n");
  const rows = async (db: any, q: string) => (await db.query(q)).rows;

  const db = await fresh();
  await db.exec(`
    INSERT INTO public.places SELECT gen_random_uuid() FROM generate_series(1, 20000);
    INSERT INTO public.place_best_of (place_id, updated_at)
      SELECT id, CASE WHEN n % 20 = 0 THEN timestamptz '2026-10-09T00:00:00Z' + (n % 200) * interval '1 hour'
                      ELSE timestamptz '2026-10-18T08:00:00Z' + (n % 240) * interval '1 minute' END
        FROM (SELECT id, row_number() OVER () AS n FROM public.places) p;
    UPDATE public.place_best_of SET updated_at = '2026-10-10T00:00:00.000Z' WHERE place_id IN (SELECT place_id FROM public.place_best_of WHERE updated_at < '${CUTOFF}' LIMIT 150);
    ANALYZE public.place_best_of;`);
  const answers = Object.fromEntries(await Promise.all(Object.entries(READS).map(async ([k, q]) => [k, await rows(db, q)])));

  await t.test("anti-vacuity: before 3902 the count and the pages scan the table, and the pages sort it", async () => {
    for (const k of ["count", "first", "later"] as const) assert.match(await plan(db, READS[k]), /Seq Scan on place_best_of/, k);
    for (const k of ["first", "later"] as const) assert.match(await plan(db, READS[k]), /Sort Key: updated_at, place_id/, k);
    assert.ok(Number(answers.count[0].count) > 900, "a 5% backlog of 20 000");
    assert.equal(answers.ties.length, 100, "a page boundary inside a run of equal instants");
  });

  await db.exec(sql);
  await db.exec("ANALYZE public.place_best_of");

  await t.test("after 3902: the count and the ties use the index; the first and next pages read it in order and stop at the LIMIT", async () => {
    for (const k of ["count", "ties"] as const) {
      const p = await plan(db, READS[k]);
      assert.match(p, new RegExp(`Index (Only )?Scan using ${INDEX}|Bitmap Index Scan on ${INDEX}`), `${k}:\n${p}`);
      assert.doesNotMatch(p, /Seq Scan/, `${k} must not scan the table:\n${p}`);
    }
    // The ties page may sort its run of equal instants (the planner's choice for a small run); it never sorts the table.
    for (const k of ["first", "later"] as const) {
      const p = await plan(db, READS[k]);
      assert.match(p, new RegExp(`Index (Only )?Scan using ${INDEX}`), `${k}:\n${p}`);
      assert.doesNotMatch(p, /Sort|Seq Scan/, `${k} must not sort or scan:\n${p}`);
    }
  });

  await t.test("the answers are unchanged", async () => {
    for (const [k, q] of Object.entries(READS)) assert.deepEqual(await rows(db, q), answers[k], k);
  });

  await t.test("re-applying is a no-op; the index is exactly the one stated", async () => {
    await db.exec(sql);
    assert.equal((await rows(db, `SELECT pg_get_indexdef('public.${INDEX}'::regclass) AS d`))[0].d,
      `CREATE INDEX ${INDEX} ON public.place_best_of USING btree (updated_at, place_id)`);
  });

  await t.test("the postcondition re-runs alone in a new session, and is load-bearing", async () => {
    const post = postconditionBlocks(sql)[0]!.text;
    await db.exec("DISCARD ALL");
    await db.exec(post);
    await db.exec(`DROP INDEX public.${INDEX}; CREATE INDEX ${INDEX} ON public.place_best_of (place_id, updated_at);`);
    await assert.rejects(db.exec(post), /POSTCONDITION FAILED \(3902\): place_best_of_updated_at_place_id_idx is not a valid btree \(updated_at, place_id\)/);
  });

  await t.test("an index of that name with another definition is refused, not built on", async () => {
    await assert.rejects(db.exec(sql), /PRECONDITION FAILED \(3902\): an index named place_best_of_updated_at_place_id_idx exists but is not this one/);
    await db.exec("ROLLBACK").catch(() => undefined); // the file's BEGIN is left open on this single session; psql would discard it at exit
  });

  await t.test("the header's rollback recipe removes it, and the file re-applies after it", async () => {
    await db.exec(`DROP INDEX public.${INDEX};`);
    await db.exec(sql);
    await db.exec(`CREATE TABLE public.schema_migration_ledger (filename text PRIMARY KEY); INSERT INTO public.schema_migration_ledger VALUES ('${FILE}');`);
    const recipe = sql.slice(sql.indexOf("-- ROLLBACK"), sql.indexOf("\nBEGIN;\n")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
    await db.exec(recipe);
    assert.equal((await rows(db, `SELECT to_regclass('public.${INDEX}') AS r`))[0].r, null);
    assert.equal((await rows(db, "SELECT count(*)::int AS n FROM public.schema_migration_ledger"))[0].n, 0);
    await db.exec(sql);
  });
  await db.close();

  await t.test("refuses without the table", async () => {
    const d = new PGlite();
    await assert.rejects(d.exec(sql), /PRECONDITION FAILED \(3902\): public\.place_best_of does not exist/);
    await d.close();
  });

  // Independent verification pass 11, C9 (c): the $pre$'s identity check refuses a same-named UNIQUE index on the very same
  // key. Its mutant F04 (the check without `NOT i.indisunique`) survived: the only foreign index staged above has another
  // key order, so no case told a UNIQUE (updated_at, place_id) from this one. Under F04 the file COMMITs and only its $post$
  // fails, AFTER the COMMIT; the refusal must come from the $pre$, before anything is built on.
  await t.test("a same-named UNIQUE (updated_at, place_id) index is refused by the precondition, not built on (pass 11, C9c)", async () => {
    const d = await fresh();
    await d.exec(`CREATE UNIQUE INDEX ${INDEX} ON public.place_best_of (updated_at, place_id)`);
    await assert.rejects(d.exec(sql), /PRECONDITION FAILED \(3902\): an index named place_best_of_updated_at_place_id_idx exists but is not this one: CREATE UNIQUE INDEX/);
    await d.exec("ROLLBACK").catch(() => undefined); // the file's BEGIN is left open on this single session; psql would discard it at exit
    await d.close();
  });
});
