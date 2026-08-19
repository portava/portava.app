/**
 * liveVsCanonicalCore — the PURE, guard-free, I/O-free core of the inverse
 * auditor (`audit:live-unexplained`, src/scripts/auditLiveVsCanonical.ts).
 *
 * It holds the model/live types, the net-new-inventory extractors the already
 * -validated parsers do not cover, the normalizers that make model and live keys
 * line up, buildModel(), and computeUnexplained() — the deterministic diff that
 * turns an already-loaded {model, live, ledger, dispositions, ci} into
 * {findings, exitCode}. Every function here is side-effect free: no filesystem,
 * no network, no environment, no client. That is what lets the unit test drive
 * the whole judgement with fixtures and NO database, and it is why this module
 * names no credential env var and opens no client — scripts/check-guard-coverage
 * .mjs must continue to see it as unable to reach the database, so it stays
 * unguarded.
 *
 * DIVISION OF LABOUR WITH THE FORWARD PARSERS (reuse, never re-implement):
 *  - The validated relation/RLS spine is INJECTED as `baselineTables`
 *    (parseBaselineSchema.parseBaselineTables — unit-tested on this exact dump).
 *  - The migration parser is INJECTED as `parseMig` (the exported parseMigration
 *    from auditMigrationsVsLive.ts) and supplies the inventories it already
 *    covers: table/view relations, columns, indexes, enums/enum values,
 *    triggers, RLS claims and TABLE grants, over baseline + canonical.
 *  - Only the inventories those two do NOT cover are extracted here: constraints,
 *    extensions, function identity signatures, policy predicates, and the
 *    paren-syntax COLUMN grants parseMigration's grant regex cannot match.
 */

import type { RlsDisposition } from "../rlsDispositions.js";
import type {
  ExplainedEntry,
  LedgerShapeProblem,
} from "../explainedLiveObjects.js";
import { ledgerKeySet } from "../explainedLiveObjects.js";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveInventory {
  /** server_version_num — predicate normalization is claimed stable only within a PG major. */
  pgVersionNum: number;
  /** relname -> relkind. The forward auditor collapses these into one set; the inverse keeps the kind. */
  relations: Map<string, "r" | "p" | "v" | "m">;
  columns: Set<string>; // 'table.column'
  functions: Set<string>; // functionIdentityKey
  indexes: Set<string>;
  policies: Map<
    string,
    { using: string | null; withCheck: string | null; roles: string[]; cmd: string }
  >; // key 'schema.table.policy'
  enums: Set<string>;
  enumValues: Set<string>;
  triggers: Set<string>; // 'table.trigger'
  rlsEnabled: Set<string>; // relrowsecurity=true, relkind r/p ONLY
  policyCountByTable: Map<string, number>; // live policy count per public table
  tableGrants: Map<string, Set<string>>; // 'table.grantee' -> {normalized privileges}
  columnGrants: Map<string, Set<string>>; // 'table.column.grantee' -> {normalized privileges}
  routineGrants: Map<string, Set<string>>; // 'name(identityargs).grantee' -> {'execute'}
  constraints: Set<string>; // 'table.conname'
  extensions: Set<string>; // extname
}

export interface Model {
  relations: Set<string>;
  columns: Set<string>;
  functions: Set<string>;
  indexes: Set<string>;
  policies: Map<
    string,
    { using: string | null; withCheck: string | null; roles: string[] }
  >; // 'schema.table.policy'
  enums: Set<string>;
  enumValues: Set<string>;
  triggers: Set<string>;
  rlsClaimTables: Set<string>; // baseline rlsEnabled UNION canonical 'rls' claims
  tableGrants: Map<string, Set<string>>;
  columnGrants: Map<string, Set<string>>;
  routineGrants: Map<string, Set<string>>;
  constraints: Set<string>;
  extensions: Set<string>;
  ledgerKeys: Set<string>;
}

export interface CiSurface {
  packageScripts: Set<string>;
  runAllChecksText: string;
  workflowText: string;
}

export interface Finding {
  code: string;
  kind: string;
  key: string;
  detail: string;
}

export interface UnexplainedResult {
  findings: Finding[];
  exitCode: 0 | 1 | 2;
}

export interface UnexplainedInput {
  model: Model;
  live: LiveInventory;
  ledger: ReadonlyArray<ExplainedEntry>;
  ledgerShapeProblems: LedgerShapeProblem[];
  dispositions: Record<string, RlsDisposition>;
  ci: CiSurface;
}

/** Minimal shape of the injected migration parser (parseMigration). */
export type MigrationClaim = { kind: string; key: string; label: string };
export type ParseMig = (sql: string) => MigrationClaim[];

// ─────────────────────────────────────────────────────────────────────────────
// LOW-LEVEL PARSE HELPERS (pure)
// ─────────────────────────────────────────────────────────────────────────────

const unquote = (s: string): string =>
  s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;

/**
 * From `src` at/after `from`, find the first '(' and return the balanced body
 * (without the outer parens), tracking single-quoted strings so parens inside
 * literals do not unbalance the scan. Returns null if unbalanced.
 */
function balancedParenBody(src: string, from: number): string | null {
  let i = src.indexOf("(", from);
  if (i === -1) return null;
  const start = i + 1;
  let depth = 1;
  i = start;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "'") {
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") i += 2;
        else if (src[i] === "'") break;
        else i++;
      }
    } else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }
  if (depth !== 0) return null;
  return src.slice(start, i - 1);
}

/** Split a parenthesized argument body on top-level commas (paren-aware). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") {
      cur += ch;
      i++;
      while (i < body.length) {
        cur += body[i];
        if (body[i] === "'" && body[i + 1] === "'") cur += body[++i];
        else if (body[i] === "'") break;
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * Read one CREATE POLICY ... ; statement starting at `from`, returning the
 * statement text and the index just past its terminating semicolon. Tracks
 * single-quoted strings so a ';' inside a predicate literal does not end it.
 */
function readStatement(src: string, from: number): { stmt: string; end: number } {
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'") {
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") i += 2;
        else if (src[i] === "'") break;
        else i++;
      }
    } else if (ch === ";") {
      return { stmt: src.slice(from, i), end: i + 1 };
    }
    i++;
  }
  return { stmt: src.slice(from), end: src.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZERS (shared by model + live so keys match; exported for the test)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lowercase, collapse whitespace, and strip fully-enclosing outer parens.
 * pg_dump wraps predicates in an extra paren layer (`USING ((a = b))`) that
 * pg_policies.qual does not (`(a = b)`); collapsing both to `a = b` lets them
 * compare. STABLE ONLY WITHIN A PG MAJOR — pg re-renders parenthesization and
 * casts across major versions.
 */
export function normalizePredicate(expr: string | null): string | null {
  if (expr === null || expr === undefined) return null;
  let s = expr.toLowerCase().replace(/\s+/g, " ").trim();
  // Strip one fully-enclosing paren pair at a time.
  let changed = true;
  while (changed && s.length >= 2 && s[0] === "(" && s[s.length - 1] === ")") {
    changed = false;
    let depth = 0;
    let enclosesAll = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") {
        depth--;
        if (depth === 0 && i < s.length - 1) {
          enclosesAll = false;
          break;
        }
      }
    }
    if (enclosesAll && depth === 0) {
      s = s.slice(1, -1).trim();
      changed = true;
    }
  }
  return s;
}

/** Sorted, lower-cased, de-duplicated role list. */
export function normalizeRoles(roles: string[]): string[] {
  return [...new Set(roles.map((r) => r.trim().toLowerCase()).filter(Boolean))].sort();
}

// Type synonyms folded to the canonical spelling pg_get_function_identity_arguments emits.
const TYPE_SYNONYMS: Record<string, string> = {
  int: "integer",
  int4: "integer",
  int8: "bigint",
  int2: "smallint",
  bool: "boolean",
  varchar: "character varying",
  timestamptz: "timestamp with time zone",
  timetz: "time with time zone",
  float8: "double precision",
  float4: "real",
  decimal: "numeric",
};
// First tokens that BEGIN a multiword built-in type (so the first token is the
// type, not an argument name).
const MULTIWORD_TYPE_HEADS = new Set([
  "character",
  "double",
  "timestamp",
  "time",
  "bit",
  "national",
]);

/**
 * '<argname> <type> [DEFAULT ...]' list -> comma-joined type-only string, e.g.
 * 'target_user_id uuid, new_role text' -> 'uuid,text'. Handles multiword types
 * ('timestamp with time zone', 'character varying', 'double precision'), arrays
 * ('text[]', 'public.event_state[]'), arg modes, DEFAULT clauses, and the
 * name-less form pg_get_function_identity_arguments emits on the live side. This
 * is the fragile join (see the auditor's open-risks note); the golden tests pin
 * the forms present in the baseline.
 */
export function normalizeArgTypes(identArgs: string): string {
  const raw = (identArgs ?? "").trim();
  if (!raw) return "";
  const args = splitTopLevel(raw);
  const types: string[] = [];
  for (let arg of args) {
    arg = arg.trim();
    if (!arg) continue;
    // Drop DEFAULT / '= expr'.
    arg = arg.replace(/\s+default\s+[\s\S]*$/i, "").replace(/\s*=\s*[\s\S]*$/, "").trim();
    // Drop leading arg mode.
    arg = arg.replace(/^(in|out|inout|variadic)\s+/i, "").trim();
    const tokens = arg.split(/\s+/);
    let type: string;
    if (tokens.length <= 1) {
      type = arg; // just a type, no name
    } else if (MULTIWORD_TYPE_HEADS.has(tokens[0].toLowerCase())) {
      type = arg; // multiword built-in type, no leading name
    } else {
      type = tokens.slice(1).join(" "); // first token is the arg name
    }
    types.push(foldTypeSynonyms(type.toLowerCase().trim()));
  }
  return types.join(",");
}

function foldTypeSynonyms(type: string): string {
  // Preserve array suffix while folding the base.
  const arrayMatch = /^(.*?)((?:\[\])+)$/.exec(type);
  const base = arrayMatch ? arrayMatch[1].trim() : type;
  const suffix = arrayMatch ? arrayMatch[2] : "";
  const folded = TYPE_SYNONYMS[base] ?? base;
  return `${folded.replace(/\s+/g, " ")}${suffix}`;
}

export function functionIdentityKey(name: string, identArgs: string): string {
  return `${name.toLowerCase()}(${normalizeArgTypes(identArgs)})`;
}

/**
 * Fold privilege vocabulary so the dump (which emits MAINTAIN / TRUNCATE and
 * uppercase names) and information_schema compare as exact sets. Lower-casing is
 * sufficient and safe: EXCESS_PRIVILEGE only fires when LIVE holds a privilege
 * beyond the model, so a privilege the dump lists but information_schema does
 * not (e.g. MAINTAIN on older servers) can only make the model a superset, never
 * a false excess.
 */
export function normalizePrivilege(p: string): string {
  return p.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// NET-NEW-INVENTORY / CLOSURE EXTRACTORS (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** 'table.conname' from ALTER TABLE ... ADD CONSTRAINT and inline table constraints. */
export function extractConstraints(sql: string): Set<string> {
  const out = new Set<string>();

  // ALTER TABLE [ONLY] [schema.]<table> ... ADD CONSTRAINT <name>
  const alterRe =
    /alter\s+table\s+(?:only\s+)?(?:"?[A-Za-z_][\w$]*"?\.)?("?[A-Za-z_][\w$]*"?)\s+add\s+constraint\s+("?[A-Za-z_][\w$]*"?)/gi;
  for (const m of sql.matchAll(alterRe)) {
    const table = unquote(m[1]).toLowerCase();
    const con = unquote(m[2]).toLowerCase();
    out.add(`${table}.${con}`);
  }

  // Inline: CREATE TABLE [schema.]<t> ( ... CONSTRAINT <name> ... )
  const createRe =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?[A-Za-z_][\w$]*"?\.)?("?[A-Za-z_][\w$]*"?)/gi;
  for (const m of sql.matchAll(createRe)) {
    const table = unquote(m[1]).toLowerCase();
    const body = balancedParenBody(sql, (m.index ?? 0) + m[0].length);
    if (body === null) continue;
    for (const part of splitTopLevel(body)) {
      const cm = /^\s*constraint\s+("?[A-Za-z_][\w$]*"?)/i.exec(part);
      if (cm) out.add(`${table}.${unquote(cm[1]).toLowerCase()}`);
    }
  }

  return out;
}

/** extname from CREATE EXTENSION [IF NOT EXISTS] <name>. */
export function extractExtensions(sql: string): Set<string> {
  const out = new Set<string>();
  const re =
    /create\s+extension\s+(?:if\s+not\s+exists\s+)?("([^"]+)"|([A-Za-z_][\w$-]*))/gi;
  for (const m of sql.matchAll(re)) {
    out.add((m[2] ?? m[3]).toLowerCase());
  }
  return out;
}

/** proname -> set of normalized identity-arg strings, from CREATE FUNCTION [schema.]name(args). */
export function extractFunctionSignatures(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re =
    /create\s+(?:or\s+replace\s+)?function\s+(?:"?[A-Za-z_][\w$]*"?\.)?("?[A-Za-z_][\w$]*"?)/gi;
  for (const m of sql.matchAll(re)) {
    const name = unquote(m[1]).toLowerCase();
    const body = balancedParenBody(sql, (m.index ?? 0) + m[0].length);
    const args = normalizeArgTypes(body ?? "");
    if (!out.has(name)) out.set(name, new Set());
    out.get(name)!.add(args);
  }
  return out;
}

/**
 * key 'schema.table.policy' -> { using, withCheck, roles }. An UNQUALIFIED
 * target ('ON events') DEFAULTS to schema 'public' so it matches the live
 * pg_policies key for the public.events table.
 */
export function extractPolicyPredicates(
  sql: string,
): Map<string, { using: string | null; withCheck: string | null; roles: string[] }> {
  const out = new Map<
    string,
    { using: string | null; withCheck: string | null; roles: string[] }
  >();

  const headRe = /create\s+policy\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(sql)) !== null) {
    const { stmt, end } = readStatement(sql, m.index);
    headRe.lastIndex = end;

    // policy name (quoted or bare) then ON <target>.
    const nameM =
      /^create\s+policy\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))\s+on\s+(?:("?[A-Za-z_][\w$]*"?)\.)?("?[A-Za-z_][\w$]*"?)/i.exec(
        stmt,
      );
    if (!nameM) continue;
    const policy = (nameM[1] ?? nameM[2]).toLowerCase();
    const schema = nameM[3] ? unquote(nameM[3]).toLowerCase() : "public";
    const table = unquote(nameM[4]).toLowerCase();
    const key = `${schema}.${table}.${policy}`;

    // roles: TO <list> up to USING / WITH CHECK / end.
    let roles: string[] = ["public"];
    const toM = /\bto\s+([\s\S]*?)(?=\busing\b|\bwith\s+check\b|;|$)/i.exec(stmt);
    if (toM) {
      const parsed = toM[1]
        .split(",")
        .map((r) => r.trim().toLowerCase())
        .filter((r) => /^[a-z_][\w$]*$/.test(r));
      if (parsed.length) roles = parsed;
    }

    // USING (...) and WITH CHECK (...) predicates.
    let using: string | null = null;
    const usingIdx = stmt.search(/\busing\b/i);
    if (usingIdx !== -1) using = balancedParenBody(stmt, usingIdx);
    let withCheck: string | null = null;
    const wcIdx = stmt.search(/\bwith\s+check\b/i);
    if (wcIdx !== -1) withCheck = balancedParenBody(stmt, wcIdx);

    out.set(key, { using, withCheck, roles });
  }

  return out;
}

/**
 * 'table.column.grantee' -> {priv} from the paren column-grant syntax
 * `GRANT SELECT(id),UPDATE(id) ON TABLE [schema.]t TO role` that
 * parseMigration's `[a-z, ]` privilege regex cannot match.
 */
export function extractColumnGrants(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  // Only lines whose privilege list carries a paren column list are column grants.
  const re =
    /grant\s+([A-Za-z]+\s*\([^)]*\)(?:\s*,\s*[A-Za-z]+\s*\([^)]*\))*)\s+on\s+(?:table\s+)?(?:"?[A-Za-z_][\w$]*"?\.)?("?[A-Za-z_][\w$]*"?)\s+to\s+([A-Za-z_][\w$]*)/gi;
  for (const m of sql.matchAll(re)) {
    const privClause = m[1];
    const table = unquote(m[2]).toLowerCase();
    const grantee = m[3].toLowerCase();
    // Each `PRIV(col1, col2)` grants PRIV on each listed column.
    const pcRe = /([A-Za-z]+)\s*\(([^)]*)\)/g;
    let pc: RegExpExecArray | null;
    while ((pc = pcRe.exec(privClause)) !== null) {
      const priv = normalizePrivilege(pc[1]);
      for (const colRaw of pc[2].split(",")) {
        const col = unquote(colRaw.trim()).toLowerCase();
        if (!col) continue;
        const key = `${table}.${col}.${grantee}`;
        if (!out.has(key)) out.set(key, new Set());
        out.get(key)!.add(priv);
      }
    }
  }
  return out;
}

/** 'enumname.value' (lowercased) from CREATE TYPE ... AS ENUM ( 'a', 'b', … ).
 *  parseMigration reads only ALTER TYPE ADD VALUE; pg_dump emits enum labels
 *  inside the CREATE TYPE body, so without this the model carries zero enum
 *  values and flags every live label as unexplained. */
export function extractEnumValues(sql: string): Set<string> {
  const out = new Set<string>();
  const re =
    /create\s+type\s+(?:[\w"]+\.)?"?([a-z_][a-z0-9_]*)"?\s+as\s+enum\s*\(([^)]*)\)/gi;
  for (const m of sql.matchAll(re)) {
    const name = m[1].toLowerCase();
    for (const v of m[2].matchAll(/'([^']*)'/g)) out.add(`${name}.${v[1]}`.toLowerCase());
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODEL BUILDER (pure)
// ─────────────────────────────────────────────────────────────────────────────

export function buildModel(args: {
  baselineSql: string;
  baselineTables: Map<
    string,
    { table: string; rlsEnabled: boolean; policyCount: number }
  >;
  canonicalSqls: string[];
  ledger: ReadonlyArray<ExplainedEntry>;
  parseMig: ParseMig;
}): Model {
  const { baselineSql, baselineTables, canonicalSqls, ledger, parseMig } = args;
  const allSqls = [baselineSql, ...canonicalSqls];

  const relations = new Set<string>();
  const columns = new Set<string>();
  const indexes = new Set<string>();
  const enums = new Set<string>();
  const enumValues = new Set<string>();
  const triggers = new Set<string>();
  const rlsClaimTables = new Set<string>();
  const tableGrants = new Map<string, Set<string>>();
  const routineGrants = new Map<string, Set<string>>();

  // Validated spine: relation set + RLS-enabled tables from parseBaselineTables.
  for (const [name, info] of baselineTables) {
    const t = name.toLowerCase();
    relations.add(t);
    if (info.rlsEnabled) rlsClaimTables.add(t);
  }

  // Everything parseMigration already covers, over baseline + canonical. VIEWS
  // are folded into relations here (parseBaselineTables only sees CREATE TABLE),
  // which is how a live VIEW like public_profile_verification stays explained.
  for (const sql of allSqls) {
    for (const c of parseMig(sql)) {
      const bare = c.key.slice(c.kind.length + 1);
      switch (c.kind) {
        case "table":
        case "view":
          relations.add(bare);
          break;
        case "column":
          columns.add(bare);
          break;
        case "index":
          indexes.add(bare);
          break;
        case "enum":
          enums.add(bare);
          break;
        case "enumvalue":
          enumValues.add(bare);
          break;
        case "trigger":
          triggers.add(bare);
          break;
        case "rls":
          rlsClaimTables.add(bare);
          break;
        case "grant": {
          // bare = 'table.grantee.priv'
          const parts = bare.split(".");
          const priv = parts.pop() as string;
          const grantee = parts.pop() as string;
          const table = parts.join(".");
          const k = `${table}.${grantee}`;
          if (!tableGrants.has(k)) tableGrants.set(k, new Set());
          tableGrants.get(k)!.add(normalizePrivilege(priv));
          break;
        }
        case "grantfn": {
          // bare = 'fn.grantee' (name-only; not compared for excess — see note).
          if (!routineGrants.has(bare)) routineGrants.set(bare, new Set());
          routineGrants.get(bare)!.add("execute");
          break;
        }
        default:
          break; // 'function' and 'policy' handled by the extractors below
      }
    }
  }

  // Net-new inventories the forward parsers do not carry.
  const functions = new Set<string>();
  const policies = new Map<
    string,
    { using: string | null; withCheck: string | null; roles: string[] }
  >();
  const columnGrants = new Map<string, Set<string>>();
  const constraints = new Set<string>();
  const extensions = new Set<string>();

  for (const sql of allSqls) {
    for (const [name, argset] of extractFunctionSignatures(sql)) {
      for (const a of argset) functions.add(`${name}(${a})`);
    }
    for (const [k, v] of extractPolicyPredicates(sql)) {
      policies.set(k, {
        using: v.using,
        withCheck: v.withCheck,
        roles: normalizeRoles(v.roles),
      });
    }
    for (const [k, privs] of extractColumnGrants(sql)) {
      if (!columnGrants.has(k)) columnGrants.set(k, new Set());
      for (const p of privs) columnGrants.get(k)!.add(p);
    }
    for (const c of extractConstraints(sql)) constraints.add(c);
    for (const e of extractExtensions(sql)) extensions.add(e);
    for (const ev of extractEnumValues(sql)) enumValues.add(ev);
  }

  return {
    relations,
    columns,
    functions,
    indexes,
    policies,
    enums,
    enumValues,
    triggers,
    rlsClaimTables,
    tableGrants,
    columnGrants,
    routineGrants,
    constraints,
    extensions,
    ledgerKeys: ledgerKeySet(ledger),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PURE CORE
// ─────────────────────────────────────────────────────────────────────────────

/** HARD gate: a verifier is wired iff it is a package.json script key. */
function isVerifierWired(name: string | undefined, ci: CiSurface): boolean {
  return !!name && ci.packageScripts.has(name);
}

type DispositionWithVerifier = RlsDisposition & { deep_verifier?: string };

export function computeUnexplained(input: UnexplainedInput): UnexplainedResult {
  const { model, live, ledger, ledgerShapeProblems, dispositions, ci } = input;
  const findings: Finding[] = [];
  const add = (code: string, kind: string, key: string, detail: string) =>
    findings.push({ code, kind, key, detail });

  // (7) LEDGER_SHAPE_INVALID — every validateLedgerShape problem is an exit-1
  //     finding, NOT a cannot-establish (mirrors check-guard-coverage.mjs).
  for (const p of ledgerShapeProblems) {
    add("LEDGER_SHAPE_INVALID", "ledger", p.key, `${p.code}: ${p.detail}`);
  }

  // (1) UNEXPLAINED_LIVE across the ten inventories.
  const modelByKind: Record<string, Set<string>> = {
    relation: model.relations,
    column: model.columns,
    function: model.functions,
    index: model.indexes,
    policy: new Set(model.policies.keys()),
    enum: model.enums,
    enumvalue: model.enumValues,
    trigger: model.triggers,
    constraint: model.constraints,
    extension: model.extensions,
  };
  const liveByKind: Record<string, Set<string>> = {
    relation: new Set(live.relations.keys()),
    column: live.columns,
    function: live.functions,
    index: live.indexes,
    policy: new Set(live.policies.keys()),
    enum: live.enums,
    enumvalue: live.enumValues,
    trigger: live.triggers,
    constraint: live.constraints,
    extension: live.extensions,
  };
  for (const kind of Object.keys(liveByKind)) {
    for (const k of liveByKind[kind]) {
      if (!modelByKind[kind].has(k) && !model.ledgerKeys.has(`${kind}:${k}`)) {
        add(
          "UNEXPLAINED_LIVE",
          kind,
          k,
          `live ${kind} '${k}' is explained by neither the model nor the ledger`,
        );
      }
    }
  }

  // (2) EXCESS_PRIVILEGE — table AND column grants, honoring two Postgres
  // semantics a naive exact-set compare gets wrong (each otherwise turns every
  // default Supabase grant into a false "excess"):
  //   * GRANT ALL is one privilege ("all") in the dump, but role_table_grants
  //     NEVER returns "all" — it returns each implied privilege as its own row.
  //     A model "all" covers them all.
  //   * A TABLE grant is inherited by every column: role_column_grants derives
  //     one row per (column, grantee). A live COLUMN privilege is explained if
  //     the model grants it (or ALL) on the column OR on the whole table.
  const covers = (privs: Set<string>, p: string): boolean =>
    privs.has(p) || privs.has("all");

  for (const [k, livePrivs] of live.tableGrants) {
    const modelPrivs = model.tableGrants.get(k) ?? new Set<string>();
    for (const p of livePrivs) {
      if (!covers(modelPrivs, p)) {
        add("EXCESS_PRIVILEGE", "grant", k, `live holds '${p}' on ${k} beyond the model`);
      }
    }
  }
  for (const [k, livePrivs] of live.columnGrants) {
    // k = "table.column.grantee"; a table grant "table.grantee" inherits to it.
    const parts = k.split(".");
    const grantee = parts[parts.length - 1];
    const table = parts.slice(0, parts.length - 2).join(".");
    const colPrivs = model.columnGrants.get(k) ?? new Set<string>();
    const tblPrivs =
      model.tableGrants.get(`${table}.${grantee}`) ?? new Set<string>();
    for (const p of livePrivs) {
      if (!covers(colPrivs, p) && !covers(tblPrivs, p)) {
        add(
          "EXCESS_PRIVILEGE",
          "columngrant",
          k,
          `live holds column privilege '${p}' on ${k} beyond the model`,
        );
      }
    }
  }

  // (3) POLICY_PREDICATE_DRIFT — policies present on both sides whose predicate/roles differ.
  for (const [k, lp] of live.policies) {
    const mp = model.policies.get(k);
    if (!mp) continue; // absence is UNEXPLAINED_LIVE's business
    const lu = normalizePredicate(lp.using);
    const mu = normalizePredicate(mp.using);
    const lw = normalizePredicate(lp.withCheck);
    const mw = normalizePredicate(mp.withCheck);
    const lr = normalizeRoles(lp.roles).join(",");
    const mr = normalizeRoles(mp.roles).join(",");
    if (lu !== mu || lw !== mw || lr !== mr) {
      add(
        "POLICY_PREDICATE_DRIFT",
        "policy",
        k,
        `using[model='${mu}' live='${lu}'] check[model='${mw}' live='${lw}'] roles[model='${mr}' live='${lr}']`,
      );
    }
  }

  // (4) RLS DISPOSITION — two separate axes.
  const livePublicRP = new Set<string>();
  for (const [name, kind] of live.relations) {
    if (kind === "r" || kind === "p") livePublicRP.add(name);
  }

  // (4a) COVERAGE over the FULL live public r/p set.
  for (const t of livePublicRP) {
    if (!(t in dispositions)) {
      add(
        "DISPOSITION_MISSING",
        "relation",
        t,
        `live public r/p table '${t}' has no RLS disposition record`,
      );
    }
  }
  for (const t of Object.keys(dispositions)) {
    if (!livePublicRP.has(t)) {
      add(
        "DISPOSITION_STALE",
        "relation",
        t,
        `RLS disposition record '${t}' names no live public r/p table`,
      );
    }
  }

  // (4b) METADATA completeness on EVERY record.
  for (const [t, d] of Object.entries(dispositions)) {
    if (d.class === "DENY_ALL_BY_DESIGN" && !d.reason?.trim()) {
      add("DISPOSITION_METADATA", "relation", t, "DENY_ALL_BY_DESIGN without a reason");
    }
    if (d.class === "REVIEWED_EXEMPT") {
      if (!d.reason?.trim() || !d.reviewer?.trim() || !d.date?.trim()) {
        add(
          "DISPOSITION_METADATA",
          "relation",
          t,
          "REVIEWED_EXEMPT missing reason, reviewer or date",
        );
      }
      const dv = (d as DispositionWithVerifier).deep_verifier;
      if (!isVerifierWired(dv, ci)) {
        add(
          "DISPOSITION_METADATA",
          "relation",
          t,
          `REVIEWED_EXEMPT deep_verifier '${dv ?? ""}' is not a package.json script`,
        );
      }
    }
    if (d.class === "NEEDS_REVIEW") {
      add(
        "DISPOSITION_UNRESOLVED",
        "relation",
        t,
        "NEEDS_REVIEW (UNKNOWN-PENDING-LIVE) is unresolved once the baseline has run",
      );
    }
  }

  // (4c) LIVE-FACT CLASS CONSISTENCY — only over (live public r/p) MINUS the
  //      model's claimed tables, so the forward auditor's enablement judgement
  //      for a claimed table is never duplicated.
  for (const t of livePublicRP) {
    if (model.rlsClaimTables.has(t)) continue;
    const d = dispositions[t];
    if (!d) continue; // missing already flagged by 4a
    const enabled = live.rlsEnabled.has(t);
    const pcount = live.policyCountByTable.get(t) ?? 0;
    if (d.class === "RLS_REQUIRED" && (!enabled || pcount < 1)) {
      add(
        "DISPOSITION_CLASS_MISMATCH",
        "relation",
        t,
        `RLS_REQUIRED but live rlsEnabled=${enabled}, policyCount=${pcount}`,
      );
    }
    if (d.class === "DENY_ALL_BY_DESIGN" && (!enabled || pcount > 0)) {
      add(
        "DISPOSITION_CLASS_MISMATCH",
        "relation",
        t,
        `DENY_ALL_BY_DESIGN but live rlsEnabled=${enabled}, policyCount=${pcount}`,
      );
    }
    if (d.class === "REVIEWED_EXEMPT" && enabled) {
      add(
        "DISPOSITION_CLASS_MISMATCH",
        "relation",
        t,
        "REVIEWED_EXEMPT but live rlsEnabled=true",
      );
    }
  }

  // (5) STALE_LEDGER_ENTRY — every ledger entry must be reachable (seen live).
  const liveReachByKind: Record<string, Set<string>> = {
    ...liveByKind,
    grant: new Set(live.tableGrants.keys()),
    columngrant: new Set(live.columnGrants.keys()),
  };
  for (const e of ledger) {
    const idx = e.key.indexOf(":");
    const kind = e.key.slice(0, idx);
    const bare = e.key.slice(idx + 1).toLowerCase();
    const set = liveReachByKind[kind];
    if (!set || !set.has(bare)) {
      add(
        "STALE_LEDGER_ENTRY",
        "ledger",
        e.key,
        `ledger entry '${e.key}' names an object not seen in the live census`,
      );
    }
  }

  // (6) VERIFIER_NOT_WIRED — HARDENED_INVARIANT ledger entry with an unwired verifier.
  for (const e of ledger) {
    if (e.disposition === "HARDENED_INVARIANT" && !isVerifierWired(e.deep_verifier, ci)) {
      add(
        "VERIFIER_NOT_WIRED",
        "ledger",
        e.key,
        `HARDENED_INVARIANT deep_verifier '${e.deep_verifier ?? ""}' is not a package.json script`,
      );
    }
  }

  // exitCode: 2 (cannot establish) if EITHER census is vacuous -- an empty live
  // relation set OR an empty disposition manifest (§5.4 "vacuity -> exit 2");
  // else 1 if any finding; else 0. Precedence 2 > 1 > 0.
  const exitCode: 0 | 1 | 2 =
    live.relations.size === 0 || Object.keys(dispositions).length === 0
      ? 2
      : findings.length > 0
        ? 1
        : 0;

  return { findings, exitCode };
}
