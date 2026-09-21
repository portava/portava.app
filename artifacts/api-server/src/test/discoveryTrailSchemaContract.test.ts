/**
 * The contract between migration 2910 and lib/discoveryTrailObject.ts.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * `02_Trails.md`'s vocabularies are written down TWICE — once as a Postgres
 * CHECK constraint in `src/migrations/2910_discovery_trails.sql` and once as a
 * TypeScript `as const` tuple. Both are correct today. Nothing except this test
 * would notice if one of them changed.
 *
 * The failure that would follow is not a type error and not a crash: the
 * application would accept a value the database refuses (a 500 on a legal
 * request) or refuse a value the database accepts (a state no write path can
 * ever reach, so a column that quietly means less than it says). Both are
 * invisible until someone hits them in production.
 *
 * `10` §7 forbids editing an applied migration, so the SQL is the fixed side of
 * this contract: when they disagree, the TypeScript moves. That is stated here
 * because the test can only report the disagreement, not decide it.
 *
 * It also pins §4's three label caps, which exist in three places — the CHECK-
 * adjacent trigger function, the TS constants, and the spec — and which a
 * reader would otherwise have to trust.
 *
 * No database is touched. The migration is read as TEXT, which is the whole
 * point: this runs in CI with no credentials, on the lane that is starved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  TRAIL_LIFECYCLE_STATES, TRAIL_CONTENT_STATES, TRAIL_EDGE_TYPES,
  TRAIL_SIGNALS, TRAIL_RELATIONSHIPS, TRAIL_CONTENT_SOURCES, TRAIL_SOURCE_TYPES,
  MAX_PRIMARY_TRAILS, MAX_SUPPORTING_TRAILS, MAX_SIGNALS,
} from "../lib/discoveryTrailObject.js";

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)), "../migrations/2910_discovery_trails.sql");
const sql = readFileSync(MIGRATION, "utf8");

/** The quoted literals of the named CHECK constraint, in the order they appear. */
function literalsOfConstraint(name: string): string[] {
  const at = sql.indexOf(`CONSTRAINT ${name} CHECK (`);
  assert.notEqual(at, -1, `migration 2910 has no CONSTRAINT ${name}`);
  const open = sql.indexOf("(", at + `CONSTRAINT ${name} CHECK`.length);
  let depth = 0, end = open;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")") { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = sql.slice(open, end + 1);
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe("migration 2910 ↔ lib/discoveryTrailObject vocabularies", () => {
  it("§7 Trail states — the CHECK admits exactly TRAIL_LIFECYCLE_STATES", () => {
    assert.deepEqual(literalsOfConstraint("trails_lifecycle_known"), [...TRAIL_LIFECYCLE_STATES]);
  });

  it("§7 content states — the CHECK admits exactly TRAIL_CONTENT_STATES", () => {
    assert.deepEqual(literalsOfConstraint("content_trails_state_known"), [...TRAIL_CONTENT_STATES]);
  });

  it("§6 edge types — the CHECK admits exactly TRAIL_EDGE_TYPES", () => {
    assert.deepEqual(literalsOfConstraint("trail_edges_type_known"), [...TRAIL_EDGE_TYPES]);
  });

  it("§4 relationships and §5 sources — the CHECKs admit exactly the TS tuples", () => {
    assert.deepEqual(literalsOfConstraint("content_trails_relationship_known"), [...TRAIL_RELATIONSHIPS]);
    assert.deepEqual(literalsOfConstraint("content_trails_source_known"), [...TRAIL_CONTENT_SOURCES]);
    assert.deepEqual(literalsOfConstraint("content_trails_source_type_known"), [...TRAIL_SOURCE_TYPES]);
  });

  it("§4 Signals — the CHECK admits exactly TRAIL_SIGNALS (and the word 'signal' that guards it)", () => {
    const literals = literalsOfConstraint("content_trails_signal_vocabulary");
    // The constraint reads `relationship = 'signal' AND signal IN (…8…) OR
    // relationship <> 'signal' …`, so the eight are bracketed by two 'signal's.
    assert.deepEqual(literals, ["signal", ...TRAIL_SIGNALS, "signal"]);
  });
});

describe("migration 2910 ↔ §4's three label caps", () => {
  it("the trigger's three budgets are the three TS constants", () => {
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.content_trails_label_cap"));
    const caps = Object.fromEntries(
      [...fn.matchAll(/WHEN '(primary|supporting|signal)'\s+THEN (\d+)/g)].map((m) => [m[1], Number(m[2])]),
    );
    assert.deepEqual(caps, {
      primary: MAX_PRIMARY_TRAILS,
      supporting: MAX_SUPPORTING_TRAILS,
      signal: MAX_SIGNALS,
    });
  });

  it("the budgets are separate — the trigger filters on relationship, not on content alone", () => {
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.content_trails_label_cap"));
    assert.match(fn, /AND relationship = NEW\.relationship/,
      "without this predicate the three budgets collapse into one pool, which inverts §4");
  });
});

describe("migration 2910 does not re-open what the ruling closed", () => {
  it("it never admits a `trail` node kind to the intelligence graph (2290 stands)", () => {
    assert.ok(!/compass_graph_nodes_node_type_check\s+CHECK/.test(sql),
      "2910 must not redefine the graph's node-type constraint");
    assert.ok(!/ALTER TABLE\s+public\.compass_graph_nodes/.test(sql),
      "2910 must not alter compass_graph_nodes at all");
    assert.match(sql, /trail must NOT be admitted to the intelligence graph \(2290 stands\)/,
      "and it asserts 2290's refusal still holds as a postcondition");
  });

  // Judged on the EXECUTING SQL only: `--` lines and the bodies of COMMENT ON
  // statements are prose, and the prose deliberately NAMES these tables to say
  // it does not touch them. A check that could not tell a mention from a
  // reference would force the file to stop explaining itself.
  it("it touches none of the tables another lane owns", () => {
    const executing = sql
      .replace(/^\s*--.*$/gm, "")
      .replace(/COMMENT ON[\s\S]*?';/g, "");
    for (const owned of ["place_momentum", "protected_zones", "canonical_locations", "rank_events"]) {
      assert.ok(!executing.includes(owned),
        `2910 must not reference ${owned} in executing SQL (another lane owns it)`);
    }
    assert.ok(!/INSERT INTO public\.feature_flags/.test(executing),
      "2910 seeds no feature flag — the Discovery flag rows are another lane's");
    // And the prose DOES name them, so the coordination note cannot be deleted
    // without this test noticing.
    assert.match(sql, /COORDINATION: this file touches NONE of rank_events/);
  });

  // Every GRANT statement is extracted and its PRIVILEGE LIST inspected, rather
  // than matching `GRANT <verb>`: `GRANT SELECT, INSERT ON …` begins with a read
  // verb and grants a write, and a mutation proved the narrower pattern missed
  // exactly that.
  it("no client may write any Trail table, and the migration asserts it", () => {
    const grants = [...sql.matchAll(/^\s*GRANT\s+([\s\S]*?)\s+ON\s/gm)].map((m) => m[1]);
    assert.ok(grants.length > 0, "the migration should grant SELECT to authenticated somewhere");
    for (const privileges of grants) {
      assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/i.test(privileges),
        `a Trail table grants a write privilege: GRANT ${privileges} …`);
    }
    assert.match(sql, /authenticated must not write public\.%/);
  });
});
