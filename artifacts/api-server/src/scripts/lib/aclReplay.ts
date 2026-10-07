/**
 * aclReplay — the table and column privileges the baseline plus the
 * post-baseline chain leave, GRANT and REVOKE applied in apply order.
 *
 * WHY. The inverse audit's model used to be the UNION of every GRANT the
 * baseline and the migrations ever issued. A REVOKE subtracted nothing, so a
 * privilege a later migration took back still "explained" a live grant: if a
 * database kept a privilege the chain revoked (an out-of-band re-grant, a
 * migration that never ran there), EXCESS_PRIVILEGE could not see it.
 * Replaying the statements makes the model what the chain says the ACL IS.
 *
 * SEMANTICS (PostgreSQL's):
 *   * GRANT p ON t TO r adds p; GRANT ALL [PRIVILEGES] adds every table
 *     privilege; GRANT p (cols) adds p on those columns only.
 *   * REVOKE p ON t FROM r removes p at table level AND p on every column of
 *     t ("when revoking privileges on a table, the corresponding column
 *     privileges … are automatically revoked on each column"); REVOKE ALL
 *     removes everything; REVOKE p (cols) removes p on those columns only;
 *     REVOKE GRANT OPTION FOR p removes only the grant option (no change here).
 *   * ON ALL TABLES IN SCHEMA public applies to every table known at that
 *     point (the baseline's, and every one the chain has created so far).
 *   * DROP TABLE forgets the table's ACL. CREATE TABLE starts it EMPTY: the
 *     Supabase default ACL is deliberately NOT modelled, so a privilege a
 *     table holds only because nobody revoked the default is still excess.
 *   * Statements are read in text order per file — written out, inside
 *     EXECUTE literals, then those expandForeachLiteralLoops() writes out, then
 *     those a temp-table-driven loop issues with literal templates (3504's
 *     shape). Files below CHAIN_START_PREFIX are not replayed: the baseline's
 *     ACL already reflects them.
 *
 * WHERE IT CANNOT KNOW, IT DOES NOT PRETEND. A GRANT issued by EXECUTE
 * format() that none of the above can evaluate (3365's computed column list
 * on post_media) makes that table's replayed ACL unknowable from that point;
 * the table is returned in `unknowable`, and the audit judges it by the old
 * union instead. A REVOKE nobody can evaluate (3390's computed verbs) simply
 * is not applied, which leaves the replay where the union was. So the replay
 * is never looser than the union it replaces.
 */
import { blankSqlComments, expandForeachLiteralLoops, normalizePrivilege } from "./liveVsCanonicalCore.js";
import { createdTables, droppedTables } from "./clientTableAclDecisions.js";
import { pgFormat } from "./chainRlsFacts.js";

const ALL_TABLE_PRIVILEGES = ["select", "insert", "update", "delete", "truncate", "references", "trigger", "maintain"];

export interface AclStatement {
  kind: "grant" | "revoke";
  /** `cols` present = a column-level privilege. */
  privs: Array<{ priv: string; cols?: string[] }>;
  tables: string[] | "ALL";
  roles: string[];
  grantOptionOnly: boolean;
}

const LEAD = /(?:^|[;'$]|\b(?:begin|then|else|loop|do)\b)\s*$/i;

function splitTop(s: string): string[] {
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

function topWord(s: string, w: string, from = 0): number {
  const re = new RegExp(String.raw`\b${w}\b`, "gi");
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    let d = 0;
    for (let i = 0; i < m.index; i++) d += s[i] === "(" ? 1 : s[i] === ")" ? -1 : 0;
    if (d === 0) return m.index;
  }
  return -1;
}

const unq = (s: string) => s.trim().replace(/^"|"$/g, "").toLowerCase();

/** GRANT / REVOKE statements on tables in `sql`, in text order. */
export function aclStatements(sql: string): AclStatement[] {
  const src = blankSqlComments(sql);
  const out: AclStatement[] = [];
  const head = /\b(grant|revoke)\s+/gi;
  let h: RegExpExecArray | null;
  while ((h = head.exec(src)) !== null) {
    if (!LEAD.test(src.slice(Math.max(0, h.index - 24), h.index))) continue;
    let i = h.index + h[0].length;
    let depth = 0;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if ((ch === ";" || ch === "'") && depth === 0) break;
    }
    let stmt = src.slice(h.index + h[0].length, i);
    const kind = h[1]!.toLowerCase() as "grant" | "revoke";
    let grantOptionOnly = false;
    if (kind === "revoke" && /^\s*grant\s+option\s+for\s+/i.test(stmt)) {
      grantOptionOnly = true;
      stmt = stmt.replace(/^\s*grant\s+option\s+for\s+/i, "");
    }
    const on = topWord(stmt, "on");
    if (on < 0) continue;
    const toFrom = topWord(stmt, kind === "grant" ? "to" : "from", on + 2);
    if (toFrom < 0) continue;
    let target = stmt.slice(on + 2, toFrom).trim();
    let tables: string[] | "ALL";
    if (/^all\s+tables\s+in\s+schema\s+"?public"?\s*$/i.test(target)) tables = "ALL";
    else {
      if (/^(function|procedure|routine|sequence|schema|database|domain|type|language|large\s+object|foreign|tablespace|parameter|all\s)/i.test(target)) continue;
      target = target.replace(/^table\s+/i, "");
      tables = [];
      for (const raw of splitTop(target)) {
        const t = raw.trim();
        if (t.includes("%")) continue;
        const m = /^(?:("?)([A-Za-z_][\w$]*)\1\.)?("?)([A-Za-z_][\w$]*)\3$/.exec(t);
        if (!m || (m[2] ?? "public").toLowerCase() !== "public") continue;
        tables.push(m[4]!.toLowerCase());
      }
      if (!tables.length) continue;
    }
    const roles = splitTop(stmt.slice(toFrom + (kind === "grant" ? 2 : 4)).replace(/\b(with\s+grant\s+option|granted\s+by|cascade|restrict)\b[\s\S]*$/i, ""))
      .map(unq)
      .filter((r) => /^[a-z_][\w$]*$/.test(r));
    if (!roles.length) continue;
    const privs: AclStatement["privs"] = [];
    for (const item of splitTop(stmt.slice(0, on))) {
      const pm = /^\s*([A-Za-z]+(?:\s+privileges)?)\s*(?:\(([^)]*)\))?\s*$/i.exec(item);
      if (!pm) continue;
      const priv = /^all\b/i.test(pm[1]!) ? "all" : normalizePrivilege(pm[1]!);
      const cols = pm[2]?.split(",").map(unq).filter(Boolean);
      privs.push(cols && cols.length ? { priv, cols } : { priv });
    }
    if (!privs.length) continue;
    out.push({ kind, privs, tables, roles, grantOptionOnly });
  }
  return out;
}

/**
 * The statements a `FOR r IN SELECT … FROM <temp table> … LOOP … END LOOP`
 * issues through `EXECUTE format('<template>', r.<col>, 'literal', …)`, one per
 * literal row of `INSERT INTO <temp table> (cols) VALUES (…)` in the same text
 * (3504's shape). Templates fed by anything else are not expanded.
 */
export function expandTempTableLoops(sql: string): string {
  const src = blankSqlComments(sql);
  const rowsOf = new Map<string, Array<Record<string, string>>>();
  for (const m of src.matchAll(/\binsert\s+into\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*values\s*/gi)) {
    const tmp = m[1]!.toLowerCase();
    if (!new RegExp(String.raw`\bcreate\s+(?:temp|temporary)\s+table\s+(?:if\s+not\s+exists\s+)?${tmp}\b`, "i").test(src)) continue;
    const cols = m[2]!.split(",").map((c) => c.trim().toLowerCase());
    const rows: Array<Record<string, string>> = [];
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
      const row: Record<string, string> = {};
      cols.forEach((c, k) => {
        if (vals[k] !== undefined) row[c] = vals[k]!;
      });
      rows.push(row);
      i = j + 1;
    }
    rowsOf.set(tmp, [...(rowsOf.get(tmp) ?? []), ...rows]);
  }
  const out: string[] = [];
  for (const m of src.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+select\b[\s\S]*?\bfrom\s+([A-Za-z_]\w*)[\s\S]*?\bloop\b([\s\S]*?)\bend\s+loop\b/gi)) {
    const rec = m[1]!.toLowerCase();
    const rows = rowsOf.get(m[2]!.toLowerCase());
    if (!rows) continue;
    for (const e of m[3]!.matchAll(/\bexecute\s+format\s*\(\s*'((?:[^']|'')*)'\s*,([^;]*?)\)\s*;/gi)) {
      const tpl = e[1]!.replace(/''/g, "'");
      const args = splitTop(e[2]!).map((a) => a.trim());
      for (const row of rows) {
        const vals: string[] = [];
        let ok = true;
        for (const a of args) {
          const rm = new RegExp(String.raw`^${rec}\.([A-Za-z_]\w*)$`, "i").exec(a);
          const lit = /^'((?:[^']|'')*)'$/.exec(a);
          if (rm && row[rm[1]!.toLowerCase()] !== undefined) vals.push(row[rm[1]!.toLowerCase()]!);
          else if (lit) vals.push(lit[1]!.replace(/''/g, "'"));
          else {
            ok = false;
            break;
          }
        }
        const stmt = ok ? pgFormat(tpl, vals) : null;
        if (stmt) out.push(`${stmt};`);
      }
    }
  }
  return out.join("\n");
}

/** Tables a GRANT issued by an EXECUTE format() nothing above can evaluate may have changed. */
function unknowableGrantTables(src: string, expandedTables: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bexecute\s+format\s*\(\s*'\s*grant\b([^']*)'/gi)) {
    if (/\bon\s+(?:function|procedure|routine|sequence|schema|database|domain|type|language|all\s)/i.test(m[1]!)) continue;
    const on = /\bon\s+(?:table\s+)?(?:public\.)?(%I|[A-Za-z_]\w*)\b/i.exec(m[1]!);
    if (!on) continue;
    if (on[1] === "%I") continue; // loop-fed: its tables are whatever the loops expanded, judged there
    const t = on[1]!.toLowerCase();
    if (!expandedTables.has(t)) out.push(t);
  }
  return out;
}

export interface ReplayedAcl {
  /** 'table.role' -> privileges. */
  tableGrants: Map<string, Set<string>>;
  /** 'table.column.role' -> privileges. */
  columnGrants: Map<string, Set<string>>;
  /** Tables whose replayed ACL a GRANT nobody can evaluate may have changed. */
  unknowable: Set<string>;
}

/**
 * Replay `baselineSql` then each of `canonicalSqls` (already in apply order).
 * `baselineTables` seeds ON ALL TABLES with the tables the baseline creates.
 */
export function replayAcl(baselineSql: string, baselineTables: Iterable<string>, canonicalSqls: readonly string[]): ReplayedAcl {
  const tableGrants = new Map<string, Set<string>>();
  const columnGrants = new Map<string, Set<string>>();
  const unknowable = new Set<string>();
  const known = new Set<string>([...baselineTables].map((t) => t.toLowerCase()));

  const apply = (s: AclStatement) => {
    if (s.grantOptionOnly) return;
    const tables = s.tables === "ALL" ? [...known] : s.tables;
    for (const t of tables) {
      for (const r of s.roles) {
        const tk = `${t}.${r}`;
        for (const { priv, cols } of s.privs) {
          const set = priv === "all" ? ALL_TABLE_PRIVILEGES : [priv];
          if (s.kind === "grant") {
            if (cols) {
              for (const c of cols) {
                const ck = `${t}.${c}.${r}`;
                if (!columnGrants.has(ck)) columnGrants.set(ck, new Set());
                for (const p of set) columnGrants.get(ck)!.add(p);
              }
            } else {
              if (!tableGrants.has(tk)) tableGrants.set(tk, new Set());
              for (const p of set) tableGrants.get(tk)!.add(p);
            }
          } else if (cols) {
            for (const c of cols) for (const p of set) columnGrants.get(`${t}.${c}.${r}`)?.delete(p);
          } else {
            for (const p of set) tableGrants.get(tk)?.delete(p);
            // …and the same privilege on every column of the table.
            for (const [ck, ps] of columnGrants) {
              if (ck.startsWith(`${t}.`) && ck.endsWith(`.${r}`) && ck.split(".").length === 3) for (const p of set) ps.delete(p);
            }
          }
        }
      }
    }
  };

  for (const s of aclStatements(baselineSql)) apply(s);

  for (const raw of canonicalSqls) {
    const src = blankSqlComments(raw);
    for (const t of droppedTables(src)) {
      for (const k of [...tableGrants.keys()]) if (k.startsWith(`${t}.`) && k.split(".").length === 2) tableGrants.delete(k);
      for (const k of [...columnGrants.keys()]) if (k.startsWith(`${t}.`)) columnGrants.delete(k);
    }
    for (const t of createdTables(src)) known.add(t);
    const loops = expandForeachLiteralLoops(src);
    const temps = expandTempTableLoops(src);
    const statements = [...aclStatements(src), ...aclStatements(loops), ...aclStatements(temps)];
    for (const s of statements) apply(s);
    const expandedTables = new Set<string>();
    for (const s of [...aclStatements(loops), ...aclStatements(temps)]) if (s.tables !== "ALL") for (const t of s.tables) expandedTables.add(t);
    for (const t of unknowableGrantTables(src, expandedTables)) unknowable.add(t);
  }
  return { tableGrants, columnGrants, unknowable };
}
