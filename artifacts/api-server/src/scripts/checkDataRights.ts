/**
 * check:data-rights — every intel column has a stated ownership class.
 *
 * Reads migration 2130 (committed, static — no database) and asserts that every
 * column of the intel tables is either classified in lib/dataRights.ts or on the
 * INTERNAL_COLUMNS list. A new column therefore cannot be added without someone
 * saying whether it may ever leave Portava.
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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FIELD_RIGHTS, INTERNAL_COLUMNS, COVERED_TABLES, OWNERSHIP_CLASSES, REDISTRIBUTABLE,
} from "../lib/dataRights.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "../migrations/2130_intel_storage.sql");

/** Column names per intel table, parsed from the CREATE TABLE bodies. */
export function columnsFromMigration(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-z_]+) \(([\s\S]*?)\n\);/g)) {
    const [, table, body] = m;
    const cols: string[] = [];
    for (const line of body.split("\n")) {
      const c = line.match(/^\s{2}([a-z_][a-z0-9_]*)\s+[a-z]/i);
      if (c && !/^CONSTRAINT/i.test(c[1])) cols.push(c[1]);
    }
    out.set(table, cols);
  }
  return out;
}

export interface RightsProblem { kind: string; detail: string }

export function computeProblems(tables: Map<string, string[]>): RightsProblem[] {
  const problems: RightsProblem[] = [];
  const internal = new Set(INTERNAL_COLUMNS);
  const classified = new Set(FIELD_RIGHTS.map((f) => `${f.table}.${f.column}`));

  for (const t of COVERED_TABLES) {
    const cols = tables.get(t);
    if (!cols || cols.length === 0) {
      problems.push({ kind: "TABLE NOT PARSED", detail: `${t} has no columns in 2130 — the scan has no subject.` });
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
    if (!cols) { problems.push({ kind: "STALE TABLE", detail: `${f.table} is classified but not created by 2130.` }); continue; }
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
  const tables = columnsFromMigration(readFileSync(MIGRATION, "utf8"));
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
