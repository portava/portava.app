/**
 * census-discovery §62 (DC-15) — check:discovery-query-paths sees the indexes
 * that UNIQUE and EXCLUDE constraints create.
 *
 * §59 reopened DC-15 because the check matched only `CREATE [UNIQUE] INDEX`:
 * `CONSTRAINT x UNIQUE (…)` inside `CREATE TABLE`, or `ALTER TABLE … ADD
 * CONSTRAINT x UNIQUE (…)`, builds the same btree and passed unregistered. P12's
 * probe (`ALTER TABLE public.rank_events ADD CONSTRAINT … UNIQUE (id, outcome)`)
 * left the check `RESULT clean`. These cases pin the fix.
 *
 * A PRIMARY KEY is deliberately NOT registered (the reading is stated in
 * docs/discovery/query-paths.md §4 and in the checker); C5 pins that too, so a
 * change of reading is a visible change.
 *
 * Run: node --import tsx/esm --test src/test/discoveryQueryPathsConstraints.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRegistry,
  constraintIndexesIn,
  discoveryObjectsIn,
} from "../scripts/checkDiscoveryQueryPaths.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(__dir, "../migrations");
const DOC = readFileSync(resolve(__dir, "../../../../docs/discovery/query-paths.md"), "utf8");
const REAL = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()
  .flatMap((f) => discoveryObjectsIn(f, readFileSync(resolve(MIGRATIONS, f), "utf8")));
const names = (os: Array<{ kind: string; name: string }>) => os.map((o) => `${o.kind}:${o.name}`).sort();

describe("check:discovery-query-paths — constraint-backed indexes (census-discovery §62)", () => {
  it("C1. P12's probe: ALTER TABLE … ADD CONSTRAINT … UNIQUE on rank_events is MISSING, exactly as its CREATE UNIQUE INDEX spelling is", () => {
    const viaConstraint = discoveryObjectsIn("3499_probe.sql",
      "ALTER TABLE public.rank_events ADD CONSTRAINT rank_events_p12_probe UNIQUE (id, outcome);");
    const viaIndex = discoveryObjectsIn("3499_probe.sql",
      "CREATE UNIQUE INDEX rank_events_p12_probe ON public.rank_events (id, outcome);");
    assert.deepEqual(names(checkRegistry([...REAL, ...viaConstraint], DOC).missing), ["index:rank_events_p12_probe"]);
    assert.deepEqual(names(checkRegistry([...REAL, ...viaIndex], DOC).missing), ["index:rank_events_p12_probe"],
      "the two spellings of one index are now one finding");
  });

  it("C2. inline named UNIQUE and EXCLUDE constraints in a CREATE TABLE are creations, keyed to their table", () => {
    const added = discoveryObjectsIn("3499_t.sql", `
      CREATE TABLE IF NOT EXISTS public.discovery_probe (
        id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code  text NOT NULL CONSTRAINT discovery_probe_code_key UNIQUE,
        span  tstzrange,
        note  text DEFAULT 'a (parenthesised) default, with a comma',
        CONSTRAINT discovery_probe_pair_unique UNIQUE (id, code),
        CONSTRAINT discovery_probe_no_overlap EXCLUDE USING gist (span WITH &&)
      );
      ALTER TABLE ONLY "trail_follows" ADD COLUMN rank int, ADD CONSTRAINT "trail_follows_rank_unique" UNIQUE (trail_id, rank);`);
    assert.deepEqual(names(added), [
      "index:discovery_probe_code_key", "index:discovery_probe_no_overlap", "index:discovery_probe_pair_unique",
      "index:trail_follows_rank_unique", "table:discovery_probe",
    ]);
    assert.deepEqual(added.filter((o) => o.kind === "index").map((o) => o.table).sort(),
      ["discovery_probe", "discovery_probe", "discovery_probe", "trail_follows"]);
    const r = checkRegistry([...REAL, ...added], DOC);
    assert.equal(r.missing.length, 5, JSON.stringify(r.missing));
  });

  it("C3. the tree's three constraint-backed indexes are seen, on the right table and migration, and each now has its row", () => {
    const seen = REAL.filter((o) => ["trails_slug_unique", "place_momentum_place_run_key", "discovery_place_reports_unique"].includes(o.name))
      .map((o) => `${o.name}@${o.table}@${o.migration.slice(0, 4)}`).sort();
    assert.deepEqual(seen, [
      "discovery_place_reports_unique@discovery_place_reports@0061",
      "place_momentum_place_run_key@place_momentum@2892",
      "trails_slug_unique@trails@2910",
    ]);
    const r = checkRegistry(REAL, DOC);
    assert.deepEqual(r, { missing: [], stale: [], malformed: [] });
    // And without their three rows, the committed tree fails on exactly them.
    const stripped = DOC.split("\n").filter((l) => !/`(trails_slug_unique|place_momentum_place_run_key|discovery_place_reports_unique)` \|/.test(l) || !l.startsWith("| index |")).join("\n");
    assert.deepEqual(names(checkRegistry(REAL, stripped).missing),
      ["index:discovery_place_reports_unique", "index:place_momentum_place_run_key", "index:trails_slug_unique"]);
  });

  it("C4. an UNNAMED UNIQUE/EXCLUDE on a Discovery table fails as MALFORMED with the instruction to name it", () => {
    for (const sql of [
      "CREATE TABLE discovery_u1 (id int PRIMARY KEY, code text UNIQUE);",
      "CREATE TABLE discovery_u2 (id int PRIMARY KEY, a int, b int, UNIQUE (a, b));",
      "ALTER TABLE public.rank_events ADD UNIQUE (id, outcome);",
      "ALTER TABLE public.trails ADD COLUMN IF NOT EXISTS handle text UNIQUE;",
      "ALTER TABLE public.trails ADD EXCLUDE USING gist (id WITH =);",
    ]) {
      const added = constraintIndexesIn("3499_u.sql", sql);
      assert.equal(added.length, 1, sql);
      assert.equal(added[0]!.unnamed, true, sql);
      const r = checkRegistry([...REAL, ...discoveryObjectsIn("3499_u.sql", sql)], DOC);
      assert.ok(r.malformed.some((m) => /unnamed UNIQUE\/EXCLUDE constraint .* name it/.test(m)), `${sql}\n${r.malformed.join("\n")}`);
      assert.ok(!r.missing.some((o) => o.unnamed), "an unnamed index is not reported as a row to add under a guessed name");
    }
  });

  it("C5. PRIMARY KEY, CHECK, FOREIGN KEY, a 'unique' string, and another surface's table create no registrable index", () => {
    const sql = `
      CREATE TABLE discovery_n (
        id uuid PRIMARY KEY,
        kind text CHECK (kind IN ('unique', 'exclude')),
        owner uuid REFERENCES profiles(id),
        CONSTRAINT discovery_n_kind_known CHECK (kind <> 'UNIQUE (x)'),
        CONSTRAINT discovery_n_owner_fk FOREIGN KEY (owner) REFERENCES profiles(id)
      );
      ALTER TABLE public.rank_events ADD CONSTRAINT rank_events_pk2 PRIMARY KEY (id);
      ALTER TABLE public.trails ADD CONSTRAINT trails_ck CHECK (slug <> 'unique');
      ALTER TABLE public.posts ADD CONSTRAINT posts_x_unique UNIQUE (id);
      CREATE TABLE public.memories (id int, CONSTRAINT memories_x UNIQUE (id));
      ALTER TABLE public.rank_events ENABLE ROW LEVEL SECURITY;`;
    assert.deepEqual(constraintIndexesIn("3499_n.sql", sql), []);
    assert.deepEqual(names(discoveryObjectsIn("3499_n.sql", sql)), ["table:discovery_n"]);
  });

  it("C6. a commented-out constraint is not a creation", () => {
    assert.deepEqual(discoveryObjectsIn("3499_c.sql",
      "-- ALTER TABLE rank_events ADD CONSTRAINT x UNIQUE (id);\n/* CREATE TABLE trails_q (id int, CONSTRAINT y UNIQUE (id)); */"), []);
  });
});
