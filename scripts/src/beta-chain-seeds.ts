/**
 * beta-chain-seeds.ts — which reference-table rows the migration CHAIN seeds
 * itself, read from the migration files. Pure: every function takes the SQL
 * text (or the file list and a reader) as an argument.
 *
 * WHY THIS EXISTS
 * ===============
 * beta-reference-snapshot.ts copies reference rows from portava-ci, and
 * beta-bootstrap.ts imports them BEFORE the chain (the canonical files at or
 * after CHAIN_START_PREFIX) is applied. A row the chain seeds itself must not be
 * among them: imported first, it pre-empts the chain's own seed — `ON CONFLICT
 * (flag) DO NOTHING` keeps the imported row — and the seeding file's
 * postcondition then measures the snapshot's row instead of its own. That is how
 * beta-db run 38070135058 (2026-10-10) stopped: 3513_layover_crowd_reports_flag.sql
 * seeds layover_crowd_reports_enabled TRUE and asserts it ON, and the snapshot had
 * imported that row with enabled forced 'false'. Leaving such rows to the chain
 * makes each chain file seed its own row exactly as it does on portava-ci, on
 * production and in CI's local-db replay (which applies the chain onto the
 * structure-only baseline with no reference rows at all).
 *
 * WHAT IT READS
 * =============
 * Every `INSERT INTO <table>` naming a reference table, at top level and inside
 * dollar-quoted bodies (DO blocks and function bodies are code: a seed inside
 * `DO $$ … $$` runs). Comments and string literals are not code. For each row
 * of `VALUES (…), (…)` it returns the row's primary-key value (as the text the
 * snapshot reads with `::text`), every column's raw value text, the conflict
 * action and the file:line.
 *
 * WHAT IT REFUSES — a problem, never a guess
 * ==========================================
 * A seed it cannot key exactly: no column list; not `INSERT … VALUES` (an
 * `INSERT … SELECT` or `DEFAULT VALUES` seeds rows nobody can name statically);
 * a value count that differs from the column count; a primary-key column absent
 * from the column list or not a plain literal; an `ON CONFLICT` whose arbiter is
 * not exactly the primary key (`ON CONSTRAINT`, no target, another column set, a
 * partial-index `WHERE`) — then the collision with an imported row is not on the
 * key this module excludes; and `COPY` or `MERGE` into the table. A caller treats
 * any problem as a refusal (scripts/src/beta-db-core.ts planReferenceTables).
 */

/** A reference table whose chain seeds are wanted. */
export interface SeedTableSpec {
  schema: string;
  table: string;
  /** Primary-key columns, in key order. */
  primaryKey: readonly string[];
}

export type ConflictAction = "none" | "nothing" | "update";

export interface ChainSeed {
  schema: string;
  table: string;
  /** The primary-key value(s), as text, in primaryKey order. */
  key: string[];
  /** Every column's raw value text from the VALUES row, trimmed (literals still quoted). */
  values: Record<string, string>;
  onConflict: ConflictAction;
  file: string;
  /** 1-based line of the INSERT keyword. */
  line: number;
}

export interface ChainSeedProblem {
  file: string;
  line: number;
  table: string;
  why: string;
}

export interface ChainSeedScan {
  seeds: ChainSeed[];
  problems: ChainSeedProblem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// MASKING — same length as the input, so offsets map back to the source
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blank every comment and every single-quoted string literal (newlines kept),
 * keep double-quoted identifiers as they are, and blank the `$tag$` DELIMITERS
 * of each dollar-quoted body while masking the body itself as code (its own
 * comments and literals blanked). The body is found by its closing tag first and
 * masked on its own, so a stray quote inside a body cannot run past it.
 */
export function maskForSeedScan(sql: string): string {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < sql.length; k++) out[k] = sql[k] === "\n" ? "\n" : " ";
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      const s = i;
      while (i < sql.length && sql[i] !== "\n") i++;
      blank(s, i);
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const s = i;
      let depth = 0;
      do {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      } while (i < sql.length && depth > 0);
      blank(s, i);
      continue;
    }
    if (ch === "'") {
      const s = i;
      // E'…' strings take backslash escapes; a plain '…' does not.
      const escapes = i > 0 && /[Ee]/.test(sql[i - 1]) && (i === 1 || !/[A-Za-z0-9_]/.test(sql[i - 2]));
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      blank(s, i);
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "$" && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        const end = sql.indexOf(tag, bodyStart);
        const bodyEnd = end === -1 ? sql.length : end;
        blank(i, bodyStart);
        const body = maskForSeedScan(sql.slice(bodyStart, bodyEnd));
        for (let k = 0; k < body.length; k++) out[bodyStart + k] = body[k];
        if (end !== -1) blank(end, end + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL PARSING HELPERS (over masked text; values are read from the source)
// ─────────────────────────────────────────────────────────────────────────────

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;

function unquoteIdent(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1).replace(/""/g, '"');
  return t.toLowerCase();
}

/** Index just past the `)` matching the `(` at `open` in masked text, or -1. */
function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Split [from, to) on commas at parenthesis/bracket depth 0 of the masked text; returns source slices. */
function splitTopLevel(src: string, masked: string, from: number, to: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  out.push(src.slice(start, to));
  return out;
}

function skipWs(masked: string, i: number): number {
  while (i < masked.length && /\s/.test(masked[i])) i++;
  return i;
}

/** The text value of a plain literal ('…' with '' escapes, an optional ::type cast, or an integer), or null. */
export function plainLiteralValue(raw: string): string | null {
  const t = raw.trim();
  const str = /^'((?:[^']|'')*)'(?:\s*::\s*[A-Za-z_][A-Za-z0-9_ ]*(?:\(\d+\))?(?:\[\])?)?$/.exec(t);
  if (str) return str[1].replace(/''/g, "'");
  if (/^-?\d+$/.test(t)) return t;
  return null;
}

function lineAt(src: string, at: number): number {
  let n = 1;
  for (let i = 0; i < at && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

function tableRe(head: string): RegExp {
  return new RegExp(`\\b${head}\\s+(?:ONLY\\s+)?(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})`, "gi");
}

function namesSpec(schemaRaw: string | undefined, tableRaw: string, spec: SeedTableSpec): boolean {
  const schema = schemaRaw === undefined ? "public" : unquoteIdent(schemaRaw);
  return schema === spec.schema && unquoteIdent(tableRaw) === spec.table;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SCAN
// ─────────────────────────────────────────────────────────────────────────────

/** Every seed of `specs`' tables in ONE file's SQL, and every seed it cannot key. Pure. */
export function scanSeedsInSql(sql: string, file: string, specs: readonly SeedTableSpec[]): ChainSeedScan {
  const masked = maskForSeedScan(sql);
  const seeds: ChainSeed[] = [];
  const problems: ChainSeedProblem[] = [];

  for (const kind of ["COPY", "MERGE\\s+INTO"]) {
    for (const m of masked.matchAll(tableRe(kind))) {
      const spec = specs.find((s) => namesSpec(m[1], m[2], s));
      if (spec) {
        problems.push({ file, line: lineAt(sql, m.index ?? 0), table: `${spec.schema}.${spec.table}`, why: `${kind.replace(/\\s\+/g, " ")} into the table: its rows cannot be keyed statically` });
      }
    }
  }

  for (const m of masked.matchAll(tableRe("INSERT\\s+INTO"))) {
    const spec = specs.find((s) => namesSpec(m[1], m[2], s));
    if (!spec) continue;
    const at = m.index ?? 0;
    const line = lineAt(sql, at);
    const tableName = `${spec.schema}.${spec.table}`;
    const refuse = (why: string) => problems.push({ file, line, table: tableName, why });

    let i = skipWs(masked, at + m[0].length);
    const alias = new RegExp(`^AS\\s+${IDENT}`, "i").exec(masked.slice(i));
    if (alias) i = skipWs(masked, i + alias[0].length);
    if (masked[i] !== "(") { refuse("INSERT without a column list"); continue; }
    const colEnd = matchParen(masked, i);
    if (colEnd === -1) { refuse("unbalanced column list"); continue; }
    const columns = splitTopLevel(sql, masked, i + 1, colEnd - 1).map(unquoteIdent);
    i = skipWs(masked, colEnd);
    if (/^OVERRIDING\b/i.test(masked.slice(i))) { refuse("INSERT … OVERRIDING … VALUE"); continue; }
    if (!/^VALUES\b/i.test(masked.slice(i))) {
      refuse(`not INSERT … VALUES (${masked.slice(i, i + 24).replace(/\s+/g, " ").trim() || "end of text"}…): the rows it seeds cannot be named statically`);
      continue;
    }
    i = skipWs(masked, i + "VALUES".length);
    const rows: Array<Record<string, string>> = [];
    let bad: string | null = null;
    for (;;) {
      if (masked[i] !== "(") { bad = "a VALUES row that is not a parenthesised list"; break; }
      const end = matchParen(masked, i);
      if (end === -1) { bad = "an unbalanced VALUES row"; break; }
      const vals = splitTopLevel(sql, masked, i + 1, end - 1).map((v) => v.trim());
      if (vals.length !== columns.length) { bad = `a VALUES row with ${vals.length} value(s) for ${columns.length} column(s)`; break; }
      rows.push(Object.fromEntries(columns.map((c, k) => [c, vals[k]])));
      i = skipWs(masked, end);
      if (masked[i] === ",") { i = skipWs(masked, i + 1); continue; }
      break;
    }
    if (bad) { refuse(bad); continue; }

    // The tail, up to the statement's end: the conflict clause.
    let tailEnd = masked.indexOf(";", i);
    if (tailEnd === -1) tailEnd = masked.length;
    const tail = masked.slice(i, tailEnd);
    let onConflict: ConflictAction = "none";
    const oc = /^\s*ON\s+CONFLICT\b/i.exec(tail);
    if (oc) {
      let j = skipWs(tail, oc[0].length);
      if (/^ON\s+CONSTRAINT\b/i.test(tail.slice(j))) { refuse("ON CONFLICT ON CONSTRAINT: the arbiter is not checked to be the primary key"); continue; }
      if (tail[j] !== "(") { refuse("ON CONFLICT without a conflict target: a collision on any unique key is skipped silently"); continue; }
      const close = matchParen(tail, j);
      if (close === -1) { refuse("unbalanced ON CONFLICT target"); continue; }
      const target = splitTopLevel(tail, tail, j + 1, close - 1).map((x) => x.trim());
      if (!target.every((x) => new RegExp(`^${IDENT}$`).test(x))) { refuse(`ON CONFLICT (${target.join(", ")}) is not a plain column list`); continue; }
      const cols = target.map(unquoteIdent).sort();
      if (cols.join(",") !== [...spec.primaryKey].sort().join(",")) {
        refuse(`ON CONFLICT (${cols.join(", ")}) is not the primary key (${spec.primaryKey.join(", ")})`);
        continue;
      }
      j = skipWs(tail, close);
      if (/^WHERE\b/i.test(tail.slice(j))) { refuse("ON CONFLICT (…) WHERE: a partial-index arbiter"); continue; }
      const action = /^DO\s+(NOTHING|UPDATE)\b/i.exec(tail.slice(j));
      if (!action) { refuse("ON CONFLICT without DO NOTHING / DO UPDATE"); continue; }
      onConflict = action[1].toUpperCase() === "NOTHING" ? "nothing" : "update";
    }

    for (const row of rows) {
      const key: string[] = [];
      for (const c of spec.primaryKey) {
        const raw = row[c];
        const v = raw === undefined ? null : plainLiteralValue(raw);
        if (v === null) {
          bad = raw === undefined ? `primary-key column ${c} is not in the column list` : `primary-key column ${c} is not a plain literal (${raw.slice(0, 60)})`;
          break;
        }
        key.push(v);
      }
      if (bad) break;
      seeds.push({ schema: spec.schema, table: spec.table, key, values: row, onConflict, file, line });
    }
    if (bad) refuse(bad);
  }
  return { seeds, problems };
}

/** scanSeedsInSql over every file, in the given (apply) order. Pure over (files, read). */
export function scanChainSeeds(
  files: readonly string[],
  read: (file: string) => string,
  specs: readonly SeedTableSpec[],
): ChainSeedScan {
  const seeds: ChainSeed[] = [];
  const problems: ChainSeedProblem[] = [];
  for (const f of files) {
    const r = scanSeedsInSql(read(f), f, specs);
    seeds.push(...r.seeds);
    problems.push(...r.problems);
  }
  return { seeds, problems };
}

/**
 * Unique keys (besides `primaryKey`) that `sql` declares on the table: CREATE
 * UNIQUE INDEX … ON it, or an ALTER TABLE on it adding UNIQUE, EXCLUDE or a
 * different PRIMARY KEY. Each is returned as a short description. Pure; used to
 * refuse keying chain seeds by the primary key alone where another unique key
 * could make the chain's `ON CONFLICT` skip its own row on an imported one.
 */
export function otherUniqueKeysInSql(sql: string, spec: SeedTableSpec): string[] {
  const masked = maskForSeedScan(sql);
  const found: string[] = [];
  const idx = new RegExp(
    `\\bCREATE\\s+UNIQUE\\s+INDEX\\b[^;]*?\\bON\\s+(?:ONLY\\s+)?(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})`,
    "gi",
  );
  for (const m of masked.matchAll(idx)) {
    if (namesSpec(m[1], m[2], spec)) found.push(`CREATE UNIQUE INDEX at line ${lineAt(sql, m.index ?? 0)}`);
  }
  const alter = new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})`, "gi");
  for (const m of masked.matchAll(alter)) {
    if (!namesSpec(m[1], m[2], spec)) continue;
    const at = m.index ?? 0;
    let end = masked.indexOf(";", at);
    if (end === -1) end = masked.length;
    const stmt = masked.slice(at, end);
    if (/\b(UNIQUE|EXCLUDE)\b/i.test(stmt)) found.push(`ALTER TABLE … UNIQUE/EXCLUDE at line ${lineAt(sql, at)}`);
    const pk = /\bPRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(stmt);
    if (pk) {
      const cols = pk[1].split(",").map(unquoteIdent).sort().join(",");
      if (cols !== [...spec.primaryKey].sort().join(",")) found.push(`ALTER TABLE … PRIMARY KEY (${pk[1].trim()}) at line ${lineAt(sql, at)}`);
    }
  }
  return found;
}

/** The text form of a key, as stored in a plan: the value itself for a one-column key, a JSON array otherwise. */
export function keyText(key: readonly string[]): string {
  return key.length === 1 ? key[0] : JSON.stringify(key);
}
