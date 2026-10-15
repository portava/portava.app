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
 * ── THE RULE: what it reads, exactly ────────────────────────────────────────
 * It does not prove that no migration can grant the table back; it fails on
 * every shape below, and the shapes it cannot read are listed under KNOWN
 * LIMITS. For each table in SERVER_ONLY_TABLES:
 *
 * 1. THE REPLAY. Every GRANT and REVOKE that reaches the table is replayed, the
 *    baseline first and then the chain in filename order: named (`public.t`,
 *    `t`, `TABLE public.t`, quoted, a target list) or `ALL TABLES IN SCHEMA
 *    public`; written out, an EXECUTE operand in one literal (`'…'` or
 *    `$tag$…$tag$` — a dollar-quote delimiter ends the statement), or issued by
 *    a FOREACH over a literal array (expandForeachLiteralLoops); per role
 *    (`anon`, `authenticated`, `PUBLIC`, with or without the legacy GROUP
 *    keyword), at table level and at column level, with PostgreSQL's rule that
 *    revoking a table-level privilege also revokes that privilege on every
 *    column. A CREATE TABLE of the table, or an `ALTER TABLE x RENAME TO
 *    <table>`, resets it to Supabase's default ACL (the four DML privileges for
 *    both client roles: the renamed table's own ACL is not replayed), so a
 *    REVOKE must follow under the protected name; a DROP TABLE empties it
 *    (renaming the table away does not: its grants go with its rows). At the
 *    end of the chain no role may hold anything.
 *    A statement is read only where SQL_STATEMENT_LEAD says one can begin, so a
 *    RAISE message or a COMMENT that reads like a GRANT is not one.
 * 2. THE STRING RULE, after the table's closing migration. Every string whose
 *    text begins with GRANT, whatever its quoting (`'…'`, `E'…'`,
 *    `$tag$…$tag$`), is read up to the next `;`: an EXECUTE operand, a format()
 *    template, a concatenation, a variable assigned the statement. It fails when
 *    the target names the table, is a run-time value (a placeholder, `||`, a
 *    quote_* or format() call) or ALL TABLES IN SCHEMA, and the grantee is a
 *    client role, PUBLIC, GROUP or a run-time value. Only the shape the replay
 *    resolves exactly is exempt: a single-quoted `format('GRANT … %I …', var)`
 *    inside a FOREACH over a literal array.
 * 3. MEMBERSHIP. A `GRANT some_role TO anon | authenticated | PUBLIC` (or TO
 *    GROUP …) anywhere in the baseline or the chain fails: neither this replay
 *    nor check:authorization-contract can see what some_role holds.
 *
 * VACUITY (real tree): the replay must see the table handed to the client roles
 * (the baseline's CREATE TABLE under the default ACL, or a GRANT) AND the
 * closing migration revoke it from both; a parser gone blind would otherwise
 * read "nothing is held" as a pass.
 *
 * KNOWN LIMITS, stated so they are not mistaken for coverage:
 *   * A GRANT assembled from pieces that split the word GRANT itself, or built
 *     by a function the migration calls, is not read by the string rule.
 *   * The string rule reads only files after the closing migration; before it,
 *     only the replay reads the chain (and the closing REVOKE ALL follows); a dynamic membership grant BEFORE the closing file is therefore unseen.
 *   * A `RENAME TO` is treated as a fresh table; `ALTER TABLE … SET SCHEMA` and
 *     a table created in another schema then moved are not modelled, nor are `ALTER TABLE … OWNER TO <client role>`, `SELECT … INTO public.memories` or a name spaced round the dot (`public . memories`). Views over the table are rule 5's.
 *   * Apply order is filename byte order; ORDER_OVERRIDES.json must not move a
 *     closing migration (the test pins it).
 *   * The LIVE backstop is check:authorization-contract (the table is in
 *     src/security/authorization-contract.json with no client grant). It reads
 *     information_schema.role_table_grants by grantee name and only the
 *     INSERT/UPDATE column privileges (checkAuthorizationContract.ts), so it
 *     never sees a membership grant or a column-level SELECT, and it sees a
 *     table grant only after main applies it to portava-ci. 3813's
 *     postcondition asks has_table_privilege / has_any_column_privilege, which
 *     do follow membership and columns, on the database it is applied to.
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
  {
    table: "memory_saves",
    closedBy: "3814_memory_social_client_privileges_revoked.sql",
    why:
      "Memory saves: a signed-in client could save ANY Memory id directly, and the FK answered 23503 vs success — an existence " +
      "oracle on private and removed Memories; the API checks blocks and canReadMemory (3814, census-highlights-memories §BL)",
  },
  {
    table: "memory_likes",
    closedBy: "3814_memory_social_client_privileges_revoked.sql",
    why:
      "Memory likes: a client could like ANY Memory id (same existence oracle) and read who liked a public Memory past the " +
      "API's block filter (3814, §BL)",
  },
  {
    table: "memory_tags",
    closedBy: "3814_memory_social_client_privileges_revoked.sql",
    why:
      "Memory tags: a tagged person could re-point their tag row's memory_id at any Memory, and an owner could insert a tag " +
      "already approved (3814, §BL)",
  },
  {
    table: "memory_items",
    closedBy: "3814_memory_social_client_privileges_revoked.sql",
    why:
      "Memory items: an owner could attach another user's storage object as a photo past the API's foreign_storage refusal " +
      "(3814, §BL)",
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
  kind: "grant" | "revoke" | "create" | "drop" | "rename-in";
  roles: AclRole[];
  privs: Array<{ priv: string; cols: string[] | null }>;
}

const leads = (src: string, at: number) => SQL_STATEMENT_LEAD.test(src.slice(Math.max(0, at - 32), at));

/**
 * Statement text from `from` to the first `;`, `'` (an EXECUTE literal's close)
 * or dollar-quote delimiter (`$$`, `$tag$`: an `EXECUTE $q$…$q$` body's close)
 * at paren depth 0.
 */
function statementFrom(src: string, from: number): string {
  let depth = 0;
  let i = from;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if ((ch === ";" || ch === "'") && depth === 0) break;
    else if (ch === "$" && depth === 0 && /^\$(?:[A-Za-z_]\w*)?\$/.test(src.slice(i, i + 66))) break;
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

/** A grantee list as roles: GRANTED BY / WITH … OPTION / CASCADE cut, the legacy GROUP keyword dropped, folded. */
function granteesOf(text: string): string[] {
  return splitTop(text.replace(/\b(with\s+(grant|admin|inherit|set)\s+option|with\s+(admin|inherit|set)\s+\w+|granted\s+by|cascade|restrict)\b[\s\S]*$/i, ""))
    .map((r) => fold(r.trim().replace(/^group\s+/i, "")));
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
    if (!on) continue; // role membership: reported by membershipGrants, not replayed
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

    const roles = granteesOf(stmt).filter((r): r is AclRole => (ROLES as readonly string[]).includes(r));
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
  // ALTER TABLE x RENAME TO <table>: another table takes the name, with an ACL
  // this replay never read — treated like a CREATE (the default client DML), so
  // a REVOKE must follow under the protected name. Renaming the table AWAY is
  // deliberately not an empty name: its rows and any client grant on them go
  // with it, so whatever the name held stays a finding.
  const rename = new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?((?:${IDENT}\.)?${IDENT})\s+rename\s+to\s+(${IDENT})`, "gi");
  for (const m of src.matchAll(rename)) {
    if (!leads(src, m.index!)) continue;
    const from = namesTable(m[1]!, table);
    const to = namesTable(m[2]!, table);
    if (to && !from) out.push({ pos: base + m.index!, kind: "rename-in", roles: [], privs: [] });
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
  if (e.kind === "create" || e.kind === "rename-in") {
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

/** Replay every client GRANT / REVOKE / CREATE / DROP / RENAME TO of `table` over the baseline and the chain. */
export function replayClientTableAcl(files: readonly MigrationText[], baselineSql: string, table: string): ReplayResult {
  const acl = emptyAcl();
  let openedSeen = 0;
  const lastGrantBy: ReplayResult["lastGrantBy"] = {};
  const revokedBy = new Map<string, Set<AclRole>>();
  const step = (name: string, sql: string) => {
    for (const e of eventsOf(sql, table)) {
      apply(acl, e);
      if (e.kind === "grant" || e.kind === "create" || e.kind === "rename-in") openedSeen++;
      if (e.kind === "grant") for (const r of e.roles) lastGrantBy[r] = name;
      if (e.kind === "create") for (const r of ["anon", "authenticated"] as const) lastGrantBy[r] = `${name} (CREATE TABLE, default ACL)`;
      if (e.kind === "rename-in") for (const r of ["anon", "authenticated"] as const) lastGrantBy[r] = `${name} (RENAME TO ${table}: the renamed table's ACL is not replayed)`;
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

/** Text that makes a GRANT's target or grantee a run-time value: a format() placeholder, a concatenation, a quoting call. */
const RUN_TIME_PART = /%(?:\d+\$)?[IsL]|\|\||\bquote_(ident|literal|nullable)\s*\(|\bformat\s*\(/i;

/**
 * The CONSERVATIVE string rule, for the chain after a closing migration. Every
 * string whose text BEGINS with GRANT, whatever its quoting (`'…'`, `E'…'`,
 * `$tag$…$tag$`), is read as raw text up to the next `;` — so an EXECUTE
 * operand, a format() template, a concatenation (`'GRANT … TO ' || g`) and a
 * variable assigned the statement are all read, not only the shapes the replay
 * parses. It is a finding when the target (between `on` and the last `to`)
 * names the table, is a run-time value or ALL TABLES IN SCHEMA, or is missing,
 * AND the grantee (after the last `to`) is a client role, PUBLIC, GROUP, a
 * run-time value, or missing. A GRANT the replay also reads is reported a
 * second time, which costs nothing. The one shape exempted is the one the
 * replay resolves exactly: a single-quoted `format('GRANT … %I …', var)`
 * template inside a FOREACH over a literal array, with no concatenation and no
 * literal name of the table (expandForeachLiteralLoops writes its iterations
 * out). A statement assembled from pieces that split the word GRANT itself is
 * not read (KNOWN LIMITS).
 */
function unresolvedDynamicClientGrants(sql: string, table: string, stats?: { grantStrings: number; exemptLoopTemplates: number }): string[] {
  const src = blankSqlComments(sql);
  const literalLoops: Array<[number, number]> = [];
  for (const m of src.matchAll(/\bforeach\s+[A-Za-z_]\w*\s+in\s+array\s+array\s*\[\s*'(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*\s*\]\s*loop\b([\s\S]*?)\bend\s+loop\b/gi)) {
    literalLoops.push([m.index!, m.index! + m[0].length]);
  }
  const nameRe = new RegExp(String.raw`(^|[^\w$])${table}(?![\w$])`, "i");
  const out: string[] = [];
  for (const m of src.matchAll(/([Ee]?'|\$(?:[A-Za-z_]\w*)?\$)\s*grant\b/gi)) {
    const semi = src.indexOf(";", m.index!);
    const window = src.slice(m.index!, Math.min(semi < 0 ? src.length : semi, m.index! + 4000));
    if (stats) stats.grantStrings++;
    const rest = window.slice(window.search(/grant\b/i));
    let toAt = -1;
    for (const t of rest.matchAll(/\bto\b/gi)) toAt = t.index!;
    const on = /\bon\b/i.exec(rest);
    const targetPart = on && (toAt < 0 || on.index < toAt) ? rest.slice(on.index + 2, toAt < 0 ? undefined : toAt) : null;
    const granteePart = toAt < 0 ? null : rest.slice(toAt + 2);
    const targetHit =
      targetPart === null || nameRe.test(targetPart) || RUN_TIME_PART.test(targetPart) || /\ball\s+tables\s+in\s+schema\b/i.test(targetPart);
    const granteeHit = granteePart === null || /\b(anon|authenticated|public|group)\b/i.test(granteePart) || RUN_TIME_PART.test(granteePart);
    if (!targetHit || !granteeHit) continue;
    // Exempt ONLY what expandFormatExecutes resolves (VERIFY-726 delta fix 1): `EXECUTE format(` written
    // directly, every argument the loop variable or a plain '…' literal, no positional %n$ placeholder.
    const loop = literalLoops.find(([a, b]) => m.index! >= a && m.index! < b);
    const argsResolvable = (): boolean => {
      if (!loop) return false;
      const lv = /\bforeach\s+([A-Za-z_]\w*)/i.exec(src.slice(loop[0]))![1]!.toLowerCase();
      let j = m.index! + 1; // past the opening '
      for (; j < src.length; j++) { if (src[j] === "'") { if (src[j + 1] === "'") { j++; continue; } break; } }
      let depth = 1, k = j + 1;
      for (; k < src.length && depth > 0; k++) { if (src[k] === "(") depth++; else if (src[k] === ")") depth--; }
      const args = splitTop(src.slice(j + 1, k - 1)).map((a) => a.trim()).filter(Boolean);
      return args.every((a) => a.toLowerCase() === lv || /^'(?:[^']|'')*'$/.test(a));
    };
    const plainLoopTemplate =
      m[1] === "'" && /\bexecute\s+format\s*\(\s*$/i.test(src.slice(Math.max(0, m.index! - 40), m.index!)) &&
      !/\|\|/.test(window) && !/%\d+\$/.test(window) && targetPart !== null && !nameRe.test(targetPart) && argsResolvable();
    if (plainLoopTemplate) {
      if (stats) stats.exemptLoopTemplates++;
      continue;
    }
    out.push(window.replace(/\s+/g, " ").trim().slice(0, 120));
  }
  return out;
}

/**
 * Role MEMBERSHIP granted to a client role — `GRANT some_role TO authenticated`
 * (or `TO GROUP …`, `TO PUBLIC`), written out or as an EXECUTE literal. The
 * replay cannot see what some_role holds on a server-only table, and neither
 * can check:authorization-contract (it reads grants by grantee name), so every
 * such statement in the baseline or the chain is a finding. None exists today.
 */
function membershipGrants(sql: string, stats?: ScanStats): string[] {
  const src = blankSqlComments(sql);
  const out: string[] = [];
  for (const text of [src, expandForeachLiteralLoops(src)]) {
    for (const h of text.matchAll(/\bgrant\s+/gi)) {
      if (!leads(text, h.index!)) continue;
      const stmt = statementFrom(text, h.index! + h[0].length);
      if (/\bon\b/i.test(stmt)) continue; // a privilege on an object: the replay's business
      const to = /\bto\b/i.exec(stmt);
      if (!to) continue;
      if (stats) stats.membershipStatementsSeen++;
      const grantees = granteesOf(stmt.slice(to.index + 2));
      if (grantees.some((r) => (ROLES as readonly string[]).includes(r))) out.push(`GRANT ${stmt.replace(/\s+/g, " ").trim()}`.slice(0, 120));
    }
  }
  return out;
}

/** What the string rule and the membership scan read (anti-vacuity for the tests). */
export interface ScanStats {
  /** Strings beginning with GRANT read by the conservative rule, summed over the server-only tables' post-closing files. */
  grantStrings: number;
  /** Of those, single-quoted FOREACH-literal format() templates left to the replay. */
  exemptLoopTemplates: number;
  /** Membership-shaped GRANT statements (no ON) seen in the baseline and the chain, whoever the grantee. */
  membershipStatementsSeen: number;
}

/**
 * Rule 7. `realTree` turns on the vacuity checks (the baseline grant and the
 * closing REVOKE must both be seen; the closing file must be in the chain).
 */
export function findServerOnlyTableBreaches(
  files: readonly MigrationText[],
  baselineSql: string,
  opts: { realTree: boolean; tables?: readonly ServerOnlyTable[] },
): { findings: ServerOnlyFinding[]; vacuity: string[]; scanned: ScanStats } {
  const findings: ServerOnlyFinding[] = [];
  const vacuity: string[] = [];
  const scanned: ScanStats = { grantStrings: 0, exemptLoopTemplates: 0, membershipStatementsSeen: 0 };
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
      for (const tpl of unresolvedDynamicClientGrants(f.sql, t.table, scanned)) {
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
  const tables = (opts.tables ?? SERVER_ONLY_TABLES).map((t) => t.table);
  const sources: MigrationText[] = [...(baselineSql ? [{ name: "(baseline)", sql: baselineSql }] : []), ...chainOf(files)];
  for (const f of sources) {
    for (const stmt of membershipGrants(f.sql, scanned)) {
      findings.push({
        table: tables.join(", "),
        file: f.name,
        message:
          `role membership granted to a client role ('${stmt}'): rule 7 cannot see what the member role holds on ` +
          `${tables.map((x) => `public.${x}`).join(" or ")}, and check:authorization-contract reads grants by grantee name and never sees it. ` +
          `Grant the privileges a client path needs to the client role itself, by name.`,
      });
    }
  }
  return { findings, vacuity, scanned };
}
