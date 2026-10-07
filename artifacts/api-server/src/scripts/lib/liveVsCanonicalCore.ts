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
 * Length-preserving blanking of SQL comments: every byte of a `--` line comment
 * and of a (nestable) block comment is replaced with a space, so every
 * index-based scan below keeps working on unchanged offsets while comment PROSE
 * can no longer be read as SQL.
 *
 * WHY THIS EXISTS, AND WHY ITS ABSENCE WAS INVISIBLE FOR 23 RUNS.
 * balancedParenBody/splitTopLevel/readStatement track single-quoted literals so
 * a paren or a semicolon inside a string does not end the scan. They did not
 * track comments — and an APOSTROPHE IN A COMMENT ("the writer's expiry") then
 * opens a literal that runs to the next apostrophe hundreds of lines away,
 * swallowing the real parens in between. balancedParenBody returns null on the
 * unbalanced result, the whole CREATE TABLE body is silently skipped, and every
 * constraint that table declares is missing from the model. The fixture suite
 * never saw it because fixtures are written without prose.
 *
 * Quote-aware in BOTH directions, which is the point: `--` inside a string
 * literal is data, an apostrophe inside a comment is prose. Single-quoted
 * literals (with '' escapes), double-quoted identifiers and dollar-quoted
 * bodies ($$ … $$ / $tag$ … $tag$, as every plpgsql function body here is) are
 * passed through untouched.
 */
export function blankSqlComments(sql: string): string {
  const out = sql.split("");
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];

    if (ch === "'" || ch === '"') {
      const q = ch;
      i++;
      while (i < n) {
        if (sql[i] === q && sql[i + 1] === q) i += 2;
        else if (sql[i] === q) {
          i++;
          break;
        } else i++;
      }
      continue;
    }

    // Dollar quoting: $$ … $$ or $tag$ … $tag$.
    if (ch === "$") {
      const m = /^\$([A-Za-z_][\w]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }

    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
        } else {
          if (sql[i] !== "\n") out[i] = " ";
          i++;
        }
      }
      continue;
    }

    i++;
  }
  return out.join("");
}

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
  // pg_get_expr never schema-qualifies public (it is in search_path); pg_dump
  // does. Strip 'public.' so baseline-derived predicates match live's.
  s = s.replace(/\bpublic\./g, "");
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
  // Bare aliases a migration writes and the live side never echoes back.
  // 2297 declares record_distribution_negative_signal(... FLOAT), Postgres
  // stores float8, and pg_get_function_identity_arguments prints
  // 'double precision' — so the model said `float`, live said
  // `double precision`, and a function the repository plainly declares read as
  // UNEXPLAINED_LIVE. Bare FLOAT is float8 in Postgres (a precision-qualified
  // FLOAT(1..24) is real, and FLOAT(n) is not folded here — it would stay
  // unexplained rather than be guessed at).
  float: "double precision",
  timestamp: "timestamp without time zone",
  time: "time without time zone",
  char: "character",
  bpchar: "character",
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
    // pg_get_function_identity_arguments never qualifies public-schema types;
    // pg_dump does (public.event_role_type[]). Strip so the two sides match.
    types.push(foldTypeSynonyms(type.toLowerCase().replace(/\bpublic\./g, "").trim()));
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

/** From `from`, skip WHITESPACE ONLY; if the next character is '(' return its
 *  balanced body, else null. Unlike balancedParenBody this does not jump over
 *  intervening SQL, so `CREATE TABLE x PARTITION OF y (…)` and
 *  `CREATE TABLE x AS SELECT f(…)` are not misread as a column list. */
function immediateParenBody(src: string, from: number): string | null {
  let i = from;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] !== "(") return null;
  return balancedParenBody(src, i);
}

/** Leading identifier of a column-list element ('session_id', '"order" DESC'). */
function leadingIdent(s: string): string | null {
  const m = /^\s*(?:"([^"]+)"|([A-Za-z_][\w$]*))/.exec(s);
  if (!m) return null;
  return (m[1] ?? m[2]!).toLowerCase();
}

/** Column names of a parenthesized column list, in order. */
function columnListNames(body: string): string[] {
  const out: string[] = [];
  for (const part of splitTopLevel(body)) {
    const id = leadingIdent(part);
    if (id) out.push(id);
  }
  return out;
}

/** The table-constraint keywords that can open a top-level CREATE TABLE element;
 *  anything else at that position is a column definition. */
const TABLE_CONSTRAINT_OPENERS = new Set([
  "constraint",
  "primary",
  "unique",
  "foreign",
  "check",
  "exclude",
  "like",
  "partition",
]);

/** NAMEDATALEN - 1. Postgres truncates a longer generated name by shortening
 *  its components; this module does NOT reproduce that truncation and instead
 *  emits nothing, so an over-long live constraint stays UNEXPLAINED_LIVE rather
 *  than being matched against a guess. Loud beats confidently wrong. */
const PG_NAME_MAX = 63;

/**
 * The names Postgres GENERATES for constraints a migration declares WITHOUT a
 * CONSTRAINT clause, plus the backing indexes PK/UNIQUE constraints create.
 *
 * WHY THE MODEL CANNOT DO WITHOUT THIS. pg_dump writes every constraint out as
 * `ALTER TABLE … ADD CONSTRAINT <name> …`, so the baseline dump names them all
 * and the model reads them straight off. A HAND-WRITTEN migration does not:
 * `id uuid PRIMARY KEY`, `session_id uuid REFERENCES …`, `status text CHECK (…)`
 * and `UNIQUE (session_id, dedup_key)` declare four constraints and name none of
 * them. Postgres then names them itself, by the rule in its ChooseConstraintName
 * / makeObjectName:
 *
 *   PRIMARY KEY              <table>_pkey
 *   UNIQUE, column-level     <table>_<column>_key
 *   UNIQUE, table-level      <table>_<col>_<col>…_key
 *   REFERENCES, column-level <table>_<column>_fkey
 *   FOREIGN KEY, table-level <table>_<col>_<col>…_fkey
 *   CHECK, column-level      <table>_<column>_check
 *   CHECK, table-level       <table>_check
 *
 * and on a collision it re-derives with a numeric suffix on the label — a second
 * unnamed CHECK on one column is `<table>_<column>_check1`, as `pass` starts at
 * 1. Those names are live in the database and appear in pg_constraint; without
 * deriving them the inverse audit reports every post-baseline table's own
 * constraints as objects "the canonical model does not explain", which is what
 * it has been doing.
 *
 * This DERIVES, it does not relax: a name is emitted only for a constraint the
 * migration text actually declares, on the table it declares it on. An
 * undeclared live constraint is still unexplained.
 *
 * NOT derived, deliberately — each stays unexplained rather than guessed:
 *   * EXCLUDE (`<table>_<col>_excl`), whose elements are expressions and
 *     operators rather than a plain column list.
 *   * Anything whose derived name would exceed PG_NAME_MAX.
 *   * PG >= 17's named NOT NULL constraints (`<table>_<column>_not_null`),
 *     which are rows in pg_constraint on that version and have no counterpart
 *     in any migration text at all. portava-ci is below 17 today; the day it is
 *     upgraded this audit goes red on every NOT NULL column, and that is a
 *     server-version fact to handle then, not a name to guess now.
 */
export function deriveImplicitConstraints(sql: string): {
  constraints: Set<string>;
  indexes: Set<string>;
  skippedTooLong: string[];
} {
  const src = blankSqlComments(sql);
  const constraints = new Set<string>();
  const indexes = new Set<string>();
  const skippedTooLong: string[] = [];

  /** Per-table taken-name set, so the collision suffix matches Postgres. */
  const taken = new Map<string, Set<string>>();
  const takenFor = (t: string): Set<string> => {
    if (!taken.has(t)) taken.set(t, new Set());
    return taken.get(t)!;
  };

  const emit = (table: string, base: string, backsIndex: boolean): void => {
    const used = takenFor(table);
    let name = base;
    let pass = 0;
    while (used.has(name)) name = `${base}${++pass}`;
    if (Buffer.byteLength(name, "utf8") > PG_NAME_MAX) {
      skippedTooLong.push(`${table}.${name}`);
      return;
    }
    used.add(name);
    constraints.add(`${table}.${name}`);
    if (backsIndex) indexes.add(name);
  };

  const claimExplicit = (table: string, name: string, backsIndex: boolean): void => {
    takenFor(table).add(name);
    constraints.add(`${table}.${name}`);
    if (backsIndex) indexes.add(name);
  };

  // ── CREATE TABLE bodies ────────────────────────────────────────────────────
  const createRe =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?[A-Za-z_][\w$]*"?\.)?("?[A-Za-z_][\w$]*"?)/gi;
  for (const m of src.matchAll(createRe)) {
    const table = unquote(m[1]!).toLowerCase();
    const body = immediateParenBody(src, (m.index ?? 0) + m[0].length);
    if (body === null) continue;

    for (const part of splitTopLevel(body)) {
      const opener = leadingIdent(part);
      if (!opener) continue;

      if (TABLE_CONSTRAINT_OPENERS.has(opener)) {
        if (opener === "like" || opener === "partition") continue;
        // Table-level element. An explicit CONSTRAINT <name> names whatever
        // follows it; otherwise derive from the kind and its column list.
        const named = /^\s*constraint\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*/i.exec(part);
        const rest = named ? part.slice(named[0].length) : part;
        const kind = leadingIdent(rest);
        const backsIndex = kind === "primary" || kind === "unique";
        if (named) {
          claimExplicit(table, (named[1] ?? named[2]!).toLowerCase(), backsIndex);
          continue;
        }
        const listIdx = rest.indexOf("(");
        const cols =
          listIdx === -1 ? [] : columnListNames(balancedParenBody(rest, listIdx) ?? "");
        if (kind === "primary") emit(table, `${table}_pkey`, true);
        else if (kind === "unique") emit(table, `${table}_${cols.join("_")}_key`, true);
        else if (kind === "foreign") emit(table, `${table}_${cols.join("_")}_fkey`, false);
        else if (kind === "check") emit(table, `${table}_check`, false);
        // 'exclude': deliberately not derived — see the header.
        continue;
      }

      // Column definition. Walk its clauses at paren depth 0, in order.
      for (const c of columnClauses(part, opener)) {
        if (c.explicit) {
          claimExplicit(table, c.explicit, c.kind === "p" || c.kind === "u");
          continue;
        }
        if (c.kind === "p") emit(table, `${table}_pkey`, true);
        else if (c.kind === "u") emit(table, `${table}_${opener}_key`, true);
        else if (c.kind === "f") emit(table, `${table}_${opener}_fkey`, false);
        else if (c.kind === "c") emit(table, `${table}_${opener}_check`, false);
      }
    }
  }

  // ── ALTER TABLE … , one action at a time ───────────────────────────────────
  // ADD COLUMN carries constraints too, and that is how most post-baseline
  // constraints on a BASELINE table arrive: `ALTER TABLE media_assets ADD
  // COLUMN purge_status text … CHECK (…)` creates media_assets_purge_status_
  // check, and `ADD COLUMN trip_id uuid REFERENCES trips(id)` creates
  // compass_conversations_trip_id_fkey. Neither is named in the migration.
  const alterHeadRe =
    /alter\s+table\s+(?:only\s+)?(?:"?[A-Za-z_][\w$]*"?\.)?("?[A-Za-z_][\w$]*"?)/gi;
  let am: RegExpExecArray | null;
  while ((am = alterHeadRe.exec(src)) !== null) {
    const table = unquote(am[1]!).toLowerCase();
    const { stmt, end } = readStatement(src, am.index);
    alterHeadRe.lastIndex = end;
    const actions = stmt.slice(am[0].length);

    for (const action of splitTopLevel(actions)) {
      const addCol =
        /^\s*add\s+column\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|([A-Za-z_][\w$]*))/i.exec(
          action,
        );
      if (addCol) {
        const col = (addCol[1] ?? addCol[2]!).toLowerCase();
        for (const c of columnClauses(action.slice(addCol[0].length - col.length), col)) {
          if (c.explicit) {
            claimExplicit(table, c.explicit, c.kind === "p" || c.kind === "u");
            continue;
          }
          if (c.kind === "p") emit(table, `${table}_pkey`, true);
          else if (c.kind === "u") emit(table, `${table}_${col}_key`, true);
          else if (c.kind === "f") emit(table, `${table}_${col}_fkey`, false);
          else if (c.kind === "c") emit(table, `${table}_${col}_check`, false);
        }
        continue;
      }

      const named =
        /^\s*add\s+constraint\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))\s+(primary\s+key|unique)?/i.exec(
          action,
        );
      if (named) {
        claimExplicit(table, (named[1] ?? named[2]!).toLowerCase(), !!named[3]);
        continue;
      }

      const bare = /^\s*add\s+(primary\s+key|unique|foreign\s+key|check)\b/i.exec(action);
      if (!bare) continue;
      const kind = bare[1]!.toLowerCase().split(/\s+/)[0]!;
      const rest = action.slice(bare[0].length);
      const listIdx = rest.indexOf("(");
      const cols =
        kind === "primary" || kind === "check" || listIdx === -1
          ? []
          : columnListNames(balancedParenBody(rest, listIdx) ?? "");
      if (kind === "primary") emit(table, `${table}_pkey`, true);
      else if (kind === "unique") emit(table, `${table}_${cols.join("_")}_key`, true);
      else if (kind === "foreign") emit(table, `${table}_${cols.join("_")}_fkey`, false);
      else if (kind === "check") emit(table, `${table}_check`, false);
    }
  }

  // ── CREATE CONSTRAINT TRIGGER ──────────────────────────────────────────────
  // A constraint trigger is a pg_constraint row (contype 't') as well as a
  // pg_trigger row, and the live census does not filter contype. parseMigration
  // already reads it as a TRIGGER, so it is explained in that inventory and was
  // unexplained in this one — one object, two inventories, one of them blind.
  const conTrigRe =
    /create\s+constraint\s+trigger\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))[\s\S]*?\son\s+(?:"?[A-Za-z_][\w$]*"?\.)?("?[A-Za-z_][\w$]*"?)/gi;
  for (const m of src.matchAll(conTrigRe)) {
    const name = (m[1] ?? m[2]!).toLowerCase();
    const table = unquote(m[3]!).toLowerCase();
    constraints.add(`${table}.${name}`);
  }

  return { constraints, indexes, skippedTooLong };
}

type ColumnClause = { kind: "p" | "u" | "f" | "c"; explicit: string | null };

/**
 * The constraint clauses one column definition declares, in declaration order.
 * Scans at paren depth 0 only, so `CHECK (x IN ('primary','unique'))` does not
 * read its own literals as keywords. A `CONSTRAINT <name>` clause names the
 * constraint that follows it.
 */
function columnClauses(part: string, columnName: string): ColumnClause[] {
  const out: ColumnClause[] = [];
  let pendingName: string | null = null;
  let depth = 0;
  // Start past the column name itself so a column called 'check' or 'unique'
  // does not register as its own constraint.
  const nameEnd = /^\s*(?:"[^"]+"|[A-Za-z_][\w$]*)/.exec(part)?.[0].length ?? 0;
  const re =
    /[()]|'(?:[^']|'')*'|\bconstraint\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))|\bprimary\s+key\b|\bunique\b|\breferences\b|\bcheck\b/gi;
  re.lastIndex = nameEnd;
  let m: RegExpExecArray | null;
  while ((m = re.exec(part)) !== null) {
    const tok = m[0];
    if (tok === "(") {
      depth++;
      continue;
    }
    if (tok === ")") {
      depth--;
      continue;
    }
    if (depth > 0 || tok.startsWith("'")) continue;
    const low = tok.toLowerCase();
    if (low.startsWith("constraint")) {
      pendingName = (m[1] ?? m[2]!).toLowerCase();
      continue;
    }
    const kind: ColumnClause["kind"] | null = low.startsWith("primary")
      ? "p"
      : low === "unique"
        ? "u"
        : low === "references"
          ? "f"
          : low === "check"
            ? "c"
            : null;
    if (!kind) continue;
    out.push({ kind, explicit: pendingName });
    pendingName = null;
  }
  // columnName is used by the caller to build the derived name; referenced here
  // only so the signature documents the pairing.
  void columnName;
  return out;
}

/**
 * 'table.conname' for every constraint the SQL declares: the explicitly named
 * ones (ALTER TABLE … ADD CONSTRAINT, and inline CONSTRAINT <name>) AND the
 * names Postgres generates for the unnamed ones, via deriveImplicitConstraints.
 *
 * Comments are blanked first. Before that they were read as SQL, and an
 * apostrophe in a comment opened a string literal that ran to the next one —
 * unbalancing the CREATE TABLE body, which was then skipped whole. Every
 * constraint of every post-baseline table went missing from the model that way.
 */
export function extractConstraints(sql: string): Set<string> {
  const src = blankSqlComments(sql);
  const out = new Set<string>();

  // ALTER TABLE [ONLY] [schema.]<table> ... ADD CONSTRAINT <name>
  const alterRe =
    /alter\s+table\s+(?:only\s+)?(?:"?[A-Za-z_][\w$]*"?\.)?("?[A-Za-z_][\w$]*"?)\s+add\s+constraint\s+("?[A-Za-z_][\w$]*"?)/gi;
  for (const m of src.matchAll(alterRe)) {
    const table = unquote(m[1]).toLowerCase();
    const con = unquote(m[2]).toLowerCase();
    out.add(`${table}.${con}`);
  }

  // Inline: CREATE TABLE [schema.]<t> ( ... CONSTRAINT <name> ... )
  const createRe =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?[A-Za-z_][\w$]*"?\.)?("?[A-Za-z_][\w$]*"?)/gi;
  for (const m of src.matchAll(createRe)) {
    const table = unquote(m[1]).toLowerCase();
    const body = immediateParenBody(src, (m.index ?? 0) + m[0].length);
    if (body === null) continue;
    for (const part of splitTopLevel(body)) {
      const cm = /^\s*constraint\s+("?[A-Za-z_][\w$]*"?)/i.exec(part);
      if (cm) out.add(`${table}.${unquote(cm[1]).toLowerCase()}`);
    }
  }

  for (const c of deriveImplicitConstraints(src).constraints) out.add(c);

  return out;
}

/** extname from CREATE EXTENSION [IF NOT EXISTS] <name>. */
export function extractExtensions(sql: string): Set<string> {
  const src = blankSqlComments(sql);
  const out = new Set<string>();
  const re =
    /create\s+extension\s+(?:if\s+not\s+exists\s+)?("([^"]+)"|([A-Za-z_][\w$-]*))/gi;
  for (const m of src.matchAll(re)) {
    out.add((m[2] ?? m[3]).toLowerCase());
  }
  return out;
}

/** proname -> set of normalized identity-arg strings, from CREATE FUNCTION [schema.]name(args). */
export function extractFunctionSignatures(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const src = blankSqlComments(sql);
  const re =
    /create\s+(?:or\s+replace\s+)?function\s+(?:"?[A-Za-z_][\w$]*"?\.)?("?[A-Za-z_][\w$]*"?)/gi;
  for (const m of src.matchAll(re)) {
    const name = unquote(m[1]).toLowerCase();
    const body = balancedParenBody(src, (m.index ?? 0) + m[0].length);
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

  const src = blankSqlComments(sql);
  const headRe = /create\s+policy\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(src)) !== null) {
    const { stmt, end } = readStatement(src, m.index);
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
 *
 * Every target table and every grantee of the statement is credited (see
 * extractGrants). It used to read the FIRST grantee only, so `GRANT SELECT
 * (a, b) ON t TO anon, authenticated` explained anon's column privilege and
 * reported authenticated's identical one as excess.
 */
export function extractColumnGrants(sql: string): Map<string, Set<string>> {
  return extractGrants(sql).columnGrants;
}

/** Targets a GRANT can name that are not tables, and so are not table grants. */
const NON_TABLE_GRANT_TARGET =
  /^(?:function|procedure|routine|sequence|schema|database|domain|type|language|large\s+object|foreign|tablespace|parameter|all\s+(?:tables|sequences|functions|procedures|routines)\b)/i;

/**
 * Where a statement can begin: start of text, after `;`, BEGIN/THEN/ELSE/LOOP/DO
 * — or inside a quoted literal ONLY when that literal is a body the server
 * executes: EXECUTE's single-quoted operand, or a dollar quote opened by
 * EXECUTE, AS (a function body) or DO. A RAISE message or COMMENT text that
 * happens to begin with GRANT / REVOKE / CREATE is not a statement, whichever
 * quote it is written in (verifier F3b / F4, and G2-2 for `$tag$` quotes):
 * crediting it would let a sentence explain away a real EXCESS_PRIVILEGE, or
 * stand in for a REVOKE that never runs. One expression for both readers
 * (extractGrants here, rule 4 / rule 5 in clientTableAclDecisions.ts).
 */
export const SQL_STATEMENT_LEAD =
  /(?:^|;|\bexecute\s*'|\b(?:execute|as|do)\s*\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$|\b(?:begin|then|else|loop|do)\b)\s*$/i;
const GRANT_STATEMENT_LEAD = SQL_STATEMENT_LEAD;

/**
 * Split on commas at paren depth 0. Unlike splitTopLevel it is used on GRANT
 * clauses, which carry no string literals.
 */
function splitCommasTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Index of the first `\b<word>\b` at paren depth 0 in `s`, or -1. */
function topLevelWord(s: string, word: string, from = 0): number {
  const re = new RegExp(String.raw`\b${word}\b`, "gi");
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    let depth = 0;
    for (let i = 0; i < m.index; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
    }
    if (depth === 0) return m.index;
  }
  return -1;
}

/**
 * Every table and column privilege a GRANT statement in `sql` confers on a
 * named table:
 *
 *   tableGrants   'table.grantee'        -> {privilege}   ('all' for ALL [PRIVILEGES])
 *   columnGrants  'table.column.grantee' -> {privilege}
 *
 * WHY THIS EXISTS NEXT TO parseMigration's GRANT CLAIM. parseMigration (shared
 * with audit:schema, deliberately unchanged) reads `GRANT <privs> ON <one table>
 * TO <one role>`. Three shapes the chain really uses defeat it, and each one
 * turned a privilege a migration plainly grants into a false EXCESS_PRIVILEGE:
 *   * several TARGETS — 2780:113 `GRANT SELECT ON public.trip_subgroups,
 *     public.trip_subgroup_members TO authenticated` (and 2794:134);
 *   * several GRANTEES — `... TO anon, authenticated` credited anon only;
 *   * a column-list privilege mixed with the others in one clause.
 * The loop-generated form (2762:113, 2763:150 — `EXECUTE format('GRANT SELECT
 * ON public.%I TO authenticated', t)` inside `FOREACH t IN ARRAY ARRAY[...]`)
 * reaches this function through expandForeachLiteralLoops, which turns it into
 * plain text first.
 *
 * WHAT IT REFUSES TO READ. A GRANT is credited only where a statement can begin
 * (start of text, after `;`, the opening quote of EXECUTE's literal operand, a
 * dollar quote, or BEGIN/THEN/ELSE/LOOP/DO) — so a COMMENT or RAISE text, even
 * one that begins with "GRANT …", is not a grant. A target still carrying a format placeholder (`%I`) is
 * skipped: what it names is decided at run time. REVOKE is not modelled here or
 * anywhere in this model (the model is a union of what the chain grants), so
 * this function can only ever EXPLAIN a privilege the chain's own text grants.
 */
export function extractGrants(sql: string): {
  tableGrants: Map<string, Set<string>>;
  columnGrants: Map<string, Set<string>>;
} {
  const src = blankSqlComments(sql);
  const tableGrants = new Map<string, Set<string>>();
  const columnGrants = new Map<string, Set<string>>();
  const credit = (m: Map<string, Set<string>>, k: string, p: string) => {
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(p);
  };

  const headRe = /\bgrant\s+/gi;
  let h: RegExpExecArray | null;
  while ((h = headRe.exec(src)) !== null) {
    if (!GRANT_STATEMENT_LEAD.test(src.slice(Math.max(0, h.index - 32), h.index))) continue;

    // The statement runs to the first `;` or `'` (the close of an EXECUTE
    // literal) at paren depth 0.
    let i = h.index + h[0].length;
    let depth = 0;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if ((ch === ";" || ch === "'") && depth === 0) break;
    }
    const stmt = src.slice(h.index + h[0].length, i);

    const onAt = topLevelWord(stmt, "on");
    if (onAt === -1) continue;
    const toAt = topLevelWord(stmt, "to", onAt + 2);
    if (toAt === -1) continue;
    const privClause = stmt.slice(0, onAt).trim();
    let targetClause = stmt.slice(onAt + 2, toAt).trim();
    let granteeClause = stmt.slice(toAt + 2);
    if (NON_TABLE_GRANT_TARGET.test(targetClause)) continue;
    // A role grant (`GRANT role TO other`) has no ON and was skipped above.
    targetClause = targetClause.replace(/^table\s+/i, "");
    granteeClause = granteeClause.replace(/\b(?:with\s+grant\s+option|granted\s+by)\b[\s\S]*$/i, "");

    const tables: string[] = [];
    for (const raw of splitCommasTopLevel(targetClause)) {
      const t = raw.trim();
      if (!t || t.includes("%")) continue;
      const m = /^(?:("?)([A-Za-z_][\w$]*)\1\.)?("?)([A-Za-z_][\w$]*)\3$/.exec(t);
      if (!m) continue;
      const schema = (m[2] ?? "public").toLowerCase();
      if (schema !== "public") continue;
      tables.push(m[4]!.toLowerCase());
    }
    const grantees: string[] = [];
    for (const raw of splitCommasTopLevel(granteeClause)) {
      const g = unquote(raw.trim()).toLowerCase();
      if (/^[a-z_][\w$]*$/.test(g)) grantees.push(g);
    }
    if (!tables.length || !grantees.length) continue;

    for (const item of splitCommasTopLevel(privClause)) {
      const pm = /^\s*([A-Za-z]+(?:\s+privileges)?)\s*(?:\(([^)]*)\))?\s*$/i.exec(item);
      if (!pm) continue;
      const priv = /^all\b/i.test(pm[1]!) ? "all" : normalizePrivilege(pm[1]!);
      const cols = pm[2]
        ?.split(",")
        .map((c) => unquote(c.trim()).toLowerCase())
        .filter(Boolean);
      for (const t of tables) {
        for (const g of grantees) {
          if (cols && cols.length) {
            for (const c of cols) credit(columnGrants, `${t}.${c}.${g}`, priv);
          } else {
            credit(tableGrants, `${t}.${g}`, priv);
          }
        }
      }
    }
  }
  return { tableGrants, columnGrants };
}

/** quote_ident() for the names a migration loop splices: plain names pass through. */
function quoteIdentLike(v: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(v) ? v : `"${v.replace(/"/g, '""')}"`;
}

/**
 * Read a single-quoted SQL literal starting at `src[at] === "'"`. Returns its
 * value ('' unescaped) and the index just past the closing quote, or null.
 */
function readQuoted(src: string, at: number): { value: string; end: number } | null {
  if (src[at] !== "'") return null;
  let i = at + 1;
  let v = "";
  while (i < src.length) {
    if (src[i] === "'" && src[i + 1] === "'") {
      v += "'";
      i += 2;
    } else if (src[i] === "'") {
      return { value: v, end: i + 1 };
    } else v += src[i++];
  }
  return null;
}

/**
 * The statements `EXECUTE format('<template>', <args>)` calls in `body` issue
 * when `loopVar` takes each of `values` in turn, written out element-major (the
 * order the loop runs them). The closed shape this interprets, and nothing
 * else, is documented on expandForeachLiteralLoops.
 */
function expandFormatExecutes(body: string, loopVar: string, values: readonly string[]): string[] {
  // perExec[k][n] = the statement the k-th EXECUTE issues on the n-th value
  // (null where it cannot be expanded exactly).
  const perExec: Array<Array<string | null>> = [];
  const execRe = /\bexecute\s+format\s*\(/gi;
  let e: RegExpExecArray | null;
  while ((e = execRe.exec(body)) !== null) {
    const stmts: Array<string | null> = values.map(() => null);
    perExec.push(stmts);
    const argsBody = balancedParenBody(body, e.index + e[0].length - 1);
    if (argsBody === null) continue;
    const args = splitTopLevel(argsBody).map((a) => a.trim());
    const tpl = readQuoted(args[0] ?? "", 0);
    if (!tpl || tpl.end !== (args[0] ?? "").length) continue;
    if (/%\d+\$/.test(tpl.value)) continue;

    const evalArg = (expr: string, v: string): string | null => {
      let acc = "";
      for (const piece of expr.split("||").map((p) => p.trim())) {
        if (piece.toLowerCase() === loopVar) acc += v;
        else {
          const q = readQuoted(piece, 0);
          if (!q || q.end !== piece.length) return null;
          acc += q.value;
        }
      }
      return acc;
    };

    values.forEach((v, n) => {
      const argVals: string[] = [];
      for (const a of args.slice(1)) {
        const r = evalArg(a, v);
        if (r === null) return;
        argVals.push(r);
      }
      let k = 0;
      let stmt = "";
      for (let j = 0; j < tpl.value.length; j++) {
        const ch = tpl.value[j];
        if (ch !== "%") {
          stmt += ch;
          continue;
        }
        const spec = tpl.value[++j];
        if (spec === "%") stmt += "%";
        else if ((spec === "I" || spec === "s" || spec === "L") && k < argVals.length) {
          const a = argVals[k++]!;
          stmt +=
            spec === "I" ? quoteIdentLike(a) : spec === "L" ? `'${a.replace(/'/g, "''")}'` : a;
        } else {
          return; // an unsupported placeholder, or more placeholders than arguments
        }
      }
      stmts[n] = `${stmt};`;
    });
  }
  const out: string[] = [];
  values.forEach((_, n) => {
    for (const stmts of perExec) if (stmts[n] !== null) out.push(stmts[n]!);
  });
  return out;
}

/**
 * The statements a migration issues through `EXECUTE format('<template>',
 * <args>)` with a variable whose value(s) the text fixes, written out as plain
 * SQL. Two shapes:
 *
 *   1. `FOREACH v IN ARRAY ARRAY['a','b',…] LOOP … END LOOP` — one copy of the
 *      body's statements per array element, in order;
 *   2. a DO block whose DECLARE section fixes `v text := '<literal>'` and whose
 *      body never assigns `v` again — one copy, for that value.
 *
 * WHY. The chain creates objects this way and no text scan can see them:
 * 2762/2763 enable RLS, create the `<t>_select_crew` policy and GRANT SELECT to
 * authenticated on seven trip tables inside one such loop; 2130, 3002 and their
 * siblings create the `<t>_no_update_delete`, `<t>_no_truncate` and
 * `<t>_contributor_token` triggers the same way, and 2276 does it for a single
 * table through `DECLARE t text := 'intel_presence_verifications'`. Every one
 * of those objects was reported live-but-unexplained on every run although a
 * migration plainly declares it.
 *
 * EXACT OR NOTHING. This interprets one closed shape and nothing else:
 *   * the array must be a literal list of single-quoted strings (or the one
 *     DECLAREd literal, never reassigned);
 *   * the template must be a single-quoted literal;
 *   * every argument must be the variable, a string literal, or a `||`
 *     concatenation of those (`t || '_select_crew'`, `'public.' || t`);
 *   * placeholders %I, %s, %L and %% only — a positional `%1$I` is refused.
 * Anything else (a temp-table driven loop such as 3390's, an argument computed
 * by a query, a placeholder fed by another variable) is skipped, so the object
 * stays unexplained rather than guessed at. Conditionals inside the body are
 * not evaluated: the expansion claims what each iteration COULD issue, which is
 * the same stance parseMigration takes for statements inside DO blocks.
 */
export function expandForeachLiteralLoops(sql: string): string {
  const src = blankSqlComments(sql);
  const out: string[] = [];

  // ── 1. FOREACH over a literal array ────────────────────────────────────────
  const headRe = /\bforeach\s+([A-Za-z_]\w*)\s+in\s+array\s+array\s*\[/gi;
  let h: RegExpExecArray | null;
  while ((h = headRe.exec(src)) !== null) {
    const loopVar = h[1]!.toLowerCase();
    // The literal element list.
    const values: string[] = [];
    let i = h.index + h[0].length;
    let ok = true;
    for (;;) {
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] === "]") {
        i++;
        break;
      }
      const q = readQuoted(src, i);
      if (!q) {
        ok = false;
        break;
      }
      values.push(q.value);
      i = q.end;
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] === ",") i++;
    }
    if (!ok || !values.length) continue;
    const loopKw = /^\s*loop\b/i.exec(src.slice(i));
    if (!loopKw) continue;
    const bodyStart = i + loopKw[0].length;

    // The body, to the END LOOP that closes this loop (nested loops counted).
    const wordRe = /\b(end\s+loop|loop)\b/gi;
    wordRe.lastIndex = bodyStart;
    let depth = 1;
    let bodyEnd = -1;
    let w: RegExpExecArray | null;
    while ((w = wordRe.exec(src)) !== null) {
      if (/^end/i.test(w[1]!)) {
        if (--depth === 0) {
          bodyEnd = w.index;
          break;
        }
      } else depth++;
    }
    if (bodyEnd === -1) continue;
    out.push(...expandFormatExecutes(src.slice(bodyStart, bodyEnd), loopVar, values));
  }

  // ── 2. A DO block's DECLAREd literal, never reassigned ─────────────────────
  const doRe = /\bdo\s+(\$[A-Za-z_]*\$)/gi;
  let d: RegExpExecArray | null;
  while ((d = doRe.exec(src)) !== null) {
    const tag = d[1]!;
    const open = d.index + d[0].length;
    const close = src.indexOf(tag, open);
    if (close === -1) continue;
    doRe.lastIndex = close + tag.length;
    const block = src.slice(open, close);
    const decl = /^\s*declare\b([\s\S]*?)\bbegin\b/i.exec(block);
    if (!decl) continue;
    const body = block.slice(decl[0].length);
    for (const m of decl[1]!.matchAll(
      /\b([A-Za-z_]\w*)\s+(?:constant\s+)?text\s*(?::=|=|\bdefault\b)\s*'((?:[^']|'')*)'\s*;/gi,
    )) {
      const v = m[1]!.toLowerCase();
      const reassigned = new RegExp(
        String.raw`\b${v}\s*:=|\binto\s+(?:strict\s+)?${v}\b|\bfor(?:each)?\s+${v}\b`,
        "i",
      );
      if (reassigned.test(body)) continue;
      out.push(...expandFormatExecutes(body, v, [m[2]!.replace(/''/g, "'")]));
    }
  }

  return out.join("\n");
}

/** 'enumname.value' (lowercased) from CREATE TYPE ... AS ENUM ( 'a', 'b', … ).
 *  parseMigration reads only ALTER TYPE ADD VALUE; pg_dump emits enum labels
 *  inside the CREATE TYPE body, so without this the model carries zero enum
 *  values and flags every live label as unexplained. */
export function extractEnumValues(sql: string): Set<string> {
  const src = blankSqlComments(sql);
  const out = new Set<string>();
  const re =
    /create\s+type\s+(?:[\w"]+\.)?"?([a-z_][a-z0-9_]*)"?\s+as\s+enum\s*\(([^)]*)\)/gi;
  for (const m of src.matchAll(re)) {
    const name = m[1].toLowerCase();
    for (const v of m[2].matchAll(/'([^']*)'/g)) out.add(`${name}.${v[1]}`.toLowerCase());
  }
  return out;
}

/** Index names Postgres auto-creates for PRIMARY KEY / UNIQUE constraints — the
 *  backing index takes the constraint's name. pg_dump emits these as ADD
 *  CONSTRAINT (not CREATE INDEX), but pg_indexes lists them live, so without
 *  this every PK/UNIQUE index reads as UNEXPLAINED_LIVE. */
export function extractConstraintBackedIndexes(sql: string): Set<string> {
  const src = blankSqlComments(sql);
  const out = new Set<string>();
  const re =
    /add\s+constraint\s+(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s+(?:primary\s+key|unique)\b/gi;
  for (const m of src.matchAll(re)) out.add((m[1] ?? m[2]).toLowerCase());
  // The same index exists for a PK/UNIQUE declared INLINE, named or not — a
  // hand-written migration declares most of them that way, and pg_indexes lists
  // every one of them live.
  for (const ix of deriveImplicitConstraints(src).indexes) out.add(ix);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODEL BUILDER (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The first migration filename prefix whose objects the 2026-08-19 baseline
 * does NOT contain. Every file that sorts below it is already reflected in the
 * dump; every file at or above it post-dates the dump. The same boundary is
 * `FROM="${LOCAL_DB_FROM:-2093}"` in scripts/local-db/up.sh and
 * CHAIN_START_PREFIX in scripts/src/beta-db-core.ts; auditLiveVsCanonical.test.ts
 * holds this constant equal to up.sh's default.
 */
export const CHAIN_START_PREFIX = "2093_";

/** Split sorted migration filenames into the pre-baseline history and the post-baseline chain. */
export function partitionByChainStart(filenames: readonly string[]): {
  historical: string[];
  canonical: string[];
} {
  const sorted = [...filenames].sort();
  return {
    historical: sorted.filter((f) => f < CHAIN_START_PREFIX),
    canonical: sorted.filter((f) => f >= CHAIN_START_PREFIX),
  };
}

export function buildModel(args: {
  baselineSql: string;
  baselineTables: Map<
    string,
    { table: string; rlsEnabled: boolean; policyCount: number }
  >;
  /** Files AT or AFTER CHAIN_START_PREFIX, in apply order. */
  canonicalSqls: string[];
  /**
   * Files BEFORE CHAIN_START_PREFIX, in filename order. Read FIRST, before the
   * baseline, so that for the one inventory where a later declaration replaces
   * an earlier one — the policy predicates, a last-wins map — the baseline's
   * production-captured text is never overwritten by the stale text of a file
   * the baseline already contains. Optional so a fixture can omit it.
   */
  historicalSqls?: string[];
  ledger: ReadonlyArray<ExplainedEntry>;
  parseMig: ParseMig;
}): Model {
  const { baselineSql, baselineTables, canonicalSqls, ledger, parseMig } = args;
  const historicalSqls = args.historicalSqls ?? [];
  // Comments blanked ONCE, here, and every reader below sees the blanked text —
  // the injected forward parser included. parseMigration is shared with
  // audit:schema and is not changed; only what THIS model feeds it is. Offsets
  // are preserved (comment bytes become spaces), so index-based scans are
  // unaffected. See blankSqlComments for the apostrophe-in-a-comment failure
  // this closes.
  //
  // ORDER: history, then the baseline, then the chain. Every inventory but one
  // is a set, where order changes nothing. The exception is `policies`, keyed by
  // name and LAST-WINS, and reading every file in plain filename order after the
  // baseline (as this did once the >= "2100" band was removed) let 0026, 0080,
  // 2033 and the rest of the pre-baseline history overwrite the baseline's
  // predicates with the text they had BEFORE the later rewrites the baseline
  // captured — e.g. highlights_insert read `auth.uid() = user_id` from 0026
  // while production and the dump say `owner_id`. Each such policy was reported
  // as POLICY_PREDICATE_DRIFT on every run.
  //
  // Each file is followed by the plain-text expansion of its FOREACH-literal
  // loops (expandForeachLiteralLoops), so loop-issued GRANTs, policies, RLS
  // switches and triggers are read by the same parsers as written-out ones.
  // The expansion is a SEPARATE text, not appended to its file: a scanner that
  // starts inside a format() template of the original (`'CREATE POLICY %I ON
  // …'`) reads to the next unquoted semicolon, and in a concatenation that
  // swallowed the first expanded statements whole.
  const allSqls = [...historicalSqls, baselineSql, ...canonicalSqls]
    .map(blankSqlComments)
    .flatMap((sql) => {
      const expanded = expandForeachLiteralLoops(sql);
      return expanded ? [sql, expanded] : [sql];
    });

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
    const grants = extractGrants(sql);
    for (const [k, privs] of grants.columnGrants) {
      if (!columnGrants.has(k)) columnGrants.set(k, new Set());
      for (const p of privs) columnGrants.get(k)!.add(p);
    }
    // Table grants parseMigration cannot read (several targets, several
    // grantees, loop-expanded); a union with its own claims above.
    for (const [k, privs] of grants.tableGrants) {
      if (!tableGrants.has(k)) tableGrants.set(k, new Set());
      for (const p of privs) tableGrants.get(k)!.add(p);
    }
    for (const c of extractConstraints(sql)) constraints.add(c);
    for (const e of extractExtensions(sql)) extensions.add(e);
    for (const ev of extractEnumValues(sql)) enumValues.add(ev);
    for (const ix of extractConstraintBackedIndexes(sql)) indexes.add(ix);
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

// Grant excess is only a signal for the UNTRUSTED client roles. role_*_grants
// list the table OWNER (postgres) and Supabase's internal roles with full
// privileges on every object; pg_dump never emits owner/internal grants, so the
// model cannot carry them and every one would read as false "excess" (~20k of
// them). service_role bypasses RLS entirely, so grants to it add no exposure.
// The mobile app ships the anon key, so anon / authenticated / PUBLIC are the
// surfaces where an unexplained grant is a real finding.
const AUDITED_GRANT_ROLES = new Set(["anon", "authenticated", "public"]);

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
  // View / matview columns appear in information_schema.columns, but the model
  // (CREATE TABLE only) carries none — a view's columns follow from its SELECT
  // and are explained by the view relation itself. Audit base-table columns.
  const viewTables = new Set<string>();
  for (const [name, kind] of live.relations) {
    if (kind === "v" || kind === "m") viewTables.add(name);
  }
  const liveBaseColumns = new Set(
    [...live.columns].filter(
      (col) => !viewTables.has(col.slice(0, col.lastIndexOf("."))),
    ),
  );

  const liveByKind: Record<string, Set<string>> = {
    relation: new Set(live.relations.keys()),
    column: liveBaseColumns,
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
    if (!AUDITED_GRANT_ROLES.has(k.slice(k.lastIndexOf(".") + 1))) continue;
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
    if (!AUDITED_GRANT_ROLES.has(grantee)) continue;
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
