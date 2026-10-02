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

/**
 * Every NOT NULL column of one `public` table, read from a schema-only dump's
 * TEXT. Pure, so it unit-tests against fixture strings.
 *
 * Exists because a NOT NULL column is a constraint that application code can
 * violate silently until the one code path that violates it finally runs —
 * which is precisely how the account-deletion anonymisation step came to be
 * guaranteed-fatal on its first real invocation while every test passed.
 */
export function notNullColumns(sql: string, table: string): Set<string> {
  const cols = new Set<string>();
  const start = sql.indexOf(`CREATE TABLE public.${table} (`);
  if (start === -1) return cols;
  const end = sql.indexOf("\n);", start);
  if (end === -1) return cols;

  for (const raw of sql.slice(start, end).split("\n").slice(1)) {
    const line = raw.trim().replace(/,$/, "");
    if (!line.endsWith("NOT NULL")) continue;
    const name = /^([A-Za-z0-9_]+)\s/.exec(line)?.[1];
    if (name) cols.add(name);
  }
  return cols;
}

/**
 * Post-baseline nullability changes, read from src/migrations.
 *
 * WHY THIS EXISTS. `notNullColumns` reads the committed baseline dump, and the
 * baseline is a SNAPSHOT — it is not the current schema. The repo's standing
 * rule is that schema truth is "the baseline PLUS later migrations", and every
 * consumer of this module that skips the second half will eventually report a
 * column as NOT NULL after a forward migration has dropped that constraint.
 *
 * That is not hypothetical. Four migrations on main drop a NOT NULL the
 * committed baseline still carries, so the baseline and the schema disagree
 * about them TODAY:
 *
 *   - src/migrations/3359_passport_postcard_cover_nullable.sql
 *     (passport_postcards.media_url)
 *   - src/migrations/3421_ranking_debug_samples_content_id_nullable.sql
 *     (ranking_debug_samples.content_id)
 *   - src/migrations/2975_highlights_permanent_lifetime.sql
 *     (highlights.expires_at, so a PERMANENT Highlight has no expiry)
 *   - src/migrations/2999_trust_profiles_nullable_scores.sql
 *     (ten trust_profiles score columns, so an uncomputed score reads as
 *     unknown rather than as a confident 50.00)
 *
 * Without this, a consumer reads the baseline, sees NOT NULL, and reports a
 * write those migrations deliberately legalised as a defect.
 *
 * DIRECTION MATTERS, so both are parsed and applied in filename order: a later
 * `SET NOT NULL` re-tightens a column an earlier migration loosened. Parsing
 * only DROP would let a re-tightened column stay permanently exempt, which
 * would be a real weakening of every caller.
 *
 * SCOPE, STATED SO IT IS NOT MISTAKEN FOR MORE. This reads nullability DDL
 * ONLY. `ALTER COLUMN ... DROP DEFAULT` is invisible to it, by design and not
 * by accident: 2999 drops ten defaults alongside its ten NOT NULLs and this
 * function reports none of them. A caller that needs to know whether a column
 * still has a default must not ask this one.
 *
 * Returns a map of `table` -> { dropped, added }, already reduced to the FINAL
 * state after all migrations are applied in order.
 */
export interface NullabilityOverrides {
  /** Columns whose NOT NULL a later migration removed and did not restore. */
  dropped: Map<string, Set<string>>;
  /** Columns a later migration made NOT NULL that the baseline did not. */
  added: Map<string, Set<string>>;
}

/**
 * ONE `ALTER TABLE` statement and its whole clause list, up to the first `;`.
 *
 * Two stages, not one, and the reason is a measured miss rather than taste. A
 * single contiguous `ALTER TABLE <t> ALTER COLUMN <c> DROP NOT NULL` regex
 * matches only the FIRST clause of a multi-clause statement, because after
 * that match the scan resumes mid-statement where no `ALTER TABLE` follows.
 * 2999 is exactly that shape — one `ALTER TABLE public.trust_profiles` with
 * twenty comma-separated `ALTER COLUMN` clauses — so a contiguous match sees
 * `overall_score` and leaves the other NINE columns stale-NOT-NULL, which is
 * the same false accusation this module exists to stop, just quieter.
 *
 * MEASURED 2026-10-02 over all 680 files in src/migrations: the two-stage
 * parse finds 30 nullability clauses where the contiguous one finds 21. The
 * nine-clause difference is entirely 2999's remaining columns; nothing is
 * lost, and nothing new is claimed anywhere else.
 *
 * The trailing `\s` after the table name is load-bearing. Without it, a
 * dynamic `EXECUTE format('ALTER TABLE public.%I ALTER COLUMN actor_id DROP
 * NOT NULL', t)` — which 3002 really contains inside a DO loop — backtracks
 * into capturing the literal `public` as the table name and attributing a
 * column to a table that does not exist. Requiring whitespace where the
 * schema-qualified name ends makes that statement match nothing at all, which
 * is the correct answer: the table is a runtime placeholder and no static
 * parser can know it.
 *
 * Stopping at `;` is what keeps a statement's clauses from leaking into the
 * next statement. Inside a DO block a quoted `;` truncates the clause list
 * early, so the failure direction is a MISS, never an over-claim.
 */
const ALTER_TABLE_STMT =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([A-Za-z0-9_]+)\s([^;]*);/gi;

/** One nullability clause inside such a statement's clause list. */
const NULLABILITY_CLAUSE =
  /ALTER\s+COLUMN\s+([A-Za-z0-9_]+)\s+(DROP|SET)\s+NOT\s+NULL/gi;

export function parseNullabilityOverrides(files: Array<{ name: string; sql: string }>): NullabilityOverrides {
  const dropped = new Map<string, Set<string>>();
  const added = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, t: string, c: string) => {
    let s = m.get(t);
    if (!s) { s = new Set(); m.set(t, s); }
    s.add(c);
  };
  const del = (m: Map<string, Set<string>>, t: string, c: string) => m.get(t)?.delete(c);

  // Filename order is apply order for this band, so a later file wins.
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    // Strip line comments so a migration DOCUMENTING a constraint it is not
    // changing (this band comments heavily) cannot register as a change.
    const sql = f.sql.replace(/^\s*--.*$/gm, "");
    for (const stmt of sql.matchAll(ALTER_TABLE_STMT)) {
      const table = stmt[1];
      for (const clause of stmt[2].matchAll(NULLABILITY_CLAUSE)) {
        const [, column, verb] = clause;
        if (verb.toUpperCase() === "DROP") { add(dropped, table, column); del(added, table, column); }
        else { add(added, table, column); del(dropped, table, column); }
      }
    }
  }
  return { dropped, added };
}

/**
 * The effective NOT NULL set for a table: the baseline, minus what later
 * migrations dropped, plus what they added.
 */
export function effectiveNotNullColumns(
  baselineSql: string,
  table: string,
  overrides: NullabilityOverrides,
): Set<string> {
  const cols = notNullColumns(baselineSql, table);
  for (const c of overrides.dropped.get(table) ?? []) cols.delete(c);
  for (const c of overrides.added.get(table) ?? []) cols.add(c);
  return cols;
}
