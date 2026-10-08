/**
 * clientTableAclDecisions — does every table the post-baseline chain creates
 * carry an explicit decision about what `anon` and `authenticated` may do to it?
 *
 * PURE: no filesystem, no network, no environment. The caller hands it file
 * names and their SQL; checkClientPrivilegeBoundary.ts (rule 4) is the CLI and
 * src/test/clientGrantExcessBoundary.test.ts drives it with fixtures.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * Supabase's `ALTER DEFAULT PRIVILEGES` hands `anon` and `authenticated` the
 * full privilege set on every table created in `public`; 2490 took back the
 * four RLS cannot police and left SELECT, INSERT, UPDATE and DELETE. So a
 * migration that runs `CREATE TABLE` and nothing else gives the ANONYMOUS key
 * those four, and the only thing between it and the rows is whether a policy
 * happens to admit it. Seven tables shipped that way (2720, 2721, 2722, 2811)
 * and the inverse audit found them live on portava-ci; 3740 takes the grants
 * back. This module is what stops the eighth.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * A table created by a file at or after CHAIN_START_PREFIX — one the baseline
 * does not contain, or one the chain DROPs and then CREATEs again — must, after
 * its LAST CREATE, be the target of a table-level REVOKE of ALL or of a DML
 * privilege from `anon` AND from `authenticated` (one statement or several), in
 * the same file after that CREATE or in a later file. A table is exempt only
 * when its last DROP comes after its last CREATE (it no longer exists). Order
 * is (filename, position in the file); statements a loop writes out count as
 * coming after the file's own text. What follows the REVOKE (a GRANT of exactly what a client path
 * needs) is the author's decision; the rule only asks that one was made, so
 * no table keeps the default ACL by omission.
 *
 * The REVOKE may be written as:
 *   * a plain statement, one or several targets (`REVOKE ALL ON public.a,
 *     public.b FROM PUBLIC, anon, authenticated`);
 *   * an EXECUTE literal inside a DO block;
 *   * an `EXECUTE format(…, t)` inside `FOREACH t IN ARRAY ARRAY[…]` (read via
 *     expandForeachLiteralLoops — 2762, 2763, 2130 do this);
 *   * an `EXECUTE format('REVOKE … ON [TABLE] public.%I …', r.col)` inside
 *     `FOR r IN SELECT … FROM <temp table>` whose rows are a literal
 *     `INSERT INTO <temp table> … VALUES` list in the same file (3504's and
 *     3390's shape). That form is credited as a decision for each listed table
 *     even where the privileges or roles are computed at run time (3390 revokes
 *     per verb and role from a second temp table): it is unmistakably a
 *     client-privilege decision about exactly those tables, which is all this
 *     rule asks.
 *
 * WHAT IS NOT A REVOKE: a column-level REVOKE (`REVOKE UPDATE (role) …`) is not
 * a decision about the table's default ACL; a string literal that merely starts
 * with REVOKE (a RAISE message, a COMMENT) is not a statement — a literal,
 * single- or dollar-quoted, is read as SQL only when it is a body the server
 * executes: EXECUTE's operand, or a dollar quote opened by EXECUTE, AS or DO
 * (verifier G2-2); a quoted identifier keeps its case (`"Zz_T"` and `zz_t` are
 * different relations).
 *
 * KNOWN LIMITS, stated (verifier F3e): the rule proves that a REVOKE STATEMENT
 * exists after the CREATE, not that the resulting ACL is right — `REVOKE ALL …;
 * GRANT SELECT, INSERT, UPDATE, DELETE … TO anon` passes, and so does a REVOKE
 * inside `IF false THEN`. A table created through EXECUTE format() inside a
 * temp-table-driven loop is not seen (none exists today). The live ACL is
 * `audit:live-unexplained`'s question.
 *
 * ── THE VIEW RULE (rule 5, findClientDefinerViews) ───────────────────────────
 * A view without `security_invoker = true` runs with its OWNER's privileges,
 * and the owner bypasses RLS on a table that does not FORCE it: such a view,
 * readable by `anon` or `authenticated`, exposes every row of the tables it
 * reads, whatever their policies say. 2776's trip_presence_current was exactly
 * that, in production (verifier F2; 3741 fixes it). Views take Supabase's
 * default ACL like tables, so a view the chain creates is client-readable
 * unless a REVOKE says otherwise. The rule replays, over the baseline and the
 * chain in order, each view's security_invoker option (CREATE … WITH (…),
 * ALTER VIEW … SET / RESET, and CREATE OR REPLACE, which replaces the options)
 * and its client access (the baseline's GRANTs; the default ACL at a chain
 * CREATE; GRANT / REVOKE of SELECT or ALL after it), and fails on every view
 * that ends client-readable without security_invoker. There are NO exceptions:
 * PostGIS's geometry_columns / geography_columns are extension members, which
 * pg_dump leaves out of the baseline and no migration creates, so the replay
 * never sees them; an allowlist of their names exempted nothing and only let a
 * chain view squat on one of them (verifier G2-3; it was removed).
 *
 * KNOWN LIMITS of rules 4 and 5, stated so they are not mistaken for coverage
 * (verifier G2-5, G2-7, G2-8; none has an instance in the chain today):
 *   * Rule 5 credits 3820's catalog loop for every name in its literal
 *     `relname IN (…)` list when the body EXECUTEs `ALTER VIEW %I.%I SET
 *     (security_invoker = true)` on the loop record; it does not evaluate the
 *     rest of the loop's WHERE, so a predicate that neuters the loop at run
 *     time (`AND false`, another schema) would still be credited.
 *   * Rule 4 does not see a table created by a bare `EXECUTE format('CREATE
 *     TABLE …', 'lit')` outside a loop, by `SELECT … INTO public.t`, by a
 *     FOREACH over a DECLAREd array variable, or by an EXECUTE whose operand is
 *     built with `||`. Such a table is never examined.
 *   * Rule 4 takes a table's LAST CREATE: a later `CREATE TABLE IF NOT EXISTS`
 *     re-statement of a table the chain already created and decided makes it
 *     undecided again (fail-closed noise; the author repeats the REVOKE).
 *   * Rule 5 reads schema `public` only, views named through literal text or a
 *     FOREACH literal, and GRANT/REVOKE statements that name the view; it does
 *     not model `GRANT … ON ALL TABLES IN SCHEMA`.
 */

import { blankSqlComments, CHAIN_START_PREFIX, expandForeachLiteralLoops, SQL_STATEMENT_LEAD } from "./liveVsCanonicalCore.js";

export interface MigrationText {
  /** Bare filename, e.g. `2720_highlight_resurfacing_preferences.sql`. */
  name: string;
  sql: string;
}

export interface UndecidedTable {
  table: string;
  /** The file whose (last) CREATE TABLE made it. */
  file: string;
  /** Which client role(s) no REVOKE reached. */
  missing: Array<"anon" | "authenticated">;
}

const CLIENT = ["anon", "authenticated"] as const;
const DML = /^(all(\s+privileges)?|select|insert|update|delete)$/i;
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;

/** An identifier as PostgreSQL folds it: quoted keeps its case, bare is lower-cased. */
function fold(id: string): string {
  return id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id.toLowerCase();
}

/** Table name from `[schema.]name`; null if not schema public, or a placeholder. */
function tableName(raw: string): string | null {
  const t = raw.trim();
  if (!t || t.includes("%")) return null;
  const m = new RegExp(String.raw`^(?:(${IDENT})\.)?(${IDENT})$`).exec(t);
  if (!m) return null;
  if (m[1] !== undefined && fold(m[1]) !== "public") return null;
  return fold(m[2]!);
}

function splitCommas(s: string): string[] {
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

/** The statement starting at `from` runs to the first `;` or `'` at paren depth 0. */
function statementFrom(src: string, from: number): string {
  let depth = 0;
  let i = from;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if ((ch === ";" || ch === "'") && depth === 0) break;
  }
  return src.slice(from, i);
}

/**
 * Where a statement can begin — liveVsCanonicalCore.SQL_STATEMENT_LEAD: start
 * of text, after `;`, BEGIN/THEN/ELSE/LOOP/DO, or inside a literal only when it
 * is a body the server executes (EXECUTE's operand; a dollar quote opened by
 * EXECUTE, AS or DO). A RAISE message or a COMMENT that happens to start with
 * REVOKE / GRANT / CREATE is not a statement, single- or dollar-quoted
 * (verifier F3b / F4 / G2-2).
 */
export const STATEMENT_LEAD = SQL_STATEMENT_LEAD;
const leads = (src: string, at: number) => STATEMENT_LEAD.test(src.slice(Math.max(0, at - 32), at));

type TableEvent =
  | { k: "create"; t: string; pos: number }
  | { k: "drop"; t: string; pos: number }
  | { k: "revoke"; t: string; pos: number; roles: string[] };

const CREATE_RE = new RegExp(
  String.raw`\bcreate\s+(?:(temp|temporary)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:${IDENT}\.)?${IDENT})(?![\w$."%])`,
  "gi",
);

function createEvents(src: string, base: number): TableEvent[] {
  const out: TableEvent[] = [];
  for (const m of src.matchAll(CREATE_RE)) {
    if (m[1]) continue;
    if (!leads(src, m.index!)) continue;
    const t = tableName(m[2]!);
    if (t) out.push({ k: "create", t, pos: base + m.index! });
  }
  return out;
}

function dropEvents(src: string, base: number): TableEvent[] {
  const out: TableEvent[] = [];
  for (const m of src.matchAll(/\bdrop\s+table\s+(?:if\s+exists\s+)?([^;']+)/gi)) {
    if (!leads(src, m.index!)) continue;
    const list = m[1]!.replace(/\b(cascade|restrict)\b/gi, "");
    for (const part of splitCommas(list)) {
      const t = tableName(part);
      if (t) out.push({ k: "drop", t, pos: base + m.index! });
    }
  }
  return out;
}

function revokeEvents(text: string, base: number): TableEvent[] {
  const out: TableEvent[] = [];
  const headRe = /\brevoke\s+/gi;
  let h: RegExpExecArray | null;
  while ((h = headRe.exec(text)) !== null) {
    if (!leads(text, h.index)) continue;
    const stmt = statementFrom(text, h.index + h[0].length);
    if (/^\s*grant\s+option\s+for\b/i.test(stmt)) continue; // takes the grant option only
    const on = /\bon\b/i.exec(stmt);
    const from = /\bfrom\b/i.exec(stmt);
    if (!on || !from || from.index < on.index) continue;
    const privs = splitCommas(stmt.slice(0, on.index)).map((p) => p.trim());
    if (!privs.some((p) => DML.test(p))) continue; // a column-level or destructive-only revoke
    let targets = stmt.slice(on.index + 2, from.index).trim();
    if (/^(function|procedure|routine|sequence|schema|database|all\s)/i.test(targets)) continue;
    targets = targets.replace(/^table\s+/i, "");
    const roles = splitCommas(stmt.slice(from.index + 4).replace(/\b(cascade|restrict)\b/gi, ""))
      .map((r) => fold(r.trim()))
      .filter((r) => (CLIENT as readonly string[]).includes(r));
    if (!roles.length) continue;
    for (const part of splitCommas(targets)) {
      const t = tableName(part);
      if (t) out.push({ k: "revoke", t, pos: base + h.index, roles });
    }
  }
  return out;
}

/** Temp-table driven loop REVOKEs (3504's and 3390's shape): table -> client roles. */
function tempTableLoopRevokes(src: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const rowsOf = new Map<string, Map<string, string[]>>();
  for (const m of src.matchAll(/\binsert\s+into\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*values\s*/gi)) {
    const tmp = m[1]!.toLowerCase();
    if (!new RegExp(String.raw`\bcreate\s+(?:temp|temporary)\s+table\s+(?:if\s+not\s+exists\s+)?${tmp}\b`, "i").test(src)) continue;
    const cols = m[2]!.split(",").map((c) => c.trim().toLowerCase());
    const byCol = rowsOf.get(tmp) ?? new Map<string, string[]>();
    for (const c of cols) if (!byCol.has(c)) byCol.set(c, []);
    let i = m.index! + m[0].length;
    for (;;) {
      while (/[\s,]/.test(src[i] ?? "")) i++;
      if (src[i] !== "(") break;
      let depth = 0;
      let j = i;
      let inQ = false;
      for (; j < src.length; j++) {
        const ch = src[j];
        if (inQ) {
          if (ch === "'" && src[j + 1] === "'") j++;
          else if (ch === "'") inQ = false;
        } else if (ch === "'") inQ = true;
        else if (ch === "(") depth++;
        else if (ch === ")" && --depth === 0) break;
      }
      const vals = [...src.slice(i + 1, j).matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1]!.replace(/''/g, "'"));
      cols.forEach((c, k) => {
        if (vals[k] !== undefined) byCol.get(c)!.push(vals[k]!);
      });
      i = j + 1;
    }
    rowsOf.set(tmp, byCol);
  }
  for (const m of src.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+select\b[\s\S]*?\bfrom\s+([A-Za-z_]\w*)[\s\S]*?\bloop\b([\s\S]*?)\bend\s+loop\b/gi)) {
    const rec = m[1]!.toLowerCase();
    const byCol = rowsOf.get(m[2]!.toLowerCase());
    if (!byCol) continue;
    for (const e of m[3]!.matchAll(/\bexecute\s+format\s*\(\s*'((?:[^']|'')*)'\s*,([\s\S]*?)\)\s*;/gi)) {
      const tpl = e[1]!.replace(/''/g, "'");
      if (!/^\s*revoke\b/i.test(tpl)) continue;
      const on = /\bon\s+(?:table\s+)?(?:public\.)?%I\b/i.exec(tpl);
      if (!on) continue;
      const ordinal = (tpl.slice(0, on.index + on[0].length).match(/%[IsL]/g) ?? []).length - 1;
      const args = splitCommas(e[2]!).map((a) => a.trim().toLowerCase());
      const am = args[ordinal] ? new RegExp(String.raw`^${rec}\.([A-Za-z_]\w*)$`).exec(args[ordinal]!) : null;
      if (!am) continue;
      for (const t of byCol.get(am[1]!) ?? []) {
        if (!out.has(t.toLowerCase())) out.set(t.toLowerCase(), new Set());
        for (const r of CLIENT) out.get(t.toLowerCase())!.add(r);
      }
    }
  }
  return out;
}

/** Every create / drop / revoke event in one file, in order. Loop-written statements follow the file's own text. */
function fileEvents(sql: string): TableEvent[] {
  const src = blankSqlComments(sql);
  const loops = expandForeachLiteralLoops(src);
  const loopBase = src.length + 1;
  const events: TableEvent[] = [
    ...createEvents(src, 0),
    ...dropEvents(src, 0),
    ...revokeEvents(src, 0),
    ...createEvents(loops, loopBase),
    ...dropEvents(loops, loopBase),
    ...revokeEvents(loops, loopBase),
  ];
  const tail = loopBase + loops.length + 1;
  for (const [t, roles] of tempTableLoopRevokes(src)) events.push({ k: "revoke", t, pos: tail, roles: [...roles] });
  return events.sort((a, b) => a.pos - b.pos);
}

/** Tables the text CREATEs (not TEMP), written out or by a FOREACH-literal loop. */
export function createdTables(sql: string): string[] {
  return fileEvents(sql).filter((e) => e.k === "create").map((e) => e.t);
}

/** Tables the text DROPs. */
export function droppedTables(sql: string): string[] {
  return fileEvents(sql).filter((e) => e.k === "drop").map((e) => e.t);
}

/** table -> the client roles a table-level REVOKE (ALL or a DML privilege) reaches in this text. */
export function revokedFromClients(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of fileEvents(sql)) {
    if (e.k !== "revoke") continue;
    if (!out.has(e.t)) out.set(e.t, new Set());
    for (const r of e.roles) out.get(e.t)!.add(r);
  }
  return out;
}

/**
 * Tables the post-baseline chain creates without a client-privilege decision
 * after their last CREATE. `files` in any order; read in filename order.
 */
export function findUndecidedTables(
  files: readonly MigrationText[],
  baselineTables: ReadonlySet<string>,
): UndecidedTable[] {
  const chain = [...files]
    .filter((f) => f.name >= CHAIN_START_PREFIX)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // A single ordered event stream: (file index, position).
  const stream: Array<TableEvent & { file: string; fi: number }> = [];
  chain.forEach((f, fi) => {
    for (const e of fileEvents(f.sql)) stream.push({ ...e, file: f.name, fi });
  });
  const after = (a: { fi: number; pos: number }, b: { fi: number; pos: number }) => a.fi > b.fi || (a.fi === b.fi && a.pos > b.pos);

  const byTable = new Map<string, typeof stream>();
  for (const e of stream) {
    if (!byTable.has(e.t)) byTable.set(e.t, []);
    byTable.get(e.t)!.push(e);
  }
  const out: UndecidedTable[] = [];
  for (const [table, evs] of [...byTable].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const creates = evs.filter((e) => e.k === "create");
    if (!creates.length) continue;
    const lastCreate = creates[creates.length - 1]!;
    const dropsBefore = evs.some((e) => e.k === "drop" && after(lastCreate, e));
    // A baseline table re-created by `CREATE TABLE IF NOT EXISTS` is a no-op;
    // one the chain dropped first is a NEW table with the default ACL.
    if (baselineTables.has(table) && !dropsBefore) continue;
    if (evs.some((e) => e.k === "drop" && after(e, lastCreate))) continue; // gone at the end
    const reached = new Set<string>();
    for (const e of evs) if (e.k === "revoke" && after(e, lastCreate)) for (const r of e.roles) reached.add(r);
    const missing = CLIENT.filter((r) => !reached.has(r));
    if (missing.length) out.push({ table, file: lastCreate.file, missing: [...missing] });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 5: client-readable views must be security_invoker
// ─────────────────────────────────────────────────────────────────────────────

export interface ClientDefinerView {
  view: string;
  /** The file (or 'baseline') whose CREATE last defined it. */
  definedIn: string;
  /** Client roles that can read it. */
  roles: string[];
}

type ViewEvent =
  | { k: "create"; v: string; pos: number; invoker: boolean; replace: boolean }
  | { k: "drop"; v: string; pos: number }
  | { k: "setinv"; v: string; pos: number; invoker: boolean }
  | { k: "grant" | "revoke"; v: string; pos: number; roles: string[] };

const truthy = (v: string) => /^'?(true|on|1|yes)'?$/i.test(v.trim());

function viewEvents(src: string, base: number): ViewEvent[] {
  const out: ViewEvent[] = [];
  const createRe = new RegExp(
    String.raw`\bcreate\s+(or\s+replace\s+)?(?:(?:temp|temporary)\s+)?(?:(materialized)\s+)?(?:recursive\s+)?view\s+(?:if\s+not\s+exists\s+)?((?:${IDENT}\.)?${IDENT})(?![\w$."%])(\s+with\s*\(([^)]*)\))?`,
    "gi",
  );
  for (const m of src.matchAll(createRe)) {
    if (!leads(src, m.index!)) continue;
    const v = tableName(m[3]!);
    if (!v) continue;
    const opts = m[5] ?? "";
    const inv = /security_invoker\s*=\s*('?[\w]+'?)/i.exec(opts);
    out.push({ k: "create", v, pos: base + m.index!, invoker: !m[2] && !!inv && truthy(inv[1]!), replace: !!m[1] });
  }
  // ALTER TABLE accepts a view for SET / RESET (reloption) too (verifier G2-4),
  // so a file written that way is read the same.
  for (const m of src.matchAll(new RegExp(String.raw`\balter\s+(?:view|table)\s+(?:if\s+exists\s+)?(?:only\s+)?((?:${IDENT}\.)?${IDENT})\s+(set|reset)\s*\(([^)]*)\)`, "gi"))) {
    if (!leads(src, m.index!)) continue;
    const v = tableName(m[1]!);
    if (!v) continue;
    const opts = m[3]!;
    if (!/security_invoker/i.test(opts)) continue;
    if (m[2]!.toLowerCase() === "reset") out.push({ k: "setinv", v, pos: base + m.index!, invoker: false });
    else {
      const inv = /security_invoker\s*(?:=\s*('?[\w]+'?))?/i.exec(opts)!;
      out.push({ k: "setinv", v, pos: base + m.index!, invoker: inv[1] === undefined ? true : truthy(inv[1]) });
    }
  }
  // A catalog loop that switches a LITERAL list of views (3820's shape):
  //   FOR v IN SELECT … relname IN ('a', 'b', …) … LOOP
  //     EXECUTE format('ALTER VIEW %I.%I SET (security_invoker = true)', v.nspname, v.relname);
  // After it, every listed view that exists is invoker — the ones it skipped
  // already were — so each listed name is credited.
  for (const m of src.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+select\b([\s\S]*?)\bloop\b([\s\S]*?)\bend\s+loop\b/gi)) {
    const rec = m[1]!.toLowerCase();
    const list = /\brelname\s+in\s*\(([^)]*)\)/i.exec(m[2]!);
    if (!list) continue;
    const sw = new RegExp(
      String.raw`\bexecute\s+format\s*\(\s*'alter\s+view\s+(?:%I\.)?%I\s+set\s*\(\s*security_invoker\s*=\s*(true|on)\s*\)'\s*,[^;]*\b${rec}\.relname\b`,
      "i",
    ).exec(m[3]!);
    if (!sw) continue;
    for (const lit of list[1]!.matchAll(/'([^']+)'/g)) out.push({ k: "setinv", v: lit[1]!, pos: base + m.index! + m[0].length, invoker: true });
  }
  for (const m of src.matchAll(/\bdrop\s+(?:materialized\s+)?view\s+(?:if\s+exists\s+)?([^;']+)/gi)) {
    if (!leads(src, m.index!)) continue;
    for (const part of splitCommas(m[1]!.replace(/\b(cascade|restrict)\b/gi, ""))) {
      const v = tableName(part);
      if (v) out.push({ k: "drop", v, pos: base + m.index! });
    }
  }
  const aclRe = /\b(grant|revoke)\s+/gi;
  let h: RegExpExecArray | null;
  while ((h = aclRe.exec(src)) !== null) {
    if (!leads(src, h.index)) continue;
    const kind = h[1]!.toLowerCase() as "grant" | "revoke";
    let stmt = statementFrom(src, h.index + h[0].length);
    if (kind === "revoke" && /^\s*grant\s+option\s+for\b/i.test(stmt)) continue;
    const on = /\bon\b/i.exec(stmt);
    const toFrom = new RegExp(String.raw`\b${kind === "grant" ? "to" : "from"}\b`, "i").exec(stmt);
    if (!on || !toFrom || toFrom.index < on.index) continue;
    const privs = splitCommas(stmt.slice(0, on.index)).map((p) => p.trim());
    // Read access: SELECT (table- or column-level) or ALL.
    if (!privs.some((p) => /^(all(\s+privileges)?|select)\b/i.test(p))) continue;
    let targets = stmt.slice(on.index + 2, toFrom.index).trim();
    if (/^(function|procedure|routine|sequence|schema|database|all\s)/i.test(targets)) continue;
    targets = targets.replace(/^table\s+/i, "");
    stmt = stmt.slice(toFrom.index + toFrom[0].length);
    const roles = splitCommas(stmt.replace(/\b(with\s+grant\s+option|granted\s+by|cascade|restrict)\b[\s\S]*$/i, ""))
      .map((r) => fold(r.trim()))
      .filter((r) => (CLIENT as readonly string[]).includes(r) || r === "public");
    if (!roles.length) continue;
    // A column-level REVOKE leaves the rest of the view readable: only a
    // table-level SELECT/ALL revoke removes access.
    if (kind === "revoke" && !privs.some((p) => /^(all(\s+privileges)?|select)\s*$/i.test(p))) continue;
    for (const part of splitCommas(targets)) {
      const v = tableName(part);
      if (v) out.push({ k: kind, v, pos: base + h.index, roles });
    }
  }
  return out;
}

/**
 * Views that end client-readable without security_invoker, replaying the
 * baseline (its views' options and GRANTs, as pg_dump wrote them) and then the
 * post-baseline chain in order.
 */
export function findClientDefinerViews(files: readonly MigrationText[], baselineSql: string): ClientDefinerView[] {
  const state = new Map<string, { invoker: boolean; roles: Set<string>; definedIn: string; isView: boolean }>();
  const apply = (e: ViewEvent, file: string, fresh: boolean) => {
    const cur = state.get(e.v);
    if (e.k === "create") {
      if (e.replace && cur) {
        // OR REPLACE keeps the ACL and REPLACES the options.
        cur.invoker = e.invoker;
        cur.definedIn = file;
        cur.isView = true;
      } else {
        state.set(e.v, {
          invoker: e.invoker,
          // pg_dump writes a baseline view's ACL as GRANTs that follow; a view
          // the chain creates takes Supabase's default ACL.
          roles: fresh ? new Set(CLIENT) : new Set(),
          definedIn: file,
          isView: true,
        });
      }
    } else if (e.k === "drop") state.delete(e.v);
    else if (e.k === "setinv") {
      if (cur) cur.invoker = e.invoker;
    } else if (cur) {
      for (const r of e.roles) {
        const targets = r === "public" ? [...CLIENT] : [r];
        for (const t of targets) {
          if (e.k === "grant") cur.roles.add(t);
          else if (r !== "public") cur.roles.delete(t);
        }
      }
    }
  };
  const baseSrc = blankSqlComments(baselineSql);
  for (const e of viewEvents(baseSrc, 0).sort((a, b) => a.pos - b.pos)) apply(e, "baseline", false);
  const chain = [...files].filter((f) => f.name >= CHAIN_START_PREFIX).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const f of chain) {
    const src = blankSqlComments(f.sql);
    const loops = expandForeachLiteralLoops(src);
    const evs = [...viewEvents(src, 0), ...viewEvents(loops, src.length + 1)].sort((a, b) => a.pos - b.pos);
    for (const e of evs) apply(e, f.name, true);
  }
  const out: ClientDefinerView[] = [];
  for (const [v, st] of [...state].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!st.isView || st.invoker || !st.roles.size) continue;
    out.push({ view: v, definedIn: st.definedIn, roles: [...st.roles].sort() });
  }
  return out;
}

/** How many views the replay ended with (rule 5's vacuity floor). */
export function countViews(files: readonly MigrationText[], baselineSql: string): number {
  const names = new Set<string>();
  for (const e of viewEvents(blankSqlComments(baselineSql), 0)) if (e.k === "create") names.add(e.v);
  for (const f of files) {
    if (f.name < CHAIN_START_PREFIX) continue;
    for (const e of viewEvents(blankSqlComments(f.sql), 0)) if (e.k === "create") names.add(e.v);
  }
  return names.size;
}
