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
 * happens to admit it. Nine tables shipped that way (2720, 2721, 2722, 2811,
 * 2951, 2952) and the inverse audit found them live on portava-ci; 3740 takes
 * the grants back. This module is what stops the tenth.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * A table created by a file at or after CHAIN_START_PREFIX, that the baseline
 * does not already contain and that no later file drops, must be the target of
 * a table-level REVOKE of ALL or of a DML privilege from `anon` AND from
 * `authenticated` (in one statement or several), in its creating file or any
 * later one. What follows the REVOKE (a GRANT of exactly what a client path
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
 * NOT what this rule proves: that the decision is RIGHT, or that the live
 * database matches it. Those are the policies' and `audit:live-unexplained`'s
 * questions. A column-level REVOKE (`REVOKE UPDATE (role) …`) is not a
 * decision about the table's default ACL and does not count.
 */
import { blankSqlComments, CHAIN_START_PREFIX, expandForeachLiteralLoops } from "./liveVsCanonicalCore.js";

export interface MigrationText {
  /** Bare filename, e.g. `2720_highlight_resurfacing_preferences.sql`. */
  name: string;
  sql: string;
}

export interface UndecidedTable {
  table: string;
  /** The file whose CREATE TABLE made it. */
  file: string;
  /** Which client role(s) no REVOKE reached. */
  missing: Array<"anon" | "authenticated">;
}

const CLIENT = ["anon", "authenticated"] as const;
const DML = /^(all(\s+privileges)?|select|insert|update|delete)$/i;

/** Table name from `[schema.]name` (quotes stripped, lower-cased); null if not schema public or a placeholder. */
function tableName(raw: string): string | null {
  const t = raw.trim();
  if (!t || t.includes("%")) return null;
  const m = /^(?:("?)([A-Za-z_][\w$]*)\1\.)?("?)([A-Za-z_][\w$]*)\3$/.exec(t);
  if (!m) return null;
  if ((m[2] ?? "public").toLowerCase() !== "public") return null;
  return m[4]!.toLowerCase();
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

const STATEMENT_LEAD = /(?:^|[;'$]|\b(?:begin|then|else|loop|do)\b)\s*$/i;

/** Tables the text CREATEs (not TEMP), keyed by name. */
export function createdTables(sql: string): string[] {
  const src = blankSqlComments(sql);
  const out: string[] = [];
  const re =
    /\bcreate\s+(?:(temp|temporary)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"?[A-Za-z_][\w$]*"?\.)?"?[A-Za-z_][\w$]*"?)/gi;
  for (const m of src.matchAll(re)) {
    if (m[1]) continue;
    if (!STATEMENT_LEAD.test(src.slice(Math.max(0, m.index! - 24), m.index))) continue;
    const t = tableName(m[2]!);
    if (t) out.push(t);
  }
  return out;
}

/** Tables the text DROPs. */
export function droppedTables(sql: string): string[] {
  const src = blankSqlComments(sql);
  const out: string[] = [];
  const re = /\bdrop\s+table\s+(?:if\s+exists\s+)?([^;']+)/gi;
  for (const m of src.matchAll(re)) {
    const list = m[1]!.replace(/\b(cascade|restrict)\b/gi, "");
    for (const part of splitCommas(list)) {
      const t = tableName(part);
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * table -> the client roles a table-level REVOKE (ALL or a DML privilege)
 * reaches in this text, over every shape the module header lists.
 */
export function revokedFromClients(sql: string): Map<string, Set<string>> {
  const src = blankSqlComments(sql);
  const out = new Map<string, Set<string>>();
  const credit = (t: string, roles: Iterable<string>) => {
    if (!out.has(t)) out.set(t, new Set());
    for (const r of roles) out.get(t)!.add(r);
  };

  const readRevokes = (text: string) => {
    const headRe = /\brevoke\s+/gi;
    let h: RegExpExecArray | null;
    while ((h = headRe.exec(text)) !== null) {
      if (!STATEMENT_LEAD.test(text.slice(Math.max(0, h.index - 24), h.index))) continue;
      const stmt = statementFrom(text, h.index + h[0].length);
      const on = /\bon\b/i.exec(stmt);
      const from = /\bfrom\b/i.exec(stmt);
      if (!on || !from || from.index < on.index) continue;
      const privs = splitCommas(stmt.slice(0, on.index)).map((p) => p.trim());
      if (!privs.some((p) => DML.test(p))) continue; // a column-level or destructive-only revoke
      let targets = stmt.slice(on.index + 2, from.index).trim();
      if (/^(function|procedure|routine|sequence|schema|database|all\s)/i.test(targets)) continue;
      targets = targets.replace(/^table\s+/i, "");
      const roles = splitCommas(stmt.slice(from.index + 4).replace(/\b(cascade|restrict)\b/gi, ""))
        .map((r) => r.trim().replace(/^"|"$/g, "").toLowerCase())
        .filter((r) => (CLIENT as readonly string[]).includes(r));
      if (!roles.length) continue;
      for (const part of splitCommas(targets)) {
        const t = tableName(part);
        if (t) credit(t, roles);
      }
    }
  };

  readRevokes(src);
  readRevokes(expandForeachLiteralLoops(src));

  // Temp-table driven loops: FOR r IN SELECT … FROM <tmp> … LOOP … EXECUTE
  // format('REVOKE … ON [TABLE] public.%I …', …, r.col, …) … END LOOP.
  const rowsOf = new Map<string, Map<string, string[]>>(); // tmp -> col -> values
  for (const m of src.matchAll(/\binsert\s+into\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*values\s*/gi)) {
    const tmp = m[1]!.toLowerCase();
    if (!new RegExp(String.raw`\bcreate\s+(?:temp|temporary)\s+table\s+(?:if\s+not\s+exists\s+)?${tmp}\b`, "i").test(src)) continue;
    const cols = m[2]!.split(",").map((c) => c.trim().toLowerCase());
    const byCol = rowsOf.get(tmp) ?? new Map<string, string[]>();
    for (const c of cols) if (!byCol.has(c)) byCol.set(c, []);
    // Literal rows until the statement ends.
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
      const arg = args[ordinal];
      const am = arg ? new RegExp(String.raw`^${rec}\.([A-Za-z_]\w*)$`).exec(arg) : null;
      if (!am) continue;
      for (const t of byCol.get(am[1]!) ?? []) credit(t.toLowerCase(), CLIENT);
    }
  }
  return out;
}

/**
 * Tables the post-baseline chain creates without a client-privilege decision.
 * `files` in any order; they are read in filename order.
 */
export function findUndecidedTables(
  files: readonly MigrationText[],
  baselineTables: ReadonlySet<string>,
): UndecidedTable[] {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chain = sorted.filter((f) => f.name >= CHAIN_START_PREFIX);

  const created = new Map<string, string>(); // table -> creating file
  for (const f of chain) {
    for (const t of createdTables(f.sql)) {
      if (!baselineTables.has(t) && !created.has(t)) created.set(t, f.name);
    }
  }

  const perFile = chain.map((f) => ({
    name: f.name,
    revoked: revokedFromClients(f.sql),
    dropped: new Set(droppedTables(f.sql)),
  }));

  const out: UndecidedTable[] = [];
  for (const [table, file] of [...created].sort()) {
    const later = perFile.filter((p) => p.name >= file);
    if (later.some((p) => p.dropped.has(table))) continue;
    const reached = new Set<string>();
    for (const p of later) for (const r of p.revoked.get(table) ?? []) reached.add(r);
    const missing = CLIENT.filter((r) => !reached.has(r));
    if (missing.length) out.push({ table, file, missing: [...missing] });
  }
  return out;
}
