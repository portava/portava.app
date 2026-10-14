/**
 * serverOnlyTables — rule 7 of check:client-privilege-boundary: a table whose
 * every reader and writer is the API (service_role) must END the chain with no
 * privilege of any kind held by `anon`, `authenticated` or `PUBLIC`.
 *
 * PURE: no filesystem, no network, no environment. The caller hands it the
 * baseline's text and the migration files; checkClientPrivilegeBoundary.ts is
 * the CLI and src/test/memoriesClientBoundary.test.ts drives it with the real
 * tree and with fixtures.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * Row-level security decides ROWS. A client role holding SELECT on a table
 * reads every COLUMN of every row a policy admits, and holding UPDATE writes
 * every column of every row a policy admits — whatever the API, which is the
 * only reader the product meant, withholds or derives. `public.memories` was
 * that table: the baseline's GRANT ALL plus `memories_public_read` let any
 * signed-in user read a stranger's exact coordinates and place references past
 * every rule the API applies (verifier V-716 fix 2); 3813 revokes it. Nothing
 * stopped the next migration from granting it back: rules 1-3 forbid only the
 * SHAPE of a grant (an unpoliced privilege, ALL, PUBLIC), and rule 4 looks only
 * at tables the chain creates. A `GRANT SELECT ON public.memories TO
 * authenticated` passed all four.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * For each table in SERVER_ONLY_TABLES, every GRANT and REVOKE that reaches it
 * is REPLAYED, the baseline first and then the chain in filename order: named
 * (`public.t`, `t`, `TABLE public.t`, a target list), or `ALL TABLES IN SCHEMA
 * public`; written out, or issued by a FOREACH-literal loop
 * (expandForeachLiteralLoops); per role (`anon`, `authenticated`, `PUBLIC`), at
 * table level and at column level, with PostgreSQL's rule that revoking a
 * table-level privilege also revokes that privilege on every column. A CREATE
 * TABLE of the table resets it to Supabase's default ACL (the four DML
 * privileges for both client roles), a DROP TABLE empties it. At the end of the
 * chain no role may hold anything. A statement is read only where
 * SQL_STATEMENT_LEAD says one can begin, so a RAISE message or a COMMENT that
 * reads like a GRANT is not one.
 *
 * A GRANT the replay cannot read — an `EXECUTE format('GRANT … ON public.%I …
 * TO authenticated', x)` outside a FOREACH over a literal array, one whose
 * grantee is itself a placeholder, or one that names the table through
 * format() — in a file that sorts after the table's closing migration is
 * reported too: it may re-open the table and nothing offline can say it does
 * not. None exists today.
 *
 * VACUITY (real tree): the replay must see the table handed to the client roles
 * (the baseline's CREATE TABLE under the default ACL, or a GRANT) AND the
 * closing migration revoke it from both; a parser gone blind would otherwise
 * read "nothing is held" as a pass.
 *
 * KNOWN LIMITS, stated so they are not mistaken for coverage:
 *   * Role MEMBERSHIP is not modelled: `GRANT some_role TO authenticated`,
 *     where some_role holds a privilege on the table, is not seen. 3813's
 *     postcondition asks has_table_privilege, which does follow membership, on
 *     the database it is applied to.
 *   * Grants issued by a temp-table or catalog-driven loop are seen only
 *     through the run-time-name report above, and only after the closing file.
 *   * Apply order is filename byte order; ORDER_OVERRIDES.json must not move a
 *     closing migration (the test pins it).
 *   * The live ACL is check:authorization-contract's question (the table is in
 *     src/security/authorization-contract.json with no client grant).
 */

import type { MigrationText } from "./clientTableAclDecisions.js";
import { blankSqlComments, CHAIN_START_PREFIX, expandForeachLiteralLoops, SQL_STATEMENT_LEAD } from "./liveVsCanonicalCore.js";

export interface ServerOnlyTable {
  /** Table name in schema public. */
  table: string;
  /** The migration that took the client privileges away. */
  closedBy: string;
  /** Why no client role needs it — the evidence a future GRANT has to overturn. */
  why: string;
}

export const SERVER_ONLY_TABLES: readonly ServerOnlyTable[] = [
  {
    table: "memories",
    closedBy: "3813_memories_client_privileges_revoked.sql",
    why:
      "canonical Memories: every reader and writer is the API on the service client; no client tree names the table, " +
      "and a client grant reads every column of a stranger's public Memory past the precision rung, the gem ceiling and the " +
      "owner's place corrections (verifier V-716 fix 2, OQ-716-1)",
  },
  {
    table: "compass_memories",
    closedBy: "2161_compass_memories_client_revoke.sql",
    why:
      "Compass memories: RLS has no policy and every access is service-role (routes/compass.ts); a client grant was a " +
      "cross-user read and a stored prompt injection (2161)",
  },
];

const ROLES = ["anon", "authenticated", "public"] as const;
export type AclRole = (typeof ROLES)[number];
const TABLE_PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"] as const;
const COLUMN_PRIVS = ["SELECT", "INSERT", "UPDATE", "REFERENCES"] as const;
/** What a CREATE TABLE in `public` hands both client roles under Supabase's default ACL after 2490. */
const DEFAULT_CLIENT_DML = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

export interface RoleAcl {
  table: Set<string>;
  /** privilege -> columns */
  cols: Map<string, Set<string>>;
}
export type TableAcl = Record<AclRole, RoleAcl>;

interface Event {
  pos: number;
  kind: "grant" | "revoke" | "create" | "drop";
  roles: AclRole[];
  privs: Array<{ priv: string; cols: string[] | null }>;
}

const leads = (src: string, at: number) => SQL_STATEMENT_LEAD.test(src.slice(Math.max(0, at - 32), at));

/** Statement text from `from` to the first `;` or `'` (an EXECUTE literal's close) at paren depth 0. */
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

/** Fold an identifier: unquoted -> lower case; "quoted" keeps its case. */
function fold(id: string): string {
  const t = id.trim();
  return /^".*"$/.test(t) ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase();
}

/** True when a target names public.<table> (schema-qualified or bare). */
function namesTable(target: string, table: string): boolean {
  const t = target.trim().replace(/^table\s+/i, "");
  const parts = t.split(".").map(fold);
  if (parts.length === 1) return parts[0] === table;
  return parts.length === 2 && parts[0] === "public" && parts[1] === table;
}

function aclEvents(src: string, base: number, table: string): Event[] {
  const out: Event[] = [];
  const headRe = /\b(grant|revoke)\s+/gi;
  let h: RegExpExecArray | null;
  while ((h = headRe.exec(src)) !== null) {
    if (!leads(src, h.index)) continue;
    const kind = h[1]!.toLowerCase() as "grant" | "revoke";
    let stmt = statementFrom(src, h.index + h[0].length);
    if (kind === "revoke" && /^\s*grant\s+option\s+for\b/i.test(stmt)) continue; // takes the grant option only
    const on = /\bon\b/i.exec(stmt);
    if (!on) continue; // role membership: not modelled (header)
    const toFrom = new RegExp(String.raw`\b${kind === "grant" ? "to" : "from"}\b`, "i").exec(stmt.slice(on.index));
    if (!toFrom) continue;
    const privText = stmt.slice(0, on.index);
    const targetText = stmt.slice(on.index + 2, on.index + toFrom.index).trim();
    stmt = stmt.slice(on.index + toFrom.index + toFrom[0].length);

    let reaches = false;
    const schemaWide = /^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i.exec(targetText);
    if (schemaWide) reaches = splitTop(schemaWide[1]!).some((s) => fold(s) === "public");
    else if (/^(function|procedure|routine|sequence|schema|database|domain|type|language|large\s+object|foreign|tablespace|parameter|all\s)/i.test(targetText)) continue;
    else reaches = splitTop(targetText).some((t) => namesTable(t, table));
    if (!reaches) continue;

    const roles = splitTop(stmt.replace(/\b(with\s+grant\s+option|granted\s+by|cascade|restrict)\b[\s\S]*$/i, ""))
      .map(fold)
      .filter((r): r is AclRole => (ROLES as readonly string[]).includes(r));
    if (!roles.length) continue;

    const privs: Event["privs"] = [];
    for (const raw of splitTop(privText)) {
      const p = /^\s*(all(?:\s+privileges)?|select|insert|update|delete|truncate|references|trigger|maintain)\s*(?:\(([^)]*)\))?\s*$/i.exec(raw);
      if (!p) continue;
      privs.push({ priv: /^all/i.test(p[1]!) ? "ALL" : p[1]!.toUpperCase(), cols: p[2] === undefined ? null : splitTop(p[2]).map(fold) });
    }
    if (privs.length) out.push({ pos: base + h.index, kind, roles, privs });
  }
  return out;
}

function tableDdlEvents(src: string, base: number, table: string): Event[] {
  const out: Event[] = [];
  const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
  const create = new RegExp(String.raw`\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:${IDENT}\.)?${IDENT})(?![\w$."%])`, "gi");
  for (const m of src.matchAll(create)) {
    if (leads(src, m.index!) && namesTable(m[1]!, table)) out.push({ pos: base + m.index!, kind: "create", roles: [], privs: [] });
  }
  for (const m of src.matchAll(/\bdrop\s+table\s+(?:if\s+exists\s+)?([^;']+)/gi)) {
    if (!leads(src, m.index!)) continue;
    const list = m[1]!.replace(/\b(cascade|restrict)\b/gi, "");
    if (splitTop(list).some((t) => namesTable(t, table))) out.push({ pos: base + m.index!, kind: "drop", roles: [], privs: [] });
  }
  return out;
}

function eventsOf(sql: string, table: string): Event[] {
  const src = blankSqlComments(sql);
  const loops = expandForeachLiteralLoops(src);
  const off = src.length + 1;
  return [
    ...aclEvents(src, 0, table),
    ...tableDdlEvents(src, 0, table),
    ...aclEvents(loops, off, table),
    ...tableDdlEvents(loops, off, table),
  ].sort((a, b) => a.pos - b.pos);
}

function emptyAcl(): TableAcl {
  const r = (): RoleAcl => ({ table: new Set(), cols: new Map() });
  return { anon: r(), authenticated: r(), public: r() };
}

export interface ReplayResult {
  acl: TableAcl;
  /** Events that handed the client roles privileges: a GRANT, or a CREATE TABLE's default ACL (vacuity). */
  openedSeen: number;
  /** The file of the last GRANT that reached each role. */
  lastGrantBy: Partial<Record<AclRole, string>>;
  /** Client roles some REVOKE reached, per file. */
  revokedBy: Map<string, Set<AclRole>>;
}

function apply(acl: TableAcl, e: Event): void {
  if (e.kind === "create") {
    Object.assign(acl, emptyAcl());
    for (const r of ["anon", "authenticated"] as const) for (const p of DEFAULT_CLIENT_DML) acl[r].table.add(p);
    return;
  }
  if (e.kind === "drop") {
    Object.assign(acl, emptyAcl());
    return;
  }
  for (const role of e.roles) {
    const st = acl[role];
    for (const { priv, cols } of e.privs) {
      const names = priv === "ALL" ? (cols === null ? [...TABLE_PRIVS] : [...COLUMN_PRIVS]) : [priv];
      for (const p of names) {
        if (e.kind === "grant") {
          if (cols === null) st.table.add(p);
          else {
            if (!st.cols.has(p)) st.cols.set(p, new Set());
            for (const c of cols) st.cols.get(p)!.add(c);
          }
        } else if (cols === null) {
          // Revoking a table-level privilege revokes it on every column too.
          st.table.delete(p);
          st.cols.delete(p);
        } else for (const c of cols) st.cols.get(p)?.delete(c);
      }
    }
  }
}

/** The post-baseline chain, in byte order of the filename. */
function chainOf(files: readonly MigrationText[]): MigrationText[] {
  return [...files].filter((f) => f.name >= CHAIN_START_PREFIX).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Replay every client GRANT / REVOKE / CREATE / DROP of `table` over the baseline and the chain. */
export function replayClientTableAcl(files: readonly MigrationText[], baselineSql: string, table: string): ReplayResult {
  const acl = emptyAcl();
  let openedSeen = 0;
  const lastGrantBy: ReplayResult["lastGrantBy"] = {};
  const revokedBy = new Map<string, Set<AclRole>>();
  const step = (name: string, sql: string) => {
    for (const e of eventsOf(sql, table)) {
      apply(acl, e);
      if (e.kind === "grant" || e.kind === "create") openedSeen++;
      if (e.kind === "grant") for (const r of e.roles) lastGrantBy[r] = name;
      if (e.kind === "create") for (const r of ["anon", "authenticated"] as const) lastGrantBy[r] = `${name} (CREATE TABLE, default ACL)`;
      if (e.kind === "revoke") {
        if (!revokedBy.has(name)) revokedBy.set(name, new Set());
        for (const r of e.roles) revokedBy.get(name)!.add(r);
      }
    }
  };
  if (baselineSql) step("(baseline)", baselineSql);
  for (const f of chainOf(files)) step(f.name, f.sql);
  return { acl, openedSeen, lastGrantBy, revokedBy };
}

/** Human-readable privileges a role holds at the end of the replay ("" when none). */
export function heldBy(acl: TableAcl, role: AclRole): string[] {
  const out = [...acl[role].table].sort();
  for (const [p, cols] of [...acl[role].cols.entries()].sort()) if (cols.size) out.push(`${p} (${[...cols].sort().join(", ")})`);
  return out;
}

export interface ServerOnlyFinding {
  table: string;
  file: string;
  message: string;
}

/**
 * A `format('GRANT … ON … TO …')` template that may reach a client role and
 * `table`, at an offset NOT inside a FOREACH over a literal array (which
 * expandForeachLiteralLoops resolves and the replay already read): its target
 * is a placeholder, or it names the table through format() — a shape the
 * replay does not read as a statement.
 */
function unresolvedDynamicClientGrants(sql: string, table: string): string[] {
  const src = blankSqlComments(sql);
  const literalLoops: Array<[number, number]> = [];
  for (const m of src.matchAll(/\bforeach\s+[A-Za-z_]\w*\s+in\s+array\s+array\s*\[\s*'(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*\s*\]\s*loop\b([\s\S]*?)\bend\s+loop\b/gi)) {
    literalLoops.push([m.index!, m.index! + m[0].length]);
  }
  const out: string[] = [];
  for (const m of src.matchAll(/\bformat\s*\(\s*'((?:[^']|'')*)'/gi)) {
    const tpl = m[1]!.replace(/''/g, "'");
    if (!/^\s*grant\b/i.test(tpl)) continue;
    const on = /\bon\s+([\s\S]*?)\s+to\s+([\s\S]*)$/i.exec(tpl);
    if (!on) continue;
    const target = on[1]!;
    const placeholder = /%[IsL]/.test(target);
    const schemaWide = /^all\s+tables\s+in\s+schema\b/i.test(target.trim());
    if (!placeholder && !schemaWide && !splitTop(target).some((x) => namesTable(x, table))) continue; // another literal table
    const grantees = on[2]!;
    if (!/(\b(anon|authenticated|public)\b|%[IsL])/i.test(grantees)) continue; // reaches service_role / a named role only
    if (literalLoops.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
    out.push(tpl.trim().slice(0, 120));
  }
  return out;
}

/**
 * Rule 7. `realTree` turns on the vacuity checks (the baseline grant and the
 * closing REVOKE must both be seen; the closing file must be in the chain).
 */
export function findServerOnlyTableBreaches(
  files: readonly MigrationText[],
  baselineSql: string,
  opts: { realTree: boolean; tables?: readonly ServerOnlyTable[] },
): { findings: ServerOnlyFinding[]; vacuity: string[] } {
  const findings: ServerOnlyFinding[] = [];
  const vacuity: string[] = [];
  for (const t of opts.tables ?? SERVER_ONLY_TABLES) {
    const r = replayClientTableAcl(files, baselineSql, t.table);
    for (const role of ROLES) {
      const held = heldBy(r.acl, role);
      if (!held.length) continue;
      findings.push({
        table: t.table,
        file: r.lastGrantBy[role] ?? "(replayed chain)",
        message:
          `public.${t.table} ends the chain with ${role === "public" ? "PUBLIC" : role} holding ${held.join(", ")}. ` +
          `It is server-only since ${t.closedBy}: ${t.why}. A client path needs the API, not a GRANT; to change that, ` +
          `remove the table from SERVER_ONLY_TABLES (src/scripts/lib/serverOnlyTables.ts) and from the authorization contract in the same reviewed change.`,
      });
    }
    for (const f of chainOf(files).filter((x) => x.name > t.closedBy)) {
      for (const tpl of unresolvedDynamicClientGrants(f.sql, t.table)) {
        findings.push({
          table: t.table,
          file: f.name,
          message:
            `a run-time-named client GRANT ('${tpl}') after ${t.closedBy}: the replay cannot see whether it re-opens ` +
            `public.${t.table}. Write its targets out, or loop over a literal array.`,
        });
      }
    }
    if (opts.realTree) {
      if (!files.some((f) => f.name === t.closedBy)) vacuity.push(`${t.table}: its closing migration ${t.closedBy} is not in the chain`);
      if (r.openedSeen === 0) vacuity.push(`${t.table}: the replay never saw the table created or granted to a client role (the baseline does both)`);
      const rev = r.revokedBy.get(t.closedBy);
      if (!rev || !rev.has("anon") || !rev.has("authenticated")) {
        vacuity.push(`${t.table}: the replay did not see ${t.closedBy} revoke the table from both anon and authenticated`);
      }
    }
  }
  return { findings, vacuity };
}
