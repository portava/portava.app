/**
 * schemaFacts — the MEASURED half of the deletion dependency graph.
 *
 * Everything in this file is read out of a schema-only pg_dump
 * (baseline/20260819_baseline_structure.sql). Nothing here is a judgement about
 * what SHOULD happen to a table on account deletion; it is what the database
 * actually declares today. The judgements live in `signalRules.ts` (rules
 * applied mechanically) and `handNotes.ts` (per-table, hand-written, and
 * labelled as such). Keeping the three apart is the whole point: a reader must
 * be able to tell a measurement from a guess without trusting the author.
 *
 * WHAT IT CANNOT SEE, stated rather than implied:
 *   * post-baseline tables — the dump is the 2026-08-19 snapshot. The intel_*,
 *     journey_* and Passport/Wall families created since are invisible here and
 *     carry `inBaseline: false` in the graph.
 *   * anything the database does not declare: application-level authorisation,
 *     PostgREST grants that Supabase issues identically to every table, and
 *     views. A table with no RLS policy is reported as "no policy", which is a
 *     fact about the schema, not a claim that reading it is safe.
 *
 * Pure functions over the dump TEXT so they can be unit-tested against fixture
 * strings rather than against the 38k-line committed file.
 */

export interface ForeignKeyFact {
  /** The table the constraint is declared ON. */
  table: string;
  /** Columns of `table` in the constraint, in declaration order. */
  columns: string[];
  /** Referenced schema-qualified table, e.g. "public.profiles" / "auth.users". */
  references: string;
  /** Referenced columns. */
  referencedColumns: string[];
  /** Declared referential action, uppercased ("CASCADE" | "SET NULL" | …). */
  onDelete: "CASCADE" | "SET NULL" | "SET DEFAULT" | "RESTRICT" | "NO ACTION";
  constraint: string;
}

export interface PolicyFact {
  table: string;
  name: string;
  /** ALL when the statement names no FOR clause, exactly as Postgres reads it. */
  command: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  /** Roles from a TO clause; empty means PUBLIC (all roles). */
  roles: string[];
  /** Raw USING expression, or null when the statement has none. */
  using: string | null;
  /** Raw WITH CHECK expression, or null. */
  withCheck: string | null;
}

export interface ColumnFact {
  name: string;
  /** Type text as dumped, e.g. "uuid", "text", "timestamp with time zone". */
  type: string;
}

export interface TableFacts {
  table: string;
  columns: ColumnFact[];
  rlsEnabled: boolean;
  policies: PolicyFact[];
  foreignKeys: ForeignKeyFact[];
  /** Constraints on OTHER tables that point AT this one. */
  referencedBy: ForeignKeyFact[];
  /** Trigger names attached to this table (append-only guards live here). */
  triggers: string[];
}

const CREATE_TABLE_RE = /^CREATE TABLE public\.([A-Za-z0-9_]+) \(([\s\S]*?)^\);/gm;

/** Column lines look like `    name type ... ,` inside the CREATE TABLE body. */
function parseColumns(body: string): ColumnFact[] {
  const out: ColumnFact[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s{4}([a-z_][a-z0-9_]*)\s+(.+?),?\s*$/.exec(line);
    if (!m) continue;
    // Table-level constraints (CONSTRAINT …, PRIMARY KEY (…)) are not columns.
    if (/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)$/i.test(m[1])) continue;
    out.push({ name: m[1], type: m[2].trim() });
  }
  return out;
}

/**
 * Split a dump into statements. pg_dump writes one statement per (possibly
 * wrapped) run of lines terminated by a line ending in `;`, with comment
 * banners between them. Comment lines are dropped so a `--` banner mentioning a
 * table name can never be mistaken for a statement about it.
 */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  for (const raw of sql.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("--")) continue;
    if (line.trim() === "" && buf.length === 0) continue;
    buf.push(line);
    if (line.endsWith(";")) {
      out.push(buf.join("\n").trim());
      buf = [];
    }
  }
  if (buf.length > 0) out.push(buf.join("\n").trim());
  return out;
}

const FK_RE =
  /ALTER TABLE (?:ONLY )?public\.([A-Za-z0-9_]+)[\s\S]*?ADD CONSTRAINT ([A-Za-z0-9_]+) FOREIGN KEY \(([^)]+)\) REFERENCES ([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\(([^)]+)\)([^;]*);/;

const POLICY_RE =
  /^CREATE POLICY\s+(?:"([^"]+)"|([A-Za-z0-9_]+))\s+ON public\.([A-Za-z0-9_]+)([\s\S]*);$/;

const TRIGGER_RE = /^CREATE(?: OR REPLACE)?(?: CONSTRAINT)? TRIGGER ([A-Za-z0-9_]+)[\s\S]*? ON public\.([A-Za-z0-9_]+)/;

function parseOnDelete(tail: string): ForeignKeyFact["onDelete"] {
  const m = /ON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/i.exec(tail);
  return (m ? (m[1].toUpperCase() as ForeignKeyFact["onDelete"]) : "NO ACTION");
}

function parseRoles(tail: string): string[] {
  const m = /\bTO ((?:[A-Za-z0-9_]+)(?:\s*,\s*[A-Za-z0-9_]+)*)\s*(?:USING|WITH CHECK|;|$)/.exec(tail);
  if (!m) return [];
  return m[1].split(",").map((r) => r.trim()).filter(Boolean);
}

/** Balanced-paren extraction of `USING (...)` / `WITH CHECK (...)`. */
function parseParenClause(tail: string, keyword: "USING" | "WITH CHECK"): string | null {
  const idx = tail.indexOf(keyword + " (");
  if (idx === -1) return null;
  let depth = 0;
  const start = idx + keyword.length + 1;
  for (let i = start; i < tail.length; i += 1) {
    if (tail[i] === "(") depth += 1;
    else if (tail[i] === ")") {
      depth -= 1;
      if (depth === 0) return tail.slice(start, i + 1);
    }
  }
  return null;
}

export function parseSchemaFacts(sql: string): Map<string, TableFacts> {
  const tables = new Map<string, TableFacts>();

  for (const m of sql.matchAll(CREATE_TABLE_RE)) {
    const [, name, body] = m;
    if (tables.has(name)) continue;
    tables.set(name, {
      table: name,
      columns: parseColumns(body),
      rlsEnabled: false,
      policies: [],
      foreignKeys: [],
      referencedBy: [],
      triggers: [],
    });
  }

  for (const stmt of statements(sql)) {
    const rls = /^ALTER TABLE public\.([A-Za-z0-9_]+) ENABLE ROW LEVEL SECURITY;$/.exec(stmt);
    if (rls) {
      const t = tables.get(rls[1]);
      if (t) t.rlsEnabled = true;
      continue;
    }

    if (stmt.startsWith("ALTER TABLE")) {
      const fk = FK_RE.exec(stmt);
      if (fk) {
        const [, table, constraint, cols, refSchema, refTable, refCols, tail] = fk;
        const fact: ForeignKeyFact = {
          table,
          constraint,
          columns: cols.split(",").map((c) => c.trim()),
          references: `${refSchema}.${refTable}`,
          referencedColumns: refCols.split(",").map((c) => c.trim()),
          onDelete: parseOnDelete(tail),
        };
        tables.get(table)?.foreignKeys.push(fact);
        if (refSchema === "public") tables.get(refTable)?.referencedBy.push(fact);
      }
      continue;
    }

    if (stmt.startsWith("CREATE POLICY")) {
      const p = POLICY_RE.exec(stmt);
      if (!p) continue;
      const [, quoted, bare, table, tail] = p;
      const cmd = /\bFOR (ALL|SELECT|INSERT|UPDATE|DELETE)\b/.exec(tail);
      tables.get(table)?.policies.push({
        table,
        name: quoted ?? bare,
        command: (cmd ? cmd[1] : "ALL") as PolicyFact["command"],
        roles: parseRoles(tail),
        using: parseParenClause(tail, "USING"),
        withCheck: parseParenClause(tail, "WITH CHECK"),
      });
      continue;
    }

    if (stmt.startsWith("CREATE TRIGGER") || stmt.startsWith("CREATE CONSTRAINT TRIGGER")) {
      const t = TRIGGER_RE.exec(stmt);
      if (t) tables.get(t[2])?.triggers.push(t[1]);
    }
  }

  return tables;
}
