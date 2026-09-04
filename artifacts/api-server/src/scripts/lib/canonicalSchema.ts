/**
 * The CANONICAL schema — what this repository declares the database to be.
 *
 * WHY THIS EXISTS
 * ---------------
 * `check:write-path-columns` diffs the code's column references against the
 * LIVE database. That is a real check, but it can only run where live
 * credentials exist, and this repo's live lane is starved: of 100 sampled
 * live-DB runs, 64 were cancelled and 45% of commits received no verdict at
 * all. `places.country` reached `main` in that gap — a column the `places`
 * table has never had, and the founding example in
 * `silentSchemaErrorCatches.test.ts`'s own header.
 *
 * A wrong column name is not a fact about the database. It is a fact about the
 * repository: the code names a column that the repo's own migrations never
 * create. That is decidable with no network at all, and this module is how.
 *
 * WHAT "CANONICAL" MEANS HERE
 * ---------------------------
 * The committed schema-only pg_dump in `baseline/`, plus every migration in
 * `migrations/` and `src/migrations/` replayed over it. That is the same pair
 * of sources `auditMigrationsVsLive.ts` treats as the repo's declaration of
 * intent, so this does not invent a third opinion about the schema.
 *
 * DELIBERATELY A SUPERSET — the false-positive posture
 * ---------------------------------------------------
 * This model decides whether to FAIL a build, so its errors are not
 * symmetrical. A missed column produces a false failure that blocks unrelated
 * work; an extra column merely lets one bad reference through to the live
 * check. So every ambiguity resolves toward INCLUDING the column:
 *
 *   - `ADD COLUMN` is honoured; `DROP COLUMN` is honoured only when the drop
 *     is unconditional and the column is never re-added.
 *   - A table whose DDL this parser cannot confidently model is marked
 *     UNMODELLED, and `isModelled()` returns false for it. Callers must not
 *     flag references to unmodelled tables at all. That applies to
 *     `CREATE TABLE ... AS SELECT` and to bodies this parser cannot read.
 *   - Conditional DDL inside `DO $$ ... $$` / `EXECUTE` does NOT unmodel the
 *     table: an ADD COLUMN there is absorbed, a DROP COLUMN there is ignored.
 *     See `absorbDynamicColumns` for why abandoning the table was worse.
 *
 * The cost of that posture is stated rather than hidden: this check cannot
 * catch a reference to a column that was legitimately dropped, and it cannot
 * see tables built dynamically. The LIVE check still owns both.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CanonicalSchema {
  /** table -> the set of column names the repo declares for it. */
  columns: Map<string, Set<string>>;
  /** Tables this parser could NOT confidently model; never flag against these. */
  unmodelled: Set<string>;
  /** Provenance, for the report. */
  sources: { baseline: string; migrationFiles: number };
}

/** `CREATE TABLE [IF NOT EXISTS] [public.]<name> (` — the opening line only. */
const CREATE_TABLE_RE =
  /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([A-Za-z0-9_]+)"?\s*\(/i;
/** `CREATE TABLE ... AS SELECT` — column list is not statically knowable. */
const CREATE_TABLE_AS_RE =
  /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([A-Za-z0-9_]+)"?\s+AS\b/i;
/** `ALTER TABLE [ONLY] [IF EXISTS] [public.]<name>` — the statement's target. */
const ALTER_TARGET_RE =
  /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?"?([A-Za-z0-9_]+)"?/i;
/**
 * Clause-level matchers, applied WITHIN one ALTER TABLE statement.
 *
 * The first version of this file matched `ALTER TABLE ... ADD COLUMN` with a
 * single windowed regex. That captured only the FIRST clause of a multi-column
 * statement, so `2140_deletion_receipt.sql` —
 *
 *     ALTER TABLE public.user_deletion_requests
 *       ADD COLUMN IF NOT EXISTS receipt_code   text ...,
 *       ADD COLUMN IF NOT EXISTS policy_version text,
 *       ADD COLUMN IF NOT EXISTS worker_version text, ...
 *
 * contributed one column and hid five, and the check then reported five real
 * columns as undeclared. A model that produces false failures is worse than no
 * model, so these are matched per-clause against the whole statement instead.
 */
const CLAUSE_ADD_RE = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi;
const CLAUSE_DROP_RE = /\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi;
const CLAUSE_RENAME_RE =
  /\bRENAME\s+(?:COLUMN\s+)?"?([A-Za-z0-9_]+)"?\s+TO\s+"?([A-Za-z0-9_]+)"?/gi;

/**
 * Split SQL into statements on top-level `;`, leaving `$$ ... $$` bodies intact
 * so a procedural block is one statement rather than several fragments.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("$$", i)) {
      const end = sql.indexOf("$$", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const ch = sql[i]!;
    if (ch === ";") { out.push(cur); cur = ""; i++; continue; }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Reserved words that can begin a table-constraint line, not a column. */
const CONSTRAINT_STARTERS = new Set([
  "constraint", "primary", "unique", "foreign", "check", "exclude", "like", "partition",
]);

/**
 * Parse the column names out of one `CREATE TABLE name ( ... )` body.
 *
 * Returns null when the body cannot be confidently parsed, which the caller
 * must treat as "unmodelled" rather than "no columns" — the difference between
 * declining to judge and asserting emptiness.
 */
export function parseCreateTableColumns(body: string): Set<string> | null {
  const cols = new Set<string>();
  let depth = 0;
  let current = "";
  const parts: string[] = [];
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  if (parts.length === 0) return null;

  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    const first = line.split(/\s+/)[0]!.replace(/"/g, "").toLowerCase();
    if (CONSTRAINT_STARTERS.has(first)) continue;
    const m = /^"?([A-Za-z0-9_]+)"?\s+\S/.exec(line);
    if (!m) continue;
    cols.add(m[1]!);
  }
  return cols.size > 0 ? cols : null;
}

/** Extract every `CREATE TABLE t (...)` in `sql`, returning table -> columns. */
function createTablesIn(sql: string, unmodelled: Set<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const lines = sql.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const asMatch = CREATE_TABLE_AS_RE.exec(lines[i]!);
    if (asMatch) {
      unmodelled.add(asMatch[1]!);
      continue;
    }
    const m = CREATE_TABLE_RE.exec(lines[i]!);
    if (!m) continue;
    const table = m[1]!;
    // Accumulate until parens balance.
    let depth = 0;
    let body = "";
    let started = false;
    let j = i;
    for (; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === "(") { depth++; started = true; if (depth === 1) continue; }
        else if (ch === ")") { depth--; if (depth === 0) break; }
        if (started && depth >= 1) body += ch;
      }
      if (started && depth === 0) break;
      if (started) body += "\n";
    }
    if (!started || depth !== 0) { unmodelled.add(table); continue; }
    const cols = parseCreateTableColumns(body);
    if (cols === null) unmodelled.add(table);
    else out.set(table, cols);
    i = j;
  }
  return out;
}

/** Strip `--` line comments and `/* *\/` blocks so DDL regexes don't match prose. */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/**
 * DDL inside a procedural block (`DO $$ ... $$`, `EXECUTE format(...)`) is
 * conditional: whether it runs depends on runtime state this parser cannot
 * evaluate. The first version of this function responded by marking such a
 * table UNMODELLED — which turned out to be badly wrong in both directions.
 *
 * It abandoned `profiles` over `2142_phone_verification.sql`, a block that
 * manipulates no columns at all, and abandoned `places` — the table whose
 * `country`/`country_code` confusion is the entire reason this check exists.
 * A model that declines to judge the two most-referenced tables in the repo is
 * not a conservative model, it is an absent one.
 *
 * The correct handling follows from the over-inclusion posture in this file's
 * header. A conditional ADD COLUMN means the column MAY exist, so include it —
 * over-inclusion costs at most a missed catch, which the live check still owns.
 * A conditional DROP COLUMN means the column MAY still exist, so also keep it.
 * Either way the table stays modelled, and neither case can produce a false
 * failure.
 */
function absorbDynamicColumns(sql: string, columns: Map<string, Set<string>>): void {
  const blocks = [
    ...(sql.match(/DO\s+\$\$[\s\S]*?\$\$/gi) ?? []),
    ...(sql.match(/EXECUTE\s+(?:format\()?['"][\s\S]{0,400}?['"]/gi) ?? []),
  ];
  for (const b of blocks) {
    for (const stmt of splitStatements(b)) {
      const target = ALTER_TARGET_RE.exec(stmt);
      if (!target) continue;
      for (const m of stmt.matchAll(CLAUSE_ADD_RE)) {
        if (!columns.has(target[1]!)) columns.set(target[1]!, new Set());
        columns.get(target[1]!)!.add(m[1]!);
      }
    }
  }
}

function listSqlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listSqlFiles(p));
    else if (e.endsWith(".sql")) out.push(p);
  }
  return out;
}

/**
 * Build the canonical schema from the baseline dump plus every migration.
 *
 * `migrationDirs` are replayed in lexical order per directory, which is the
 * repo's own ordering convention (numeric prefixes, enforced by
 * `check:migration-prefixes`).
 */
export function buildCanonicalSchema(
  baselinePath: string,
  migrationDirs: string[],
): CanonicalSchema {
  const unmodelled = new Set<string>();
  const columns = new Map<string, Set<string>>();

  const baselineSql = stripSqlComments(readFileSync(baselinePath, "utf8"));
  for (const [t, cols] of createTablesIn(baselineSql, unmodelled)) {
    columns.set(t, new Set(cols));
  }

  const files: string[] = [];
  for (const d of migrationDirs) files.push(...listSqlFiles(d));

  for (const f of files) {
    const sql = stripSqlComments(readFileSync(f, "utf8"));
    absorbDynamicColumns(sql, columns);

    for (const [t, cols] of createTablesIn(sql, unmodelled)) {
      const existing = columns.get(t);
      if (existing) for (const c of cols) existing.add(c);
      else columns.set(t, new Set(cols));
    }
    for (const stmt of splitStatements(sql)) {
      const target = ALTER_TARGET_RE.exec(stmt);
      if (!target) continue;
      const t = target[1]!;
      for (const m of stmt.matchAll(CLAUSE_ADD_RE)) {
        if (!columns.has(t)) columns.set(t, new Set());
        columns.get(t)!.add(m[1]!);
      }
      for (const m of stmt.matchAll(CLAUSE_RENAME_RE)) {
        const set = columns.get(t);
        if (!set) continue;
        // Keep BOTH: a rename mid-history means either name may legitimately
        // appear in code written against a different point in that history,
        // and over-inclusion is the safe direction here.
        set.add(m[1]!);
        set.add(m[2]!);
      }
      for (const m of stmt.matchAll(CLAUSE_DROP_RE)) {
        columns.get(t)?.delete(m[1]!);
      }
    }
  }

  return {
    columns,
    unmodelled,
    sources: { baseline: baselinePath, migrationFiles: files.length },
  };
}

/** True when `table` was modelled confidently enough to judge references against. */
export function isModelled(schema: CanonicalSchema, table: string): boolean {
  return schema.columns.has(table) && !schema.unmodelled.has(table);
}

/** True when `table.column` is declared by the repo (or the table is unmodelled). */
export function hasColumn(schema: CanonicalSchema, table: string, column: string): boolean {
  if (!isModelled(schema, table)) return true; // decline to judge
  return schema.columns.get(table)!.has(column);
}
