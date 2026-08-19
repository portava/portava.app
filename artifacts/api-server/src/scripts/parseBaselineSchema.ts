/**
 * Parses artifacts/api-server/baseline/*.sql (a schema-only pg_dump of
 * production) for the two facts rlsDispositions.ts needs per `public`-schema
 * table: whether RLS is enabled, and how many policies exist.
 *
 * This is the SAME parser used to generate rlsDispositions.ts and to test it
 * (src/test/rlsDispositions.test.ts) — deliberately one implementation, not
 * two independently-written ones that could quietly drift apart and both be
 * wrong in the same direction.
 *
 * Statement shapes relied on (verified against the 2026-08-19 baseline
 * before writing this):
 *   CREATE TABLE public.<name> (                              -- one per line
 *   ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY;       -- one per line
 *   CREATE POLICY <name-or-"quoted name"> ON public.<name> ... -- may wrap
 *     onto following lines (long USING/WITH CHECK clauses), but "ON
 *     public.<name>" always appears on the CREATE POLICY line itself, so a
 *     per-line regex is sufficient — verified: 122 of 741 policy statements
 *     in the 2026-08-19 baseline wrap, and all 122 still have their target
 *     table on the opening line.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

/** Path to the most recent committed baseline capture. */
export const BASELINE_PATH = resolve(
  __dir,
  "../../baseline/20260819_baseline_structure.sql",
);

export interface BaselineTableInfo {
  table: string;
  rlsEnabled: boolean;
  policyCount: number;
}

const CREATE_TABLE_RE = /^CREATE TABLE public\.([A-Za-z0-9_]+)/;
const ENABLE_RLS_RE = /^ALTER TABLE public\.([A-Za-z0-9_]+) ENABLE ROW LEVEL SECURITY;/;
const CREATE_POLICY_RE = /^CREATE POLICY\s+(?:"[^"]*"|\S+)\s+ON public\.([A-Za-z0-9_]+)/;

/**
 * Parse a schema-only dump's TEXT (not a file path) for every `public`-schema
 * table's RLS status and policy count. Pure function — no filesystem access —
 * so it can be unit-tested against fixture strings independent of the
 * committed baseline file.
 */
export function parseBaselineTables(sql: string): Map<string, BaselineTableInfo> {
  const tables = new Map<string, BaselineTableInfo>();

  for (const line of sql.split("\n")) {
    const createMatch = CREATE_TABLE_RE.exec(line);
    if (createMatch) {
      const name = createMatch[1];
      if (!tables.has(name)) {
        tables.set(name, { table: name, rlsEnabled: false, policyCount: 0 });
      }
      continue;
    }
    const enableMatch = ENABLE_RLS_RE.exec(line);
    if (enableMatch) {
      const info = tables.get(enableMatch[1]);
      if (info) info.rlsEnabled = true;
      continue;
    }
    const policyMatch = CREATE_POLICY_RE.exec(line);
    if (policyMatch) {
      const info = tables.get(policyMatch[1]);
      // A policy on a table this dump never CREATE TABLE'd would be a parser
      // bug or a genuinely inconsistent dump — either way, do not silently
      // fabricate a table entry for it.
      if (info) info.policyCount += 1;
      continue;
    }
  }

  return tables;
}

/** Reads and parses the committed baseline file from disk. */
export function loadBaselineTables(): Map<string, BaselineTableInfo> {
  return parseBaselineTables(readFileSync(BASELINE_PATH, "utf8"));
}
