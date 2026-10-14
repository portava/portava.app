/**
 * memorySocialClientBoundary — lane MEM-ACL-2 (follow-up to 3813 / PR #726,
 * census-highlights-memories §BL): migration 3814 closes the client doors on
 * public.memory_saves, public.memory_likes, public.memory_tags and
 * public.memory_items, and THIS FILE is the static guard that keeps them closed.
 *
 * THE DEFECT. The baseline grants ALL on the four tables to anon and
 * authenticated (2490 left SELECT, INSERT, UPDATE, DELETE) and RLS decides rows
 * only: a signed-in user saves and likes ANY Memory id (memory_saves_own,
 * memory_likes_own), and the foreign key — checked as the owner — answers
 * whether that id exists; a tagged person re-points their tag row at another
 * Memory (memory_tags_tagged_update writes every column); an owner inserts tags
 * and photos past the API's checks (memory_tags_owner_insert,
 * memory_items_via_memory); any signed-in user reads who liked a public Memory
 * (memory_likes_read). No client tree uses any of it: likes and saves go through
 * POST|DELETE /memories/:id/like and /save.
 *
 * WHY THE GUARD LIVES HERE. PR #726 adds rule 7 of check:client-privilege-boundary
 * (src/scripts/lib/serverOnlyTables.ts, SERVER_ONLY_TABLES) for public.memories;
 * it is NOT merged as this file is written, and its parser is being hardened on
 * its own branch. Until it merges, this suite replays the chain for the four
 * tables itself. MERGE PATH: once #726 is on main, add the four tables to
 * SERVER_ONLY_TABLES (closedBy 3814) — data only, the parser is #726's — and this
 * suite's G-* block becomes a second opinion rather than the only one.
 *
 * WHAT IS PROVEN HERE, OFFLINE (the executed proof against PostgreSQL is
 * src/test/db/memorySocialClientBoundary.db.test.ts, run by CI's local-db job):
 *   A-*  the chain's END STATE for each table, replayed in apply order over the
 *        baseline and every migration: no client role or PUBLIC holds anything
 *        — and without 3814 both client roles hold the four DML privileges
 *        (anti-vacuity: the defect is on main).
 *   G-*  the guard: every shape that would hand a client role one of the four
 *        back after 3814 fails it — written out, column-level, ALL, ALL TABLES IN
 *        SCHEMA, a FOREACH loop, a dollar-quoted / E'' / concatenated / format()
 *        EXECUTE, TO GROUP, a role-membership grant, a RENAME into the name, a
 *        re-CREATE — and none of the shapes that do not.
 *   B-*  3814 and its rollback are shaped as they claim.
 *   P-*  the premise: no client tree reads or writes the four directly, and
 *        every chain function that does is service-role-only or a definer trigger.
 *   K-*  the live guard agrees: the four are in the authorization contract with
 *        no client grant and exactly their baseline (3672) policies.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memorySocialClientBoundary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { blankSqlComments, CHAIN_START_PREFIX, expandForeachLiteralLoops } from "../scripts/lib/liveVsCanonicalCore.js";
import { isAssertionOnlyDoBlock, isPreconditionDoBlock, topLevelStatements } from "../scripts/lib/migrationSqlBlocks.js";
import { BASELINE_PATH } from "../scripts/parseBaselineSchema.js";
import { loadContract } from "../security/authorizationContract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const MIGRATIONS = join(API_ROOT, "src", "migrations");
const CLOSER = "3814_memory_social_client_privileges_revoked.sql";
const ROLLBACK = join(REPO_ROOT, "db", "rollback", "2026-10-14-3814-memory-social-client-privileges-revoked-rollback.sql");
const TABLES = ["memory_saves", "memory_likes", "memory_tags", "memory_items"] as const;
type Table = (typeof TABLES)[number];
const BASELINE = readFileSync(BASELINE_PATH, "utf8");

type Mig = { name: string; sql: string };
let realFiles: Mig[] | null = null; // read once: every replay below shares these objects (and their memoised events)
const chain = (skip: readonly string[] = [], extra: readonly Mig[] = []): Mig[] => {
  realFiles ??= readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") }));
  return [...realFiles.filter((f) => !skip.includes(f.name)), ...extra].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

// ════════════════════════════════════════════════════════════════════════════
// THE GUARD — a replay of every client GRANT / REVOKE / CREATE / DROP of one
// table over the baseline and the chain, plus a conservative report of what a
// replay cannot resolve, after the closing file.
// ════════════════════════════════════════════════════════════════════════════
type Role = "anon" | "authenticated" | "public";
const ROLES: readonly Role[] = ["anon", "authenticated", "public"];
const TABLE_PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
const COLUMN_PRIVS = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
/** What a CREATE TABLE in public hands both client roles under Supabase's default ACL after 2490. */
const DEFAULT_CLIENT_DML = ["SELECT", "INSERT", "UPDATE", "DELETE"];

/**
 * Where a statement can begin. Wider than liveVsCanonicalCore's
 * SQL_STATEMENT_LEAD on purpose: an E'' literal, a format() template in any
 * quoting, and a literal assigned to a variable (later EXECUTEd) all count —
 * VERIFY-726 planted those shapes past rule 7's first parser.
 */
const LEAD =
  /(?:^|;|\bexecute\s+e?'|\bexecute\s*\$(?:[A-Za-z_]\w*)?\$|\bformat\s*\(\s*e?'|\bformat\s*\(\s*\$(?:[A-Za-z_]\w*)?\$|:=\s*e?'|:=\s*\$(?:[A-Za-z_]\w*)?\$|\b(?:as|do)\s*\$(?:[A-Za-z_]\w*)?\$|\b(?:begin|then|else|loop|do)\b)\s*$/i;
const leads = (src: string, at: number) => LEAD.test(src.slice(Math.max(0, at - 40), at));

/** Statement text from `from` to the first `;`, `'` or dollar-quote delimiter at paren depth 0. */
function statementFrom(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (ch === ";" || ch === "'" || (ch === "$" && /^\$(?:[A-Za-z_]\w*)?\$/.test(src.slice(i, i + 64))))) return src.slice(from, i);
  }
  return src.slice(from);
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
const IDENT = /^(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)$/;
/** A plain identifier or schema.identifier: nothing a run-time value could stand in. */
const isLiteralName = (s: string) => s.trim().split(".").every((p) => IDENT.test(p.trim()));
const fold = (id: string) => {
  const t = id.trim();
  return /^".*"$/.test(t) ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase();
};
function namesTable(target: string, table: string): boolean {
  const parts = target.trim().replace(/^table\s+/i, "").split(".").map(fold);
  return parts.length === 1 ? parts[0] === table : parts.length === 2 && parts[0] === "public" && parts[1] === table;
}

interface AclEvent { pos: number; kind: "grant" | "revoke" | "create" | "drop"; roles: Role[]; privs: Array<{ priv: string; cols: string[] | null }> }
interface Unresolved { pos: number; text: string; why: string }
type Reach = "yes" | "no" | "unknown";

/** One table's ACL events in one file, and what this parser cannot resolve. */
function eventsOf(sql: string, table: Table): { events: AclEvent[]; unresolved: Unresolved[] } {
  const src = blankSqlComments(sql);
  const events: AclEvent[] = [];
  const unresolved: Unresolved[] = [];
  const literalLoops: Array<[number, number]> = [];
  for (const m of src.matchAll(/\bforeach\s+[A-Za-z_]\w*\s+in\s+array\s+array\s*\[\s*'(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*\s*\]\s*loop\b[\s\S]*?\bend\s+loop\b/gi)) {
    literalLoops.push([m.index!, m.index! + m[0].length]);
  }
  const inLiteralLoop = (at: number) => literalLoops.some(([a, b]) => at >= a && at < b);

  const scan = (text: string, base: number, fromLoops: boolean) => {
    for (const h of text.matchAll(/\b(grant|revoke)\s+/gi)) {
      if (!leads(text, h.index!)) continue;
      const kind = h[1]!.toLowerCase() as "grant" | "revoke";
      const stmt = statementFrom(text, h.index! + h[0].length);
      if (kind === "revoke" && /^\s*grant\s+option\s+for\b/i.test(stmt)) continue; // takes the grant option only
      const pos = base + h.index!;
      const runtimeOk = fromLoops || inLiteralLoop(h.index!);
      const flag = (why: string) => {
        if (kind === "grant" && !runtimeOk) unresolved.push({ pos, text: `GRANT ${stmt}`.replace(/\s+/g, " ").trim().slice(0, 160), why });
      };
      const on = /\bon\b/i.exec(stmt);
      const kw = kind === "grant" ? "to" : "from";
      if (!on) {
        // GRANT <role> TO <role>: membership. Nothing a table ACL replay can follow.
        const to = new RegExp(String.raw`\b${kw}\b([\s\S]*)$`, "i").exec(stmt);
        if (kind === "grant" && to && granteesReachClient(to[1]!) !== "no") flag("a role-membership grant to a client role");
        continue;
      }
      const toFrom = new RegExp(String.raw`\b${kw}\b`, "i").exec(stmt.slice(on.index));
      const privText = stmt.slice(0, on.index);
      const targetText = toFrom ? stmt.slice(on.index + 2, on.index + toFrom.index).trim() : stmt.slice(on.index + 2).trim();
      const granteeText = toFrom ? stmt.slice(on.index + toFrom.index + toFrom[0].length) : "";

      const schemaWide = /^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i.exec(targetText);
      let reach: Reach;
      if (schemaWide) {
        const schemas = splitTop(schemaWide[1]!);
        reach = schemas.some((s) => isLiteralName(s) && fold(s) === "public") ? "yes" : schemas.every((s) => isLiteralName(s)) ? "no" : "unknown";
      } else if (/^(function|procedure|routine|sequence|schema|database|domain|type|language|large\s+object|foreign|tablespace|parameter|all\s+(sequences|functions|procedures|routines))\b/i.test(targetText)) {
        continue;
      } else {
        const targets = splitTop(targetText);
        if (!targets.length) reach = "unknown";
        else if (targets.some((t) => isLiteralName(t.replace(/^\s*table\s+/i, "")) && namesTable(t, table))) reach = "yes";
        else reach = targets.every((t) => isLiteralName(t.replace(/^\s*table\s+/i, ""))) ? "no" : "unknown";
      }
      if (reach === "no") continue;
      const clientReach = granteesReachClient(granteeText);
      if (clientReach === "no") continue;
      if (reach === "unknown" || clientReach === "unknown") {
        flag(reach === "unknown" ? "a run-time or unreadable target" : "a run-time or unreadable grantee");
        if (reach === "unknown") continue;
      }
      const roles = granteeList(granteeText).filter((r): r is Role => (ROLES as readonly string[]).includes(r));
      if (!roles.length) continue;
      const privs: AclEvent["privs"] = [];
      for (const raw of splitTop(privText)) {
        const p = /^\s*(all(?:\s+privileges)?|select|insert|update|delete|truncate|references|trigger|maintain)\s*(?:\(([^)]*)\))?\s*$/i.exec(raw);
        if (!p) {
          flag("an unreadable privilege list");
          continue;
        }
        privs.push({ priv: /^all/i.test(p[1]!) ? "ALL" : p[1]!.toUpperCase(), cols: p[2] === undefined ? null : splitTop(p[2]).map(fold) });
      }
      if (privs.length) events.push({ pos, kind, roles, privs });
    }
    const T = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
    for (const m of text.matchAll(new RegExp(String.raw`\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:${T}\.)?${T})(?![\w$."%])`, "gi"))) {
      if (leads(text, m.index!) && namesTable(m[1]!, table)) events.push({ pos: base + m.index!, kind: "create", roles: [], privs: [] });
    }
    for (const m of text.matchAll(/\bdrop\s+table\s+(?:if\s+exists\s+)?([^;']+)/gi)) {
      if (leads(text, m.index!) && splitTop(m[1]!.replace(/\b(cascade|restrict)\b/gi, "")).some((t) => namesTable(t, table))) {
        events.push({ pos: base + m.index!, kind: "drop", roles: [], privs: [] });
      }
    }
    for (const m of text.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?[^;']*?\brename\s+to\s+("?[A-Za-z_][\w$]*"?)/gi)) {
      if (fold(m[1]!) === table && !fromLoops) unresolved.push({ pos: base + m.index!, text: m[0].replace(/\s+/g, " ").slice(0, 160), why: "a table renamed INTO the name keeps whatever ACL it carried" });
    }
  };
  scan(src, 0, false);
  scan(expandForeachLiteralLoops(src), src.length + 1, true);
  events.sort((a, b) => a.pos - b.pos);
  return { events, unresolved };
}
/** eventsOf is pure in (sql, table); the baseline and the real files are parsed once per table, not once per test. */
const memo = new Map<string, Map<string, ReturnType<typeof eventsOf>>>();
function eventsMemo(sql: string, table: Table): ReturnType<typeof eventsOf> {
  let byTable = memo.get(table);
  if (!byTable) memo.set(table, (byTable = new Map()));
  let r = byTable.get(sql);
  if (!r) byTable.set(sql, (r = eventsOf(sql, table)));
  return r;
}
function granteeList(text: string): string[] {
  return splitTop(text.replace(/\b(with\s+grant\s+option|granted\s+by|cascade|restrict)\b[\s\S]*$/i, ""))
    .map((g) => g.trim().replace(/^group\s+/i, ""))
    .filter((g) => g !== "")
    .map(fold);
}
/** Does a grantee list reach anon, authenticated or PUBLIC? "unknown" when any entry is not a literal role name. */
function granteesReachClient(text: string): Reach {
  const raw = splitTop(text.replace(/\b(with\s+grant\s+option|granted\s+by|cascade|restrict)\b[\s\S]*$/i, "")).map((g) => g.trim().replace(/^group\s+/i, ""));
  if (!raw.filter((g) => g !== "").length) return "unknown"; // cut at a quote: the grantee is concatenated on at run time
  if (raw.some((g) => g !== "" && isLiteralName(g) && (ROLES as readonly string[]).includes(fold(g)))) return "yes";
  return raw.every((g) => g === "" || isLiteralName(g)) ? "no" : "unknown";
}

type Acl = Record<Role, { table: Set<string>; cols: Map<string, Set<string>> }>;
const emptyAcl = (): Acl => ({
  anon: { table: new Set(), cols: new Map() },
  authenticated: { table: new Set(), cols: new Map() },
  public: { table: new Set(), cols: new Map() },
});
function applyEvent(acl: Acl, e: AclEvent): void {
  if (e.kind === "create" || e.kind === "drop") {
    Object.assign(acl, emptyAcl());
    if (e.kind === "create") for (const r of ["anon", "authenticated"] as const) for (const p of DEFAULT_CLIENT_DML) acl[r].table.add(p);
    return;
  }
  for (const role of e.roles) {
    const st = acl[role];
    for (const { priv, cols } of e.privs) {
      for (const p of priv === "ALL" ? (cols === null ? TABLE_PRIVS : COLUMN_PRIVS) : [priv]) {
        if (e.kind === "grant") {
          if (cols === null) st.table.add(p);
          else {
            if (!st.cols.has(p)) st.cols.set(p, new Set());
            for (const c of cols) st.cols.get(p)!.add(c);
          }
        } else if (cols === null) {
          st.table.delete(p); // a table-level REVOKE takes the column grants with it
          st.cols.delete(p);
        } else for (const c of cols) st.cols.get(p)?.delete(c);
      }
    }
  }
}
function heldBy(acl: Acl, role: Role): string[] {
  const out = [...acl[role].table].sort();
  for (const [p, cols] of [...acl[role].cols.entries()].sort()) if (cols.size) out.push(`${p} (${[...cols].sort().join(", ")})`);
  return out;
}
interface Replay { acl: Acl; opened: number; revokedByCloser: Set<Role>; revokedBy: Map<string, Set<Role>>; unresolvedAfterCloser: Array<{ file: string; text: string; why: string }> }
function replay(files: readonly Mig[], table: Table): Replay {
  const acl = emptyAcl();
  let opened = 0;
  const revokedBy = new Map<string, Set<Role>>();
  const unresolvedAfterCloser: Replay["unresolvedAfterCloser"] = [];
  const step = (name: string, sql: string, after: boolean) => {
    const { events, unresolved } = eventsMemo(sql, table);
    for (const e of events) {
      applyEvent(acl, e);
      if (e.kind === "grant" || e.kind === "create") opened++;
      if (e.kind === "revoke") {
        if (!revokedBy.has(name)) revokedBy.set(name, new Set());
        for (const r of e.roles) revokedBy.get(name)!.add(r);
      }
    }
    if (after) for (const u of unresolved) unresolvedAfterCloser.push({ file: name, text: u.text, why: u.why });
  };
  step("(baseline)", BASELINE, false);
  for (const f of files.filter((x) => x.name >= CHAIN_START_PREFIX)) step(f.name, f.sql, f.name > CLOSER);
  return { acl, opened, revokedByCloser: revokedBy.get(CLOSER) ?? new Set(), revokedBy, unresolvedAfterCloser };
}
/** The guard: every finding that would put a client role back on one of the four. Empty = the doors stay shut. */
function breaches(files: readonly Mig[]): string[] {
  const out: string[] = [];
  if (!files.some((f) => f.name === CLOSER)) out.push(`VACUOUS: ${CLOSER} is not in the chain`);
  for (const t of TABLES) {
    const r = replay(files, t);
    if (r.opened === 0) out.push(`VACUOUS: the replay never saw public.${t} opened to a client role (the baseline does)`);
    for (const role of ["anon", "authenticated"] as const) if (!r.revokedByCloser.has(role)) out.push(`VACUOUS: the replay did not see ${CLOSER} revoke public.${t} from ${role}`);
    for (const role of ROLES) {
      const held = heldBy(r.acl, role);
      if (held.length) out.push(`public.${t} ends the chain with ${role === "public" ? "PUBLIC" : role} holding ${held.join(", ")}`);
    }
    for (const u of r.unresolvedAfterCloser) out.push(`${u.file}: ${u.why} after ${CLOSER} may re-open public.${t}: ${u.text}`);
  }
  return out;
}

describe("MEM-ACL-2 — the chain's end state: no client role holds anything on the four tables", () => {
  it("A-0: no apply-order override names 3814 or a file sorting near it (byte order is the apply order here)", () => {
    const overrides = JSON.parse(readFileSync(join(MIGRATIONS, "ORDER_OVERRIDES.json"), "utf8")) as { overrides: Array<Record<string, unknown>> };
    const named = JSON.stringify(overrides.overrides);
    assert.ok(!named.includes(CLOSER), "3814 is moved or skipped by ORDER_OVERRIDES.json");
    for (const m of named.matchAll(/"(\d{4})_[^"]+\.sql"/g)) assert.ok(m[1]! < "3800" || m[1]! > "3819", `an override names ${m[0]} in 3814's band`);
  });

  for (const t of TABLES) {
    it(`A-1 (anti-vacuity, the defect) ${t}: WITHOUT 3814 both client roles end the chain holding SELECT, INSERT, UPDATE and DELETE`, () => {
      const r = replay(chain([CLOSER]), t);
      for (const role of ["anon", "authenticated"] as const) assert.deepEqual(heldBy(r.acl, role), ["DELETE", "INSERT", "SELECT", "UPDATE"], role);
      assert.ok(r.revokedBy.get("2490_destructive_privilege_boundary.sql")?.has("anon"), "the replay sees 2490 take the four unpoliced privileges");
    });
    it(`A-2 THE POINT ${t}: with 3814, anon, authenticated and PUBLIC hold nothing, at table or column level`, () => {
      const r = replay(chain(), t);
      for (const role of ROLES) assert.deepEqual(heldBy(r.acl, role), [], role);
      assert.deepEqual([...r.revokedByCloser].sort(), ["anon", "authenticated", "public"]);
    });
  }

  it("A-3: the guard holds on the real tree and is not blind; without 3814 it reports the vacuity and every client role on every table", () => {
    assert.deepEqual(breaches(chain()), []);
    const blind = breaches(chain([CLOSER]));
    assert.ok(blind.includes(`VACUOUS: ${CLOSER} is not in the chain`), blind.join("\n"));
    for (const t of TABLES) for (const role of ["anon", "authenticated"]) assert.ok(blind.some((b) => b.startsWith(`public.${t} ends the chain with ${role} holding`)), `${t} ${role}`);
  });

  it("A-4: the real files after 3814 carry dynamic SQL the guard reads and correctly leaves alone (anti-vacuity for the conservative report)", () => {
    const after = chain().filter((f) => f.name > CLOSER);
    assert.ok(after.length >= 10, `only ${after.length} files sort after 3814`);
    const dyn = after.filter((f) => /\bexecute\s+format\s*\(\s*'grant\b/i.test(blankSqlComments(f.sql)));
    assert.ok(dyn.length >= 1, "no post-3814 file builds a GRANT with format() any more; the next assertion would be vacuous");
    assert.deepEqual(after.flatMap((f) => TABLES.flatMap((t) => eventsOf(f.sql, t).unresolved.map((u) => `${f.name}: ${u.text}`))), []);
  });
});

describe("the guard fails on every shape that re-opens a table after 3814, and on none that does not", () => {
  const planted = (sql: string, name = "3995_planted.sql") => breaches(chain([], [{ name, sql }]));
  const red: Array<[string, string, RegExp]> = [
    ["a plain table grant", "GRANT SELECT ON public.memory_likes TO authenticated;", /memory_likes ends the chain with authenticated holding SELECT/],
    ["a bare name, quoted, uppercase", 'GRANT INSERT ON TABLE "memory_saves" TO ANON;', /memory_saves ends the chain with anon holding INSERT/],
    ["a column grant", "GRANT UPDATE (memory_id, status) ON public.memory_tags TO authenticated;", /memory_tags ends the chain with authenticated holding UPDATE \(memory_id, status\)/],
    ["GRANT ALL", "GRANT ALL ON public.memory_items TO authenticated;", /memory_items ends the chain with authenticated holding .*TRUNCATE/],
    ["a target list", "GRANT SELECT ON public.trips, public.memory_saves TO anon;", /memory_saves ends the chain with anon holding SELECT/],
    ["PUBLIC", "GRANT SELECT ON public.memory_likes TO PUBLIC;", /memory_likes ends the chain with PUBLIC holding SELECT/],
    ["TO GROUP", "GRANT SELECT ON public.memory_tags TO GROUP authenticated;", /memory_tags ends the chain with authenticated holding SELECT/],
    ["ALL TABLES IN SCHEMA public", "GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;", /memory_items ends the chain with anon holding SELECT/],
    ["a FOREACH over a literal array", "DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['memory_saves'] LOOP EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t); END LOOP; END $$;", /memory_saves ends the chain with authenticated holding SELECT/],
    ["a dollar-quoted EXECUTE", "DO $$ BEGIN EXECUTE $q$GRANT SELECT ON public.memory_likes TO authenticated$q$; END $$;", /memory_likes ends the chain with authenticated holding SELECT/],
    ["an E'' EXECUTE", "DO $$ BEGIN EXECUTE E'GRANT INSERT ON public.memory_saves TO authenticated'; END $$;", /memory_saves ends the chain with authenticated holding INSERT/],
    ["a single-quoted EXECUTE", "DO $$ BEGIN EXECUTE 'GRANT DELETE ON public.memory_tags TO anon'; END $$;", /memory_tags ends the chain with anon holding DELETE/],
    ["a grantee concatenated on", "DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.memory_saves TO ' || 'authenticated'; END $$;", /3995_planted\.sql: a run-time or unreadable grantee after 3814.*memory_saves/],
    ["a grantee from quote_ident", "DO $$ DECLARE g text := 'anon'; BEGIN EXECUTE 'GRANT SELECT ON public.memory_likes TO ' || quote_ident(g); END $$;", /a run-time or unreadable grantee after 3814\S* may re-open public\.memory_likes/],
    ["a table name split across literals", "DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.' || 'memory_tags TO authenticated'; END $$;", /a run-time or unreadable target after 3814\S* may re-open public\.memory_tags/],
    ["a run-time target in format()", "DO $$ DECLARE r record; BEGIN FOR r IN SELECT relname FROM pg_class LOOP EXECUTE format('GRANT SELECT ON public.%I TO authenticated', r.relname); END LOOP; END $$;", /a run-time or unreadable target after 3814\S* may re-open public\.memory_items/],
    ["format(E'')", "DO $$ BEGIN EXECUTE format(E'GRANT SELECT ON public.%I TO anon', 'memory_saves'); END $$;", /a run-time or unreadable target after 3814\S* may re-open public\.memory_saves/],
    ["format($q$…$q$)", "DO $$ BEGIN EXECUTE format($q$GRANT SELECT ON %I TO authenticated$q$, 'memory_likes'); END $$;", /a run-time or unreadable target after 3814\S* may re-open public\.memory_likes/],
    ["a run-time grantee in format()", "DO $$ DECLARE g text; BEGIN EXECUTE format('GRANT SELECT ON public.memory_tags TO %I', g); END $$;", /a run-time or unreadable grantee after 3814\S* may re-open public\.memory_tags/],
    ["a literal assigned to a variable and EXECUTEd", "DO $$ DECLARE s text; BEGIN s := 'GRANT SELECT ON public.memory_items TO authenticated'; EXECUTE s; END $$;", /memory_items ends the chain with authenticated holding SELECT/],
    ["a role-membership grant to a client role", "CREATE ROLE memreader; GRANT memreader TO authenticated;", /a role-membership grant to a client role after 3814/],
    ["a table renamed into the name", "ALTER TABLE public.memory_saves RENAME TO memory_saves_old; CREATE TABLE public.memory_saves_v2 (memory_id uuid); REVOKE ALL ON public.memory_saves_v2 FROM anon, authenticated; ALTER TABLE public.memory_saves_v2 RENAME TO memory_saves;", /a table renamed INTO the name keeps whatever ACL it carried/],
    ["a re-CREATE under Supabase's default ACL", "DROP TABLE public.memory_likes; CREATE TABLE public.memory_likes (memory_id uuid, user_id uuid);", /memory_likes ends the chain with anon holding DELETE, INSERT, SELECT, UPDATE/],
  ];
  for (const [name, sql, re] of red) {
    it(`G-red: ${name}`, () => {
      const b = planted(sql);
      assert.ok(b.some((x) => re.test(x)), `expected ${re} in:\n${b.join("\n") || "(nothing — the guard is blind to this shape)"}`);
    });
  }
  const green: Array<[string, string]> = [
    ["a grant to service_role", "GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_saves TO service_role;"],
    ["a client grant on another table", "GRANT SELECT ON public.memory_saves_archive TO authenticated;"],
    ["a format() grant to service_role (3931's shape)", "DO $$ DECLARE t text; BEGIN FOR t IN SELECT 1 LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO service_role', t); END LOOP; END $$;"],
    ["a REVOKE", "REVOKE ALL ON public.memory_likes FROM anon, authenticated;"],
    ["REVOKE GRANT OPTION FOR", "REVOKE GRANT OPTION FOR SELECT ON public.memory_tags FROM authenticated;"],
    ["a grant in a comment", "-- GRANT SELECT ON public.memory_likes TO authenticated;\nSELECT 1;"],
    ["a grant in a RAISE message", "DO $$ BEGIN RAISE NOTICE 'GRANT SELECT ON public.memory_likes TO authenticated'; END $$;"],
    ["a grant in a COMMENT", "COMMENT ON TABLE public.trips IS 'GRANT SELECT ON public.memory_saves TO anon';"],
    ["EXECUTE ON FUNCTION", "GRANT EXECUTE ON FUNCTION public.memory_kernel_execute(jsonb) TO authenticated;"],
    ["a membership grant to a server role", "CREATE ROLE memwriter; GRANT memwriter TO service_role;"],
    ["a rename to another name", "ALTER TABLE public.trips RENAME TO trips_old;"],
    ["ALL TABLES in another schema", "GRANT SELECT ON ALL TABLES IN SCHEMA graphql_public TO anon;"],
  ];
  for (const [name, sql] of green) {
    it(`G-green: ${name}`, () => assert.deepEqual(planted(sql), []));
  }
  it("G-order: a client grant BEFORE 3814 is closed by it (only the end state counts)", () => {
    assert.deepEqual(planted("GRANT SELECT ON public.memory_likes TO authenticated;", "3700_planted_before.sql"), []);
  });
});

describe("3814 and its rollback — shaped as they claim", () => {
  const sql = readFileSync(join(MIGRATIONS, CLOSER), "utf8");
  const rb = readFileSync(ROLLBACK, "utf8");
  const aclStatements = (text: string) =>
    topLevelStatements(text)
      .map((s) => s.replace(/^(\s|--[^\n]*\n)*/, "").replace(/\s+/g, " ").trim())
      .filter((s) => /^(GRANT|REVOKE)\b/i.test(s));

  it("B-1: exactly one $pre$ and one assertion-only postcondition after COMMIT, reading only the catalog, naming all four tables", () => {
    const stmts = topLevelStatements(sql);
    const pre = stmts.filter((s) => isAssertionOnlyDoBlock(s) && isPreconditionDoBlock(s));
    const post = stmts.filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
    assert.equal(pre.length, 1, "exactly one assertion-only $pre$ block");
    assert.equal(post.length, 1, "exactly one assertion-only postcondition");
    assert.match(post[0]!, /POSTCONDITION FAILED \(3814\)/);
    assert.doesNotMatch(blankSqlComments(post[0]!), /pg_temp|current_setting\s*\(|set_config\s*\(|\btemp(orary)?\s+table\b/i);
    assert.ok(sql.indexOf("DO $post$") > sql.lastIndexOf("\nCOMMIT;"));
    for (const t of TABLES) {
      assert.match(post[0]!, new RegExp(`'${t}'`), `the postcondition does not check ${t}`);
      assert.match(pre[0]!, new RegExp(`'${t}'`), `the precondition does not check ${t}`);
    }
  });

  it("B-2: the only privilege statement is REVOKE ALL on the four from PUBLIC, anon and authenticated — nothing is granted back, nothing else changes", () => {
    assert.deepEqual(aclStatements(sql), [
      "REVOKE ALL ON TABLE public.memory_saves, public.memory_likes, public.memory_tags, public.memory_items FROM PUBLIC, anon, authenticated;",
    ]);
    assert.doesNotMatch(blankSqlComments(sql), /\b(CREATE|DROP|ALTER)\s+(POLICY|FUNCTION|TRIGGER|TABLE|VIEW)\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b/i);
  });

  it("B-3: the rollback restores 2490's four privileges on the four tables — never ALL, never an unpoliced one, never PUBLIC — clears the ledger row, and refuses unsafe states", () => {
    assert.deepEqual(aclStatements(rb), [
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_saves, public.memory_likes, public.memory_tags, public.memory_items TO anon, authenticated;",
    ]);
    const code = blankSqlComments(rb);
    assert.match(code, /DELETE FROM public\.schema_migration_ledger WHERE filename = '3814_memory_social_client_privileges_revoked\.sql'/);
    assert.match(code, /RLS is not enabled on public\.%/);
    for (const p of ["memory_saves_own", "memory_likes_own", "memory_likes_read", "memory_tags_owner_delete", "memory_tags_owner_insert", "memory_tags_owner_read", "memory_tags_tagged_update", "memory_items_public_read", "memory_items_via_memory"]) {
      assert.match(code, new RegExp(`'${p}'`), `the rollback does not require ${p}`);
    }
    assert.match(code, /visibility IS NULL/, "the rollback does not refuse to re-open an only_me photo (3672)");
  });
});

describe("the premise: no client path reads or writes the four tables as a client role", () => {
  const CLIENT_ROOTS = ["travel-buddy-standalone/src", "travel-buddy-standalone/app", "src", "app", "packages", "posts-ui", "lib",
    "posts-backend", "follows-backend", "friends-backend", "passport-backend", "stamps-backend", "composer-pkg", "posts-frontend-pkg"];
  const SKIP_DIR = /(^|\/)(node_modules|__tests__|\.expo|dist|build)(\/|$)/;
  function* walk(dir: string): Generator<string> {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      if (SKIP_DIR.test(p)) continue;
      const st = statSync(p);
      if (st.isDirectory()) yield* walk(p);
      else if (/\.(tsx?|jsx?|mjs)$/.test(e) && !/\.test\.|\.spec\./.test(e) && !/database\.types\.ts$/.test(e)) yield p;
    }
  }
  const clientFiles = () => CLIENT_ROOTS.flatMap((r) => [...walk(join(REPO_ROOT, r))]);
  const rel = (p: string) => p.slice(REPO_ROOT.length + 1);
  const NAME = String.raw`(memory_saves|memory_likes|memory_tags|memory_items)`;

  it("P-1: no client source names one of the four as a table — .from(), a realtime filter, a REST path, an embed — and the walk read real files", () => {
    const files = clientFiles();
    assert.ok(files.length > 200, `only ${files.length} client files scanned: the roots moved`);
    let fromCalls = 0;
    const hits: string[] = [];
    for (const p of files) {
      const src = readFileSync(p, "utf8");
      fromCalls += (src.match(/\.from\(\s*['"`][a-z_]+['"`]\s*\)/g) ?? []).length;
      if (new RegExp(String.raw`\.from\(\s*['"\`]${NAME}['"\`]\s*\)`).test(src)) hits.push(`${rel(p)}: .from()`);
      if (new RegExp(String.raw`\btable\s*:\s*['"\`]${NAME}['"\`]`).test(src)) hits.push(`${rel(p)}: a realtime filter`);
      if (new RegExp(String.raw`rest/v1/${NAME}\b`).test(src)) hits.push(`${rel(p)}: a REST path`);
      for (const m of src.matchAll(/\.select\(\s*(['"`])([^'"`]*)\1/g)) {
        if (new RegExp(String.raw`(^|[^\w])${NAME}\s*[(!:]`).test(m[2]!)) hits.push(`${rel(p)}: select('${m[2]}') embeds one`);
      }
    }
    assert.ok(fromCalls >= 10, `only ${fromCalls} client .from('<table>') calls found: the scan went blind`);
    assert.deepEqual(hits, [], "a client reads or writes one of the four directly; after 3814 it is refused with 42501 — it needs the API");
  });

  it("P-2: the client's like and save buttons go through the API routes, not PostgREST", () => {
    const svc = readFileSync(join(REPO_ROOT, "travel-buddy-standalone", "src", "services", "memories.ts"), "utf8");
    assert.match(svc, /\/memories\/\$\{[^}]+\}\/like/, "likeMemory no longer calls POST /memories/:id/like");
    const hook = readFileSync(join(REPO_ROOT, "travel-buddy-standalone", "src", "hooks", "useMemoryLike.ts"), "utf8");
    assert.match(hook, /import \{ likeMemory, unlikeMemory \} from '\.\.\/services\/memories\.ts'/);
  });

  // A function body that reads or writes one of the four, by the statement shapes 3814's precondition uses.
  const TOUCHES = new RegExp(String.raw`\b(from|join|into|update|table)\s+(only\s+)?(public\.)?"?${NAME}"?(?![\w])`, "i");
  function touchingFunctions(): Array<{ name: string; file: string; trigger: boolean; definer: boolean }> {
    const out: Array<{ name: string; file: string; trigger: boolean; definer: boolean }> = [];
    for (const f of chain()) {
      const text = blankSqlComments(f.sql);
      for (const m of text.matchAll(/\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\.)?("?[A-Za-z_]\w*"?)\s*\(([\s\S]*?)\)\s*returns\s+([\s\S]*?)\bas\s+(\$[A-Za-z_]*\$)([\s\S]*?)\4/gi)) {
        if (!TOUCHES.test(m[5]!)) continue;
        out.push({ name: m[1]!.replace(/"/g, "").toLowerCase(), file: f.name, trigger: /^\s*(setof\s+)?trigger\b/i.test(m[3]!), definer: /\bsecurity\s+definer\b/i.test(m[3]!) });
      }
    }
    return out;
  }

  it("P-3: every chain function whose body reads or writes one of the four is revoked from anon and authenticated, or is a SECURITY DEFINER trigger function", () => {
    const fns = touchingFunctions();
    const names = fns.map((f) => f.name);
    for (const expected of ["memory_kernel_execute", "memory_graph_kernel_execute", "memory_graph_mirror_memory"]) {
      assert.ok(names.includes(expected), `the scan no longer finds ${expected}: it went blind (found ${names.join(", ")})`);
    }
    const allText = chain().map((f) => blankSqlComments(f.sql)).join("\n");
    const open: string[] = [];
    for (const r of fns) {
      if (r.trigger && r.definer) continue;
      const revoked = (role: string) =>
        new RegExp(String.raw`\brevoke\s+(all|execute)\s+on\s+function\s+(public\.)?${r.name}\s*\([^)]*\)\s+from\s+[^;]*\b${role}\b`, "i").test(allText);
      if (r.trigger || !revoked("anon") || !revoked("authenticated")) open.push(`${r.name} (${r.file})`);
    }
    assert.deepEqual(open, [], "a client role may call, or fire as an invoker, a function that touches the four; after 3814 it fails with 42501");
  });

  it("P-4: no client source calls an RPC that touches the four, and no chain policy on another table reads them", () => {
    const fnNames = new Set(touchingFunctions().map((f) => f.name));
    const called: string[] = [];
    for (const p of clientFiles()) {
      for (const m of readFileSync(p, "utf8").matchAll(/\.rpc\(\s*['"`]([A-Za-z_]\w*)['"`]/g)) if (fnNames.has(m[1]!.toLowerCase())) called.push(`${rel(p)}: ${m[1]}`);
    }
    assert.deepEqual(called, []);
    const foreign: string[] = [];
    for (const src of [BASELINE, ...chain().map((f) => f.sql)]) {
      for (const m of blankSqlComments(src).matchAll(/\bcreate\s+policy\s+(\w+)\s+on\s+(?:public\.)?(\w+)\b([^;]*)/gi)) {
        if ((TABLES as readonly string[]).includes(m[2]!.toLowerCase())) continue;
        if (new RegExp(String.raw`\b(public\.)?${NAME}\b`, "i").test(m[3]!)) foreign.push(`${m[2]}.${m[1]}`);
      }
    }
    assert.deepEqual(foreign, [], "a policy on another table reads one of the four; after 3814 a client query reaching it fails with 42501");
  });
});

describe("the live guard agrees: authorization-contract.json", () => {
  const contract = loadContract();
  const EXPECTED: Record<Table, string[]> = {
    memory_saves: ["memory_saves_own|ALL|true|public"],
    memory_likes: ["memory_likes_own|ALL|true|public", "memory_likes_read|SELECT|true|public"],
    memory_tags: ["memory_tags_owner_delete|DELETE|true|public", "memory_tags_owner_insert|INSERT|true|public", "memory_tags_owner_read|SELECT|true|public", "memory_tags_tagged_update|UPDATE|true|public"],
    memory_items: ["memory_items_public_read|SELECT|true|public", "memory_items_via_memory|ALL|true|public"],
  };
  for (const t of TABLES) {
    it(`K-1 ${t}: contracted with no client table grant, no client-writable column, and exactly its baseline policies`, () => {
      const c = contract.tables[t];
      assert.ok(c, `${t} is not in the authorization contract`);
      assert.deepEqual([c.tableGrants, c.insertCols, c.updateCols], [{}, {}, {}]);
      assert.deepEqual(c.policies.map((p) => `${p.name}|${p.cmd}|${p.permissive}|${p.roles.join("+")}`).sort(), EXPECTED[t]);
      for (const p of EXPECTED[t]) assert.match(BASELINE, new RegExp(`CREATE POLICY ${p.split("|")[0]} ON public\\.${t}\\b`), `${p} is not the baseline's`);
    });
  }
  it("K-2: no chain migration adds, alters or drops a policy on the four except 3672's re-creation of memory_items_public_read", () => {
    const touched = chain().flatMap((f) =>
      [...blankSqlComments(f.sql).matchAll(/\b(create|drop|alter)\s+policy\s+(?:if\s+exists\s+)?(\w+)\s+on\s+(?:public\.)?(memory_saves|memory_likes|memory_tags|memory_items)\b/gi)].map((m) => `${f.name}:${m[1]!.toLowerCase()} ${m[2]}`),
    );
    assert.deepEqual(touched.sort(), ["3672_memory_item_visibility.sql:create memory_items_public_read", "3672_memory_item_visibility.sql:drop memory_items_public_read"]);
  });
});
