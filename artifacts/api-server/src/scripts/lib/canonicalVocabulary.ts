/**
 * Canonical VALUE vocabulary — what a column is allowed to CONTAIN.
 *
 * THE DEFECT CLASS THIS EXISTS FOR
 * --------------------------------
 * `lib/canonicalSchema.ts` models which COLUMNS a table has. That catches
 * `places.country`. It cannot catch this:
 *
 *     .from("trips").eq("status", "in_progress")
 *
 * `trips.status` is a real column. `in_progress` is not a label of the
 * `trip_status` enum (draft | planning | upcoming | active | completed |
 * cancelled | archived). Postgres does not match zero rows for an unknown enum
 * literal — it REJECTS the cast, 22P02, and PostgREST fails the WHOLE request.
 * The read returns an error object rather than throwing, so a surrounding
 * `try/catch` never fires and a `{ data }` destructure quietly yields
 * `undefined`. The feature is then permanently, silently empty.
 *
 * The CHECK-constrained TEXT variant is quieter still: no error at all, the
 * predicate simply matches nothing, forever.
 *
 * WHY NO TEST COULD SEE IT
 * ------------------------
 * Every fake Supabase client in this repo implements `eq` as
 * `filters.push(r => r[col] === val)`. It answers *"does my fixture's value
 * appear in what you passed?"* — never *"is what you passed a real label of
 * that column?"*. So a fixture written from a fiction PINS the fiction: a 2026-
 * 09-05 audit found three tests that were load-bearing (mutate the production
 * literal and they go RED) on values the database rejects outright. Passing
 * tests and load-bearing tests are both insufficient. The double has to be able
 * to fail the way the database fails — or, as here, something has to check the
 * literals against the schema instead of against the double.
 *
 * WHY `src/lib/database.types.ts` IS NOT THE SOURCE
 * -------------------------------------------------
 * It OVER-reports: it carries union members the live enums do not have (e.g.
 * `"suspended"` for account status). Believing it is how several of these
 * literals were written in the first place. The truth is the baseline dump plus
 * every migration that alters a type or a constraint — the same source
 * `lib/canonicalSchema.ts` uses, for the same reason: it needs no network, no
 * credentials, and cannot be starved by a flaky live-DB lane.
 *
 * FAILURE POSTURE — over-permissive on purpose
 * --------------------------------------------
 * A false failure here blocks unrelated work, so every ambiguity resolves
 * toward "allowed":
 *   - a column with no enum type and no parseable CHECK is NOT modelled, and
 *     nothing is ever flagged against it;
 *   - `ALTER TYPE … ADD VALUE` is unioned in regardless of the `IF NOT EXISTS`
 *     / `DO $$` guard around it;
 *   - when two CHECKs constrain one column the real vocabulary is their
 *     INTERSECTION, but this model takes the UNION — the wider, safer set;
 *   - a `DROP CONSTRAINT` with no replacement removes the vocabulary entirely,
 *     so the column stops being judged.
 * The cost is stated rather than hidden: this cannot catch a literal that is
 * legal in the declared schema but absent from the live one. `audit:schema`
 * owns that.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { splitStatements, stripSqlComments } from "./canonicalSchema.js";

export interface CanonicalVocabulary {
  /** `table.column` -> the set of values the repo declares it may hold. */
  values: Map<string, Set<string>>;
  /** `table.column` -> how that vocabulary was derived, for the report. */
  origin: Map<string, string>;
  /** Provenance. */
  sources: { baseline: string; migrationFiles: number };
}

const CREATE_TYPE_ENUM_RE =
  /CREATE\s+TYPE\s+(?:public\.)?"?([A-Za-z0-9_]+)"?\s+AS\s+ENUM\s*\(([^)]*)\)/gi;
const ALTER_TYPE_ADD_RE =
  /ALTER\s+TYPE\s+(?:public\.)?"?([A-Za-z0-9_]+)"?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']*)'/gi;
const CREATE_TABLE_RE =
  /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:public|auth|storage)\.)?"?([A-Za-z0-9_]+)"?\s*\(/i;
const ALTER_TARGET_RE =
  /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?"?([A-Za-z0-9_]+)"?/i;
const CLAUSE_ADD_COLUMN_RE =
  /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s+((?:public\.)?"?[A-Za-z0-9_]+"?)/gi;
const CLAUSE_ALTER_COLUMN_TYPE_RE =
  /\bALTER\s+(?:COLUMN\s+)?"?([A-Za-z0-9_]+)"?\s+(?:SET\s+DATA\s+)?TYPE\s+((?:public\.)?"?[A-Za-z0-9_]+"?)/gi;
const ADD_CONSTRAINT_CHECK_RE =
  /\bADD\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?\s+CHECK\s*\(/gi;
const DROP_CONSTRAINT_RE =
  /\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi;
const INLINE_CONSTRAINT_CHECK_RE =
  /\bCONSTRAINT\s+"?([A-Za-z0-9_]+)"?\s+CHECK\s*\(/gi;

/** Reserved words that begin a table-level constraint line, not a column. */
const CONSTRAINT_STARTERS = new Set([
  "constraint", "primary", "unique", "foreign", "check", "exclude", "like", "partition",
]);

function normalizeType(raw: string): string {
  return raw.replace(/^public\./i, "").replace(/"/g, "").toLowerCase();
}

/**
 * Read the balanced parenthesised expression that starts at `open` (the index
 * of its `(`). Returns the inside, or null if it never closes.
 */
function balanced(sql: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Pull `col -> labels` out of one CHECK expression body.
 *
 * Recognises the two forms Postgres and this repo write:
 *   col = ANY (ARRAY['a'::text, 'b'::text])     — pg_dump's normalisation
 *   col IN ('a', 'b')                            — how migrations are written
 *
 * Anything else (a range, a regex, a cross-column predicate, a subquery) yields
 * nothing, which correctly leaves the column unmodelled rather than asserting a
 * vocabulary this parser did not understand.
 */
export function vocabularyFromCheck(body: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (col: string, vals: string[]): void => {
    if (vals.length === 0) return;
    if (!out.has(col)) out.set(col, new Set());
    for (const v of vals) out.get(col)!.add(v);
  };
  for (const m of body.matchAll(
    /"?([A-Za-z0-9_]+)"?\s*=\s*ANY\s*\(\s*\(?\s*ARRAY\s*\[([^\]]*)\]/gi,
  )) {
    add(m[1]!, [...m[2]!.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]!.replace(/''/g, "'")));
  }
  for (const m of body.matchAll(/"?([A-Za-z0-9_]+)"?\s+IN\s*\(([^)]*)\)/gi)) {
    add(m[1]!, [...m[2]!.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]!.replace(/''/g, "'")));
  }
  return out;
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

interface Model {
  /** enum type name -> labels */
  enums: Map<string, Set<string>>;
  /** `table.column` -> declared SQL type (lower-cased, schema-stripped) */
  columnTypes: Map<string, string>;
  /** `table.column` -> constraintName -> labels */
  checks: Map<string, Map<string, Set<string>>>;
  /** constraintName -> `table.column` it constrained, so DROP can find it */
  constraintOwner: Map<string, Set<string>>;
}

function absorbEnums(sql: string, model: Model): void {
  for (const m of sql.matchAll(CREATE_TYPE_ENUM_RE)) {
    const name = m[1]!;
    const labels = [...m[2]!.matchAll(/'((?:[^']|'')*)'/g)].map((x) =>
      x[1]!.replace(/''/g, "'"),
    );
    if (!model.enums.has(name)) model.enums.set(name, new Set());
    for (const l of labels) model.enums.get(name)!.add(l);
  }
  // Absorbed unconditionally: an ADD VALUE inside a `DO $$ … $$` guard still
  // means the label MAY exist, and over-inclusion is the safe direction.
  for (const m of sql.matchAll(ALTER_TYPE_ADD_RE)) {
    if (!model.enums.has(m[1]!)) model.enums.set(m[1]!, new Set());
    model.enums.get(m[1]!)!.add(m[2]!);
  }
}

function recordCheck(
  model: Model,
  table: string,
  constraintName: string,
  body: string,
): void {
  for (const [col, vals] of vocabularyFromCheck(body)) {
    const key = `${table}.${col}`;
    if (!model.checks.has(key)) model.checks.set(key, new Map());
    model.checks.get(key)!.set(constraintName, vals);
    if (!model.constraintOwner.has(constraintName)) {
      model.constraintOwner.set(constraintName, new Set());
    }
    model.constraintOwner.get(constraintName)!.add(key);
  }
}

/** Parse `CREATE TABLE t ( … )` bodies for column types and inline CHECKs. */
function absorbCreateTables(sql: string, model: Model): void {
  const lines = sql.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = CREATE_TABLE_RE.exec(lines[i]!);
    if (!m) continue;
    const table = m[1]!;
    const openIdx = lines[i]!.indexOf("(");
    let rest = lines[i]!.slice(openIdx) + "\n";
    let depth = 0;
    let closed = false;
    for (const ch of rest) {
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { closed = true; break; } }
    }
    let j = i;
    while (!closed && ++j < lines.length) {
      rest += lines[j]! + "\n";
      depth = 0;
      let seen = false;
      for (const ch of rest) {
        if (ch === "(") { depth++; seen = true; }
        else if (ch === ")") { depth--; if (seen && depth === 0) { closed = true; break; } }
      }
    }
    const body = balanced(rest, rest.indexOf("("));
    if (body === null) { i = j; continue; }

    // Split on top-level commas into column / constraint definitions.
    const parts: string[] = [];
    let cur = "";
    let d = 0;
    for (const ch of body) {
      if (ch === "(") d++;
      else if (ch === ")") d--;
      if (ch === "," && d === 0) { parts.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);

    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      const first = line.split(/\s+/)[0]!.replace(/"/g, "").toLowerCase();
      if (CONSTRAINT_STARTERS.has(first)) {
        INLINE_CONSTRAINT_CHECK_RE.lastIndex = 0;
        const cm = INLINE_CONSTRAINT_CHECK_RE.exec(line);
        if (cm) {
          const inner = balanced(line, line.indexOf("(", cm.index));
          if (inner !== null) recordCheck(model, table, cm[1]!, inner);
        }
        continue;
      }
      const cm = /^"?([A-Za-z0-9_]+)"?\s+((?:public\.)?"?[A-Za-z0-9_]+"?)/.exec(line);
      if (!cm) continue;
      model.columnTypes.set(`${table}.${cm[1]!}`, normalizeType(cm[2]!));
    }
    i = j;
  }
}

/**
 * Statements to apply, with `DO $$ … $$` blocks flattened into the statements
 * they contain.
 *
 * THIS IS NOT A NICETY. The repo's idiom for an idempotent constraint change is
 *
 *     DO $$ BEGIN
 *       ALTER TABLE t DROP CONSTRAINT IF EXISTS c;
 *       ALTER TABLE t ADD CONSTRAINT c CHECK (col IN (…));
 *     END $$;
 *
 * and `splitStatements` deliberately keeps a `$$` body intact so its inner
 * semicolons do not split the outer statement. The result is one statement
 * beginning `DO`, which `ALTER_TARGET_RE` (anchored at `^\s*ALTER TABLE`) never
 * matches — so every widening written in that idiom was invisible and the model
 * kept reporting the PRE-migration vocabulary.
 *
 * That is not an over-permissive miss like the ones listed at the top of this
 * file; it is the one direction this check must never fail in. Migration 2302
 * widens `plan_attendance_events_event_type_check` to admit
 * 'suspicious_check_in' exactly this way, and without this flattening the check
 * called a live, correct, schema-legal literal DEAD and demanded it be
 * "repaired" into one nothing writes.
 *
 * Nesting is not attempted: `$$` bodies do not nest in this repo, and a `$$`
 * that never closes is left alone rather than guessed at.
 */
function* flattenStatements(sql: string): Generator<string> {
  for (const stmt of splitStatements(sql)) {
    yield stmt;
    let at = stmt.indexOf("$$");
    while (at !== -1) {
      const end = stmt.indexOf("$$", at + 2);
      if (end === -1) break;
      for (const inner of splitStatements(stmt.slice(at + 2, end))) yield inner;
      at = stmt.indexOf("$$", end + 2);
    }
  }
}

/** Apply `ALTER TABLE` statements: ADD COLUMN, ALTER COLUMN TYPE, ADD/DROP CONSTRAINT. */
function absorbAlters(sql: string, model: Model): void {
  for (const stmt of flattenStatements(sql)) {
    const target = ALTER_TARGET_RE.exec(stmt);
    if (!target) continue;
    const table = target[1]!;

    for (const m of stmt.matchAll(CLAUSE_ADD_COLUMN_RE)) {
      const key = `${table}.${m[1]!}`;
      if (!model.columnTypes.has(key)) model.columnTypes.set(key, normalizeType(m[2]!));
    }
    for (const m of stmt.matchAll(CLAUSE_ALTER_COLUMN_TYPE_RE)) {
      model.columnTypes.set(`${table}.${m[1]!}`, normalizeType(m[2]!));
    }
    // DROP before ADD: `DROP CONSTRAINT IF EXISTS x; ADD CONSTRAINT x CHECK(…)`
    // is the repo's idiom for widening, and it is frequently one statement.
    for (const m of stmt.matchAll(DROP_CONSTRAINT_RE)) {
      const owners = model.constraintOwner.get(m[1]!);
      if (!owners) continue;
      for (const key of owners) model.checks.get(key)?.delete(m[1]!);
    }
    for (const m of stmt.matchAll(ADD_CONSTRAINT_CHECK_RE)) {
      const openIdx = stmt.indexOf("(", m.index + m[0]!.length - 1);
      const inner = balanced(stmt, openIdx);
      if (inner !== null) recordCheck(model, table, m[1]!, inner);
    }
  }
}

/**
 * Build the value vocabulary from the baseline dump plus every migration,
 * replayed in the repo's own lexical order.
 */
export function buildCanonicalVocabulary(
  baselinePath: string,
  migrationDirs: string[],
): CanonicalVocabulary {
  const model: Model = {
    enums: new Map(),
    columnTypes: new Map(),
    checks: new Map(),
    constraintOwner: new Map(),
  };

  const baselineSql = stripSqlComments(readFileSync(baselinePath, "utf8"));
  absorbEnums(baselineSql, model);
  absorbCreateTables(baselineSql, model);
  absorbAlters(baselineSql, model);

  const files: string[] = [];
  for (const d of migrationDirs) files.push(...listSqlFiles(d));
  // Numeric prefix order, then name — the order check:migration-prefixes enforces.
  files.sort((a, b) => {
    const na = Number(/(\d+)/.exec(a.split("/").pop() ?? "")?.[1] ?? 0);
    const nb = Number(/(\d+)/.exec(b.split("/").pop() ?? "")?.[1] ?? 0);
    return na === nb ? a.localeCompare(b) : na - nb;
  });
  for (const f of files) {
    const sql = stripSqlComments(readFileSync(f, "utf8"));
    absorbEnums(sql, model);
    absorbCreateTables(sql, model);
    absorbAlters(sql, model);
  }

  const values = new Map<string, Set<string>>();
  const origin = new Map<string, string>();
  for (const [key, type] of model.columnTypes) {
    const labels = model.enums.get(type);
    if (labels && labels.size > 0) {
      values.set(key, new Set(labels));
      origin.set(key, `enum ${type}`);
    }
  }
  for (const [key, byName] of model.checks) {
    if (values.has(key)) continue; // an enum type is the stronger authority
    const union = new Set<string>();
    const names: string[] = [];
    for (const [name, vals] of byName) {
      names.push(name);
      for (const v of vals) union.add(v);
    }
    if (union.size === 0) continue; // every CHECK on it was dropped
    values.set(key, union);
    origin.set(key, `check ${names.sort().join(" + ")}`);
  }

  return {
    values,
    origin,
    sources: { baseline: baselinePath, migrationFiles: files.length },
  };
}

/** True when this column's value vocabulary is known well enough to judge. */
export function hasVocabulary(v: CanonicalVocabulary, table: string, column: string): boolean {
  return v.values.has(`${table}.${column}`);
}

/** True when `literal` is a declared value of `table.column` (or it is unmodelled). */
export function permits(
  v: CanonicalVocabulary,
  table: string,
  column: string,
  literal: string,
): boolean {
  const set = v.values.get(`${table}.${column}`);
  if (!set) return true; // decline to judge
  return set.has(literal);
}
