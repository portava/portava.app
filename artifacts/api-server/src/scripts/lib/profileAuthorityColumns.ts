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
 * Barrier 2 is replayed the same way over CREATE [OR REPLACE] FUNCTION /
 * DROP FUNCTION, CREATE / DROP TRIGGER … ON profiles and ALTER TABLE profiles
 * ENABLE / DISABLE TRIGGER, and judged on the LAST definition of each function.
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
 * A grant issued through a bare EXECUTE format() outside a loop, through an
 * EXECUTE operand built with `||`, or to a role that is itself a member of
 * anon/authenticated is not modelled; neither is a trigger body that delegates
 * the comparison to another function. None exists in the chain today. The live
 * ACL is audit:live-unexplained's question; this rule keeps the chain honest.
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
      note: "trigger lands with 3600 (PR #592); its column grant is revoked by 3742 now",
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
  | { k: "trigger"; pos: number; name: string; before: boolean; row: boolean; events: Set<string>; fn: string }
  | { k: "droptrigger"; pos: number; name: string }
  | { k: "enable"; pos: number; name: string | null; enabled: boolean };

const NAME = String.raw`(?:"?[A-Za-z_][\w$]*"?\.)?"?[A-Za-z_][\w$]*"?`;
const bare = (q: string) => fold(q.split(".").pop()!);
const isProfiles = (q: string) => namesProfiles(q);

function trigEvents(src: string, base: number): TrigEvent[] {
  const out: TrigEvent[] = [];
  for (const m of src.matchAll(new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+(${NAME})\s*\(`, "gi"))) {
    if (!leads(src, m.index!)) continue;
    const after = m.index! + m[0].length;
    const open = /\$([A-Za-z_][\w]*)?\$/.exec(src.slice(after));
    if (!open) continue;
    // The body's opening quote comes before the header's first `;`. A
    // single-quoted body ('SELECT …';) has none, and the next dollar quote
    // belongs to someone else.
    const semi = src.indexOf(";", after);
    if (semi >= 0 && semi < after + open.index) continue;
    const start = after + open.index + open[0].length;
    const close = src.indexOf(open[0], start);
    if (close < 0) continue;
    out.push({ k: "fn", pos: base + m.index!, name: bare(m[1]!), body: src.slice(start, close) });
  }
  for (const m of src.matchAll(new RegExp(String.raw`\bdrop\s+function\s+(?:if\s+exists\s+)?(${NAME})`, "gi"))) {
    if (!leads(src, m.index!)) continue;
    out.push({ k: "dropfn", pos: base + m.index!, name: bare(m[1]!) });
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
    });
  }
  for (const m of src.matchAll(new RegExp(String.raw`\bdrop\s+trigger\s+(?:if\s+exists\s+)?(${NAME})\s+on\s+(${NAME})`, "gi"))) {
    if (!leads(src, m.index!) || !isProfiles(m[2]!)) continue;
    out.push({ k: "droptrigger", pos: base + m.index!, name: bare(m[1]!) });
  }
  for (const m of src.matchAll(
    new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${NAME})\s+(enable|disable)\s+(?:(?:replica|always)\s+)?trigger\s+(${NAME})`, "gi"),
  )) {
    if (!leads(src, m.index!) || !isProfiles(m[1]!)) continue;
    const which = fold(m[3]!);
    out.push({ k: "enable", pos: base + m.index!, name: which === "all" || which === "user" ? null : bare(m[3]!), enabled: m[2]!.toLowerCase() === "enable" });
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
    else if (e.k === "trigger") trigs.set(e.name, { name: e.name, fn: e.fn, before: e.before, row: e.row, events: [...e.events].sort(), enabled: true });
    else if (e.k === "droptrigger") trigs.delete(e.name);
    else for (const t of trigs.values()) if (e.name === null || t.name === e.name) t.enabled = e.enabled;
  };
  for (const e of eventsOf(baselineSql).trig) apply(e);
  for (const f of chainOf(files)) for (const e of eventsOf(f.sql).trig) apply(e);
  return [...trigs.values()].map((t) => ({ ...t, body: bodies.get(t.fn) ?? null })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when an enabled BEFORE INSERT OR UPDATE row trigger's function guards `column` in both directions. */
export function triggerGuards(t: ProfilesTrigger, column: string): boolean {
  if (!t.enabled || !t.before || !t.row || !t.events.includes("insert") || !t.events.includes("update") || t.body === null) return false;
  const c = esc(column);
  return (
    new RegExp(String.raw`\bNEW\.${c}\s+IS\s+DISTINCT\s+FROM\s+OLD\.${c}\b`, "i").test(t.body) &&
    (t.body.match(new RegExp(String.raw`\bNEW\.${c}\b`, "gi")) ?? []).length >= 2 &&
    /\bcaller_may_write_profile_role\s*\(\s*\)/i.test(t.body)
  );
}

export interface AuthorityTriggerGap {
  column: string;
  pending: boolean;
  note: string;
}

/** Authority columns no trigger guards; a `pending` gap is reported, not failed. */
export function unguardedAuthorityColumns(files: readonly MigrationText[], baselineSql: string): AuthorityTriggerGap[] {
  const trigs = replayProfilesTriggers(files, baselineSql);
  const definesFn = (fn: string) =>
    new RegExp(String.raw`\bfunction\s+(?:"?public"?\.)?"?${esc(fn)}"?\s*\(`, "i").test(baselineSql) ||
    files.some((f) => new RegExp(String.raw`\bfunction\s+(?:"?public"?\.)?"?${esc(fn)}"?\s*\(`, "i").test(f.sql));
  const out: AuthorityTriggerGap[] = [];
  for (const col of PROFILE_AUTHORITY_COLUMNS) {
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
