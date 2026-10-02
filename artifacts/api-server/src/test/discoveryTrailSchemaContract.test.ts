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
  isTrailLifecycleTransitionAllowed, isTrailContentTransitionAllowed,
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

// ── 3380 / 3381 — the later migrations that restate a Trail rule (§51) ──────
//
// 3380 REPLACES 2910's label-cap function, so the budgets the database enforces
// now live in 3380's text, and the 2910 assertions above describe a body that is
// no longer installed wherever 3380 is applied. 3381 writes §7's transition
// relation a SECOND time, in SQL. Both are pinned to the TypeScript here, as
// text, so the ordinary credential-free suite catches a drift the harness suite
// (src/test/db/trailsConstraints.db.test.ts T5/C2) would only catch where a
// database runs.

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const sql3380 = readFileSync(resolve(MIGRATIONS_DIR, "3380_content_trails_label_cap_serialised.sql"), "utf8");
const sql3381 = readFileSync(resolve(MIGRATIONS_DIR, "3381_trail_lifecycle_transitions.sql"), "utf8");
const rollback3380 = readFileSync(resolve(MIGRATIONS_DIR,
  "../../../../db/rollback/2026-09-27-3380-content-trails-label-cap-serialised-rollback.sql"), "utf8");

/** The `$fn$ … $fn$` body of the named function in a migration's text. */
function fnBody(text: string, name: string): string {
  const at = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
  assert.notEqual(at, -1, `no CREATE OR REPLACE FUNCTION public.${name}()`);
  const open = text.indexOf("$fn$", at);
  const close = text.indexOf("$fn$", open + 4);
  return text.slice(open + 4, close);
}

/** `(OLD.col = 'a' AND NEW.col IN ('b', 'c'))` clauses → from → sorted tos. */
function relationOf(body: string, col: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const re = new RegExp(`OLD\\.${col} = '([a-z_]+)'\\s+AND NEW\\.${col} IN \\(([^)]*)\\)`, "g");
  for (const m of body.matchAll(re)) {
    out[m[1]!] = [...m[2]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!).sort();
  }
  return out;
}

/** The TypeScript relation, read through its own predicate over every pair. */
function tsRelation<S extends string>(states: readonly S[], allowed: (a: S, b: S) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const from of states) {
    const tos = states.filter((to) => to !== from && allowed(from, to));
    if (tos.length > 0) out[from] = [...tos].sort();
  }
  return out;
}

describe("3380 ↔ §4's three label caps, and the lock that makes them hold under concurrency", () => {
  it("3380's budgets are the three TS constants", () => {
    const body = fnBody(sql3380, "content_trails_label_cap");
    const caps = Object.fromEntries(
      [...body.matchAll(/WHEN '(primary|supporting|signal)'\s+THEN (\d+)/g)].map((m) => [m[1], Number(m[2])]),
    );
    assert.deepEqual(caps, { primary: MAX_PRIMARY_TRAILS, supporting: MAX_SUPPORTING_TRAILS, signal: MAX_SIGNALS });
  });

  it("the per-content advisory lock is taken BEFORE the count, or it serialises nothing", () => {
    const body = fnBody(sql3380, "content_trails_label_cap");
    const lock = body.indexOf("pg_advisory_xact_lock");
    const count = body.indexOf("SELECT count(*) INTO held");
    assert.ok(lock !== -1 && count !== -1 && lock < count, "the lock must precede the count");
    assert.match(body, /NEW\.source_type \|\| ':' \|\| NEW\.source_id/, "keyed on the CONTENT, the unit §4 budgets");
  });

  it("the one budget §4 fixes at ONE is also a partial UNIQUE index", () => {
    assert.match(sql3380,
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_content_trails_one_primary\s+ON public\.content_trails \(source_type, source_id\) WHERE relationship = 'primary';/);
    assert.equal(MAX_PRIMARY_TRAILS, 1);
  });

  it("the rollback restores 2910's function body byte-for-byte", () => {
    assert.equal(fnBody(rollback3380, "content_trails_label_cap"), fnBody(sql, "content_trails_label_cap"));
  });
});

describe("3381 ↔ §7's transition relations in lib/discoveryTrailObject", () => {
  it("the Trail lifecycle relation is the TypeScript one, pair for pair", () => {
    assert.deepEqual(
      relationOf(fnBody(sql3381, "trails_lifecycle_transition"), "lifecycle_status"),
      tsRelation(TRAIL_LIFECYCLE_STATES, isTrailLifecycleTransitionAllowed),
    );
  });

  it("the in-Trail content relation is the TypeScript one, pair for pair", () => {
    assert.deepEqual(
      relationOf(fnBody(sql3381, "content_trails_state_transition"), "content_state"),
      tsRelation(TRAIL_CONTENT_STATES, isTrailContentTransitionAllowed),
    );
  });

  it("archived has NO outgoing clause — terminal in SQL as in TypeScript", () => {
    const rel = relationOf(fnBody(sql3381, "trails_lifecycle_transition"), "lifecycle_status");
    assert.equal(rel.archived, undefined);
    assert.ok(Object.keys(rel).length === 4, "the four non-terminal states each have a clause");
  });
});
