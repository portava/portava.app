/**
 * beta-db-core.ts — the PURE half of the beta-environment bootstrap.
 *
 * Shared by scripts/src/beta-bootstrap.ts (writes the portava-beta project)
 * and scripts/src/beta-reference-snapshot.ts (reads portava-ci). Everything
 * here is a constant, a parser, a planner or a SQL-text builder. The one
 * function that performs I/O against a network, managementApi(), takes its
 * project ref and token as ARGUMENTS: this module reads no environment
 * variable and names no credential, so scripts/src/beta-bootstrap.test.ts can
 * import all of it with no credentials and no database.
 *
 * SCHEMA TRUTH
 * ============
 * The beta project is built from exactly two inputs, the same two every other
 * replay in this repo uses (artifacts/api-server/scripts/local-db/up.sh):
 *
 *   1. artifacts/api-server/baseline/20260819_baseline_structure.sql — a
 *      pg_dump 17 STRUCTURE-ONLY dump of production as of 2026-08-19;
 *   2. the canonical chain artifacts/api-server/src/migrations/*.sql, from the
 *      first file whose objects the baseline lacks (CHAIN_START_PREFIX) on,
 *      applied by the UNCHANGED applier, scripts/src/apply-migrations.ts.
 *
 * Never src/lib/database.types.ts. That file is a generated client type, not a
 * schema, and it has drifted from both of the above before.
 *
 * Because the baseline is STRUCTURE-only, rows that migrations sorting before
 * CHAIN_START_PREFIX seeded (feature flags, stamp definitions, country
 * essentials, …) are in neither input. beta-reference-snapshot.ts copies them
 * from portava-ci under an explicit allowlist (REFERENCE_PUBLIC_TABLES) and the
 * bootstrap imports them before the chain runs, because chain files such as
 * 2970_stamp_definitions_evidences_presence.sql refuse to run against an empty
 * catalog (artifacts/api-server/scripts/local-db/KNOWN_UNREPLAYABLE.json).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIGRATIONS_DIR,
  classifyMigration,
  compareMigrationFilenames,
  findTransactionStatements,
  listMigrationFiles,
  maskForKeywordScan,
  maskNonCode,
} from "./apply-migrations.js";

const __dir = dirname(fileURLToPath(import.meta.url));

/** The repository root (scripts/src -> repo). */
export const REPO_ROOT = resolve(__dir, "..", "..");

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE REFS. Hard facts, compared by ref and never by display name: the
// CI credential once enumerated two different projects both called
// "travel-buddy" (see .github/scripts/assert-nonprod-supabase.sh).
// ─────────────────────────────────────────────────────────────────────────────

/** portava-beta — created 2026-10-06, empty, Postgres 17, us-east-1. */
export const BETA_PROJECT_REF = "emfpckykpzfturllshly";
/** Production. Never a target and never a source, of anything in this file. */
export const PRODUCTION_PROJECT_REF = "ajrurzioarfkagpuxfnb";

/** The same shape rule the allowlist policy script applies. */
const SUPABASE_URL_RE = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/;

/** The project ref in https://<ref>.supabase.co, or null when it is not that shape. */
export function resolveProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  const m = SUPABASE_URL_RE.exec(url);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// INPUT LOCATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const BASELINE_REL = "artifacts/api-server/baseline/20260819_baseline_structure.sql";
export const BASELINE_PATH = join(REPO_ROOT, BASELINE_REL);

/**
 * The first canonical filename prefix whose objects are ABSENT from the
 * baseline. Measured, not assumed: 2092_discovery_shadow_serves.sql's table is
 * in the dump and 2093's grants are not. It is the same boundary the local
 * replay uses (`FROM="${LOCAL_DB_FROM:-2093}"` in
 * artifacts/api-server/scripts/local-db/up.sh), and the unit test asserts the
 * two agree.
 */
export const CHAIN_START_PREFIX = "2093_";

/** The migration that creates public.schema_migration_ledger. */
export const LEDGER_MIGRATION_FILE = "2254_schema_migration_ledger.sql";
export const LEDGER_TABLE = "public.schema_migration_ledger";

/**
 * The `notes` value of every row the bootstrap backfills. 2254's own
 * provenance vocabulary is used unchanged (checksum 'backfill', applied_by
 * 'backfill'): such a row asserts that the file is accounted for by something
 * other than an individual apply, and the applier's isProofOfApply() already
 * treats it as "not proof", which is exactly right.
 */
export const BACKFILL_NOTES =
  "beta-bootstrap 2026-10-06: covered by baseline/20260819_baseline_structure.sql " +
  "(+reference snapshot); not individually replayed";

/** Statements per Management API call. */
export const BATCH_SIZE = 200;

/** A reference table larger than this is not reference data; refuse it. */
export const REFERENCE_ROW_CAP = 20_000;

/** Rows per INSERT when importing a reference table. */
export const IMPORT_CHUNK_ROWS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// SQL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Plain lowercase identifiers only — every name this module splices into SQL. */
const SIMPLE_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function assertSimpleIdent(name: string, what: string): void {
  if (!SIMPLE_IDENT_RE.test(name)) {
    throw new Error(`${what} '${name}' is not a plain lowercase identifier; refusing to splice it into SQL.`);
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Collapse runs of whitespace; used on MASKED text only. */
function norm(masked: string): string {
  return masked.replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// DOLLAR QUOTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is `$tag$` a safe delimiter for `body`?
 *
 * Not merely "the body does not contain $tag$". The closing delimiter is
 * appended to the body, so a body ENDING in a prefix of it ("…$bb") would form
 * the delimiter one character early and end the literal there. The exact
 * condition is that the first occurrence of `$tag$` in body+delimiter is the
 * appended one — which is how PostgreSQL's scanner reads a dollar-quoted
 * string (it ends at the first occurrence of the opening tag).
 */
export function isSafeDollarTag(body: string, tag: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag)) return false;
  const d = `$${tag}$`;
  return (body + d).indexOf(d) === body.length;
}

/** The first of `prefix`, `prefix1`, `prefix2`, … that is safe for every body. */
export function chooseDollarTag(bodies: readonly string[], prefix: string): string {
  for (let k = 0; k < 100_000; k++) {
    const tag = k === 0 ? prefix : `${prefix}${k}`;
    if (bodies.every((b) => isSafeDollarTag(b, tag))) return tag;
  }
  throw new Error(`no safe dollar-quote tag with prefix '${prefix}' was found`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STATEMENT SPLITTING — reuses the applier's comment/literal/dollar-quote mask
// ─────────────────────────────────────────────────────────────────────────────

export interface SqlStatement {
  /** 1-based position among the file's top-level statements. */
  ordinal: number;
  /** 1-based line of the statement's first code character. */
  line: number;
  /** Raw text from the first code character up to (not including) its `;`. */
  code: string;
  /** maskNonCode() of the same span: comments, literals and bodies blanked. */
  masked: string;
}

export interface SplitResult {
  statements: SqlStatement[];
  /** Code after the last `;`, or null when there is none. */
  unterminated: string | null;
}

/**
 * Split on TOP-LEVEL semicolons, using apply-migrations' maskNonCode() so a `;`
 * inside a comment, a string literal, a quoted identifier or a dollar-quoted
 * function body never ends a statement. Leading comments (pg_dump's
 * `-- Name: …; Type: …` headers) are not part of `code`.
 */
export function splitTopLevelStatements(sql: string): SplitResult {
  const masked = maskNonCode(sql);
  const statements: SqlStatement[] = [];
  let start = 0;
  let lineAtCursor = 1;
  let cursor = 0;
  const lineOf = (offset: number): number => {
    for (; cursor < offset; cursor++) if (sql[cursor] === "\n") lineAtCursor++;
    return lineAtCursor;
  };
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== ";") continue;
    const seg = masked.slice(start, i);
    const off = seg.search(/\S/);
    if (off !== -1) {
      const from = start + off;
      statements.push({
        ordinal: statements.length + 1,
        line: lineOf(from),
        code: sql.slice(from, i).trimEnd(),
        masked: masked.slice(from, i).trimEnd(),
      });
    }
    start = i + 1;
  }
  const tail = masked.slice(start);
  return {
    statements,
    unterminated: tail.trim() === "" ? null : sql.slice(start).trim(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SKIP RULES
// ─────────────────────────────────────────────────────────────────────────────

export type SkipRule =
  | "dump-session-preamble"
  | "platform-schema"
  | "storage-platform-object"
  | "supabase-admin-default-privileges";

/** Why each rule exists. Printed next to every skipped statement. */
export const SKIP_RULE_REASONS: Record<SkipRule, string> = {
  "dump-session-preamble":
    "pg_dump's own session SETs and its set_config(search_path). Each batch runs a fixed prelude " +
    "instead (BATCH_PRELUDE) and beta_bootstrap.run() pins search_path='' itself.",
  "platform-schema":
    "CREATE SCHEMA public / storage. Both exist on every Supabase project; recreating them fails.",
  "storage-platform-object":
    "An object in schema `storage` (its types, functions, tables, indexes, triggers, constraints, " +
    "RLS switches, grants and default privileges). The Storage service owns and migrates that schema " +
    "on every project; restating its 2026-08-19 shape over the beta project's would fight it. The " +
    "app's own CREATE POLICY … ON storage.objects statements are NOT skipped.",
  "supabase-admin-default-privileges":
    "ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin. The Management API runs as `postgres`, which " +
    "cannot alter another role's default privileges; Supabase already sets these on every project.",
};

export type StatementDecision =
  | { action: "execute"; appStoragePolicy: boolean }
  | { action: "skip"; rule: SkipRule };

/**
 * The schema of the object a pg_dump statement targets, or null when the
 * statement has no single target this function recognises. Reads NORMALISED
 * MASKED text, so a schema name inside a literal or a function body is never
 * mistaken for a target.
 */
export function statementTargetSchema(maskedNorm: string): string | null {
  const S = "([a-z_][a-z0-9_]*)";
  const patterns: RegExp[] = [
    new RegExp(
      `^CREATE (?:OR REPLACE )?(?:UNLOGGED )?(?:TYPE|FUNCTION|PROCEDURE|AGGREGATE|TABLE|VIEW|MATERIALIZED VIEW|SEQUENCE|DOMAIN) ${S}\\.`,
      "i",
    ),
    new RegExp(
      `^ALTER (?:TABLE|SEQUENCE|FUNCTION|PROCEDURE|TYPE|VIEW|MATERIALIZED VIEW|INDEX|DOMAIN)(?: IF EXISTS)?(?: ONLY)? ${S}\\.`,
      "i",
    ),
    new RegExp(`^CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)?(?: IF NOT EXISTS)?(?: \\S+)? ON(?: ONLY)? ${S}\\.`, "i"),
    new RegExp(`^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER \\S+ .*? ON ${S}\\.`, "i"),
    new RegExp(`^CREATE POLICY (?:\\S+ )?ON ${S}\\.`, "i"),
    new RegExp(
      `^COMMENT ON (?:COLUMN|TABLE|FUNCTION|PROCEDURE|TYPE|VIEW|MATERIALIZED VIEW|INDEX|SEQUENCE|DOMAIN|AGGREGATE) ${S}\\.`,
      "i",
    ),
    new RegExp(`^COMMENT ON (?:POLICY|TRIGGER|CONSTRAINT|RULE) (?:\\S+ )?ON ${S}\\.`, "i"),
    new RegExp(`^COMMENT ON SCHEMA ${S}(?: |$)`, "i"),
    new RegExp(`^(?:GRANT|REVOKE) .*? ON SCHEMA ${S}(?: |$)`, "i"),
    new RegExp(`^(?:GRANT|REVOKE) .*? ON (?:TABLE |FUNCTION |PROCEDURE |SEQUENCE |TYPE |DOMAIN )?${S}\\.`, "i"),
    new RegExp(`^ALTER DEFAULT PRIVILEGES .*? IN SCHEMA ${S}(?: |$)`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(maskedNorm);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Decide one baseline statement. The rules are documented in SKIP_RULE_REASONS. */
export function classifyBaselineStatement(masked: string): StatementDecision {
  const n = norm(masked);
  if (/^SET /i.test(n) || /^SELECT pg_catalog\.set_config ?\(/i.test(n)) {
    return { action: "skip", rule: "dump-session-preamble" };
  }
  if (/^CREATE SCHEMA (?:public|storage)$/i.test(n)) {
    return { action: "skip", rule: "platform-schema" };
  }
  if (/^ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin /i.test(n)) {
    return { action: "skip", rule: "supabase-admin-default-privileges" };
  }
  if (statementTargetSchema(n) === "storage") {
    if (/^CREATE POLICY (?:\S+ )?ON storage\.objects /i.test(n)) {
      return { action: "execute", appStoragePolicy: true };
    }
    return { action: "skip", rule: "storage-platform-object" };
  }
  return { action: "execute", appStoragePolicy: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BASELINE MODEL — what the dump declares, measured from the file
// ─────────────────────────────────────────────────────────────────────────────

export interface BaselineColumn {
  name: string;
  type: string;
  notNull: boolean;
  /** GENERATED ALWAYS AS (expr) STORED — never inserted into. */
  generated: boolean;
  identity: boolean;
  /** Exactly json or jsonb (not an array of them). */
  isJson: boolean;
}

export interface BaselineTable {
  schema: string;
  name: string;
  columns: BaselineColumn[];
  /** REFERENCES found inside the CREATE TABLE body (pg_dump emits none). */
  inlineReferences: number;
}

export interface ForeignKey {
  /** "schema.table" */
  table: string;
  constraint: string;
  columns: string[];
  /** "schema.table" */
  refTable: string;
  refColumns: string[];
}

export interface NamedObject {
  schema: string;
  name: string;
}

export interface PolicyObject extends NamedObject {
  table: string;
}

export interface ClassifiedStatement extends SqlStatement {
  decision: StatementDecision;
}

export interface BaselineModel {
  sha256: string;
  statements: ClassifiedStatement[];
  unterminated: string | null;
  tables: Map<string, BaselineTable>;
  primaryKeys: Map<string, string[]>;
  foreignKeys: ForeignKey[];
  /** Policies from EXECUTED statements only. */
  policies: PolicyObject[];
  /** Functions, types and views from EXECUTED statements only. */
  functions: NamedObject[];
  types: NamedObject[];
  views: NamedObject[];
}

function unquoteIdent(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1).replace(/""/g, '"');
  return t;
}

function splitIdentList(list: string): string[] {
  return list.split(",").map((s) => unquoteIdent(s));
}

/** Split `body` on commas at parenthesis depth 0, judged on `bodyMasked`. */
function splitTopLevelCommas(body: string, bodyMasked: string): Array<{ raw: string; masked: string }> {
  const out: Array<{ raw: string; masked: string }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < bodyMasked.length; i++) {
    const ch = bodyMasked[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push({ raw: body.slice(start, i).trim(), masked: bodyMasked.slice(start, i).trim() });
      start = i + 1;
    }
  }
  const last = { raw: body.slice(start).trim(), masked: bodyMasked.slice(start).trim() };
  if (last.masked !== "") out.push(last);
  return out;
}

const TABLE_CONSTRAINT_RE = /^(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE|LIKE)\b/i;
const COLUMN_TYPE_END_RE =
  /\s(?:DEFAULT|NOT\s+NULL|NULL|COLLATE|GENERATED|CONSTRAINT|CHECK|REFERENCES|PRIMARY\s+KEY|UNIQUE)\b/i;

/** Parse one `CREATE TABLE schema.name ( … )` statement. Null for any other statement. */
export function parseCreateTable(stmt: SqlStatement): BaselineTable | null {
  const head = /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(/i.exec(stmt.masked);
  if (!head) return null;
  const open = head[0].length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < stmt.masked.length; i++) {
    if (stmt.masked[i] === "(") depth++;
    else if (stmt.masked[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) throw new Error(`unbalanced CREATE TABLE at baseline line ${stmt.line}`);
  const body = stmt.code.slice(open + 1, close);
  const bodyMasked = stmt.masked.slice(open + 1, close);
  const columns: BaselineColumn[] = [];
  let inlineReferences = 0;
  for (const el of splitTopLevelCommas(body, bodyMasked)) {
    if (/\bREFERENCES\b/i.test(el.masked)) inlineReferences++;
    if (TABLE_CONSTRAINT_RE.test(el.masked)) continue;
    let name: string;
    let rest: string;
    let restMasked: string;
    if (el.raw.startsWith('"')) {
      const end = el.raw.indexOf('"', 1);
      name = el.raw.slice(1, end);
      rest = el.raw.slice(end + 1);
      restMasked = el.masked.slice(end + 1);
    } else {
      const m = /^(\S+)/.exec(el.raw);
      if (!m) continue;
      name = m[1];
      rest = el.raw.slice(m[1].length);
      restMasked = el.masked.slice(m[1].length);
    }
    const endM = COLUMN_TYPE_END_RE.exec(restMasked);
    const type = (endM ? rest.slice(0, endM.index) : rest).trim();
    const restNorm = norm(restMasked);
    const identity = /\bGENERATED (?:ALWAYS|BY DEFAULT) AS IDENTITY\b/i.test(restNorm);
    columns.push({
      name,
      type,
      notNull: /\bNOT NULL\b/i.test(restNorm),
      generated: !identity && /\bGENERATED ALWAYS AS ?\(/i.test(restNorm),
      identity,
      isJson: /^jsonb?$/i.test(type),
    });
  }
  return { schema: head[1].toLowerCase(), name: head[2].toLowerCase(), columns, inlineReferences };
}

/** Build the model from the dump's TEXT. Pure, so it unit-tests against fixtures. */
export function buildBaselineModel(sql: string): BaselineModel {
  const { statements, unterminated } = splitTopLevelStatements(sql);
  const classified: ClassifiedStatement[] = statements.map((s) => ({
    ...s,
    decision: classifyBaselineStatement(s.masked),
  }));

  const tables = new Map<string, BaselineTable>();
  const primaryKeys = new Map<string, string[]>();
  const foreignKeys: ForeignKey[] = [];
  const policies: PolicyObject[] = [];
  const functions: NamedObject[] = [];
  const types: NamedObject[] = [];
  const views: NamedObject[] = [];

  const PK_RE =
    /^ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+ADD\s+CONSTRAINT\s+(\S+)\s+PRIMARY\s+KEY\s*\(([^)]*)\)/i;
  const FK_RE =
    /^ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+ADD\s+CONSTRAINT\s+(\S+)\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/i;
  const POLICY_RE = /^CREATE\s+POLICY\s+("(?:[^"]|"")*"|\S+)\s+ON\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/i;
  const FUNCTION_RE = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(/i;
  const TYPE_RE = /^CREATE\s+TYPE\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/i;
  const VIEW_RE = /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/i;

  for (const s of classified) {
    const t = parseCreateTable(s);
    if (t) {
      tables.set(`${t.schema}.${t.name}`, t);
      continue;
    }
    const pk = PK_RE.exec(s.code);
    if (pk) {
      primaryKeys.set(`${pk[1]}.${pk[2]}`, splitIdentList(pk[4]));
      continue;
    }
    const fk = FK_RE.exec(s.code);
    if (fk) {
      foreignKeys.push({
        table: `${fk[1]}.${fk[2]}`,
        constraint: unquoteIdent(fk[3]),
        columns: splitIdentList(fk[4]),
        refTable: `${fk[5]}.${fk[6]}`,
        refColumns: splitIdentList(fk[7]),
      });
      continue;
    }
    if (s.decision.action !== "execute") continue;
    const pol = POLICY_RE.exec(s.code);
    if (pol) {
      policies.push({ name: unquoteIdent(pol[1]), schema: pol[2], table: pol[3] });
      continue;
    }
    const fn = FUNCTION_RE.exec(s.code);
    if (fn) {
      functions.push({ schema: fn[1], name: fn[2] });
      continue;
    }
    const ty = TYPE_RE.exec(s.code);
    if (ty) {
      types.push({ schema: ty[1], name: ty[2] });
      continue;
    }
    const vw = VIEW_RE.exec(s.code);
    if (vw) views.push({ schema: vw[1], name: vw[2] });
  }

  return {
    sha256: sha256(sql),
    statements: classified,
    unterminated,
    tables,
    primaryKeys,
    foreignKeys,
    policies,
    functions,
    types,
    views,
  };
}

let cachedModel: BaselineModel | null = null;

/** The committed baseline, parsed once per process. */
export function loadBaselineModel(): BaselineModel {
  if (!cachedModel) cachedModel = buildBaselineModel(readFileSync(BASELINE_PATH, "utf8"));
  return cachedModel;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE MEASURED SHAPE OF THE BASELINE — a self-check, not a configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every number below was MEASURED from the committed baseline on 2026-10-06 and
 * is asserted at runtime (assertBaselineShape) and in
 * scripts/src/beta-bootstrap.test.ts. They are not knobs. If the baseline is
 * refreshed, the bootstrap refuses to run until a human has re-read the skip
 * rules against the new dump and updated these numbers in the same PR — a
 * statement that silently changes rule is the failure this exists to prevent.
 *
 * Two of them differ from the figures quoted in the brief that commissioned
 * this script, and the measured value is the one recorded:
 *
 *   * 395 is the number of `CREATE TABLE` statements in the file, but 8 of them
 *     are storage.* tables. The public table count is 387.
 *   * "93 storage statements" counts the statements naming a `storage.`
 *     -qualified object (89 skipped + the 4 kept policies). The skip rule also
 *     covers 6 `GRANT … ON SCHEMA storage` and 12 `ALTER DEFAULT PRIVILEGES …
 *     IN SCHEMA storage`, which name the schema rather than a qualified object:
 *     111 storage-targeted statements, 107 skipped, 4 kept.
 *   * The longest statement is 11,338 bytes measured from its first code
 *     character; 11,461 is the same statement's raw span including the
 *     preceding pg_dump comment header (both are reported by the test).
 */
export const BASELINE_SHAPE = {
  statements: 5200,
  longestStatementBytes: 11338,
  executed: 5066,
  skipped: {
    "dump-session-preamble": 13,
    "platform-schema": 2,
    "storage-platform-object": 107,
    "supabase-admin-default-privileges": 12,
  } satisfies Record<SkipRule, number>,
  appStoragePolicies: 4,
  createTableStatements: 395,
  publicTables: 387,
  publicPolicies: 737,
  publicFunctions: 59,
  publicTypes: 69,
  publicViews: 10,
} as const;

export interface ShapeMeasurement {
  statements: number;
  longestStatementBytes: number;
  executed: number;
  skipped: Record<SkipRule, number>;
  appStoragePolicies: number;
  createTableStatements: number;
  publicTables: number;
  publicPolicies: number;
  publicFunctions: number;
  publicTypes: number;
  publicViews: number;
}

export function measureBaselineShape(model: BaselineModel): ShapeMeasurement {
  const skipped: Record<SkipRule, number> = {
    "dump-session-preamble": 0,
    "platform-schema": 0,
    "storage-platform-object": 0,
    "supabase-admin-default-privileges": 0,
  };
  let executed = 0;
  let appStoragePolicies = 0;
  let longest = 0;
  for (const s of model.statements) {
    longest = Math.max(longest, Buffer.byteLength(s.code, "utf8"));
    if (s.decision.action === "skip") skipped[s.decision.rule]++;
    else {
      executed++;
      if (s.decision.appStoragePolicy) appStoragePolicies++;
    }
  }
  const pub = (xs: readonly NamedObject[]) => xs.filter((x) => x.schema === "public").length;
  return {
    statements: model.statements.length,
    longestStatementBytes: longest,
    executed,
    skipped,
    appStoragePolicies,
    createTableStatements: model.tables.size,
    publicTables: [...model.tables.values()].filter((t) => t.schema === "public").length,
    publicPolicies: pub(model.policies),
    publicFunctions: pub(model.functions),
    publicTypes: pub(model.types),
    publicViews: pub(model.views),
  };
}

/** Problems between the measured shape and BASELINE_SHAPE; empty means identical. */
export function baselineShapeProblems(model: BaselineModel): string[] {
  const got = measureBaselineShape(model);
  const problems: string[] = [];
  if (model.unterminated !== null) {
    problems.push(`the baseline ends with an unterminated statement: ${model.unterminated.slice(0, 120)}`);
  }
  const flat = (o: ShapeMeasurement | typeof BASELINE_SHAPE): Record<string, number> => ({
    statements: o.statements,
    longestStatementBytes: o.longestStatementBytes,
    executed: o.executed,
    ...Object.fromEntries(Object.entries(o.skipped).map(([k, v]) => [`skipped.${k}`, v])),
    appStoragePolicies: o.appStoragePolicies,
    createTableStatements: o.createTableStatements,
    publicTables: o.publicTables,
    publicPolicies: o.publicPolicies,
    publicFunctions: o.publicFunctions,
    publicTypes: o.publicTypes,
    publicViews: o.publicViews,
  });
  const want = flat(BASELINE_SHAPE);
  const have = flat(got);
  for (const k of Object.keys(want)) {
    if (want[k] !== have[k]) problems.push(`${k}: expected ${want[k]}, measured ${have[k]}`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTENSIONS — measured on portava-ci
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtensionExpectation {
  name: string;
  schema: string;
  /** Created by the bootstrap when absent. The others exist on every project. */
  create: boolean;
  /** A wrong schema or an absence fails the bootstrap; otherwise a warning. */
  required: boolean;
  why: string;
}

/**
 * The extension census of portava-ci, and why each one matters to the build.
 *
 * `unaccent` is DELIBERATELY ABSENT, decided by reading its one baseline use:
 * baseline line 2400, inside public.upsert_city_stamp()'s plpgsql body —
 *   `BEGIN v_city_norm := unaccent(v_city_norm); EXCEPTION WHEN undefined_function THEN NULL; END;`
 * A plpgsql body is not resolved at CREATE time (and check_function_bodies is
 * off besides), and at run time the function already tolerates the extension's
 * absence. No index, column default or generated column references it, and
 * portava-ci does not have it. Installing it would make beta differ from CI.
 */
export const EXTENSION_CENSUS: readonly ExtensionExpectation[] = [
  {
    name: "postgis",
    schema: "public",
    create: true,
    required: true,
    why: "three generated columns call public.st_setsrid(public.st_makepoint(…))::public.geography at CREATE TABLE time",
  },
  {
    name: "pg_trgm",
    schema: "public",
    create: true,
    required: true,
    why: "portava-ci has it in public; 2220_canonical_locations_search_key.sql creates it IF NOT EXISTS and must find it there",
  },
  {
    name: "pgcrypto",
    schema: "extensions",
    create: false,
    required: true,
    why: "a column default calls extensions.gen_random_bytes(16)",
  },
  { name: "uuid-ossp", schema: "extensions", create: false, required: true, why: "portava-ci parity" },
  { name: "plpgsql", schema: "pg_catalog", create: false, required: true, why: "every plpgsql function" },
  { name: "pg_stat_statements", schema: "extensions", create: false, required: false, why: "portava-ci parity" },
  { name: "supabase_vault", schema: "vault", create: false, required: false, why: "portava-ci parity" },
];

export function buildCreateExtensionsSql(): string {
  return EXTENSION_CENSUS.filter((e) => e.create)
    .map((e) => `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(e.name)} WITH SCHEMA ${e.schema};`)
    .join("\n");
}

export const EXTENSION_CENSUS_SQL =
  "SELECT e.extname::text AS name, n.nspname::text AS schema FROM pg_catalog.pg_extension e " +
  "JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace ORDER BY 1";

export function extensionCensusProblems(
  live: ReadonlyArray<{ name: string; schema: string }>,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byName = new Map(live.map((e) => [e.name, e.schema]));
  for (const e of EXTENSION_CENSUS) {
    const at = byName.get(e.name);
    if (at === e.schema) continue;
    const msg =
      at === undefined
        ? `extension ${e.name} is not installed (expected in schema ${e.schema}: ${e.why})`
        : `extension ${e.name} is installed in schema ${at}, not ${e.schema} (${e.why})`;
    (e.required ? errors : warnings).push(msg);
  }
  return { errors, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SCRATCH EXECUTOR — beta_bootstrap.run(text[])
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SQLSTATEs tolerated by beta_bootstrap.run(): exactly the "it already exists"
 * family, which is what a re-run over a partly-built schema produces. Anything
 * else re-raises and aborts the whole batch (the batch is ONE statement — the
 * SELECT that calls run() — so it is atomic by construction).
 */
export const TOLERATED_SQLSTATES: Readonly<Record<string, string>> = {
  "42P06": "duplicate_schema",
  "42P07": "duplicate_table",
  "42710": "duplicate_object",
  "42723": "duplicate_function",
};

export const SCRATCH_SCHEMA = "beta_bootstrap";

/**
 * Creates beta_bootstrap.run(stmts text[]). Its SET clauses carry the session
 * state pg_dump's preamble would have set, so they hold for every EXECUTE even
 * if a Management API session were to run the batch prelude in autocommit.
 */
export function buildRunFunctionSql(): string {
  const conditions = Object.values(TOLERATED_SQLSTATES).join(" OR ");
  return `BEGIN;
CREATE SCHEMA IF NOT EXISTS ${SCRATCH_SCHEMA};
REVOKE ALL ON SCHEMA ${SCRATCH_SCHEMA} FROM PUBLIC;
CREATE OR REPLACE FUNCTION ${SCRATCH_SCHEMA}.run(stmts text[])
RETURNS TABLE (ord integer, err_code text, err_message text, stmt_head text)
LANGUAGE plpgsql
SET search_path = ''
SET check_function_bodies = off
SET row_security = off
SET client_min_messages = warning
AS $beta_bootstrap_run$
DECLARE
  n integer := coalesce(array_length(stmts, 1), 0);
  i integer;
  v_code text;
  v_msg text;
  v_detail text;
  v_hint text;
BEGIN
  FOR i IN 1 .. n LOOP
    BEGIN
      EXECUTE stmts[i];
    EXCEPTION
      WHEN ${conditions} THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        ord := i;
        err_code := v_code;
        err_message := v_msg;
        stmt_head := left(stmts[i], 200);
        RETURN NEXT;
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                                v_detail = PG_EXCEPTION_DETAIL, v_hint = PG_EXCEPTION_HINT;
        RAISE EXCEPTION USING
          ERRCODE = v_code,
          MESSAGE = format('beta_bootstrap.run: statement #%s of %s failed [SQLSTATE %s]: %s', i, n, v_code, v_msg),
          DETAIL = coalesce(v_detail, ''),
          HINT = coalesce(v_hint, '');
    END;
  END LOOP;
  RETURN;
END
$beta_bootstrap_run$;
REVOKE ALL ON FUNCTION ${SCRATCH_SCHEMA}.run(text[]) FROM PUBLIC;
COMMIT;`;
}

export const DROP_SCRATCH_SQL = `DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE;`;

/**
 * Run before the SELECT in each batch. SET LOCAL rather than SET: the batch is
 * one implicit transaction, so these end with it and cannot leak into a pooled
 * session that a later Management API call (the applier's) might reuse.
 */
export const BATCH_PRELUDE: readonly string[] = [
  "SET LOCAL check_function_bodies = off;",
  "SET LOCAL client_min_messages = warning;",
  "SET LOCAL row_security = off;",
  "SET LOCAL statement_timeout = 0;",
];

export interface BatchQuery {
  sql: string;
  tag: string;
}

/** One Management API call: the prelude, then ONE SELECT over beta_bootstrap.run(). */
export function buildBatchQuery(stmts: readonly string[]): BatchQuery {
  if (stmts.length === 0) throw new Error("an empty batch is a planning bug");
  const tag = chooseDollarTag(stmts, "bb");
  const d = `$${tag}$`;
  for (const s of stmts) {
    if (!isSafeDollarTag(s, tag)) throw new Error(`dollar tag ${d} is not safe for a statement in this batch`);
  }
  const elems = stmts.map((s) => `${d}${s}${d}`).join(",\n");
  return {
    tag,
    sql:
      BATCH_PRELUDE.join("\n") +
      `\nSELECT ord, err_code, err_message, stmt_head FROM ${SCRATCH_SCHEMA}.run(ARRAY[\n${elems}\n]::text[]);`,
  };
}

export function planBatches<T>(items: readonly T[], size: number = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The 1-based statement number a run() failure names, or null. */
export function parseRunFailureOrdinal(message: string): number | null {
  const m = /beta_bootstrap\.run: statement #(\d+) of \d+/.exec(message);
  return m ? Number(m[1]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EMPTINESS AND RESET
// ─────────────────────────────────────────────────────────────────────────────

const NOT_EXTENSION_MEMBER = (catalog: string, alias: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = '${catalog}'::regclass ` +
  `AND d.objid = ${alias}.oid AND d.deptype = 'e')`;

/** One row describing whether the target is a bootstrap target at all. */
export const EMPTINESS_SQL = `SELECT
  (SELECT count(*) FROM auth.users)::text AS auth_users,
  (SELECT coalesce(json_agg(c.relname::text ORDER BY c.relname), '[]'::json)
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND ${NOT_EXTENSION_MEMBER("pg_catalog.pg_class", "c")}) AS public_tables,
  (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND ${NOT_EXTENSION_MEMBER("pg_catalog.pg_proc", "p")})::text AS public_functions,
  (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'r')
      AND ${NOT_EXTENSION_MEMBER("pg_catalog.pg_type", "t")})::text AS public_types,
  (SELECT coalesce(json_agg(e.extname::text ORDER BY e.extname), '[]'::json)
     FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    WHERE n.nspname = 'public') AS public_extensions,
  EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = '${SCRATCH_SCHEMA}') AS scratch_schema,
  (to_regclass('${LEDGER_TABLE}') IS NOT NULL) AS ledger_present`;

export const LEDGER_FILENAMES_SQL = `SELECT filename, checksum, applied_by FROM ${LEDGER_TABLE} ORDER BY filename`;

export interface EmptinessState {
  authUsers: number;
  publicTables: string[];
  publicFunctions: number;
  publicTypes: number;
  publicExtensions: string[];
  scratchSchema: boolean;
  /** Ledger filenames, or null when the ledger table does not exist. */
  ledgerFiles: string[] | null;
}

export type EmptinessVerdict =
  | { action: "proceed"; fresh: boolean; notes: string[] }
  | { action: "reset"; notes: string[] }
  | { action: "refuse"; reasons: string[] };

/**
 * May this project be bootstrapped, and does it need the reset first?
 *
 * A project with sign-ins is never a target, with or without --reset: users
 * are the one thing a reset would destroy that this script cannot rebuild.
 * Otherwise "empty" means: no public base table other than the ledger, and no
 * ledger row for any file the chain applies (a row there would make the
 * applier skip or distrust that file).
 */
export function decideEmptiness(state: EmptinessState, opts: { reset: boolean }): EmptinessVerdict {
  if (state.authUsers > 0) {
    return {
      action: "refuse",
      reasons: [
        `auth.users holds ${state.authUsers} row(s). A project somebody has signed in to is not a ` +
          "bootstrap target, and --reset does not change that: it would drop the public schema those " +
          "users' data lives in.",
      ],
    };
  }
  const strayTables = state.publicTables.filter((t) => t !== "schema_migration_ledger");
  const chainRows = (state.ledgerFiles ?? []).filter(
    (f) => compareMigrationFilenames(f, CHAIN_START_PREFIX) >= 0,
  );
  const notes: string[] = [];
  if (state.scratchSchema) notes.push(`schema ${SCRATCH_SCHEMA} is present (left by an earlier run); it is replaced.`);
  if (state.ledgerFiles !== null) notes.push(`${LEDGER_TABLE} exists with ${state.ledgerFiles.length} row(s).`);
  if (strayTables.length === 0 && chainRows.length === 0) {
    if (opts.reset) return { action: "reset", notes };
    const fresh =
      state.publicTables.length === 0 &&
      state.publicFunctions === 0 &&
      state.publicTypes === 0 &&
      !state.scratchSchema &&
      state.ledgerFiles === null;
    return { action: "proceed", fresh, notes };
  }
  if (opts.reset) return { action: "reset", notes };
  const reasons: string[] = [];
  if (strayTables.length > 0) {
    reasons.push(
      `public holds ${strayTables.length} base table(s) other than the ledger ` +
        `(${strayTables.slice(0, 12).join(", ")}${strayTables.length > 12 ? ", …" : ""}). ` +
        "This script restores a baseline over whatever is there, so it only runs on an empty public " +
        "schema — or after --reset --confirm-reset=RESET-BETA drops it.",
    );
  }
  if (chainRows.length > 0) {
    reasons.push(
      `${LEDGER_TABLE} already records ${chainRows.length} chain file(s) at or after ${CHAIN_START_PREFIX} ` +
        `(${chainRows.slice(0, 6).join(", ")}${chainRows.length > 6 ? ", …" : ""}); the ledger claims an ` +
        "apply the schema cannot account for.",
    );
  }
  return { action: "refuse", reasons };
}

/**
 * The reset, as one transaction: drop the scratch schema and the app's
 * storage.objects policies, drop every extension living in public (postgis
 * objects are owned by the platform, so DROP SCHEMA public CASCADE alone would
 * fail on them), then recreate public with Supabase's default grants.
 */
export function buildResetSql(storagePolicyNames: readonly string[], publicExtensions: readonly string[]): string {
  const lines = ["BEGIN;", DROP_SCRATCH_SQL];
  for (const p of storagePolicyNames) lines.push(`DROP POLICY IF EXISTS ${quoteIdent(p)} ON storage.objects;`);
  for (const e of publicExtensions) {
    if (!/^[a-z0-9_-]+$/.test(e)) throw new Error(`refusing to splice extension name '${e}' into SQL`);
    lines.push(`DROP EXTENSION IF EXISTS ${quoteIdent(e)} CASCADE;`);
  }
  lines.push(
    "DROP SCHEMA public CASCADE;",
    "CREATE SCHEMA public;",
    "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;",
    "GRANT ALL ON SCHEMA public TO postgres;",
    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;",
    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;",
    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;",
    "COMMIT;",
  );
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-BASELINE CENSUS
// ─────────────────────────────────────────────────────────────────────────────

export const POST_BASELINE_CENSUS_SQL = `SELECT
  (SELECT coalesce(json_agg(c.relname::text), '[]'::json)
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND ${NOT_EXTENSION_MEMBER("pg_catalog.pg_class", "c")}) AS tables,
  (SELECT coalesce(json_agg(c.relname::text), '[]'::json)
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
      AND ${NOT_EXTENSION_MEMBER("pg_catalog.pg_class", "c")}) AS views,
  (SELECT coalesce(json_agg(json_build_array(tablename::text, policyname::text)), '[]'::json)
     FROM pg_catalog.pg_policies WHERE schemaname = 'public') AS policies,
  (SELECT coalesce(json_agg(policyname::text), '[]'::json)
     FROM pg_catalog.pg_policies WHERE schemaname = 'storage' AND tablename = 'objects') AS storage_object_policies,
  (SELECT coalesce(json_agg(p.proname::text), '[]'::json)
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND ${NOT_EXTENSION_MEMBER("pg_catalog.pg_proc", "p")}) AS functions,
  (SELECT coalesce(json_agg(t.typname::text), '[]'::json)
     FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'r')
      AND ${NOT_EXTENSION_MEMBER("pg_catalog.pg_type", "t")}) AS types`;

export interface CensusExpectation {
  tables: string[];
  views: string[];
  policies: string[];
  storageObjectPolicies: string[];
  functions: string[];
  types: string[];
}

export function expectedPostBaselineCensus(model: BaselineModel): CensusExpectation {
  const pub = <T extends NamedObject>(xs: readonly T[]) => xs.filter((x) => x.schema === "public");
  return {
    tables: [...model.tables.values()].filter((t) => t.schema === "public").map((t) => t.name),
    views: pub(model.views).map((v) => v.name),
    policies: pub(model.policies).map((p) => `${p.table}.${p.name}`),
    storageObjectPolicies: model.policies
      .filter((p) => p.schema === "storage" && p.table === "objects")
      .map((p) => p.name),
    functions: pub(model.functions).map((f) => f.name),
    types: pub(model.types).map((t) => t.name),
  };
}

/** Multiset difference: what is expected and absent, and what is present and unexpected. */
export function diffMultiset(
  expected: readonly string[],
  actual: readonly string[],
  allowedExtra: readonly string[] = [],
): { missing: string[]; unexpected: string[] } {
  const count = new Map<string, number>();
  for (const e of expected) count.set(e, (count.get(e) ?? 0) + 1);
  const unexpected: string[] = [];
  for (const a of actual) {
    const c = count.get(a) ?? 0;
    if (c > 0) count.set(a, c - 1);
    else if (!allowedExtra.includes(a)) unexpected.push(a);
  }
  const missing: string[] = [];
  for (const [k, c] of count) for (let i = 0; i < c; i++) missing.push(k);
  return { missing: missing.sort(), unexpected: unexpected.sort() };
}

// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE ROWS — the allowlist and its projection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public tables whose rows migrations sorting before CHAIN_START_PREFIX seeded,
 * and which the structure-only baseline therefore lacks. NOTHING ELSE IS READ.
 * None holds personal data; the FK-nulling below is the belt.
 *
 * REMOVED FROM THE COMMISSIONED LIST, ON MEASUREMENT: place_coverage_buckets.
 * No migration seeds it — 2048_place_coverage_buckets.sql creates it and a
 * function that increments per-place post counters at run time — so its rows
 * are derived user activity, not reference data. Its PRIMARY KEY column
 * canonical_place_id is a NOT NULL foreign key to public.places, which is
 * neither copied nor nullable, so any row in it would fail the beta import on
 * that FK. planReferenceTables() refuses an allowlisted table with such a
 * foreign key, and the unit test pins this exclusion.
 */
export const REFERENCE_PUBLIC_TABLES = [
  "feature_flags",
  "stamp_definitions",
  "stamp_collections",
  "country_essentials",
  "compass_intent_modes",
  "compass_frontload_rules",
  "price_baselines",
  "destination_identities",
  "geofence_admin_settings",
  "rent_buddy_global_controls",
  "rent_buddy_city_rollouts",
] as const;

export const EXCLUDED_REFERENCE_TABLES: Readonly<Record<string, string>> = {
  place_coverage_buckets:
    "runtime-derived per-place post counters (no migration seeds it); its NOT NULL primary-key column " +
    "is a foreign key to public.places, which is not copied",
};

/** storage.buckets: these columns only. */
export const STORAGE_BUCKET_COLUMNS = ["id", "name", "public", "file_size_limit", "allowed_mime_types"] as const;

/** Foreign-key targets whose referencing columns are set to NULL in the snapshot. */
export const IDENTITY_TABLES: readonly string[] = ["public.profiles", "auth.users"];

/**
 * Actor columns that hold a user id WITHOUT a foreign key in the baseline, so
 * the FK measurement cannot find them. Nulled for the same reason: the id names
 * a portava-ci user who does not exist on beta. The unit test asserts that
 * every uuid column of every allowlisted table is accounted for (a key, an FK
 * to an allowlisted table, a nulled FK, or listed here).
 */
export const ACTOR_COLUMNS_WITHOUT_FK: Readonly<Record<string, readonly string[]>> = {
  price_baselines: ["verified_by"],
};

/** Values written in place of the source's. Fail-closed: beta's flag policy is a later, explicit owner step. */
export const FORCED_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  feature_flags: { enabled: "false" },
};

export interface ReferenceTablePlan {
  schema: "public" | "storage";
  table: string;
  primaryKey: string[];
  /** Every column copied, in baseline order. */
  columns: string[];
  jsonColumns: string[];
  /** column -> why it is NULL in every snapshot row */
  nulledColumns: Record<string, string>;
  /** column -> the text value every snapshot row carries */
  forcedValues: Record<string, string>;
}

export const SNAPSHOT_FORMAT = "portava-beta-reference-snapshot/1";

/** Throws unless (schema, table) is on the allowlist. */
export function assertAllowlisted(schema: string, table: string): void {
  const ok =
    (schema === "public" && (REFERENCE_PUBLIC_TABLES as readonly string[]).includes(table)) ||
    (schema === "storage" && table === "buckets");
  if (!ok) {
    throw new Error(
      `${schema}.${table} is not on the reference allowlist (REFERENCE_PUBLIC_TABLES + storage.buckets). ` +
        "Only allowlisted tables are read from portava-ci or written to beta.",
    );
  }
}

/** Stable topological order over FKs between allowlisted tables. */
function orderByForeignKeys(names: readonly string[], fks: readonly ForeignKey[]): string[] {
  const set = new Set(names);
  const deps = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  for (const fk of fks) {
    const from = fk.table.replace(/^public\./, "");
    const to = fk.refTable.replace(/^public\./, "");
    if (fk.table.startsWith("public.") && fk.refTable.startsWith("public.") && set.has(from) && set.has(to) && from !== to) {
      deps.get(from)?.add(to);
    }
  }
  const out: string[] = [];
  const done = new Set<string>();
  while (out.length < names.length) {
    const next = names.find((n) => !done.has(n) && [...(deps.get(n) ?? [])].every((d) => done.has(d)));
    if (next === undefined) throw new Error("the reference allowlist has a foreign-key cycle");
    out.push(next);
    done.add(next);
  }
  return out;
}

/**
 * The per-table plan: what to select, what to null, what to force, in a
 * dependency-safe import order (public tables, then storage.buckets).
 */
export function planReferenceTables(
  model: BaselineModel,
  /** A subset of the allowlist, for fixture tests. Never a superset. */
  tables: readonly string[] = REFERENCE_PUBLIC_TABLES,
): ReferenceTablePlan[] {
  for (const t of tables) assertAllowlisted("public", t);
  const allow = new Set<string>(tables);
  const plans: ReferenceTablePlan[] = [];
  for (const name of orderByForeignKeys(tables, model.foreignKeys)) {
    assertSimpleIdent(name, "reference table");
    const key = `public.${name}`;
    const table = model.tables.get(key);
    if (!table) throw new Error(`${key} is on the reference allowlist but the baseline does not create it`);
    const primaryKey = model.primaryKeys.get(key);
    if (!primaryKey || primaryKey.length === 0) {
      throw new Error(`${key} has no PRIMARY KEY in the baseline; the import keys ON CONFLICT on it`);
    }
    const identity = table.columns.filter((c) => c.identity).map((c) => c.name);
    if (identity.length > 0) throw new Error(`${key} has identity column(s) ${identity.join(", ")}; not supported`);
    const columns = table.columns.filter((c) => !c.generated);
    for (const c of columns) assertSimpleIdent(c.name, `${key} column`);
    const nulledColumns: Record<string, string> = {};
    for (const fk of model.foreignKeys.filter((f) => f.table === key)) {
      if (IDENTITY_TABLES.includes(fk.refTable)) {
        for (const c of fk.columns) nulledColumns[c] = `FK ${fk.constraint} -> ${fk.refTable}`;
      } else if (!(fk.refTable.startsWith("public.") && allow.has(fk.refTable.slice("public.".length)))) {
        throw new Error(
          `${key} has foreign key ${fk.constraint} (${fk.columns.join(", ")}) -> ${fk.refTable}, which is ` +
            "neither on the allowlist nor an identity table that is nulled. Its rows cannot be imported " +
            "into a beta project where that table is empty.",
        );
      }
    }
    for (const c of ACTOR_COLUMNS_WITHOUT_FK[name] ?? []) {
      nulledColumns[c] = "actor user id with no FK in the baseline";
    }
    for (const c of Object.keys(nulledColumns)) {
      const col = columns.find((x) => x.name === c);
      if (!col) throw new Error(`${key}.${c} is to be nulled but is not a column of the baseline table`);
      if (col.notNull) throw new Error(`${key}.${c} is NOT NULL in the baseline and cannot be nulled`);
      if (primaryKey.includes(c)) throw new Error(`${key}.${c} is part of the primary key and cannot be nulled`);
    }
    const forcedValues = { ...(FORCED_VALUES[name] ?? {}) };
    for (const c of Object.keys(forcedValues)) {
      if (!columns.some((x) => x.name === c)) throw new Error(`${key}.${c} is forced but is not a column`);
    }
    plans.push({
      schema: "public",
      table: name,
      primaryKey,
      columns: columns.map((c) => c.name),
      jsonColumns: columns.filter((c) => c.isJson).map((c) => c.name),
      nulledColumns,
      forcedValues,
    });
  }
  const buckets = model.tables.get("storage.buckets");
  for (const c of STORAGE_BUCKET_COLUMNS) {
    if (!buckets?.columns.some((x) => x.name === c)) {
      throw new Error(`storage.buckets in the baseline has no column ${c}`);
    }
  }
  plans.push({
    schema: "storage",
    table: "buckets",
    primaryKey: ["id"],
    columns: [...STORAGE_BUCKET_COLUMNS],
    jsonColumns: [],
    nulledColumns: {},
    forcedValues: {},
  });
  return plans;
}

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT SQL — SELECT only, inside a READ ONLY transaction
// ─────────────────────────────────────────────────────────────────────────────

const READ_ONLY_PREFIX = "SET TRANSACTION READ ONLY;";

const MUTATION_RE =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT|COPY|CALL|DO|LOCK|REFRESH|VACUUM|CLUSTER|REINDEX|SECURITY|IMPORT|EXECUTE|PREPARE|LISTEN|NOTIFY|DISCARD|RESET|SET)\b/i;

/**
 * Throws unless `sql` is exactly `SET TRANSACTION READ ONLY;` followed by ONE
 * SELECT with no write keyword outside literals. The read-only transaction is
 * the database's own guarantee; this is the script refusing to even send
 * anything else.
 */
export function assertReadOnlySelect(sql: string): void {
  if (!sql.startsWith(READ_ONLY_PREFIX)) throw new Error("a snapshot query must start with SET TRANSACTION READ ONLY");
  const rest = sql.slice(READ_ONLY_PREFIX.length);
  const masked = maskNonCode(rest);
  const body = masked.trim().replace(/;$/, "");
  if (body.includes(";")) throw new Error("a snapshot query must be exactly one SELECT");
  if (!/^SELECT\b/i.test(body)) throw new Error("a snapshot query must be a SELECT");
  // maskForKeywordScan keeps dollar-quoted bodies (they are code), so a write
  // hidden in one is still seen. `FOR UPDATE`/`FOR SHARE` is a row lock.
  const scan = maskForKeywordScan(rest);
  const hit = MUTATION_RE.exec(scan) ?? /\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b/i.exec(scan);
  if (hit) throw new Error(`a snapshot query contains '${hit[0]}'; only a plain SELECT is sent`);
}

function readOnly(select: string): string {
  const sql = `${READ_ONLY_PREFIX}\n${select}`;
  assertReadOnlySelect(sql);
  return sql;
}

function qualified(plan: ReferenceTablePlan): string {
  assertAllowlisted(plan.schema, plan.table);
  return `${plan.schema}.${quoteIdent(plan.table)}`;
}

export function buildSourceColumnCensusSql(plans: readonly ReferenceTablePlan[]): string {
  const pub = plans.filter((p) => p.schema === "public").map((p) => quoteLiteral(p.table)).join(", ");
  return readOnly(
    "SELECT n.nspname::text AS schema_name, c.relname::text AS table_name, a.attname::text AS column_name " +
      "FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid " +
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p') " +
      `AND ((n.nspname = 'public' AND c.relname IN (${pub})) OR (n.nspname = 'storage' AND c.relname = 'buckets'))`,
  );
}

/**
 * Whether the reading role sees every row. storage.buckets has RLS enabled and
 * is owned by the storage admin, so a role that neither is superuser nor has
 * BYPASSRLS would read only what a policy allows — a silent under-copy. The
 * snapshot refuses in that case rather than writing a short file.
 */
export function buildReadingRoleSql(): string {
  return readOnly(
    "SELECT current_user::text AS role_name, (r.rolsuper OR r.rolbypassrls)::text AS sees_all_rows " +
      "FROM pg_catalog.pg_roles r WHERE r.rolname = current_user",
  );
}

export function buildSnapshotCountSql(plan: ReferenceTablePlan): string {
  return readOnly(`SELECT count(*)::text AS n FROM ${qualified(plan)}`);
}

/**
 * Every value is selected AS TEXT (or the forced literal, or NULL), and the
 * whole table comes back as ONE json text value. Nothing numeric is ever
 * parsed by JavaScript, so a numeric(12,2) or a big integer inside a jsonb
 * value round-trips exactly; the import casts each text back through the
 * column's own input function.
 */
export function buildSnapshotSelectSql(plan: ReferenceTablePlan): string {
  const cols = plan.columns.map((c) => {
    if (c in plan.nulledColumns) return `NULL::text AS ${quoteIdent(c)}`;
    if (c in plan.forcedValues) return `${quoteLiteral(plan.forcedValues[c])}::text AS ${quoteIdent(c)}`;
    return `${quoteIdent(c)}::text AS ${quoteIdent(c)}`;
  });
  const order = plan.primaryKey.map((c) => `s.${quoteIdent(c)}`).join(", ");
  return readOnly(
    `SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY ${order}), '[]'::jsonb)::text AS rows_json ` +
      `FROM (SELECT ${cols.join(", ")} FROM ${qualified(plan)}) AS s`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT FILE — shape and validation (used by BOTH scripts)
// ─────────────────────────────────────────────────────────────────────────────

export type SnapshotRow = Record<string, string | null>;

export interface SnapshotTable extends ReferenceTablePlan {
  rowCount: number;
  rows: SnapshotRow[];
}

export interface ReferenceSnapshot {
  format: string;
  takenAt: string;
  sourceProjectRef: string;
  baselineSha256: string;
  rowCap: number;
  tables: SnapshotTable[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Validate a snapshot against the plan derived from the CURRENT baseline.
 * Throws naming the first violation. A snapshot is accepted only if it carries
 * exactly the allowlisted tables, each with exactly the planned columns, every
 * nulled column NULL and every forced value forced in every row.
 */
export function validateSnapshot(
  raw: unknown,
  plans: readonly ReferenceTablePlan[],
  baselineSha256: string,
): ReferenceSnapshot {
  if (!isRecord(raw)) throw new Error("snapshot: not a JSON object");
  if (raw.format !== SNAPSHOT_FORMAT) throw new Error(`snapshot: format is ${String(raw.format)}, expected ${SNAPSHOT_FORMAT}`);
  if (raw.baselineSha256 !== baselineSha256) {
    throw new Error(
      "snapshot: it was planned against a different baseline (sha256 mismatch). Its column sets are " +
        "not the ones this baseline creates; take a new snapshot.",
    );
  }
  if (typeof raw.sourceProjectRef !== "string" || raw.sourceProjectRef === PRODUCTION_PROJECT_REF) {
    throw new Error("snapshot: sourceProjectRef is missing or names production");
  }
  if (typeof raw.takenAt !== "string") throw new Error("snapshot: takenAt is missing");
  if (raw.rowCap !== REFERENCE_ROW_CAP) throw new Error("snapshot: rowCap differs from REFERENCE_ROW_CAP");
  if (!Array.isArray(raw.tables)) throw new Error("snapshot: tables is not an array");

  const seen = new Set<string>();
  const tables: SnapshotTable[] = [];
  for (const t of raw.tables as unknown[]) {
    if (!isRecord(t) || typeof t.schema !== "string" || typeof t.table !== "string") {
      throw new Error("snapshot: a table entry lacks schema/table");
    }
    assertAllowlisted(t.schema, t.table);
    const id = `${t.schema}.${t.table}`;
    if (seen.has(id)) throw new Error(`snapshot: ${id} appears twice`);
    seen.add(id);
    const plan = plans.find((p) => p.schema === t.schema && p.table === t.table);
    if (!plan) throw new Error(`snapshot: ${id} has no plan`);
    const strList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
    if (!strList(t.columns) || !sameList(t.columns as string[], plan.columns)) {
      throw new Error(`snapshot: ${id} columns differ from the baseline plan`);
    }
    if (!strList(t.primaryKey) || !sameList(t.primaryKey as string[], plan.primaryKey)) {
      throw new Error(`snapshot: ${id} primary key differs from the baseline plan`);
    }
    if (!strList(t.jsonColumns) || !sameList(t.jsonColumns as string[], plan.jsonColumns)) {
      throw new Error(`snapshot: ${id} json columns differ from the baseline plan`);
    }
    if (!isRecord(t.nulledColumns) || !sameList(Object.keys(t.nulledColumns).sort(), Object.keys(plan.nulledColumns).sort())) {
      throw new Error(`snapshot: ${id} nulled columns differ from the plan`);
    }
    if (!isRecord(t.forcedValues) || JSON.stringify(t.forcedValues) !== JSON.stringify(plan.forcedValues)) {
      throw new Error(`snapshot: ${id} forced values differ from the plan`);
    }
    if (!Array.isArray(t.rows)) throw new Error(`snapshot: ${id} rows is not an array`);
    if (t.rowCount !== t.rows.length) throw new Error(`snapshot: ${id} rowCount does not match its rows`);
    if (t.rows.length > REFERENCE_ROW_CAP) throw new Error(`snapshot: ${id} exceeds ${REFERENCE_ROW_CAP} rows`);
    const rows: SnapshotRow[] = [];
    for (const r of t.rows as unknown[]) {
      if (!isRecord(r)) throw new Error(`snapshot: ${id} has a row that is not an object`);
      const keys = Object.keys(r).sort();
      if (!sameList(keys, [...plan.columns].sort())) throw new Error(`snapshot: ${id} has a row whose keys differ from its columns`);
      const row: SnapshotRow = {};
      for (const c of plan.columns) {
        const v = r[c];
        if (v !== null && typeof v !== "string") throw new Error(`snapshot: ${id}.${c} holds a non-text value`);
        row[c] = v;
      }
      for (const c of Object.keys(plan.nulledColumns)) {
        if (row[c] !== null) throw new Error(`snapshot: ${id}.${c} must be NULL in every row (${plan.nulledColumns[c]})`);
      }
      for (const [c, v] of Object.entries(plan.forcedValues)) {
        if (row[c] !== v) throw new Error(`snapshot: ${id}.${c} must be '${v}' in every row`);
      }
      for (const c of plan.primaryKey) {
        if (row[c] === null) throw new Error(`snapshot: ${id} has a row with a NULL primary-key column ${c}`);
      }
      rows.push(row);
    }
    tables.push({ ...plan, rowCount: rows.length, rows });
  }
  for (const p of plans) {
    if (!seen.has(`${p.schema}.${p.table}`)) throw new Error(`snapshot: ${p.schema}.${p.table} is missing`);
  }
  // Import in PLAN order (dependency-safe), whatever order the file used.
  const ordered = plans.map((p) => tables.find((t) => t.schema === p.schema && t.table === p.table)!);
  return {
    format: SNAPSHOT_FORMAT,
    takenAt: raw.takenAt,
    sourceProjectRef: raw.sourceProjectRef,
    baselineSha256,
    rowCap: REFERENCE_ROW_CAP,
    tables: ordered,
  };
}

/**
 * One INSERT for a chunk of snapshot rows, returning how many were inserted.
 * Each text value goes through the column's own input function via
 * jsonb_populate_record(); json/jsonb columns are re-parsed from their text
 * first, because populate_record would otherwise store a JSON string scalar.
 */
export function buildReferenceImportSql(plan: ReferenceTablePlan, rows: readonly SnapshotRow[]): string {
  const target = qualified(plan);
  const payload = JSON.stringify(rows);
  const tag = chooseDollarTag([payload], "ref");
  const d = `$${tag}$`;
  const overrides = plan.jsonColumns
    .map((c) => `${quoteLiteral(c)}, (e.r ->> ${quoteLiteral(c)})::jsonb`)
    .join(", ");
  const record = overrides ? `e.r || pg_catalog.jsonb_build_object(${overrides})` : "e.r";
  const cols = plan.columns.map(quoteIdent).join(", ");
  const conflict = plan.primaryKey.map(quoteIdent).join(", ");
  // The rows are typed in the CTE, so the INSERT is the plain
  // `INSERT … SELECT … FROM src ON CONFLICT …` shape.
  return (
    `WITH src AS (SELECT p.* FROM pg_catalog.jsonb_array_elements(${d}${payload}${d}::jsonb) AS e(r), ` +
    `LATERAL pg_catalog.jsonb_populate_record(NULL::${target}, ${record}) AS p), ` +
    `ins AS (INSERT INTO ${target} (${cols}) SELECT ${cols} FROM src ` +
    `ON CONFLICT (${conflict}) DO NOTHING RETURNING 1) ` +
    "SELECT count(*)::text AS inserted FROM ins"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LEDGER PRE-CREATION
// ─────────────────────────────────────────────────────────────────────────────

/** Every canonical file sorting before CHAIN_START_PREFIX — the baseline's coverage. */
export function backfillFilenames(files: readonly string[] = listMigrationFiles()): string[] {
  return files.filter((f) => compareMigrationFilenames(f, CHAIN_START_PREFIX) < 0);
}

/**
 * 2254's DDL — everything in its transaction body BEFORE its
 * `INSERT INTO public.schema_migration_ledger`: the precondition, the table,
 * the applied_by CHECK, the index, RLS, the revokes and grant, the comments.
 * Its BEGIN/COMMIT are stripped (classifyMigration's "unwrapped" body), its
 * 382-file backfill INSERT and its postcondition (which requires those 382
 * rows) are cut.
 */
export function extractLedgerDdl(sql: string): string {
  const cls = classifyMigration(sql, LEDGER_MIGRATION_FILE);
  if (cls.kind !== "unwrapped") {
    throw new Error(`${LEDGER_MIGRATION_FILE} is no longer a single BEGIN … COMMIT file (shape ${cls.kind}).`);
  }
  const body = cls.body;
  const masked = maskNonCode(body);
  const re = /\bINSERT\s+INTO\s+public\.schema_migration_ledger\b/gi;
  let cut = -1;
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    const before = masked.slice(0, m.index);
    if (before.slice(before.lastIndexOf(";") + 1).trim() === "") {
      cut = m.index;
      break;
    }
  }
  if (cut === -1) throw new Error(`${LEDGER_MIGRATION_FILE} has no top-level INSERT INTO ${LEDGER_TABLE}.`);
  const ddl = body.slice(0, cut).trim();
  if (findTransactionStatements(ddl).length > 0) throw new Error("the extracted ledger DDL carries transaction control");
  // `INSERT` the privilege (in the GRANT to service_role) is expected; an
  // INSERT statement, top-level or inside a DO body, is not.
  if (/\bINSERT\s+INTO\b/i.test(maskForKeywordScan(ddl))) {
    throw new Error("the extracted ledger DDL contains an INSERT statement");
  }
  return ddl;
}

export function loadLedgerDdl(): string {
  return extractLedgerDdl(readFileSync(join(MIGRATIONS_DIR, LEDGER_MIGRATION_FILE), "utf8"));
}

const FILENAME_RE = /^[A-Za-z0-9_.-]+\.sql$/;

/** The ledger DDL and the backfill rows, in ONE transaction. */
export function buildLedgerPrecreationSql(ddl: string, files: readonly string[]): string {
  for (const f of files) {
    if (!FILENAME_RE.test(f)) throw new Error(`refusing to splice filename '${f}' into SQL`);
  }
  const list = files.map((f) => `  ${quoteLiteral(f)}`).join(",\n");
  return [
    "BEGIN;",
    ddl,
    "",
    `INSERT INTO ${LEDGER_TABLE} (filename, checksum, applied_by, notes)`,
    `SELECT f, 'backfill', 'backfill', ${quoteLiteral(BACKFILL_NOTES)}`,
    `FROM pg_catalog.unnest(ARRAY[\n${list}\n]::text[]) AS f`,
    "ON CONFLICT (filename) DO NOTHING;",
    "COMMIT;",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// FILES THE APPLIER REFUSES BY SHAPE — hand-applied by the bootstrap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * apply-migrations.ts refuses a file whose transaction control it cannot wrap
 * in one transaction with its ledger row, and its header names the remedy:
 * "apply it by hand, verify it, then INSERT its ledger row with
 * applied_by='manual'". On portava-ci such files sit under 2254's backfill rows
 * and are never classified; on beta every chain file is pending, so they are
 * met. The bootstrap is that hand (`--apply-refused <file>`).
 *
 * The set is computed exactly as the applier would meet it: canonical files
 * sorting at or after CHAIN_START_PREFIX, with no ledger row, that
 * classifyMigration() refuses. Measured 2026-10-06: exactly
 * 2182_close_authz_rpc_oracle.sql (a BEGIN … ROLLBACK verification probe after
 * its BEGIN … COMMIT body) and 2190_memory_lifecycle_fixes.sql (two
 * BEGIN … COMMIT blocks). The unit test pins that set, so a newly refused file
 * is noticed rather than absorbed.
 */
export interface RefusedChainFile {
  filename: string;
  /** classifyMigration()'s full reason. */
  reason: string;
}

export function refusedChainFiles(
  files: readonly string[],
  read: (filename: string) => string,
  recorded: ReadonlySet<string> = new Set(),
): RefusedChainFile[] {
  const out: RefusedChainFile[] = [];
  for (const f of files) {
    if (compareMigrationFilenames(f, CHAIN_START_PREFIX) < 0 || recorded.has(f)) continue;
    const cls = classifyMigration(read(f), f);
    if (cls.kind === "refuse") out.push({ filename: f, reason: cls.reason });
  }
  return out;
}

/** The first sentence of a classifyMigration() reason — the part that names the shape. */
export function firstSentence(reason: string): string {
  const m = /^[\s\S]*?\.(?=\s|$)/.exec(reason);
  return (m ? m[0] : reason).trim();
}

/**
 * Chain files sorting BEFORE `filename` that have no ledger row. A hand
 * apply is only in order when this is empty — i.e. the applier has already
 * recorded everything before the file it stopped at.
 */
export function unrecordedPredecessors(
  files: readonly string[],
  filename: string,
  recorded: ReadonlySet<string>,
): string[] {
  return files.filter(
    (f) =>
      compareMigrationFilenames(f, CHAIN_START_PREFIX) >= 0 &&
      compareMigrationFilenames(f, filename) < 0 &&
      !recorded.has(f),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SEGMENTED MANUAL APPLY — a refused file, applied atomically with its row
// ─────────────────────────────────────────────────────────────────────────────
//
// Sending a refused file verbatim (the first design) had three defects, found
// when run 38057476281 reached this point on 2026-10-10:
//   * the file's verification queries ran but nobody saw them: the endpoint
//     returns only the LAST non-empty result, so 2182's checks A–D were
//     executed and discarded;
//   * the ledger row was a second call, so "applied and unrecorded" was a
//     reachable state;
//   * a probe failing AFTER 2182's COMMIT left a file that could not be sent
//     again (its ALTER … SET SCHEMA would no longer find public.is_blocked).
// So the file is cut at its own transaction-control statements instead:
//   apply  — the body of each BEGIN … COMMIT block, in file order;
//   probe  — the body of each BEGIN … ROLLBACK block, and each statement
//            outside every block (the file's verification SELECTs).
// The apply bodies are then sent as ONE transaction together with the per-file
// verification (DO blocks that RAISE) and the ledger row, so either the file,
// its verification and its row all commit, or none of it does. Each probe is
// sent on its own inside BEGIN TRANSACTION READ ONLY … ROLLBACK, before the
// apply (2182's check A is a pre-press check; C and D are compared before vs
// after) and again after it, and its rows are printed. The ledger checksum is
// still the applier's checksumOf() of the whole file.

export interface ManualProbe {
  /** 1-based line of the probe's first statement. */
  line: number;
  /** "rollback-block" (BEGIN … ROLLBACK in the file) or "bare" (a statement outside every block). */
  origin: "rollback-block" | "bare";
  statements: string[];
}

export interface ManualApplyPlan {
  /** The bodies of the file's BEGIN … COMMIT blocks, in order, without the BEGIN/COMMIT. */
  applyStatements: string[];
  /** How many BEGIN … COMMIT blocks the apply statements came from. */
  applyBlocks: number;
  probes: ManualProbe[];
}

const TXN_OPEN_RE = /^(?:BEGIN|START\s+TRANSACTION)(?:\s+(?:WORK|TRANSACTION))?$/i;
const TXN_COMMIT_RE = /^(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?$/i;
const TXN_ROLLBACK_RE = /^(?:ROLLBACK|ABORT)(?:\s+(?:WORK|TRANSACTION))?$/i;
const TXN_OTHER_RE = /^(?:SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+(?:PREPARED|TO))\b/i;
const PROBE_SET_LOCAL_ROLE_RE = /^SET\s+LOCAL\s+ROLE\s+[a-z_][a-z0-9_]*$/i;

/** Throws unless a probe statement is a plain read: a SELECT/WITH with no write keyword, or SET LOCAL ROLE. */
function assertProbeStatement(code: string, masked: string, line: number): void {
  const norm = masked.replace(/\s+/g, " ").trim();
  if (PROBE_SET_LOCAL_ROLE_RE.test(norm)) return;
  if (!/^(?:SELECT|WITH)\b/i.test(norm)) {
    throw new Error(`line ${line}: a statement outside a BEGIN … COMMIT block must be a read-only SELECT (or SET LOCAL ROLE inside a rollback block); got '${norm.slice(0, 60)}'.`);
  }
  const scan = maskForKeywordScan(code);
  const hit = MUTATION_RE.exec(scan) ?? /\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b/i.exec(scan);
  if (hit) throw new Error(`line ${line}: probe statement contains '${hit[0]}'; a probe must not write.`);
}

/**
 * Cut a refused file at its own transaction control. Throws on any shape it
 * cannot cut safely: nested or unclosed blocks, SAVEPOINT/2PC, an unterminated
 * tail, a write outside a COMMIT block, or no COMMIT block at all.
 */
export function planManualApply(sql: string, filename: string): ManualApplyPlan {
  const split = splitTopLevelStatements(sql);
  if (split.unterminated !== null) throw new Error(`${filename}: code after the last ';' — refusing to cut a file that does not end on a statement.`);
  const applyStatements: string[] = [];
  const probes: ManualProbe[] = [];
  let applyBlocks = 0;
  let open: { line: number; body: SqlStatement[] } | null = null;
  for (const st of split.statements) {
    const norm = st.masked.replace(/\s+/g, " ").trim();
    if (TXN_OTHER_RE.test(norm)) throw new Error(`${filename}:${st.line}: '${norm}' — savepoints and two-phase commit are not cut.`);
    if (TXN_OPEN_RE.test(norm)) {
      if (open) throw new Error(`${filename}:${st.line}: BEGIN inside the block opened at line ${open.line}.`);
      open = { line: st.line, body: [] };
      continue;
    }
    if (TXN_COMMIT_RE.test(norm) || TXN_ROLLBACK_RE.test(norm)) {
      if (!open) throw new Error(`${filename}:${st.line}: '${norm}' with no open block.`);
      if (open.body.length === 0) throw new Error(`${filename}:${open.line}: empty transaction block.`);
      if (TXN_COMMIT_RE.test(norm)) {
        applyBlocks++;
        applyStatements.push(...open.body.map((s) => s.code));
      } else {
        for (const s of open.body) assertProbeStatement(s.code, s.masked, s.line);
        probes.push({ line: open.body[0].line, origin: "rollback-block", statements: open.body.map((s) => s.code) });
      }
      open = null;
      continue;
    }
    if (open) {
      open.body.push(st);
      continue;
    }
    if (PROBE_SET_LOCAL_ROLE_RE.test(norm)) throw new Error(`${filename}:${st.line}: SET LOCAL ROLE outside a block.`);
    assertProbeStatement(st.code, st.masked, st.line);
    probes.push({ line: st.line, origin: "bare", statements: [st.code] });
  }
  if (open) throw new Error(`${filename}:${open.line}: block opened and never closed.`);
  if (applyBlocks === 0) throw new Error(`${filename}: no BEGIN … COMMIT block — nothing to apply.`);
  return { applyStatements, applyBlocks, probes };
}

/** One probe as sent: its statements inside a READ ONLY transaction that is rolled back. */
export function buildProbeSql(probe: ManualProbe): string {
  return ["BEGIN TRANSACTION READ ONLY;", ...probe.statements.map((s) => `${s};`), "ROLLBACK;"].join("\n");
}

/** What the per-file verification measured before the apply, spliced into its in-transaction checks. */
export type ProbeResults = ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;

export interface ManualVerification {
  /** The probe count the file must cut into — a changed file is refused, not guessed at. */
  probes: number;
  /** Problems with the BEFORE results (empty = proceed). */
  checkBefore(before: ProbeResults): string[];
  /** DO blocks sent inside the apply transaction, after the file's body and before its ledger row. */
  inTransaction(before: ProbeResults): string[];
  /**
   * A schema PostgREST must NOT expose, checked before the apply. 2182's check E
   * (an HTTP probe: rpc/is_blocked 404 after) holds exactly when the functions
   * have left public (B) and their new schema is not exposed (this).
   */
  unexposedSchema?: string;
}

const rowText = (r: Record<string, unknown>, k: string): string => {
  const v = r[k];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new Error(`probe row lacks column ${k}: ${JSON.stringify(r).slice(0, 200)}`);
};

/** 2182's pre-press expectation, verbatim from its check A. */
export const AUTHZ_2182_PRE_PRESS: readonly string[] = [
  "function can_see_location(uuid,uuid)",
  "policy highlights / highlights_select",
  "policy highlights / highlights_select_active",
  "policy messages / messages_hide_blocked_sender",
  "policy user_locations / loc_select",
];

function verify2182(): ManualVerification {
  // Probes, in file order: A (pre-press callers), B (where the functions live),
  // C (policies bound to them), D (anon-visible user_locations, a rollback block).
  const policies = (rows: ReadonlyArray<Record<string, unknown>>) =>
    rows.map((r) => `${rowText(r, "tablename")} / ${rowText(r, "policyname")}`).sort();
  return {
    probes: 4,
    unexposedSchema: "authz",
    checkBefore([a, , c, d]) {
      const problems: string[] = [];
      const got = a.map((r) => `${rowText(r, "kind")} ${rowText(r, "obj")}`).sort();
      if (JSON.stringify(got) !== JSON.stringify(AUTHZ_2182_PRE_PRESS)) {
        problems.push(`check A (pre-press caller completeness) expected exactly ${AUTHZ_2182_PRE_PRESS.join("; ")} — got ${got.join("; ") || "(nothing)"}. The file says: anything else stops the press.`);
      }
      if (policies(c).length !== 4) problems.push(`check C before the apply lists ${policies(c).length} policies, not 4.`);
      if (d.length !== 1) problems.push(`check D returned ${d.length} rows, not 1.`);
      else if (!/^\d+$/.test(rowText(d[0], "anon_visible_locations"))) problems.push("check D's count is not an integer.");
      return problems;
    },
    inTransaction([, , c, d]) {
      const bound = policies(c).join("\n");
      const anon = rowText(d[0], "anon_visible_locations");
      return [
        // B — the three moved, viewer_is_blocked untouched, the pin follows can_see_location.
        `DO $verify_b$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname IN ('is_blocked','in_accepted_circle','can_see_location')) THEN
    RAISE EXCEPTION '2182 verification B: an authz predicate is still in public';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'authz' AND p.proname IN ('is_blocked','in_accepted_circle','can_see_location')) <> 3 THEN
    RAISE EXCEPTION '2182 verification B: authz does not hold exactly the three predicates';
  END IF;
  IF to_regprocedure('public.viewer_is_blocked(uuid)') IS NULL THEN
    RAISE EXCEPTION '2182 verification B: public.viewer_is_blocked(uuid) is gone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('authz.can_see_location(uuid,uuid)')
                 AND 'search_path=authz, public, pg_catalog' = ANY (proconfig)) THEN
    RAISE EXCEPTION '2182 verification B: authz.can_see_location search_path is not authz, public, pg_catalog';
  END IF;
END
$verify_b$`,
        // C — the same four policies still bind (by OID; the expression now names authz).
        `DO $verify_c$
DECLARE got text;
BEGIN
  SELECT string_agg(tablename || ' / ' || policyname, E'\\n' ORDER BY (tablename || ' / ' || policyname) COLLATE "C") INTO got
    FROM pg_policies
   WHERE schemaname = 'public'
     AND coalesce(qual,'') || coalesce(with_check,'') ~ '\\m(is_blocked|can_see_location|in_accepted_circle)\\M';
  IF got IS DISTINCT FROM ${quoteLiteral(bound)} THEN
    RAISE EXCEPTION '2182 verification C: policies bound to the predicates changed: %', got;
  END IF;
END
$verify_c$`,
        // D — negative control, as anon, compared to the count measured before the apply.
        "SET LOCAL ROLE anon",
        "SELECT set_config('request.jwt.claims', NULL, true)",
        `DO $verify_d$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.user_locations;
  IF n <> ${Number(anon)} THEN
    RAISE EXCEPTION '2182 verification D: anon sees % user_locations rows, % before the apply', n, ${Number(anon)};
  END IF;
END
$verify_d$`,
        "RESET ROLE",
      ];
    },
  };
}

function verify2190(): ManualVerification {
  // Block 1 carries its own POSTCONDITION DO block, which runs inside the apply
  // transaction. Block 2 (project_all_memory) carries none; this is its check.
  return {
    probes: 0,
    checkBefore: () => [],
    inTransaction: () => [
      `DO $verify_2190$
DECLARE fn regprocedure := to_regprocedure('public.project_all_memory(boolean)');
BEGIN
  IF fn IS NULL THEN RAISE EXCEPTION '2190 verification: project_all_memory(boolean) missing'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = fn) !~ 'project_user_memory_with_retraction' THEN
    RAISE EXCEPTION '2190 verification: project_all_memory does not call the retraction wrapper';
  END IF;
  IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE') THEN
    RAISE EXCEPTION '2190 verification: project_all_memory is executable by anon/authenticated';
  END IF;
END
$verify_2190$`,
    ],
  };
}

/** Per-file verification for the files applied by hand. A refused file not listed here is not applied. */
export const MANUAL_VERIFICATION: Readonly<Record<string, () => ManualVerification>> = {
  "2182_close_authz_rpc_oracle.sql": verify2182,
  "2190_memory_lifecycle_fixes.sql": verify2190,
};

/** The ledger row inside the apply transaction: a plain INSERT, so an existing row aborts everything. */
export function buildManualLedgerInsertSql(filename: string, checksum: string, notes: string): string {
  if (!FILENAME_RE.test(filename)) throw new Error(`refusing to splice filename '${filename}' into SQL`);
  if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error("a manual ledger row needs a real sha256");
  return (
    `INSERT INTO ${LEDGER_TABLE} (filename, checksum, applied_by, notes) ` +
    `VALUES (${quoteLiteral(filename)}, ${quoteLiteral(checksum)}, 'manual', ${quoteLiteral(notes)})`
  );
}

/** The single apply call: the file's COMMIT-block bodies, the verification, the ledger row — one transaction. */
export function buildManualApplySql(plan: ManualApplyPlan, verification: readonly string[], ledgerInsert: string): string {
  return ["BEGIN;", ...plan.applyStatements.map((s) => `${s};`), ...verification.map((s) => `${s};`), `${ledgerInsert};`, "COMMIT;"].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// THE MANAGEMENT API — the only I/O in this module; everything is a parameter
// ─────────────────────────────────────────────────────────────────────────────

export class ManagementApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: string,
  ) {
    super(message);
    this.name = "ManagementApiError";
  }
}

/**
 * The rows of the LAST result. The endpoint returns a JSON array of row
 * objects for a single statement; for a multi-statement text it returns the
 * last non-empty result's rows. An array of arrays is accepted too (last one
 * wins), so a change in that convention cannot be misread as "no rows".
 */
export function lastResultRows(json: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(json)) throw new Error(`unexpected Management API response shape: ${JSON.stringify(json).slice(0, 200)}`);
  if (json.length > 0 && json.every((x) => Array.isArray(x))) {
    return lastResultRows(json[json.length - 1]);
  }
  for (const r of json) {
    if (!isRecord(r)) throw new Error(`unexpected Management API row: ${JSON.stringify(r).slice(0, 200)}`);
  }
  return json as Array<Record<string, unknown>>;
}

export interface ManagementApi {
  ref: string;
  query(sql: string): Promise<Array<Record<string, unknown>>>;
  /** GET /v1/projects/{ref}/<path> (read-only project config, e.g. "postgrest"). */
  getJson(path: string): Promise<unknown>;
}

export function managementApi(ref: string, token: string, timeoutMs = 600_000): ManagementApi {
  assertSimpleIdent(ref, "project ref");
  const base = `https://api.supabase.com/v1/projects/${ref}`;
  async function request(path: string, init: { method: "GET" } | { method: "POST"; body: string }): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${base}/${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ManagementApiError(
        `the request did not complete (${(err as Error).message}). Whether the server applied it is UNKNOWN.`,
        null,
        "",
      );
    }
    const text = await res.text();
    if (!res.ok) {
      const scope =
        res.status === 401 || res.status === 403
          ? " The token was refused for this project: if SUPABASE_PROJECT_TOKEN is scoped to one project " +
            "rather than the account, it cannot reach this one. That is an external prerequisite to fix " +
            "on the token, not in this script."
          : "";
      throw new ManagementApiError(`Management API ${res.status}: ${text}${scope}`, res.status, text);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ManagementApiError(`Management API returned non-JSON: ${text.slice(0, 200)}`, res.status, text);
    }
  }
  return {
    ref,
    async query(sql: string) {
      return lastResultRows(await request("database/query", { method: "POST", body: JSON.stringify({ query: sql }) }));
    },
    async getJson(path: string) {
      if (!/^[a-z][a-z0-9/_-]*$/.test(path)) throw new Error(`refusing Management API path '${path}'`);
      return request(path, { method: "GET" });
    },
  };
}

/**
 * The schemas PostgREST exposes, from GET /v1/projects/{ref}/postgrest
 * (`db_schema`, comma-separated). Throws on any other shape, so an absent
 * field cannot read as "nothing exposed".
 */
export function exposedSchemas(json: unknown): string[] {
  const v = isRecord(json) ? json["db_schema"] : undefined;
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`PostgREST config has no db_schema: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return v.split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

/** A row's column as a string (bigint and count() arrive as text). */
export function textField(row: Record<string, unknown> | undefined, key: string): string {
  const v = row?.[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new Error(`expected column ${key} in the result, got ${JSON.stringify(row ?? null).slice(0, 200)}`);
}

/**
 * A row's json column. The endpoint returns json columns parsed; a json TEXT
 * value is parsed here too, so a change in that convention cannot read as
 * "absent".
 */
export function jsonField(row: Record<string, unknown> | undefined, key: string): unknown {
  const v = row?.[key];
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** A row's json column as a string array. */
export function stringArrayField(row: Record<string, unknown> | undefined, key: string): string[] {
  const v = jsonField(row, key);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new Error(`expected a JSON string array in column ${key}, got ${JSON.stringify(v ?? null).slice(0, 200)}`);
}

/** A row's boolean column: true/false, or their text forms; anything else throws. */
export function boolField(row: Record<string, unknown> | undefined, key: string): boolean {
  const v = row?.[key];
  if (v === true || v === "t" || v === "true") return true;
  if (v === false || v === "f" || v === "false") return false;
  throw new Error(`expected a boolean in column ${key}, got ${JSON.stringify(v ?? null).slice(0, 200)}`);
}

/** Read --name value / --name=value. */
export function argValue(argv: readonly string[], name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      const v = argv[i + 1];
      return v !== undefined && !v.startsWith("--") ? v : "";
    }
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return null;
}
