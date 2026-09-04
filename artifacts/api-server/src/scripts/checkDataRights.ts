/**
 * check:data-rights — every intel column has a stated ownership class.
 *
 * Reads the intel migrations (committed, static — no database): the CREATE TABLE
 * bodies from 2130 PLUS every `ALTER TABLE ... ADD COLUMN` across all migrations,
 * and asserts that every column of the intel tables is either classified in
 * lib/dataRights.ts or on the INTERNAL_COLUMNS list. A new column — whether it
 * arrives in a CREATE or a later ALTER — therefore cannot be added without someone
 * saying whether it may ever leave Portava. (Reading only 2130 once let 2171's
 * group_key / party_size_bucket slip in unclassified while this check stayed green.)
 *
 * WHAT IT DOES NOT ENFORCE, stated rather than implied:
 *   * that a classification is CORRECT. It enforces that somebody chose one.
 *   * that redistributable fields are actually being redistributed lawfully —
 *     a contributor licence and a partner agreement are documents, not code.
 *   * anything outside the intel tables. The registry is deliberately scoped;
 *     a registry nobody can finish is a registry nobody maintains.
 *
 * Exit 0 only if every intel column is classified or explicitly internal.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FIELD_RIGHTS, INTERNAL_COLUMNS, COVERED_TABLES, OWNERSHIP_CLASSES, REDISTRIBUTABLE,
} from "../lib/dataRights.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "../migrations");
/**
 * The migrations that CREATE intel tables. 2130 made the five storage tables;
 * I4a's 2277/2278 add the attribution + scoped-trust ledgers. A new intel table
 * is covered by listing its migration here AND the table in COVERED_TABLES.
 */
export const CREATE_MIGRATIONS = [
  "2130_intel_storage.sql",
  "2277_intel_outcomes_attribution.sql",
  "2278_intel_scoped_trust.sql",
] as const;

/** Column names per intel table, parsed from the CREATE TABLE bodies. */
export function columnsFromMigration(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-z_]+) \(([\s\S]*?)\n\);/g)) {
    const [, table, body] = m;
    const cols: string[] = [];
    for (const line of body.split("\n")) {
      const c = line.match(/^\s{2}([a-z_][a-z0-9_]*)\s+[a-z]/i);
      // Table-level constraint lines (CONSTRAINT …, PRIMARY KEY (…), UNIQUE (…),
      // FOREIGN KEY (…), CHECK (…)) are not columns — 2278's composite PK is the
      // first intel table to declare one.
      if (c && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)$/i.test(c[1])) cols.push(c[1]);
    }
    out.set(table, cols);
  }
  return out;
}

/** Columns added by `ALTER TABLE public.<t> ... ADD COLUMN [IF NOT EXISTS] <c>` in a sql string. */
export function alterAddColumns(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of sql.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?public\.([a-z_]+)([\s\S]*?);/gi)) {
    const [, table, body] = m;
    for (const cm of body.matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      const arr = out.get(table) ?? [];
      if (!arr.includes(cm[1])) arr.push(cm[1]);
      out.set(table, arr);
    }
  }
  return out;
}

/** CREATE TABLE bodies from every intel-creating migration (missing files are skipped). */
export function intelCreateColumns(dir: string): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const file of CREATE_MIGRATIONS) {
    let sql: string;
    try { sql = readFileSync(join(dir, file), "utf8"); } catch { continue; }
    for (const [table, cols] of columnsFromMigration(sql)) merged.set(table, cols);
  }
  return merged;
}

/**
 * The full live column set per intel table: the CREATE TABLE bodies (2130 +
 * 2277 + 2278) plus every ADD COLUMN across ALL migrations, so a column added
 * by a later ALTER is seen and must be classified — not silently skipped the
 * way 2171's were.
 */
export function allIntelColumns(dir: string): Map<string, string[]> {
  const merged = intelCreateColumns(dir);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".sql")) continue;
    for (const [table, cols] of alterAddColumns(readFileSync(join(dir, file), "utf8"))) {
      if (!COVERED_TABLES.includes(table)) continue;
      const arr = merged.get(table) ?? [];
      for (const c of cols) if (!arr.includes(c)) arr.push(c);
      merged.set(table, arr);
    }
  }
  return merged;
}

export interface RightsProblem { kind: string; detail: string }

export function computeProblems(tables: Map<string, string[]>): RightsProblem[] {
  const problems: RightsProblem[] = [];
  const internal = new Set(INTERNAL_COLUMNS);
  const classified = new Set(FIELD_RIGHTS.map((f) => `${f.table}.${f.column}`));

  for (const t of COVERED_TABLES) {
    const cols = tables.get(t);
    if (!cols || cols.length === 0) {
      problems.push({ kind: "TABLE NOT PARSED", detail: `${t} has no columns in any of ${CREATE_MIGRATIONS.join(", ")} — the scan has no subject.` });
      continue;
    }
    for (const c of cols) {
      if (internal.has(c)) continue;
      if (!classified.has(`${t}.${c}`)) {
        problems.push({
          kind: "UNCLASSIFIED FIELD",
          detail: `${t}.${c} has no ownership class. Add it to FIELD_RIGHTS with a reason, or to INTERNAL_COLUMNS if it can never be redistributed. Possession is not a right.`,
        });
      }
    }
  }

  // Stale entries and malformed classifications.
  for (const f of FIELD_RIGHTS) {
    const cols = tables.get(f.table);
    if (!cols) { problems.push({ kind: "STALE TABLE", detail: `${f.table} is classified but not created by an intel migration.` }); continue; }
    if (!cols.includes(f.column)) {
      problems.push({ kind: "STALE FIELD", detail: `${f.table}.${f.column} is classified but does not exist. Remove it.` });
    }
    if (!OWNERSHIP_CLASSES.includes(f.ownership)) {
      problems.push({ kind: "BAD CLASS", detail: `${f.table}.${f.column} has unknown ownership '${f.ownership}'.` });
    }
    if (!f.reason || f.reason.trim().length < 10) {
      problems.push({ kind: "EMPTY REASON", detail: `${f.table}.${f.column} needs a reason someone could defend.` });
    }
  }
  return problems;
}

function main(): void {
  const tables = allIntelColumns(MIGRATIONS_DIR);
  const problems = computeProblems(tables);
  const redistributable = FIELD_RIGHTS.filter((f) => REDISTRIBUTABLE[f.ownership]).length;
  const personal = FIELD_RIGHTS.filter((f) => f.personal).length;

  console.log(
    `\ncheck-data-rights: ${FIELD_RIGHTS.length} intel field(s) classified\n` +
      `   ${redistributable} may be redistributed (subject to licence/agreement terms)\n` +
      `   ${FIELD_RIGHTS.length - redistributable} may NOT leave Portava\n` +
      `   ${personal} carry or could reconstruct personal data\n`,
  );

  if (problems.length > 0) {
    console.error(`✖ check-data-rights FAILED — ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  • ${p.kind}: ${p.detail}`);
    process.exit(1);
  }
  console.log("✓ every intel column has a stated ownership class.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
