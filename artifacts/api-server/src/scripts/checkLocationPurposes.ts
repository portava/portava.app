/**
 * check:location-purposes — every location-processing purpose is documented,
 * and every table holding coordinates belongs to one.
 *
 * Enforces the owner ruling of 2026-08-22. Reads the committed baseline (no
 * database) to find tables carrying coordinate columns, then asserts each is
 * either claimed by a declared purpose in lib/locationPurposes.ts or listed as
 * venue REFERENCE data.
 *
 * WHAT IT ENFORCES
 *   * a new table with lat/lng cannot ship unclaimed;
 *   * every purpose carries all four fields the ruling requires — lawful basis,
 *     retention, visibility, deletion behaviour;
 *   * a PRECISE purpose must have a BOUNDED retention (a clock, or an explicitly
 *     stated session/incident bound). "Minimize persistent raw movement history"
 *     is unenforceable if precise purposes may be open-ended.
 *
 * WHAT IT DOES NOT ENFORCE — stated rather than implied
 *   * that a declared lawful basis is CORRECT. That is a legal judgement; this
 *     checks that one was written down and can be reviewed.
 *   * that the retention is actually applied at runtime. location_snapshots had
 *     a documented 24h expiry and no cleanup job for months — a policy nothing
 *     executes is not a policy. Enforcement lives in the schedulers.
 *   * post-baseline tables, until the baseline is recaptured.
 */
import { readFileSync } from "node:fs";
import { BASELINE_PATH } from "./parseBaselineSchema.js";
import {
  LOCATION_PURPOSES, REFERENCE_LOCATION_TABLES, LAWFUL_BASES, PRECISION_CLASSES,
  RETENTION_BOUNDS, purposeTables, unboundedPrecisePurposes, precisePurposes,
  undecidedRetentionPurposes, ACKNOWLEDGED_OPEN_DECISIONS,
} from "../lib/locationPurposes.js";
// Reused rather than duplicated: deletionDispositions already tracks which
// tables post-date the 2026-08-19 baseline, and a second list would drift.
import { POST_BASELINE_TABLES } from "../lib/deletionDispositions.js";

const COORD_COLUMNS = new Set([
  "lat", "lng", "latitude", "longitude", "geog", "accuracy_m", "accuracy_meters",
  "heading_deg", "speed_mps",
]);

export function coordinateTablesFromBaseline(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of sql.matchAll(/^CREATE TABLE public\.([A-Za-z0-9_]+) \(([\s\S]*?)^\);/gm)) {
    const [, name, body] = m;
    const hit: string[] = [];
    for (const c of body.matchAll(/^\s+([a-z_][a-z0-9_]*)\s+/gm)) {
      if (COORD_COLUMNS.has(c[1])) hit.push(c[1]);
    }
    if (hit.length) out.set(name, hit);
  }
  return out;
}

export interface PurposeProblem { kind: string; detail: string }

export function computeProblems(tables: Map<string, string[]>): PurposeProblem[] {
  const problems: PurposeProblem[] = [];
  const claimed = purposeTables();
  const reference = new Set(REFERENCE_LOCATION_TABLES);
  const postBaseline = new Set(POST_BASELINE_TABLES);
  const baselineSql = readFileSync(BASELINE_PATH, "utf8");

  for (const [t] of tables) {
    if (reference.has(t) || claimed.has(t)) continue;
    problems.push({
      kind: "UNCLAIMED LOCATION TABLE",
      detail: `${t} holds coordinate columns but no declared purpose claims it. Add it to a purpose in lib/locationPurposes.ts with a lawful basis, retention, visibility and deletion behaviour — or to REFERENCE_LOCATION_TABLES if it is venue data rather than personal location.`,
    });
  }

  for (const p of LOCATION_PURPOSES) {
    if (!LAWFUL_BASES.includes(p.lawfulBasis)) {
      problems.push({ kind: "BAD LAWFUL BASIS", detail: `${p.id}: '${p.lawfulBasis}' is not a recognised basis.` });
    }
    if (!RETENTION_BOUNDS.includes(p.retentionBound)) {
      problems.push({ kind: "BAD RETENTION BOUND", detail: `${p.id}: '${p.retentionBound}' is not a recognised bound.` });
    }
    if (p.retentionBound === "clock" && p.retentionSeconds === null) {
      problems.push({ kind: "CLOCK WITHOUT A NUMBER", detail: `${p.id} claims a clock bound but sets no retentionSeconds.` });
    }
    if (!PRECISION_CLASSES.includes(p.precision)) {
      problems.push({ kind: "BAD PRECISION", detail: `${p.id}: '${p.precision}' is not a precision class.` });
    }
    for (const [field, v] of [["retentionNote", p.retentionNote], ["visibility", p.visibility], ["deletionBehavior", p.deletionBehavior], ["description", p.description]] as const) {
      if (!v || v.trim().length < 15) {
        problems.push({ kind: "THIN FIELD", detail: `${p.id}.${field} must be a real statement someone could review.` });
      }
    }
    if (p.tables.length === 0) {
      problems.push({ kind: "EMPTY PURPOSE", detail: `${p.id} claims no tables. Remove it or name what it processes.` });
    }
    for (const t of p.tables) {
      if (tables.has(t) || reference.has(t) || postBaseline.has(t)) continue;
      // Many purpose tables (plan_checkins, circle_presence) deliberately hold
      // NO coordinates, so absence from `tables` is fine. Only a name absent
      // from the baseline entirely is stale.
      if (!baselineSql.includes(`CREATE TABLE public.${t} (`)) {
        problems.push({ kind: "UNKNOWN TABLE", detail: `${p.id} claims '${t}', which is not in the baseline and is not declared post-baseline. Stale name?` });
      }
    }
  }

  // An open_decision bound on a NON-precise purpose was previously reported by
  // nothing: unboundedPrecisePurposes only inspects precise purposes. A warning
  // that only fires for one precision class is silent debt wearing a label.
  const acknowledged = new Set(ACKNOWLEDGED_OPEN_DECISIONS);
  for (const p of undecidedRetentionPurposes()) {
    if (!acknowledged.has(p.id)) {
      problems.push({
        kind: "NEW UNDECIDED RETENTION",
        detail: `${p.id} declares retentionBound 'open_decision' but is not in ACKNOWLEDGED_OPEN_DECISIONS. Decide its retention, or add it there with the decision it is waiting on — known debt may exist, it may not grow unnoticed.`,
      });
    }
  }

  for (const p of unboundedPrecisePurposes()) {
    problems.push({
      kind: "UNBOUNDED PRECISE RETENTION",
      detail: `${p.id} retains PRECISE location with no bound (retentionBound='${p.retentionBound}'). The ruling requires purpose-specific limits — set a clock with retentionSeconds, or a real bound (session / content_lifetime).`,
    });
  }

  return problems;
}

function main(): void {
  const tables = coordinateTablesFromBaseline(readFileSync(BASELINE_PATH, "utf8"));
  if (tables.size === 0) {
    console.error("✖ check-location-purposes: zero coordinate tables parsed — the scan has no subject.");
    process.exit(1);
  }
  const problems = computeProblems(tables);
  const precise = precisePurposes();

  console.log(
    `\ncheck-location-purposes: ${tables.size} table(s) hold coordinates in the baseline\n` +
      `   ${LOCATION_PURPOSES.length} declared purpose(s)\n` +
      `   ${precise.length} process PRECISE location — all must be bounded\n` +
      `   ${REFERENCE_LOCATION_TABLES.length} table(s) classified as venue reference data\n` +
      `   ${LOCATION_PURPOSES.filter((p) => p.requiresSeparateControl).length} require a separate user control\n` +
      `   ${undecidedRetentionPurposes().length} have an UNDECIDED retention window (${undecidedRetentionPurposes().map((p) => p.id).join(", ") || "none"})\n`,
  );

  if (problems.length > 0) {
    console.error(`✖ check-location-purposes FAILED — ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  • ${p.kind}: ${p.detail}`);
    process.exit(1);
  }
  console.log("✓ every coordinate-holding table is claimed by a documented purpose.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
