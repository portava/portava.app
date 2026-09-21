/**
 * The mechanics behind `check:layover-cutover`: can migration 2411 be applied to
 * PRODUCTION right now, and if not, exactly what is missing?
 *
 * Kept apart from the CLI so every rule is a pure function over explicit inputs
 * and the mutation suite can violate one condition at a time.
 *
 * ── WHY A SQL COMMENT STRIPPER LIVES HERE ────────────────────────────────────
 * Five checkers in this tree shipped the same bug: they answered a question
 * about CODE by matching RAW FILE TEXT, and matched inside a comment.
 * `scripts/lib/stripComments.ts` is the shared cure for TypeScript. SQL has its
 * own comment forms (a `--` line comment and a slash-star block comment) and its
 * own trap — `$$ … $$` dollar-quoted bodies, which is where every DO block in
 * this repo keeps its real DDL AND its prose. `canonicalSchema.stripSqlComments`
 * is a two-regex approximation that
 * cannot see either dollar quotes or string literals; a `--` inside a literal
 * would silently eat the rest of that line of real SQL.
 *
 * So this module carries a scanning stripper that knows about `'…'`, `"…"`,
 * `$tag$…$tag$` and nested block comments, and RECURSES into dollar-quoted
 * bodies — because in a migration those bodies are code, not data, and their
 * comments must be removed like any other.
 *
 * Two questions in this file are deliberately asked of the RAW text instead:
 * "is the rollback path written down where a reader will find it" and "does the
 * migration publish a countable predicate". Those are questions ABOUT the prose,
 * so prose is the correct place to look. Every other rule reads stripped SQL.
 */

// ── SQL lexing ───────────────────────────────────────────────────────────────

const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Remove line and block comments, leaving string literals and quoted
 * identifiers intact. Dollar-quoted bodies keep their delimiters but are
 * stripped recursively: `DO $$ … $$` is code.
 *
 * Newlines are preserved so a caller can still report a line number.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];

    if (c === "$") {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          // Unterminated — treat the remainder as body and strip it.
          out += tag + stripSqlComments(sql.slice(i + tag.length));
          return out;
        }
        out += tag + stripSqlComments(sql.slice(i + tag.length, end)) + tag;
        i = end + tag.length;
        continue;
      }
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) { j += 1; break; }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    if (c === "-" && d === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue; // the newline itself is emitted on the next turn
    }

    if (c === "/" && d === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth += 1; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth -= 1; i += 2; continue; }
        if (sql[i] === "\n") out += "\n";
        i += 1;
      }
      out += " ";
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

/** Split on top-level `;`, ignoring separators inside literals and `$$` bodies. */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "$") {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) { j += 1; break; }
        j += 1;
      }
      i = j;
      continue;
    }
    if (c === ";") {
      const s = sql.slice(start, i).trim();
      if (s) out.push(s);
      start = i + 1;
    }
    i += 1;
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

const MUTATING = /^(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|TRUNCATE|COMMENT|REINDEX|REFRESH)\b/i;

/**
 * Does this statement write?
 *
 * `WITH … UPDATE` counts. So does a `DO $$ … $$` block whose BODY writes — half
 * the DDL in this repo is conditional and lives inside one, and a rule that
 * reads `DO` as "not a write" would classify those migrations as inert. A DO
 * block that only SELECTs and RAISEs (an assertion-only migration) is correctly
 * not a write.
 */
export function isMutatingStatement(stmt: string): boolean {
  const s = stmt.trim();
  if (MUTATING.test(s)) return true;
  if (/^WITH\b/i.test(s) && /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/i.test(s)) return true;
  if (/^DO\b/i.test(s)) {
    const body = expandProceduralBody(s);
    if (body.length === 1 && body[0] === s) return false;
    return body.some((sub) => {
      const t = sub.replace(/^\s*(?:IF|ELSIF|ELSE|THEN|BEGIN|END|LOOP|EXECUTE)\b\s*/i, "").trim();
      return MUTATING.test(t) || MUTATING.test(sub.trim());
    });
  }
  return false;
}

// ── object extraction ────────────────────────────────────────────────────────

export interface SqlObject {
  kind: "relation" | "column" | "function" | "enum";
  /** `layover_recommendations`, `layover_recommendations.rec_key`, `fn()`… */
  name: string;
  table?: string;
  column?: string;
}

const SQL_NON_COLUMNS = new Set([
  "true", "false", "null", "and", "or", "not", "is", "in", "exists", "select", "from", "where",
  "case", "when", "then", "else", "end", "count", "left", "right", "trim", "both", "lower", "upper",
  "coalesce", "regexp_replace", "distinct", "group", "order", "by", "having", "limit", "offset",
  "into", "values", "set", "as", "on", "using", "all", "any", "some", "filter", "over", "text",
  "integer", "boolean", "loop", "begin", "if", "declare", "return", "raise", "notice", "exception",
  "g", "public", "with", "union", "join", "inner", "outer", "cross", "full", "asc", "desc",
]);

const ALIAS_STOPWORDS = new Set([
  "where", "set", "on", "using", "group", "order", "limit", "having", "with", "select", "and",
  "or", "inner", "left", "right", "full", "cross", "join", "union", "returning", "for", "into",
  "values", "as", "from", "loop", "then", "else", "end", "is", "not", "filter", "offset",
]);

const SCHEMAS = new Set(["public", "information_schema", "pg_catalog", "pg_temp", "auth", "storage", "extensions"]);

export interface Extraction {
  objects: SqlObject[];
  /** Relations named with an explicit `public.` qualifier. */
  relations: Set<string>;
  /** table -> columns */
  columns: Map<string, Set<string>>;
  /** Function names called with an explicit schema qualifier or a repo-declared name. */
  calls: Set<string>;
  /** `'label'::type` pairs. */
  enumCasts: Array<{ type: string; label: string }>;
  statements: string[];
  mutatingStatements: string[];
}

/**
 * Pull every schema object a migration names out of its stripped SQL.
 *
 * OVER-INCLUSION IS NOT FREE HERE. A dependency check asks "does this object
 * exist?", so an identifier wrongly read as a column produces a FALSE FAILURE,
 * not a missed catch. The extraction is therefore alias-driven rather than
 * greedy: `alias.column` resolves through the relation the alias was bound to,
 * and bare identifiers are only attributed when a statement names exactly one
 * `public.` relation, and only in comparison or SET position.
 */
/**
 * A `DO $$ … $$` block is ONE statement to the parser and a whole program to
 * Postgres. Its body is split out so a rule that only makes sense over a single
 * statement — "this SELECT names exactly one table, so a bare identifier in it
 * is that table's column" — is not defeated by the block as a whole naming
 * three. Without this, a DO block's PL/pgSQL locals (`IF colliding <> 0`) get
 * attributed as columns of whichever table the block happens to mention.
 */
/**
 * Blank the CONTENTS of every string literal, keeping the quotes and the length.
 *
 * The comment stripper deliberately preserves literals — a `--` inside one is
 * data, not a comment. But an identifier scan must not read them: 2411's own
 * `RAISE EXCEPTION 'layover_stable_recommendation_ids_enabled is already TRUE.'`
 * otherwise parses as a column named after the flag, sitting in `IS` position.
 * That is the same "matched inside prose" defect stripComments exists to stop,
 * one quoting level further in.
 */
export function maskSqlLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) { j += 1; break; }
        j += 1;
      }
      out += c + sql.slice(i + 1, Math.max(i + 1, j - 1)).replace(/[^\n]/g, " ") + (j - 1 > i ? sql[j - 1] : "");
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export function expandProceduralBody(stmt: string): string[] {
  const m = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(stmt);
  if (!m) return [stmt];
  const tag = m[0];
  const start = stmt.indexOf(tag);
  const end = stmt.indexOf(tag, start + tag.length);
  if (end === -1) return [stmt];
  const body = stmt.slice(start + tag.length, end);
  const parts = splitSqlStatements(body);
  return parts.length > 0 ? parts : [stmt];
}

/** Names bound by a PL/pgSQL `DECLARE` section — locals, never columns. */
export function declaredLocals(stmt: string): Set<string> {
  const out = new Set<string>();
  const m = /\bDECLARE\b([\s\S]*?)\bBEGIN\b/i.exec(stmt);
  if (!m) return out;
  for (const line of m[1]!.split(";")) {
    const d = /^\s*([a-z_][a-z0-9_]*)\s+/i.exec(line);
    if (d) out.add(d[1]!.toLowerCase());
  }
  return out;
}

export function extractSqlObjects(strippedSql: string, declaredFunctions: ReadonlySet<string>): Extraction {
  const statements = splitSqlStatements(strippedSql);
  const units = statements.flatMap(expandProceduralBody);
  const relations = new Set<string>();
  const columns = new Map<string, Set<string>>();
  const calls = new Set<string>();
  const enumCasts: Array<{ type: string; label: string }> = [];

  const addColumn = (t: string, c: string) => {
    if (!columns.has(t)) columns.set(t, new Set());
    columns.get(t)!.add(c);
  };

  for (const stmt of units) {
    // CTE names are relations that exist only inside this statement.
    const ctes = new Set<string>();
    for (const m of stmt.matchAll(/(?:\bWITH\b|,)\s*([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)) ctes.add(m[1]!.toLowerCase());

    const masked = maskSqlLiterals(stmt);
    const locals = declaredLocals(masked);
    const stmtRelations = new Set<string>();
    for (const m of masked.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)/gi)) {
      const r = m[1]!.toLowerCase();
      relations.add(r);
      stmtRelations.add(r);
    }
    for (const m of stmt.matchAll(/to_regclass\s*\(\s*'public\.([a-z_][a-z0-9_]*)'\s*\)/gi)) {
      relations.add(m[1]!.toLowerCase());
    }

    // alias -> relation (only for public-qualified relations; CTE aliases are dropped)
    const alias = new Map<string, string>();
    for (const m of masked.matchAll(
      /\b(?:FROM|JOIN|UPDATE|INTO)\s+(public\.)?([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/gi,
    )) {
      const qualified = Boolean(m[1]);
      const rel = m[2]!.toLowerCase();
      const a = m[3]!.toLowerCase();
      if (ALIAS_STOPWORDS.has(a)) continue;
      if (!qualified && !stmtRelations.has(rel)) continue; // a CTE or a catalog table
      if (ctes.has(rel)) continue;
      alias.set(a, rel);
    }
    for (const r of stmtRelations) alias.set(r, r);

    // qualified columns
    for (const m of masked.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
      const lhs = m[1]!.toLowerCase();
      const col = m[2]!.toLowerCase();
      if (SCHEMAS.has(lhs)) continue;
      if (ctes.has(lhs)) continue;
      const rel = alias.get(lhs);
      if (!rel) continue;
      addColumn(rel, col);
    }

    // information_schema probes name their target as literals
    const tn = /table_name\s*=\s*'([a-z_][a-z0-9_]*)'/i.exec(stmt);
    if (tn) {
      for (const m of stmt.matchAll(/column_name\s*=\s*'([a-z_][a-z0-9_]*)'/gi)) {
        relations.add(tn[1]!.toLowerCase());
        addColumn(tn[1]!.toLowerCase(), m[1]!.toLowerCase());
      }
    }

    // UPDATE … SET col = : the target table's column
    const target = /\bUPDATE\s+(?:public\.)?([a-z_][a-z0-9_]*)/i.exec(masked);
    if (target) {
      const t = target[1]!.toLowerCase();
      if (!ctes.has(t)) {
        for (const m of masked.matchAll(/\bSET\s+([a-z_][a-z0-9_]*)\s*=/gi)) addColumn(t, m[1]!.toLowerCase());
      }
    }

    // bare identifiers in comparison position, only when the statement is
    // unambiguously about ONE public relation
    if (stmtRelations.size === 1) {
      const only = [...stmtRelations][0]!;
      for (const m of masked.matchAll(/(?:^|[\s(,])([a-z_][a-z0-9_]*)\s*(?:=|<>|!=|<=|>=|<|>|\bIS\b)/gi)) {
        const id = m[1]!.toLowerCase();
        if (SQL_NON_COLUMNS.has(id)) continue;
        if (locals.has(id)) continue;
        addColumn(only, id);
      }
    }

    // function calls: schema-qualified, or a name this repo's migrations declare
    for (const m of masked.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)\s*\(/gi)) calls.add(m[1]!.toLowerCase());
    for (const m of masked.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
      const fn = m[1]!.toLowerCase();
      if (declaredFunctions.has(fn)) calls.add(fn);
    }

    for (const m of stmt.matchAll(/'([^']*)'\s*::\s*(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      enumCasts.push({ label: m[1]!, type: m[2]!.toLowerCase() });
    }
  }

  const objects: SqlObject[] = [];
  for (const r of [...relations].sort()) objects.push({ kind: "relation", name: r });
  for (const t of [...columns.keys()].sort()) {
    for (const c of [...columns.get(t)!].sort()) {
      objects.push({ kind: "column", name: `${t}.${c}`, table: t, column: c });
    }
  }
  for (const f of [...calls].sort()) objects.push({ kind: "function", name: `${f}()` });

  return {
    objects,
    relations,
    columns,
    calls,
    enumCasts,
    statements,
    mutatingStatements: statements.filter(isMutatingStatement),
  };
}

// ── what a corpus of migrations creates ──────────────────────────────────────

export interface CreatedObjects {
  tables: Set<string>;
  indexes: Set<string>;
  /** table -> columns added by ADD COLUMN or named in a CREATE TABLE body */
  columns: Map<string, Set<string>>;
  functions: Set<string>;
  types: Set<string>;
}

export function emptyCreated(): CreatedObjects {
  return { tables: new Set(), indexes: new Set(), columns: new Map(), functions: new Set(), types: new Set() };
}

/** Accumulate every object a stripped SQL text creates into `into`. */
export function collectCreatedObjects(strippedSql: string, into: CreatedObjects): void {
  const add = (t: string, c: string) => {
    const k = t.toLowerCase();
    if (!into.columns.has(k)) into.columns.set(k, new Set());
    into.columns.get(k)!.add(c.toLowerCase());
  };

  for (const m of strippedSql.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi,
  )) {
    const table = m[1]!.toLowerCase();
    into.tables.add(table);
    // Column names are the first identifier on each line of the body.
    const open = strippedSql.indexOf("(", m.index! + m[0].length - 1);
    let depth = 0;
    let end = open;
    for (let i = open; i < strippedSql.length; i += 1) {
      if (strippedSql[i] === "(") depth += 1;
      else if (strippedSql[i] === ")") { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    const body = strippedSql.slice(open + 1, end);
    let d = 0;
    let cur = "";
    const parts: string[] = [];
    for (const ch of body) {
      if (ch === "(") d += 1;
      if (ch === ")") d -= 1;
      if (ch === "," && d === 0) { parts.push(cur); cur = ""; continue; }
      cur += ch;
    }
    parts.push(cur);
    for (const p of parts) {
      const c = /^\s*"?([a-z_][a-z0-9_]*)"?\s+/i.exec(p);
      if (!c) continue;
      const name = c[1]!.toLowerCase();
      if (["constraint", "primary", "unique", "foreign", "check", "exclude", "like"].includes(name)) continue;
      add(table, name);
    }
  }

  for (const m of strippedSql.matchAll(
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?([\s\S]*?);/gi,
  )) {
    const table = m[1]!.toLowerCase();
    for (const c of m[2]!.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      add(table, c[1]!);
    }
  }

  for (const m of strippedSql.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
  )) {
    into.indexes.add(m[1]!.toLowerCase());
  }

  for (const m of strippedSql.matchAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi,
  )) {
    into.functions.add(m[1]!.toLowerCase());
  }

  for (const m of strippedSql.matchAll(/CREATE\s+TYPE\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    into.types.add(m[1]!.toLowerCase());
  }
}
