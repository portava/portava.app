/**
 * profiles AUTHORITY columns — rule 6 of check:client-privilege-boundary.
 *
 * ── WHAT AN AUTHORITY COLUMN IS ──────────────────────────────────────────────
 * A column of `public.profiles` that the server reads as a FACT about the user
 * it describes — who is an admin, who is verified, how trusted, how old the
 * account is — and that only the server may therefore write. `profiles_update`
 * admits a user's own row (id = auth.uid()) and RLS cannot restrict columns, so
 * each such column needs the two barriers 2078 set up for `role`:
 *
 *   1. no client role (anon, authenticated, or PUBLIC) holds UPDATE on it, at
 *      column or table level — the narrow barrier, which a single careless
 *      `GRANT UPDATE ON profiles TO authenticated` silently undoes;
 *   2. an enabled BEFORE INSERT OR UPDATE row trigger on profiles whose function
 *      compares `NEW.<col> IS DISTINCT FROM OLD.<col>`, checks NEW.<col> on
 *      INSERT too, and consults caller_may_write_profile_role() — the barrier
 *      that survives the re-grant.
 *
 * 3742 found seven columns with neither (verified, verified_at, trust_score,
 * trust_label, verification_method, featured_count, created_at), and ten whose
 * trigger existed but whose grant was never taken (is_official and 2163's nine).
 *
 * ── HOW IT IS DECIDED (offline, from the repository) ─────────────────────────
 * Barrier 1 is REPLAYED: every GRANT / REVOKE that reaches profiles (named, or
 * `ALL TABLES IN SCHEMA public`), in the baseline and then the chain in order,
 * written out or issued from a FOREACH-literal loop, per client role, at table
 * and column level, with PostgreSQL's rule that revoking a table-level
 * privilege also revokes that privilege on every column. It is replayed from
 * TWO starting points and must hold for both: the production shape (the
 * baseline's column grants alone) and the shape of every database built by
 * replaying the baseline over Supabase's default ACL (portava-ci, the beta
 * bootstrap, the local harness: table-level ALL for anon and authenticated,
 * which 3740 removes). A statement is read only where SQL_STATEMENT_LEAD says a
 * statement can begin, so a RAISE message or COMMENT that reads like a GRANT is
 * not one.
 *
 * Barrier 2 is replayed the same way over CREATE [OR REPLACE] FUNCTION,
 * DROP FUNCTION | ROUTINE (every name the statement lists, with or without an
 * argument list), ALTER FUNCTION | ROUTINE … RENAME TO, any other ALTER
 * FUNCTION | ROUTINE (SET search_path, SECURITY, OWNER, SET SCHEMA …: the
 * function is no longer the one reviewed, so it guards nothing until a CREATE
 * re-states it), CREATE / DROP TRIGGER … ON profiles, ALTER TRIGGER … ON
 * profiles RENAME TO, and EVERY action of an ALTER TABLE profiles statement
 * that is ENABLE [ALWAYS | REPLICA] / DISABLE TRIGGER (`ALTER TABLE profiles
 * ADD COLUMN …, DISABLE TRIGGER t` disables t; verifier G3b B, C). It is judged
 * on the LAST definition of each function. A trigger counts only when it is
 * enabled (ENABLE REPLICA is not: it fires only under session_replication_role
 * = replica), carries no WHEN (…) condition and no UPDATE OF column list
 * (BETA2 verifier F6), and its function — comments
 * removed — compares the column, reads it again on INSERT, and calls the
 * predicate BEFORE its first RETURN (verifier G3 F2-F4). A function body is
 * the dollar-quoted string, or the single-quoted string after AS; any other
 * body is unknown and guards nothing.
 *
 * The predicate itself, caller_may_write_profile_role(), is pinned on its FULL
 * definition: argument list, every header option (RETURNS, LANGUAGE,
 * volatility, SECURITY, SET search_path …, whether written before or after the
 * body) and the body. A chain CREATE whose definition differs from the
 * baseline's (2078's) — modulo whitespace, keyword case and comments, the
 * comments found by a quote-aware scan so a `/*` or `--` inside a string
 * literal is data, not a comment — is a change; so is any DROP FUNCTION |
 * ROUTINE that lists it and any ALTER FUNCTION | ROUTINE of it, with or without
 * an argument list. A change unguards every column, because every one of these
 * triggers trusts it (verifier G3 F1; G3b A: the baseline's body under `SET
 * search_path TO 'evil', 'pg_catalog'` opens all 19 columns).
 *
 * WHAT IT IS: a reading of the migration TEXT. It proves no trigger RUNS; the
 * executed proof is src/test/db/profileAuthorityColumns.db.test.ts (CI's
 * local-db job), and 3742's own $post$ block, re-run after COMMIT, checks the
 * live catalog and executes the predicate. WHERE IT RUNS: the always-run tier
 * is src/test/profileAuthorityColumns.test.ts (R6-1, R6-7) in ci.yml's
 * node:test job; the CLI's --require line in run-security-checks.sh runs only
 * under check:security, in live-db.yml.
 *
 * Order is byte order of the filenames. ORDER_OVERRIDES.json moves 2136 and
 * 2140 and skips 2137; none of them grants, revokes or triggers anything on
 * profiles, which profileAuthorityColumns.test.ts pins, so byte order is the
 * apply order for everything this rule reads.
 *
 * ── PENDING, NOT EXEMPT ──────────────────────────────────────────────────────
 * account_status's trigger is 3600's (PR #592). Until a migration defines
 * enforce_profile_account_status_privileged() or a 3600_ file exists, its
 * missing trigger is reported as PENDING instead of failing; the moment either
 * lands, the trigger is required like any other. Its grant is required now
 * (3742 revokes it).
 *
 * ── KNOWN LIMITS ─────────────────────────────────────────────────────────────
 * Not modelled (none exists in the chain today; each is caught at certify
 * stage 4 by 3742's $post$ where noted):
 *   - a GRANT, DISABLE TRIGGER, DROP TRIGGER or CREATE FUNCTION issued through
 *     a bare EXECUTE format() outside a FOREACH-literal loop, or through an
 *     EXECUTE operand built with `||` ($post$ catches the trigger and the grant);
 *   - a grant to a role that is itself a member of anon/authenticated
 *     (`GRANT service_role TO authenticated`);
 *   - a trigger body that delegates the comparison to another function, or
 *     that keeps every checked shape but never reaches it (IF false THEN …);
 *   - a function or operator in schema public that shadows one the predicate
 *     calls (its search_path lists public before pg_catalog);
 *   - ALTER TABLE profiles RENAME, or a guard moved to another schema.
 * The TRIGGER-FUNCTION reading is textual, on regular expressions, and it is
 * the same reading as 3742's $post$ check 3 (comments removed `/* … *\/` first,
 * then `--` to end of line; neither tier tracks string literals). These shapes
 * pass BOTH tiers and are caught only by the executed proof (the local-db
 * suite's PA1-PA3 on the replayed chain) (verifier G3b D):
 *   - `--` or `/*` inside a string literal: `v_changed := '--'; RETURN NEW;`
 *     loses `'; RETURN NEW;` to the comment stripper, so the early RETURN is
 *     not seen; likewise a nested block comment, which PostgreSQL closes at
 *     its outer `*\/` and a non-greedy regex at its inner one;
 *   - the refusal wrapped in `BEGIN … EXCEPTION WHEN OTHERS THEN NULL; END;`,
 *     which swallows the 42501 it raises;
 *   - the predicate call present only inside a string literal
 *     (`v_changed := 'caller_may_write_profile_role()'; RETURN NEW;`).
 * THE INSERT SIDE (verifier G3d F1). On INSERT the trigger is the only barrier
 * (the column REVOKE is UPDATE-only; anon/authenticated keep table-level
 * INSERT). This rule's INSERT-side reading is a second `NEW.<col>` mention,
 * so these pass THIS tier: the refusal gated on TG_OP (`IF v_changed <> ''
 * AND TG_OP = 'UPDATE' THEN`, or wrapped in `IF TG_OP = 'UPDATE' THEN`), and
 * the INSERT branch blanked while a literal still names `NEW.<col>`. Rule 6
 * cannot refuse TG_OP gating in general — 3600's guard legitimately branches
 * on TG_OP inside its refusal condition. For 3742's own function, $post$
 * check 3 refuses both (it pins the gate `IF v_changed <> '' THEN`, TG_OP only
 * as the two branch heads, and per column an INSERT-side test against a
 * constant); the executed proof is the local-db suite's PA3/PA11.
 * WHY NOT STRIP STRING LITERALS: the refusal's own `ERRCODE = '42501'`, the
 * HINT and every column-name label are string literals, so blanking literals
 * blinds the check to the thing it must find; and a correct quote-aware
 * reading in plpgsql ($post$) is a lexer, not a check. The PREDICATE pin is
 * different: it asks for equality with the baseline, so it uses the
 * quote-aware blankSqlComments and none of these shapes can make a changed
 * predicate read as the baseline's.
 * The live ACL is audit:live-unexplained's question; this rule keeps the chain
 * honest.
 */
import type { MigrationText } from "./clientTableAclDecisions.js";
import { blankSqlComments, CHAIN_START_PREFIX, expandForeachLiteralLoops, SQL_STATEMENT_LEAD } from "./liveVsCanonicalCore.js";

export type { MigrationText };

export interface ProfileAuthorityColumn {
  column: string;
  /** The migration and trigger function that guard it. */
  guardedBy: string;
  /** Why the server trusts it (a reader), so the entry can be audited. */
  readAs: string;
  /** Present only while the guarding trigger has not landed on main. */
  pending?: { fn: string; filePrefix: string; note: string };
}

const VERIFICATION_2163 = "2163 enforce_profile_verification_privileged()";
const AUTHORITY_3742 = "3742 enforce_profile_authority_privileged()";

export const PROFILE_AUTHORITY_COLUMNS: readonly ProfileAuthorityColumn[] = [
  { column: "role", guardedBy: "2078 enforce_profile_role_privileged()", readAs: "every admin guard (lib/requireAdmin.ts)" },
  { column: "is_official", guardedBy: "0106/2079 enforce_is_official_privileged()", readAs: "the official-account badge" },
  { column: "verification_status", guardedBy: VERIFICATION_2163, readAs: "lib/travelerVerification.ts idVerified" },
  { column: "verification_level", guardedBy: VERIFICATION_2163, readAs: "lib/travelerVerification.ts idVerified; Telegraph send tier" },
  { column: "verified_since", guardedBy: VERIFICATION_2163, readAs: "verified-traveller badge" },
  { column: "id_verified_at", guardedBy: VERIFICATION_2163, readAs: "lib/travelerVerification.ts idVerified" },
  { column: "selfie_verified_at", guardedBy: VERIFICATION_2163, readAs: "verification badges" },
  { column: "home_country_verified_at", guardedBy: VERIFICATION_2163, readAs: "verification badges" },
  { column: "host_verified_at", guardedBy: VERIFICATION_2163, readAs: "host badge" },
  { column: "buddy_verified_at", guardedBy: VERIFICATION_2163, readAs: "buddy badge" },
  { column: "safety_flags_count", guardedBy: VERIFICATION_2163, readAs: "Compass reward engine severe-flag check" },
  {
    column: "account_status",
    guardedBy: "3600 enforce_profile_account_status_privileged() (PR #592)",
    readAs: "the erasure tombstone the creator ledger trusts (3600 (4b)); account-state gates",
    pending: {
      fn: "enforce_profile_account_status_privileged",
      filePrefix: "3600_",
      note: "trigger lands with 3600 (PR #592); its column UPDATE grant is revoked by 3742 now, but the INSERT side stays open until 3600 (a new account can create its row carrying a non-active account_status)",
    },
  },
  { column: "verified", guardedBy: AUTHORITY_3742, readAs: "routes/events.ts verified-only events; routes/posts.ts verified-only comments" },
  { column: "verified_at", guardedBy: AUTHORITY_3742, readAs: "PassportProjectionService.ts verified badge" },
  { column: "trust_score", guardedBy: AUTHORITY_3742, readAs: "domain/telegraph/policies/sendRateLimit.ts send tier" },
  { column: "trust_label", guardedBy: AUTHORITY_3742, readAs: "the trust label beside the score" },
  { column: "verification_method", guardedBy: AUTHORITY_3742, readAs: "how the user was verified, as displayed" },
  { column: "featured_count", guardedBy: AUTHORITY_3742, readAs: "routes/passport.ts / routes/profile.ts Featured by Portava" },
  { column: "created_at", guardedBy: AUTHORITY_3742, readAs: "sendRateLimit.ts account age (account_under_two_days_old)" },
];


const CLIENT_AND_PUBLIC = ["anon", "authenticated", "public"] as const;
type AclRole = (typeof CLIENT_AND_PUBLIC)[number];
interface RoleAcl {
  table: boolean;
  cols: Set<string>;
}
export type ProfilesUpdateAcl = Record<AclRole, RoleAcl>;
export type StartModel = "production" | "default-acl";

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

/** True when a GRANT/REVOKE target names public.profiles. */
function namesProfiles(target: string): boolean {
  const t = target.trim().replace(/^table\s+/i, "");
  const parts = t.split(".").map(fold);
  if (parts.length === 1) return parts[0] === "profiles";
  return parts.length === 2 && parts[0] === "public" && parts[1] === "profiles";
}

interface AclEvent {
  pos: number;
  kind: "grant" | "revoke";
  roles: AclRole[];
  /** null = table level (UPDATE or ALL without a column list); otherwise the columns. */
  updateCols: string[] | null;
}

function aclEvents(src: string, base: number): AclEvent[] {
  const out: AclEvent[] = [];
  const headRe = /\b(grant|revoke)\s+/gi;
  let h: RegExpExecArray | null;
  while ((h = headRe.exec(src)) !== null) {
    if (!leads(src, h.index)) continue;
    const kind = h[1]!.toLowerCase() as "grant" | "revoke";
    let stmt = statementFrom(src, h.index + h[0].length);
    if (kind === "revoke" && /^\s*grant\s+option\s+for\b/i.test(stmt)) continue; // takes the grant option only
    const on = /\bon\b/i.exec(stmt);
    if (!on) continue;
    const toFrom = new RegExp(String.raw`\b${kind === "grant" ? "to" : "from"}\b`, "i").exec(stmt.slice(on.index));
    if (!toFrom) continue;
    const privText = stmt.slice(0, on.index);
    const targetText = stmt.slice(on.index + 2, on.index + toFrom.index).trim();
    stmt = stmt.slice(on.index + toFrom.index + toFrom[0].length);

    let reaches = false;
    const schemaWide = /^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i.exec(targetText);
    if (schemaWide) reaches = splitTop(schemaWide[1]!).some((s) => fold(s) === "public");
    else if (/^(function|procedure|routine|sequence|schema|database|domain|type|language|large\s+object|foreign|tablespace|parameter|all\s)/i.test(targetText)) continue;
    else reaches = splitTop(targetText).some(namesProfiles);
    if (!reaches) continue;

    const roles = splitTop(stmt.replace(/\b(with\s+grant\s+option|granted\s+by|cascade|restrict)\b[\s\S]*$/i, ""))
      .map(fold)
      .filter((r): r is AclRole => (CLIENT_AND_PUBLIC as readonly string[]).includes(r));
    if (!roles.length) continue;

    for (const raw of splitTop(privText)) {
      const p = /^\s*(all(?:\s+privileges)?|update)\s*(?:\(([^)]*)\))?\s*$/i.exec(raw);
      if (!p) continue;
      const cols = p[2] === undefined ? null : splitTop(p[2]).map(fold);
      out.push({ pos: base + h.index, kind, roles, updateCols: cols });
    }
  }
  return out;
}

function eventsOf(sql: string): { acl: AclEvent[]; trig: TrigEvent[] } {
  const src = blankSqlComments(sql);
  const loops = expandForeachLiteralLoops(src);
  const off = src.length + 1;
  const acl = [...aclEvents(src, 0), ...aclEvents(loops, off)].sort((a, b) => a.pos - b.pos);
  const trig = [...trigEvents(src, 0), ...trigEvents(loops, off)].sort((a, b) => a.pos - b.pos);
  return { acl, trig };
}

/** The post-baseline chain, in byte order of the filename (see header). */
function chainOf(files: readonly MigrationText[]): MigrationText[] {
  return [...files].filter((f) => f.name >= CHAIN_START_PREFIX).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Replay the client roles' UPDATE privilege on profiles over the baseline and the chain. */
export function replayProfilesUpdateAcl(files: readonly MigrationText[], baselineSql: string, start: StartModel): ProfilesUpdateAcl {
  const acl: ProfilesUpdateAcl = {
    anon: { table: start === "default-acl", cols: new Set() },
    authenticated: { table: start === "default-acl", cols: new Set() },
    public: { table: false, cols: new Set() },
  };
  const apply = (e: AclEvent) => {
    for (const r of e.roles) {
      const st = acl[r];
      if (e.kind === "grant") {
        if (e.updateCols === null) st.table = true;
        else for (const c of e.updateCols) st.cols.add(c);
      } else if (e.updateCols === null) {
        // Revoking a table-level privilege revokes it on every column too.
        st.table = false;
        st.cols.clear();
      } else for (const c of e.updateCols) st.cols.delete(c);
    }
  };
  for (const e of eventsOf(baselineSql).acl) apply(e);
  for (const f of chainOf(files)) for (const e of eventsOf(f.sql).acl) apply(e);
  return acl;
}

export interface ClientUpdatableColumn {
  column: string;
  roles: string[];
  models: StartModel[];
}

/** Authority columns some client role can still UPDATE after the chain, under either starting model. */
export function clientUpdatableAuthorityColumns(files: readonly MigrationText[], baselineSql: string): ClientUpdatableColumn[] {
  const out = new Map<string, ClientUpdatableColumn>();
  for (const model of ["production", "default-acl"] as const) {
    const acl = replayProfilesUpdateAcl(files, baselineSql, model);
    for (const { column } of PROFILE_AUTHORITY_COLUMNS) {
      const viaPublic = acl.public.table || acl.public.cols.has(column);
      for (const role of ["anon", "authenticated"] as const) {
        if (!(viaPublic || acl[role].table || acl[role].cols.has(column))) continue;
        const cur = out.get(column) ?? { column, roles: [], models: [] };
        if (!cur.roles.includes(role)) cur.roles.push(role);
        if (!cur.models.includes(model)) cur.models.push(model);
        out.set(column, cur);
      }
    }
  }
  return [...out.values()].map((c) => ({ ...c, roles: c.roles.sort(), models: c.models.sort() })).sort((a, b) => (a.column < b.column ? -1 : 1));
}

// ── Barrier 2: the triggers ──────────────────────────────────────────────────

type TrigEvent =
  | { k: "fn"; pos: number; name: string; body: string }
  | { k: "dropfn"; pos: number; name: string }
  | { k: "alterfn"; pos: number; name: string }
  | { k: "renamefn"; pos: number; name: string; to: string }
  | { k: "trigger"; pos: number; name: string; before: boolean; row: boolean; events: Set<string>; fn: string; qualified: boolean; columnList: boolean }
  | { k: "droptrigger"; pos: number; name: string }
  | { k: "renametrigger"; pos: number; name: string; to: string }
  | { k: "enable"; pos: number; name: string | null; enabled: boolean };

const NAME = String.raw`(?:"?[A-Za-z_][\w$]*"?\.)?"?[A-Za-z_][\w$]*"?`;
const bare = (q: string) => fold(q.split(".").pop()!);
const isProfiles = (q: string) => namesProfiles(q);

/**
 * The body of the CREATE FUNCTION whose header starts at `from`: the first
 * dollar-quoted string, or the single-quoted string after AS ('' unescaped),
 * whichever the header reaches before its terminating `;`. A header that ends
 * with neither (a SQL-standard RETURN … / BEGIN ATOMIC body), an E'…' body or
 * an unterminated quote yields "" — an UNKNOWN body, which guards nothing and
 * equals no predicate (verifier G3 F4: a single-quoted body used to be
 * skipped, so the previous definition was kept).
 */
function functionBodySpan(src: string, from: number): { body: string; start: number; end: number } | null {
  for (let i = from; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === ";") return null;
    if (ch === "$" && !/[\w$]/.test(src[i - 1] ?? "")) {
      const open = /^\$([A-Za-z_][\w]*)?\$/.exec(src.slice(i));
      if (!open) continue;
      const start = i + open[0].length;
      const close = src.indexOf(open[0], start);
      return close < 0 ? null : { body: src.slice(start, close), start: i, end: close + open[0].length };
    }
    if (ch === "'") {
      let j = i + 1;
      let text = "";
      for (; j < src.length; j++) {
        if (src[j] === "'" && src[j + 1] === "'") {
          text += "'";
          j++;
        } else if (src[j] === "'") break;
        else text += src[j];
      }
      if (j >= src.length) return null;
      const lead = src.slice(Math.max(from, i - 12), i);
      if (/\bas\s*$/i.test(lead)) return { body: text, start: i, end: j + 1 };
      if (/\bas\s+e$/i.test(lead)) return null;
      i = j;
    }
  }
  return null;
}

function functionBody(src: string, from: number): string {
  return functionBodySpan(src, from)?.body ?? "";
}

/**
 * A function body with its -- and /* *\/ comments removed (text in a comment
 * guards nothing). Regular expressions, block comments first — the SAME
 * reading as 3742's $post$ check 3, so both tiers share one set of KNOWN
 * LIMITS (a `--` or `/*` inside a string literal, nested block comments).
 */
const codeOf = (body: string) => body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/**
 * SQL text compared modulo comments, whitespace and the case of everything
 * outside quotes: comments found by the quote-aware blankSqlComments (a `/*`
 * or `--` inside a string literal is data), single- and double-quoted text and
 * dollar-quoted bodies kept verbatim, whitespace collapsed and dropped around
 * punctuation. Used only where the question is EQUALITY with the baseline.
 */
function normalSql(text: string): string {
  const src = blankSqlComments(text);
  const parts: string[] = [];
  let plain = "";
  const flush = () => {
    parts.push(plain.toLowerCase().replace(/\s+/g, " ").replace(/ ?([(),=;]) ?/g, "$1"));
    plain = "";
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === ch && src[j + 1] === ch) j++;
        else if (src[j] === ch) break;
      }
      flush();
      parts.push(src.slice(i, j + 1));
      i = j;
    } else if (ch === "$" && !/[\w$]/.test(src[i - 1] ?? "") && /^\$([A-Za-z_]\w*)?\$/.test(src.slice(i))) {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i))![0];
      const close = src.indexOf(tag, i + tag.length);
      const end = close < 0 ? src.length : close + tag.length;
      flush();
      parts.push(src.slice(i, end));
      i = end - 1;
    } else plain += ch;
  }
  flush();
  return parts.join("").trim();
}

/** End of the statement that continues at `from`: the first `;` outside quotes at paren depth 0. */
function statementEnd(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === ch && src[j + 1] === ch) j++;
        else if (src[j] === ch) break;
      }
      i = j;
    } else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth <= 0) return i;
  }
  return src.length;
}

/**
 * The FULL definition of the CREATE FUNCTION whose argument list opens just
 * before `afterParen`, normalised: arguments, every option before the body,
 * the body (comments and whitespace aside), every option after it. null when
 * the body is not a dollar- or single-quoted string (a SQL-standard RETURN …
 * or BEGIN ATOMIC body, an E'…' body): no such definition equals the
 * baseline's (verifier G3b A: comparing the body alone let a header-only
 * change through).
 */
function functionDefinition(src: string, afterParen: number): string | null {
  let depth = 1;
  let i = afterParen;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") depth--;
    else if (src[i] === ";") return null;
  }
  if (depth !== 0) return null;
  const span = functionBodySpan(src, i);
  if (!span) return null;
  const tail = src.slice(span.end, statementEnd(src, span.end));
  return `(${normalSql(src.slice(afterParen, i - 1))})${normalSql(src.slice(i, span.start))} «${normalSql(span.body)}» ${normalSql(tail)}`;
}

/**
 * The rest of the statement from `from`, string-literal contents blanked: to
 * the first `;` at paren depth 0 — or, for a statement inside an EXECUTE '…'
 * operand, to that operand's closing quote (where a string is written ''…'').
 */
function statementRest(src: string, from: number, inLiteral: boolean): string {
  let out = "";
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "'") {
      if (inLiteral) {
        if (src[i + 1] !== "'") break;
        const close = src.indexOf("''", i + 2);
        if (close < 0) break;
        out += " ".repeat(close + 2 - i);
        i = close + 1;
        continue;
      }
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === "'" && src[j + 1] === "'") j++;
        else if (src[j] === "'") break;
      }
      out += " ".repeat(Math.min(j, src.length - 1) + 1 - i);
      i = j;
      continue;
    }
    if (ch === "$" && !inLiteral && !/[\w$]/.test(src[i - 1] ?? "")) {
      const open = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i));
      if (open) {
        const close = src.indexOf(open[0], i + open[0].length);
        const end = close < 0 ? src.length : close + open[0].length;
        out += " ".repeat(end - i);
        i = end - 1;
        continue;
      }
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth <= 0) break;
    out += ch;
  }
  return out;
}

/** Every function a DROP FUNCTION | ROUTINE statement names (it may list several, each with or without arguments). */
function droppedFunctions(src: string, from: number, inLiteral: boolean): string[] {
  const rest = statementRest(src, from, inLiteral).replace(/\b(?:cascade|restrict)\s*$/i, "");
  return splitTop(rest)
    .map((item) => new RegExp(String.raw`^\s*(${NAME})`).exec(item)?.[1])
    .filter((n): n is string => !!n)
    .map(bare);
}

/** True when the statement at `at` sits inside an EXECUTE '…' operand. */
const inExecuteLiteral = (src: string, at: number) => /\bexecute\s*'\s*$/i.test(src.slice(Math.max(0, at - 32), at));

function trigEvents(src: string, base: number): TrigEvent[] {
  const out: TrigEvent[] = [];
  for (const m of src.matchAll(new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+(${NAME})\s*\(`, "gi"))) {
    if (!leads(src, m.index!)) continue;
    out.push({ k: "fn", pos: base + m.index!, name: bare(m[1]!), body: functionBody(src, m.index! + m[0].length) });
  }
  // ALTER FUNCTION | ROUTINE name [(args)] <action>: RENAME TO is followed (a
  // trigger holds its function by OID); any other action (SET search_path,
  // SECURITY DEFINER, OWNER TO, SET SCHEMA …) leaves a function that is not
  // the one reviewed, so it guards nothing until a CREATE re-states it
  // (verifier G3b B).
  for (const m of src.matchAll(new RegExp(String.raw`\balter\s+(?:function|routine)\s+(${NAME})(?![\w$."])\s*(?:\([^)]*\))?\s*(?:(rename\s+to\s+(${NAME}))|[a-z])`, "gi"))) {
    if (!leads(src, m.index!)) continue;
    if (m[2]) out.push({ k: "renamefn", pos: base + m.index!, name: bare(m[1]!), to: bare(m[3]!) });
    else out.push({ k: "alterfn", pos: base + m.index!, name: bare(m[1]!) });
  }
  for (const m of src.matchAll(/\bdrop\s+(?:function|routine)\s+(?:if\s+exists\s+)?/gi)) {
    if (!leads(src, m.index!)) continue;
    for (const name of droppedFunctions(src, m.index! + m[0].length, inExecuteLiteral(src, m.index!))) {
      out.push({ k: "dropfn", pos: base + m.index!, name });
    }
  }
  const trigRe = new RegExp(
    String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+(${NAME})\s+(before|after|instead\s+of)\s+([\s\S]+?)\s+on\s+(${NAME})\s+([\s\S]*?)\bexecute\s+(?:function|procedure)\s+(${NAME})\s*\(`,
    "gi",
  );
  for (const m of src.matchAll(trigRe)) {
    if (!leads(src, m.index!)) continue;
    if (!isProfiles(m[4]!)) continue;
    const events = new Set(m[3]!.toLowerCase().split(/\s+or\s+/).map((e) => e.trim().split(/\s+/)[0]!));
    out.push({
      k: "trigger",
      pos: base + m.index!,
      name: bare(m[1]!),
      before: m[2]!.toLowerCase() === "before",
      row: /\bfor\s+each\s+row\b/i.test(m[5]!),
      events,
      fn: bare(m[6]!),
      // WHEN (…) between ON <table> and EXECUTE: the trigger fires only where
      // the condition holds, and WHEN (false) never (verifier G3 F2).
      qualified: /\bwhen\s*\(/i.test(m[5]!),
      // UPDATE OF <columns>: it fires only when the UPDATE names one of them,
      // so `SET verified = true` alone never reaches it (BETA2 verifier F6).
      columnList: /\bupdate\s+of\b/i.test(m[3]!),
    });
  }
  for (const m of src.matchAll(new RegExp(String.raw`\balter\s+trigger\s+(${NAME})\s+on\s+(${NAME})\s+rename\s+to\s+(${NAME})`, "gi"))) {
    if (!leads(src, m.index!) || !isProfiles(m[2]!)) continue;
    out.push({ k: "renametrigger", pos: base + m.index!, name: bare(m[1]!), to: bare(m[3]!) });
  }
  for (const m of src.matchAll(new RegExp(String.raw`\bdrop\s+trigger\s+(?:if\s+exists\s+)?(${NAME})\s+on\s+(${NAME})`, "gi"))) {
    if (!leads(src, m.index!) || !isProfiles(m[2]!)) continue;
    out.push({ k: "droptrigger", pos: base + m.index!, name: bare(m[1]!) });
  }
  // ALTER TABLE profiles takes a comma-separated list of actions; EVERY one of
  // them is read, so `ADD COLUMN …, DISABLE TRIGGER t` disables t (verifier
  // G3b C). String literals are blanked first: a DEFAULT ', DISABLE TRIGGER t'
  // is data.
  for (const m of src.matchAll(new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${NAME})(?![\w$."])(?:\s*\*)?`, "gi"))) {
    if (!leads(src, m.index!) || !isProfiles(m[1]!)) continue;
    const rest = statementRest(src, m.index! + m[0].length, inExecuteLiteral(src, m.index!));
    for (const a of rest.matchAll(new RegExp(String.raw`(?:^|,)\s*(enable|disable)\s+(?:(replica|always)\s+)?trigger\s+(${NAME})`, "gi"))) {
      const which = fold(a[3]!);
      // ENABLE REPLICA fires only under session_replication_role = replica —
      // never for a PostgREST request — so it is not enabled (verifier G3 F4).
      const enabled = a[1]!.toLowerCase() === "enable" && (a[2] ?? "").toLowerCase() !== "replica";
      out.push({ k: "enable", pos: base + m.index! + a.index!, name: which === "all" || which === "user" ? null : bare(a[3]!), enabled });
    }
  }
  return out;
}

export interface ProfilesTrigger {
  name: string;
  fn: string;
  before: boolean;
  row: boolean;
  events: string[];
  enabled: boolean;
  /** Carries a WHEN (…) condition. */
  qualified: boolean;
  /** Fires on UPDATE OF a column list only. */
  columnList: boolean;
  /** The function's last definition, or null when it was dropped or never defined. */
  body: string | null;
}

/** The triggers on profiles after the baseline and the chain, each with its function's last body. */
export function replayProfilesTriggers(files: readonly MigrationText[], baselineSql: string): ProfilesTrigger[] {
  const bodies = new Map<string, string>();
  const trigs = new Map<string, Omit<ProfilesTrigger, "body">>();
  const apply = (e: TrigEvent) => {
    if (e.k === "fn") bodies.set(e.name, e.body);
    else if (e.k === "dropfn") bodies.delete(e.name);
    else if (e.k === "alterfn") {
      // Altered in place (search_path, SECURITY, owner, schema …): not the
      // function that was reviewed — an UNKNOWN body, which guards nothing.
      if (bodies.has(e.name)) bodies.set(e.name, "");
    }
    else if (e.k === "renamefn") {
      // A trigger holds its function by OID, so it follows the rename; a later
      // CREATE under the old name is a different function.
      const b = bodies.get(e.name);
      bodies.delete(e.name);
      if (b !== undefined) bodies.set(e.to, b);
      for (const t of trigs.values()) if (t.fn === e.name) t.fn = e.to;
    } else if (e.k === "trigger")
      trigs.set(e.name, { name: e.name, fn: e.fn, before: e.before, row: e.row, events: [...e.events].sort(), enabled: true, qualified: e.qualified, columnList: e.columnList });
    else if (e.k === "droptrigger") trigs.delete(e.name);
    else if (e.k === "renametrigger") {
      const t = trigs.get(e.name);
      trigs.delete(e.name);
      if (t) trigs.set(e.to, { ...t, name: e.to });
    } else for (const t of trigs.values()) if (e.name === null || t.name === e.name) t.enabled = e.enabled;
  };
  for (const e of eventsOf(baselineSql).trig) apply(e);
  for (const f of chainOf(files)) for (const e of eventsOf(f.sql).trig) apply(e);
  return [...trigs.values()].map((t) => ({ ...t, body: bodies.get(t.fn) ?? null })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PREDICATE_CALL = /\bcaller_may_write_profile_role\s*\(\s*\)/i;

/**
 * True when an enabled, unconditional (no WHEN, no UPDATE OF column list)
 * BEFORE INSERT OR UPDATE row trigger's
 * function guards `column` in both directions. TEXTUAL, on the body with its
 * comments removed: it compares NEW.<col> to OLD.<col> and reads NEW.<col>
 * again (the INSERT side), consults the predicate, and reaches that call before
 * its first RETURN — an early RETURN NEW leaves the comparisons as dead code
 * (verifier G3 F3). A body that keeps these shapes but never reaches them
 * (IF false THEN …) passes; the executed proof is the local-db suite.
 */
export function triggerGuards(t: ProfilesTrigger, column: string): boolean {
  if (!t.enabled || t.qualified || t.columnList || !t.before || !t.row || !t.events.includes("insert") || !t.events.includes("update") || t.body === null) return false;
  const code = codeOf(t.body);
  const c = esc(column);
  const call = PREDICATE_CALL.exec(code);
  const ret = /\breturn\b/i.exec(code);
  return (
    new RegExp(String.raw`\bNEW\.${c}\s+IS\s+DISTINCT\s+FROM\s+OLD\.${c}\b`, "i").test(code) &&
    (code.match(new RegExp(String.raw`\bNEW\.${c}\b`, "gi")) ?? []).length >= 2 &&
    call !== null &&
    (ret === null || ret.index > call.index)
  );
}

export interface PredicateRedefinition {
  file: string;
  what: string;
}

const PREDICATE = "caller_may_write_profile_role";
/** The predicate's name as a statement writes it: optionally public-qualified or quoted, not a longer name. */
const PREDICATE_NAME = String.raw`(?:"?public"?\s*\.\s*)?"?${PREDICATE}"?(?![\w$])`;

/** Each CREATE FUNCTION of the predicate in `text`, with its normalised full definition (null: a body this cannot read). */
function predicateCreates(text: string): Array<{ verb: string; def: string | null }> {
  const out: Array<{ verb: string; def: string | null }> = [];
  for (const m of text.matchAll(new RegExp(String.raw`\b(create\s+(?:or\s+replace\s+)?function)\s+${PREDICATE_NAME}\s*\(`, "gi"))) {
    if (!leads(text, m.index!)) continue;
    out.push({ verb: m[1]!.toLowerCase().replace(/\s+/g, " "), def: functionDefinition(text, m.index! + m[0].length) });
  }
  return out;
}

/**
 * Every chain statement that changes caller_may_write_profile_role() — the
 * predicate behind 2078's, 0106/2079's, 2163's, 3600's and 3742's guards. One
 * CREATE OR REPLACE returning true opens every authority column behind every
 * one of those triggers (verifier G3 F1). A CREATE whose FULL definition —
 * arguments, header options before and after the body, and the body — equals
 * the baseline's (modulo whitespace, keyword case and comments) is a
 * re-statement and passes; any other CREATE is a finding, the same body under
 * another `SET search_path`, SECURITY, LANGUAGE or volatility included
 * (verifier G3b A). So is any DROP FUNCTION | ROUTINE that lists it and any
 * ALTER FUNCTION | ROUTINE of it (RENAME, OWNER, SECURITY, SET …), with or
 * without an argument list (verifier G3b B).
 */
export function predicateRedefinitions(files: readonly MigrationText[], baselineSql: string): PredicateRedefinition[] {
  const baseDefs = predicateCreates(blankSqlComments(baselineSql));
  const want = baseDefs.length ? baseDefs[baseDefs.length - 1]!.def : null;
  const out: PredicateRedefinition[] = [];
  const alterRe = new RegExp(String.raw`\b(alter\s+(?:function|routine))\s+${PREDICATE_NAME}`, "gi");
  const listed = new RegExp(String.raw`^\s*${PREDICATE_NAME}`, "i");
  for (const f of chainOf(files)) {
    const src = blankSqlComments(f.sql);
    for (const text of [src, expandForeachLiteralLoops(src)]) {
      for (const c of predicateCreates(text)) {
        if (want !== null && c.def === want) continue;
        out.push({
          file: f.name,
          what: `${c.verb} ${PREDICATE}() with a definition that is not the baseline's (2078's)${c.def === null ? " (a body this rule cannot read)" : ""}`,
        });
      }
      for (const m of text.matchAll(alterRe)) {
        if (!leads(text, m.index!)) continue;
        out.push({ file: f.name, what: `${m[1]!.toLowerCase().replace(/\s+/g, " ")} ${PREDICATE}` });
      }
      for (const m of text.matchAll(/\b(drop\s+(?:function|routine))\s+(?:if\s+exists\s+)?/gi)) {
        if (!leads(text, m.index!)) continue;
        const items = splitTop(statementRest(text, m.index! + m[0].length, inExecuteLiteral(text, m.index!)));
        if (items.some((item) => listed.test(item))) out.push({ file: f.name, what: `${m[1]!.toLowerCase().replace(/\s+/g, " ")} ${PREDICATE}` });
      }
    }
  }
  return out;
}

export interface AuthorityTriggerGap {
  column: string;
  pending: boolean;
  note: string;
}

/** Authority columns no trigger guards; a `pending` gap is reported, not failed. */
export function unguardedAuthorityColumns(files: readonly MigrationText[], baselineSql: string): AuthorityTriggerGap[] {
  const trigs = replayProfilesTriggers(files, baselineSql);
  const redefined = predicateRedefinitions(files, baselineSql);
  const definesFn = (fn: string) =>
    new RegExp(String.raw`\bfunction\s+(?:"?public"?\.)?"?${esc(fn)}"?\s*\(`, "i").test(baselineSql) ||
    files.some((f) => new RegExp(String.raw`\bfunction\s+(?:"?public"?\.)?"?${esc(fn)}"?\s*\(`, "i").test(f.sql));
  const out: AuthorityTriggerGap[] = [];
  for (const col of PROFILE_AUTHORITY_COLUMNS) {
    if (redefined.length) {
      // Every guard consults the predicate: a changed predicate unguards them all.
      out.push({
        column: col.column,
        pending: false,
        note: `its guard trusts caller_may_write_profile_role(), which the chain changes (${redefined.map((r) => `${r.file}: ${r.what}`).join("; ")})`,
      });
      continue;
    }
    if (trigs.some((t) => triggerGuards(t, col.column))) continue;
    const landed = col.pending && (definesFn(col.pending.fn) || files.some((f) => f.name.startsWith(col.pending!.filePrefix)));
    const pending = !!col.pending && !landed;
    out.push({
      column: col.column,
      pending,
      note: pending ? col.pending!.note : `no enabled BEFORE INSERT OR UPDATE row trigger on profiles guards it (expected: ${col.guardedBy})`,
    });
  }
  return out;
}
