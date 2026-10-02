/**
 * census-discovery DC-15 / §54 — check:discovery-query-paths fails on exactly
 * what `10` §4 asks for: a Discovery table or index created without an entry
 * (expected cardinality, index rationale, EXPLAIN) in docs/discovery/query-paths.md.
 *
 * Run: node --import tsx/esm --test src/test/discoveryQueryPathsCheck.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRegistry,
  discoveryObjectsIn,
  isDiscoveryTable,
  parseRegistry,
} from "../scripts/checkDiscoveryQueryPaths.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(__dir, "../migrations");
const DOC_PATH = resolve(__dir, "../../../../docs/discovery/query-paths.md");
const DOC = readFileSync(DOC_PATH, "utf8");
const REAL = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()
  .flatMap((f) => discoveryObjectsIn(f, readFileSync(resolve(MIGRATIONS, f), "utf8")));

describe("check:discovery-query-paths", () => {
  it("K1. the tree as committed is complete: every Discovery creation has a registry row, and no row is stale", () => {
    const r = checkRegistry(REAL, DOC);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.stale, []);
    assert.deepEqual(r.malformed, []);
    assert.ok(REAL.length >= 55, `expected the 55 creations known at §54, read ${REAL.length}`);
  });

  it("K2. a NEW migration adding a Discovery table without a row fails as MISSING", () => {
    const added = discoveryObjectsIn("3399_discovery_new_thing.sql",
      "CREATE TABLE IF NOT EXISTS public.discovery_new_thing (id uuid PRIMARY KEY);");
    const r = checkRegistry([...REAL, ...added], DOC);
    assert.deepEqual(r.missing.map((o) => `${o.kind}:${o.name}`), ["table:discovery_new_thing"]);
  });

  it("K3. a NEW index on a Discovery table fails; one on another surface's table is not this check's", () => {
    const added = discoveryObjectsIn("3399_x.sql", `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS rank_events_new_idx ON public.rank_events (item_id);
      CREATE UNIQUE INDEX "trail_follows_new" ON trail_follows (user_id, trail_id);
      CREATE INDEX posts_new_idx ON public.posts (created_at);`);
    const r = checkRegistry([...REAL, ...added], DOC);
    assert.deepEqual(r.missing.map((o) => o.name).sort(), ["rank_events_new_idx", "trail_follows_new"]);
    assert.equal(isDiscoveryTable("posts"), false);
    assert.equal(isDiscoveryTable("discovery_anything"), true, "a new discovery_* table is caught by name");
  });

  it("K4. a registry row that no migration backs is STALE", () => {
    const doc = DOC + "\n| index | `discovery_places_ghost_idx` | `discovery_places` | 0029 | QP-03 | an index nobody created |\n";
    const r = checkRegistry(REAL, doc);
    assert.deepEqual(r.stale.map((s) => s.name), ["discovery_places_ghost_idx"]);
  });

  it("K5. a row must cite a defined path or say 'not a hot path', and carry a rationale", () => {
    const added = discoveryObjectsIn("3399_y.sql", "CREATE INDEX discovery_cache_y ON discovery_cache (destination);");
    const noPath = DOC + "\n| index | `discovery_cache_y` | `discovery_cache` | 3399 | fast | used for lookups by destination |\n";
    assert.ok(checkRegistry([...REAL, ...added], noPath).malformed.some((m) => m.includes("names no QP-nn path")));
    const badPath = DOC + "\n| index | `discovery_cache_y` | `discovery_cache` | 3399 | QP-99 | used for lookups by destination |\n";
    assert.ok(checkRegistry([...REAL, ...added], badPath).malformed.some((m) => m.includes("QP-99")));
    const noWhy = DOC + "\n| index | `discovery_cache_y` | `discovery_cache` | 3399 | QP-01 | x |\n";
    assert.ok(checkRegistry([...REAL, ...added], noWhy).malformed.some((m) => m.includes("no rationale")));
    const good = DOC + "\n| index | `discovery_cache_y` | `discovery_cache` | 3399 | QP-01 | used for lookups by destination |\n";
    assert.deepEqual(checkRegistry([...REAL, ...added], good), { missing: [], stale: [], malformed: [] });
  });

  it("K6. the row must name the migration that creates the object", () => {
    const added = discoveryObjectsIn("3399_z.sql", "CREATE INDEX discovery_cache_z ON discovery_cache (category);");
    const wrong = DOC + "\n| index | `discovery_cache_z` | `discovery_cache` | 3398 | QP-01 | used for lookups by category |\n";
    assert.ok(checkRegistry([...REAL, ...added], wrong).malformed.some((m) => m.includes("3399_z.sql")));
  });

  it("K7. commented-out DDL is not a creation", () => {
    assert.deepEqual(discoveryObjectsIn("3399_c.sql", "-- CREATE INDEX x ON rank_events (id);\n/* CREATE TABLE discovery_q (id int); */"), []);
  });

  it("K8. the registry parser reads every row of §4", () => {
    const rows = parseRegistry(DOC);
    assert.equal(rows.length, new Set(REAL.map((o) => `${o.kind}:${o.name}`)).size);
  });
});
