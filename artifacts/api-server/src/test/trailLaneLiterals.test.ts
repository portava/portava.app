/**
 * Trails lane — every filter literal and every referenced column, checked
 * against the REAL schema.
 *
 * WHY THIS FILE EXISTS. The Trails lane reads five tables (route_plans,
 * route_stops, trip_members, intel_observations, feature_flags) and filters them
 * on hard-coded string literals. Two failure modes make such a literal invisible:
 *
 *   • an ENUM-typed column filtered on a label the type cannot hold makes
 *     PostgREST reject the WHOLE query with 22P02 — and every Trails read is
 *     wrapped in a try/catch that turns that into an EMPTY result, not an error;
 *   • a TEXT+CHECK column filtered on a value the CHECK excludes does not even
 *     error: the read simply returns nothing, forever.
 *
 * Both are permanently inert code that looks completely healthy. The §14 outcome
 * derivation was in exactly that state until 2026-09-05 — `TRAIL_OUTCOME_VERBS`
 * held four strings (`arrival_confirmed`, `next_stop`, `entry_succeeded`,
 * `entry_failed`) that the `canonical_events` verb CHECK has never admitted, and
 * the test covering it used the same phantom vocabulary in its fixture, so it was
 * green over values production cannot produce.
 *
 * THE SCHEMA MODEL IS DERIVED, NOT TYPED OUT. Labels come from
 * `baseline/20260819_baseline_structure.sql` (a schema-only pg_dump) plus every
 * post-baseline migration, so a later `ALTER TYPE … ADD VALUE` or a re-added
 * CHECK is honoured. It deliberately does NOT come from
 * `src/lib/database.types.ts`, which over-reports.
 *
 * THE CODE LITERALS ARE READ OUT OF THE SOURCE, NOT RESTATED HERE. Each
 * assertion greps the production module for the literal it actually passes, so
 * editing the module to a dead literal turns this RED — restating the literal in
 * the test would only prove the test agrees with itself.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PILOT_CLAIMABLE_MODERATION_STATES, INTEL_FLAGS } from "../lib/intelContracts.js";
import { CAPTURE_SURFACES } from "../services/intel/IntelCaptureService.js";
import { extractColumnRefs } from "./helpers/schemaColumnExtractor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "../migrations");
const SRC = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");

const BASELINE = readFileSync(join(HERE, "../../baseline/20260819_baseline_structure.sql"), "utf8");
/** Every post-baseline migration, in apply order, so a later definition wins. */
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n");
const SCHEMA = `${BASELINE}\n${MIGRATIONS}`;

const TRAIL_LIVE_INTEL = SRC("lib/trailLiveIntel.ts");
const TRAIL_SERVE = SRC("lib/trailServe.ts");

// ── Tiny schema model ────────────────────────────────────────────────────────

/** Quoted literals inside the parenthesised body that follows `from`. */
function literalsAfter(sql: string, from: number): string[] {
  const open = sql.indexOf("(", from);
  if (open === -1) return [];
  let depth = 0;
  let i = open;
  for (; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") { depth--; if (depth === 0) break; }
  }
  return [...sql.slice(open, i + 1).matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

/** Enum labels for a type: the baseline CREATE TYPE plus any migration ADD VALUE. */
function enumLabels(type: string): Set<string> {
  const at = SCHEMA.indexOf(`CREATE TYPE public.${type} AS ENUM`);
  assert.notEqual(at, -1, `enum type ${type} not found in the schema`);
  const labels = new Set(literalsAfter(SCHEMA, at));
  for (const m of SCHEMA.matchAll(
    new RegExp(`ALTER TYPE public\\.${type}\\s+ADD VALUE\\s+(?:IF NOT EXISTS\\s+)?'([^']+)'`, "g"),
  )) labels.add(m[1]!);
  return labels;
}

/** The values a named CHECK constraint admits, taking its LAST definition. */
function checkLiterals(constraint: string): Set<string> {
  const re = new RegExp(`CONSTRAINT\\s+${constraint}\\b`, "g");
  let last = -1;
  for (const m of SCHEMA.matchAll(re)) last = m.index!;
  assert.notEqual(last, -1, `CHECK constraint ${constraint} not found in the schema`);
  const check = SCHEMA.indexOf("CHECK", last);
  assert.notEqual(check, -1, `${constraint} has no CHECK body`);
  return new Set(literalsAfter(SCHEMA, check));
}

/** Column names of a table: its CREATE TABLE block plus later ADD COLUMNs. */
function tableColumns(table: string): Set<string> {
  const patterns = [`CREATE TABLE public.${table} (`, `CREATE TABLE IF NOT EXISTS public.${table} (`, `CREATE TABLE IF NOT EXISTS ${table} (`];
  let start = -1;
  for (const p of patterns) {
    const at = SCHEMA.indexOf(p);
    if (at !== -1) { start = at + p.length - 1; break; }
  }
  assert.notEqual(start, -1, `table ${table} not found in the schema`);
  let depth = 0;
  let i = start;
  for (; i < SCHEMA.length; i++) {
    if (SCHEMA[i] === "(") depth++;
    else if (SCHEMA[i] === ")") { depth--; if (depth === 0) break; }
  }
  const cols = new Set<string>();
  for (const raw of SCHEMA.slice(start + 1, i).split("\n")) {
    const line = raw.trim();
    const m = /^([a-z_][a-z0-9_]*)\s+\S/.exec(line);
    if (m && !/^(constraint|primary|unique|foreign|check|exclude)$/i.test(m[1]!)) cols.add(m[1]!);
  }
  // `ALTER TABLE public.<t> ADD COLUMN a, ADD COLUMN b;` — take every ADD COLUMN
  // clause up to the statement terminator, not just the first.
  for (const stmt of SCHEMA.matchAll(new RegExp(`ALTER TABLE (?:ONLY )?public\\.${table}\\b([^;]*);`, "g")))
    for (const m of stmt[1]!.matchAll(/ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/g)) cols.add(m[1]!);
  return cols;
}

/** The literal a module passes to `.eq("<column>", "<literal>")`. */
function eqLiteral(source: string, column: string): string {
  const m = new RegExp(`\\.eq\\(\\s*"${column}"\\s*,\\s*"([^"]+)"\\s*\\)`).exec(source);
  assert.ok(m, `no .eq("${column}", "<literal>") found — the guard has lost its target`);
  return m![1]!;
}

// ── route_stops / route_plans / trip_members (lib/trailLiveIntel) ─────────────

describe("Trails · trailLiveIntel filters only on literals the schema admits", () => {
  it("the stop filter uses a real stop_source_type label", () => {
    const literal = eqLiteral(TRAIL_LIVE_INTEL, "source_type");
    const labels = enumLabels("stop_source_type");
    assert.ok(
      labels.has(literal),
      `route_stops.source_type is enum stop_source_type (${[...labels].join("|")}) — '${literal}' would 22P02 the whole read`,
    );
  });

  it("the membership filter uses a value trip_members_status_check admits", () => {
    const literal = eqLiteral(TRAIL_LIVE_INTEL, "status");
    const allowed = checkLiterals("trip_members_status_check");
    assert.ok(
      allowed.has(literal),
      `trip_members.status admits ${[...allowed].join("|")} — '${literal}' would silently authorise nobody`,
    );
  });

  it("every column the read references exists on route_plans / route_stops / trip_members", () => {
    for (const table of ["route_plans", "route_stops", "trip_members"]) {
      const cols = tableColumns(table);
      const refs = extractColumnRefs(TRAIL_LIVE_INTEL, table);
      assert.ok(refs.length > 0, `no column references extracted for ${table} — the guard has lost its target`);
      for (const ref of refs)
        assert.ok(cols.has(ref.column), `${table}.${ref.column} (.${ref.method}) does not exist in the schema`);
    }
  });
});

// ── intel_observations (lib/trailServe) ──────────────────────────────────────

describe("Trails · trailServe filters only on literals the schema admits", () => {
  it("every PILOT_CLAIMABLE_MODERATION_STATE is admitted by intel_observations_moderation_check", () => {
    const allowed = checkLiterals("intel_observations_moderation_check");
    for (const state of PILOT_CLAIMABLE_MODERATION_STATES)
      assert.ok(allowed.has(state), `moderation_state '${state}' is not admitted (${[...allowed].join("|")})`);
    // The filter really is the one being checked.
    assert.match(TRAIL_SERVE, /PILOT_CLAIMABLE_MODERATION_STATES/);
  });

  it("every capture surface the service accepts is storable in capture_surface", () => {
    const allowed = checkLiterals("intel_observations_capture_surface_check");
    for (const surface of CAPTURE_SURFACES)
      assert.ok(allowed.has(surface), `capture_surface '${surface}' is not admitted (${[...allowed].join("|")})`);
    assert.ok(allowed.has("trail"), "the trail surface must be storable at all");
  });

  it("every column the movement read selects or filters exists on intel_observations", () => {
    const cols = tableColumns("intel_observations");
    for (const extra of ["group_key", "party_size_bucket"]) assert.ok(cols.has(extra), `${extra} (2171) must be modelled`);
    const refs = extractColumnRefs(TRAIL_SERVE, "intel_observations");
    assert.ok(refs.length > 0, "no column references extracted — the guard has lost its target");
    for (const ref of refs)
      assert.ok(cols.has(ref.column), `intel_observations.${ref.column} (.${ref.method}) does not exist in the schema`);
  });

  it("the consent read references only real intel_contribution_consent columns", () => {
    const cols = tableColumns("intel_contribution_consent");
    for (const ref of extractColumnRefs(TRAIL_SERVE, "intel_contribution_consent"))
      assert.ok(cols.has(ref.column), `intel_contribution_consent.${ref.column} does not exist`);
  });
});

// ── The flag literal is not a phantom ────────────────────────────────────────

describe("Trails · the gating flag names a seeded row", () => {
  it("intel_trail_followup is seeded by a migration, so the gate reads a real flag", () => {
    assert.match(TRAIL_SERVE, /isFlagEnabled\(sc, "intel_trail_followup"\)/);
    assert.match(
      MIGRATIONS,
      /INSERT INTO public\.feature_flags[\s\S]{0,600}?'intel_trail_followup'/,
      "intel_trail_followup must be seeded; an unseeded flag literal reads as OFF forever",
    );
  });

  it("intel_capture_quick_signal — the declared dependency the chain now reads — is seeded too", () => {
    assert.match(TRAIL_SERVE, /isFlagEnabled\(sc, "intel_capture_quick_signal"\)/);
    assert.match(MIGRATIONS, /INSERT INTO public\.feature_flags[\s\S]{0,600}?'intel_capture_quick_signal'/);
  });

  /**
   * READ ⇔ SEEDED, both ways, for the whole §26 flag family.
   *
   * Three comments — in lib/trailServe, routes/intel and check-flag-polarity —
   * used to say `intel_movement_prediction` was "seeded OFF". It is not seeded at
   * all: no migration creates the row (nor for `intel_external_api` or
   * `intel_qiu_cash_pool`), because the rule migration 2165 records is that "a
   * flag row arrives with the unit that reads it, never before". Nothing reads
   * those three, so there is no live defect — but the comments were false, and a
   * false comment about a privacy gate is how the next reader concludes the gate
   * is configured when it is merely absent.
   *
   * The prose is now correct. This makes it LOAD-BEARING in both directions:
   *   • a flag the code reads MUST be seeded (an unseeded literal reads as OFF
   *     forever — the failure mode this whole file exists to catch);
   *   • a flag nothing reads must NOT be seeded (check-flag-polarity's own
   *     "seeded but never read" rule, restated here for this family).
   * Adding a reader for one of the three without its seed migration turns this
   * red, which is exactly when the comments would go stale again.
   */
  it("every §26 intel flag is EITHER read AND seeded, OR unread AND unseeded", () => {
    /**
     * A flag counts as READ when its literal appears QUOTED in production source
     * outside its declaration home. Quoted, because prose names a flag in
     * backticks or bare (`index.ts` mentions intel_missions in a comment) and a
     * comment is not a reader. Not "inline in an isFlagEnabled(…) call",
     * because a real reader may route through a named constant — CoverageService
     * reads `const MISSIONS_FLAG = "intel_missions"` — and a detector that
     * missed that would report a live gate as dead config.
     */
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist" || e.name === "migrations") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        // intelContracts.ts DECLARES the family (INTEL_FLAGS, the dependency
        // table). Declaring a flag is not reading one, so it is excluded — that
        // exclusion is the whole reason the three unread flags are detectable.
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && e.name !== "intelContracts.ts")
          sources.push(readFileSync(p, "utf8"));
      }
    };
    walk(join(HERE, ".."));
    const code = sources.join("\n");

    assert.ok(INTEL_FLAGS.length > 0, "the flag family must be non-empty for this guard to mean anything");
    const seenRead: string[] = [];
    const seenSeeded: string[] = [];
    for (const flag of INTEL_FLAGS) {
      const read = new RegExp(`["']${flag}["']`).test(code);
      const seeded = new RegExp(`INSERT INTO public\\.feature_flags[\\s\\S]{0,600}?'${flag}'`).test(MIGRATIONS);
      if (read) seenRead.push(flag);
      if (seeded) seenSeeded.push(flag);
      assert.equal(
        read, seeded,
        read
          ? `${flag} is READ in src/ but seeded by NO migration — the gate reads a missing row as OFF forever.`
          : `${flag} is SEEDED but read by nothing — dead config, or a reader that was removed.`,
      );
    }
    // Neither side may be vacuously empty: a regex that silently stopped
    // matching would make every assertion above pass by finding nothing.
    assert.ok(seenRead.length > 0, "no intel flag matched the READ pattern — the guard has lost its target");
    assert.ok(seenSeeded.length > 0, "no intel flag matched the SEED pattern — the guard has lost its target");
    // …and the three the comments name really are on the unread/unseeded side.
    for (const flag of ["intel_movement_prediction", "intel_external_api", "intel_qiu_cash_pool"] as const) {
      assert.ok((INTEL_FLAGS as readonly string[]).includes(flag), `${flag} must still be declared in INTEL_FLAGS`);
      assert.ok(!seenRead.includes(flag), `${flag} gained a reader — its seed migration is now owed`);
      assert.ok(!seenSeeded.includes(flag), `${flag} gained a seed — the "NOT SEEDED" comments are now false`);
    }
  });
});
