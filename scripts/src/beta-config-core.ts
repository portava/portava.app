/**
 * beta-config-core.ts — the PURE half of the portava-beta configuration step
 * (scripts/src/beta-configure.ts, dispatched by .github/workflows/beta-config.yml
 * after beta-db.yml has built the schema).
 *
 * WHAT THE STEP CONFIGURES, AND NOTHING ELSE
 * ==========================================
 *   (a) Supabase Auth, through the Management API:
 *         PATCH /v1/projects/{ref}/config/auth  { disable_signup, site_url, uri_allow_list }
 *       then GET /v1/projects/{ref}/config/auth and compare. Field names verified
 *       2026-10-06 against https://supabase.com/docs/reference/api/v1-update-auth-service-config
 *       (`disable_signup` boolean, `site_url` string, `uri_allow_list` STRING — the
 *       comma-separated GoTrue allow list; https://supabase.com/docs/guides/auth/redirect-urls
 *       documents the `**` wildcard). The read-back compares the allow list as a
 *       SET, so a server that re-joins it differently is not a false mismatch,
 *       and a missing or extra entry is a real one.
 *       disable_signup closes the doors the API cannot see: the mobile app signs
 *       up with supabase.auth.signUp and signs in with signInWithIdToken
 *       (Apple/Google), both of which create users inside Supabase Auth.
 *   (b) public.feature_flags to scripts/src/beta-flag-policy.json, in ONE
 *       transaction that also writes a feature_flag_audit_log row (changed_by
 *       NULL: no admin profile exists on a fresh beta) for every flag it flips.
 *   (c) a read-back of both, compared against what was asked for.
 *
 * Everything here is a constant, a parser, a planner or a SQL-text builder.
 * The only I/O helper, betaManagementClient(), takes its ref, token and fetch
 * as ARGUMENTS, so scripts/src/beta-configure.test.ts drives it with a stubbed
 * Management API and no credentials.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BETA_PROJECT_REF, PRODUCTION_PROJECT_REF, quoteLiteral, resolveProjectRef } from "./beta-db-core.js";
import { MIGRATIONS_DIR, listMigrationFiles } from "./apply-migrations.js";

const __dir = dirname(fileURLToPath(import.meta.url));

export const CONFIRMATION = "CONFIGURE-BETA";
export const FLAG_POLICY_PATH = resolve(__dir, "beta-flag-policy.json");

/** The beta API's EXPECTED Replit origin (the fork is to be named portava-beta). Not a measured URL. */
export const BETA_WEB_ORIGIN = "https://portava-beta.replit.app";
/** The mobile app's URL scheme (travel-buddy-standalone/app.json `expo.scheme`). */
export const APP_SCHEME = "travelbuddy";

export interface AuthConfig {
  disable_signup: boolean;
  site_url: string;
  uri_allow_list: string;
}

export const BETA_AUTH_CONFIG: AuthConfig = {
  disable_signup: true,
  site_url: BETA_WEB_ORIGIN,
  // travelbuddy://** covers travelbuddy://update-password (src/services/auth.ts
  // requestPasswordReset) and any other in-app deep link; the web origin covers
  // the static web build the beta API serves.
  uri_allow_list: `${APP_SCHEME}://**,${BETA_WEB_ORIGIN}/**`,
};

/** null when the target is portava-beta; otherwise why the step refuses (exit 2). */
export function configureTargetRefusal(url: string | undefined): string | null {
  const ref = resolveProjectRef(url);
  if (ref === null) return "SUPABASE_URL is not https://<ref>.supabase.co; there is no target to verify.";
  if (ref === PRODUCTION_PROJECT_REF) return "SUPABASE_URL names PRODUCTION. Never.";
  if (ref !== BETA_PROJECT_REF) {
    return (
      `SUPABASE_URL names project ${ref}, not portava-beta (${BETA_PROJECT_REF}). This step closes sign-up and ` +
      "rewrites every feature flag; it is hard-wired to the beta project, whatever the allowlist says."
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FLAG POPULATION — every flag the beta database will contain, from the
// migrations. Same matcher as artifacts/api-server/scripts/check-flag-polarity.mjs
// (comment-stripped, quote-aware, optional schema qualifier, `('name', bool`
// rows) so the two agree on what "seeded" means; plus the DELETE FROM
// feature_flags statements that retire flags, applied in chain order.
// ─────────────────────────────────────────────────────────────────────────────

export interface SeededFlag {
  flag: string;
  /** "<file>:<line>" of the first seeding row. */
  seededIn: string;
  seededValue: boolean;
  /**
   * Did ANY migration ever turn it on — a TRUE seed row, or an
   * `UPDATE feature_flags SET enabled = true` naming it (3501 does both)? The
   * policy test uses this to catch a post-snapshot migration that seeds a flag
   * TRUE without the policy deciding it explicitly.
   */
  everSetTrue: boolean;
}

/** Quote-aware SQL comment strip (same contract as check-flag-polarity's stripSqlComments). */
export function stripSqlComments(sql: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const d = sql[i + 1];
    if (inStr) {
      out += c;
      if (c === "'" && d === "'") out += sql[++i];
      else if (c === "'") inStr = false;
      continue;
    }
    if (c === "'") { inStr = true; out += c; continue; }
    if (c === "-" && d === "-") {
      while (i < sql.length && sql[i] !== "\n") { out += " "; i++; }
      out += "\n";
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) { out += sql[i] === "\n" ? "\n" : " "; i++; }
      i++;
      out += "  ";
      continue;
    }
    out += c;
  }
  return out;
}

/** The statement starting at `index`, up to its first semicolon outside a string literal. */
function statementAt(text: string, index: number): string {
  const rest = text.slice(index);
  let inQuote = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "'") inQuote = !inQuote;
    else if (rest[i] === ";" && !inQuote) return rest.slice(0, i);
  }
  return rest;
}

const INSERT_RE = /INSERT\s+INTO\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?feature_flags\b/gi;
const DELETE_RE = /DELETE\s+FROM\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?feature_flags\b/gi;
const UPDATE_RE = /UPDATE\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?feature_flags\b/gi;
const ROW_RE = /\(\s*'([A-Za-z0-9_]+)'\s*,\s*(true|false)\b/gi;

/** A SQL LIKE pattern (`%`, `_`, backslash escapes) as an anchored RegExp; ILIKE is case-insensitive. */
export function likeToRegExp(pattern: string, caseInsensitive = false): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) { out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (c === "%") out += ".*";
    else if (c === "_") out += ".";
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, caseInsensitive ? "i" : "");
}

/**
 * Flags the migration chain leaves in public.feature_flags, in chain order:
 * seeded by an INSERT, minus those a later DELETE retires (re-seeding after a
 * retirement brings a flag back). Pure over (files, read).
 */
export function seededFlagPopulation(
  files: readonly string[] = listMigrationFiles(),
  read: (f: string) => string = (f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"),
): Map<string, SeededFlag> {
  const live = new Map<string, SeededFlag>();
  for (const f of files) {
    const text = stripSqlComments(read(f));
    const events: Array<{ at: number; kind: "seed" | "delete" | "set-true" | "set-true-like"; flag: string; value?: boolean; line?: number }> = [];
    for (const m of text.matchAll(INSERT_RE)) {
      const stmt = statementAt(text, m.index ?? 0);
      for (const r of stmt.matchAll(ROW_RE)) {
        const at = (m.index ?? 0) + (r.index ?? 0);
        events.push({ at, kind: "seed", flag: r[1], value: r[2].toLowerCase() === "true", line: text.slice(0, at).split("\n").length });
      }
    }
    for (const m of text.matchAll(UPDATE_RE)) {
      const stmt = statementAt(text, m.index ?? 0);
      const setAt = stmt.search(/\bSET\b/i);
      if (setAt < 0) continue;
      const whereAt = stmt.search(/\bWHERE\b/i);
      const setClause = stmt.slice(setAt + 3, whereAt >= 0 ? whereAt : stmt.length);
      // `enabled = true` anywhere in the SET list (`SET metadata = '{}', enabled = true` too), outside literals.
      if (!/(?:^|,)\s*enabled\s*=\s*true\b/i.test(setClause.replace(/'(?:[^']|'')*'/g, "''"))) continue;
      const where = whereAt >= 0 ? stmt.slice(whereAt) : "";
      for (const r of where.matchAll(/'([A-Za-z0-9_]+)'/g)) events.push({ at: m.index ?? 0, kind: "set-true", flag: r[1] });
      // `WHERE flag LIKE 'wall\_%'` — every live flag the pattern matches at this point in the chain.
      for (const r of where.matchAll(/\bflag\s+(I?LIKE)\s+'((?:[^']|'')*)'/gi)) {
        events.push({ at: m.index ?? 0, kind: "set-true-like", flag: r[2], value: r[1].toUpperCase() === "ILIKE" });
      }
    }
    for (const m of text.matchAll(DELETE_RE)) {
      const stmt = statementAt(text, m.index ?? 0);
      for (const r of stmt.matchAll(/'([A-Za-z0-9_]+)'/g)) events.push({ at: m.index ?? 0, kind: "delete", flag: r[1] });
    }
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.kind === "delete") live.delete(e.flag);
      else if (e.kind === "set-true") {
        const cur = live.get(e.flag);
        if (cur) cur.everSetTrue = true;
      } else if (e.kind === "set-true-like") {
        const re = likeToRegExp(e.flag, e.value === true);
        for (const cur of live.values()) if (re.test(cur.flag)) cur.everSetTrue = true;
      } else if (!live.has(e.flag)) {
        live.set(e.flag, { flag: e.flag, seededIn: `${f}:${e.line}`, seededValue: e.value === true, everSetTrue: e.value === true });
      } else if (e.value === true) {
        live.get(e.flag)!.everSetTrue = true;
      }
    }
  }
  return live;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE POLICY
// ─────────────────────────────────────────────────────────────────────────────

export type FlagKind = "STOP" | "CAPABILITY" | "CONFIG";

export interface FlagPolicyEntry {
  flag: string;
  /** The ROW value written to public.feature_flags.enabled. For a STOP flag, true = the stop is ENGAGED. */
  enabled: boolean;
  kind: FlagKind;
  /** One line: why this value. */
  reason: string;
  /** Census rows (census-<name>:<ROW>), owner decisions (OD-*), lead rulings (D-nn). */
  evidence: string[];
}

export interface FlagPolicy {
  format: "portava-beta-flag-policy/1";
  project_ref: string;
  flags: FlagPolicyEntry[];
}

export function loadFlagPolicy(path: string = FLAG_POLICY_PATH): FlagPolicy {
  return JSON.parse(readFileSync(path, "utf8")) as FlagPolicy;
}

/** Structural problems with a policy against a population (empty = valid). */
export function flagPolicyProblems(policy: FlagPolicy, population: ReadonlyMap<string, SeededFlag>): string[] {
  const problems: string[] = [];
  if (policy.format !== "portava-beta-flag-policy/1") problems.push(`unknown policy format ${JSON.stringify(policy.format)}`);
  if (policy.project_ref !== BETA_PROJECT_REF) problems.push(`policy.project_ref must be ${BETA_PROJECT_REF}`);
  const seen = new Map<string, number>();
  for (const e of policy.flags) seen.set(e.flag, (seen.get(e.flag) ?? 0) + 1);
  for (const [flag, n] of seen) if (n > 1) problems.push(`${flag} is listed ${n} times`);
  for (const flag of population.keys()) if (!seen.has(flag)) problems.push(`${flag} is seeded by ${population.get(flag)?.seededIn} but not in the policy`);
  for (const e of policy.flags) {
    if (!population.has(e.flag)) problems.push(`${e.flag} is in the policy but no migration leaves it in feature_flags`);
    if (typeof e.enabled !== "boolean") problems.push(`${e.flag}: enabled must be a boolean`);
    if (!["STOP", "CAPABILITY", "CONFIG"].includes(e.kind)) problems.push(`${e.flag}: unknown kind ${JSON.stringify(e.kind)}`);
    if (typeof e.reason !== "string" || !e.reason.trim() || /\n/.test(e.reason)) problems.push(`${e.flag}: reason must be one non-empty line`);
    if (!Array.isArray(e.evidence)) problems.push(`${e.flag}: evidence must be an array`);
    else if (e.enabled && (e.evidence.length === 0 || e.evidence.some((x) => typeof x !== "string" || !x.trim()))) {
      problems.push(`${e.flag}: an enabled entry needs non-empty evidence`);
    }
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// APPLYING THE POLICY
// ─────────────────────────────────────────────────────────────────────────────

export interface FlagRow {
  flag: string;
  enabled: boolean;
}

export const FLAG_STATE_SQL = "SELECT flag, enabled FROM public.feature_flags ORDER BY flag";

export interface FlagPlan {
  /** Policy flags absent from the database — the step refuses to write. */
  missing: string[];
  /** Database flags no policy entry names — forced OFF and reported. */
  unknown: string[];
  /** What the database must read after the apply. */
  target: Map<string, boolean>;
  changes: Array<{ flag: string; from: boolean; to: boolean }>;
}

export function planFlagApply(rows: readonly FlagRow[], policy: FlagPolicy): FlagPlan {
  const want = new Map(policy.flags.map((e) => [e.flag, e.enabled]));
  const have = new Map(rows.map((r) => [r.flag, r.enabled]));
  const missing = [...want.keys()].filter((f) => !have.has(f)).sort();
  const unknown = [...have.keys()].filter((f) => !want.has(f)).sort();
  const target = new Map<string, boolean>();
  for (const f of have.keys()) target.set(f, want.get(f) === true);
  const changes = [...target]
    .filter(([f, to]) => have.get(f) !== to)
    .map(([flag, to]) => ({ flag, from: have.get(flag) === true, to }))
    .sort((a, b) => (a.flag < b.flag ? -1 : 1));
  return { missing, unknown, target, changes };
}

const FLAG_NAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * ONE statement, ONE transaction: every row is set to its target (true for the
 * ON set, false for everything else, policy-unknown flags included), and every
 * row whose value changed gets an audit row. Returns the flipped flags.
 */
export function buildFlagApplySql(onFlags: readonly string[]): string {
  for (const f of onFlags) if (!FLAG_NAME_RE.test(f)) throw new Error(`refusing to splice flag name '${f}' into SQL`);
  const on = onFlags.length ? `ARRAY[${onFlags.map(quoteLiteral).join(", ")}]::text[]` : "ARRAY[]::text[]";
  return (
    "WITH changed AS (" +
    ` UPDATE public.feature_flags SET enabled = (flag = ANY(${on})), updated_at = now()` +
    ` WHERE enabled IS DISTINCT FROM (flag = ANY(${on}))` +
    " RETURNING flag, enabled), audited AS (" +
    " INSERT INTO public.feature_flag_audit_log (flag, changed_by_user_id, old_enabled, new_enabled)" +
    " SELECT flag, NULL, NOT enabled, enabled FROM changed RETURNING flag)" +
    " SELECT flag FROM audited ORDER BY flag"
  );
}

/** Read-back: every database row must equal its target, and nothing may be missing. */
export function flagStateProblems(rows: readonly FlagRow[], target: ReadonlyMap<string, boolean>): string[] {
  const have = new Map(rows.map((r) => [r.flag, r.enabled]));
  const problems: string[] = [];
  for (const [flag, want] of target) {
    if (!have.has(flag)) problems.push(`${flag}: missing on read-back`);
    else if (have.get(flag) !== want) problems.push(`${flag}: reads ${have.get(flag)}, policy says ${want}`);
  }
  return problems;
}

/** Read-back of Auth: field by field; the allow list compared as a set. */
export function authConfigProblems(got: unknown, want: AuthConfig = BETA_AUTH_CONFIG): string[] {
  if (typeof got !== "object" || got === null) return ["the auth config read-back is not an object"];
  const g = got as Record<string, unknown>;
  const problems: string[] = [];
  if (g.disable_signup !== want.disable_signup) problems.push(`disable_signup reads ${JSON.stringify(g.disable_signup)}, want ${want.disable_signup}`);
  if (g.site_url !== want.site_url) problems.push(`site_url reads ${JSON.stringify(g.site_url)}, want ${JSON.stringify(want.site_url)}`);
  const asSet = (v: unknown) => new Set(typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const gotList = asSet(g.uri_allow_list);
  const wantList = asSet(want.uri_allow_list);
  const missing = [...wantList].filter((u) => !gotList.has(u));
  const extra = [...gotList].filter((u) => !wantList.has(u));
  if (typeof g.uri_allow_list !== "string") problems.push(`uri_allow_list reads ${JSON.stringify(g.uri_allow_list)}, want a comma-separated string`);
  else if (missing.length || extra.length) {
    problems.push(`uri_allow_list differs${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; unexpected ${extra.join(", ")}` : ""}`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE profiles CLIENT GRANT (migration 3740, PR #647) — verified before testers
// ─────────────────────────────────────────────────────────────────────────────
//
// The baseline is a pg_dump: it records profiles' client ACL as COLUMN grants
// (anon/authenticated may read 61 columns, never date_of_birth, full_name,
// expo_push_token, phone_e164 …). Replayed onto a Supabase project, whose
// default ACL already hands anon and authenticated ALL on every new table in
// public (and scripts/src/beta-db-core.ts buildResetSql sets that default before
// a rebuild), CREATE TABLE profiles inherits TABLE-level SELECT/UPDATE, which
// covers every column. On such a database the PUBLIC anon key reads the
// personal columns of every non-private profile. 3740 revokes the table-level
// grants and re-issues the baseline's column lists; its own postcondition
// proves the result. This read proves the property independently on beta, and
// the configuration step fails (after configuring) while it does not hold:
// no tester account may exist on a database where it does not.

/** Personal or authority columns no client role may read (3740's v_never_read). */
export const PROFILES_NEVER_READ = [
  "date_of_birth", "full_name", "expo_push_token", "phone_e164", "phone_verified_at",
  "trust_score", "safety_flags_count", "id_verified_at", "selfie_verified_at", "verification_method",
] as const;

/**
 * profiles' AUTHORITY columns: server-write-only after migration 3742 (PR #653, stacked on #647) — exactly 3742's
 * v_revoked. The verified badge and its timestamp, trust score and label, verification method, the "Featured by
 * Portava" counter, the account's age and status, role (2078), is_official (0106/2079) and the nine verification
 * columns 2163's trigger guards. No client role may hold UPDATE on any of them, at column or table level (lead
 * rulings G3-1/G3-2; BETA-6 extended 2026-10-07): a tester who can write them can give themselves the verified
 * badge, a trust tier, an older account or a role.
 */
export const PROFILES_SERVER_ONLY = [
  "verified", "verified_at", "trust_score", "trust_label",
  "verification_method", "featured_count", "created_at", "account_status",
  "role", "is_official", "verification_status", "verification_level",
  "verified_since", "id_verified_at", "selfie_verified_at",
  "home_country_verified_at", "host_verified_at", "buddy_verified_at",
  "safety_flags_count",
] as const;

/** 3742's second barrier, which survives a careless re-grant: this trigger on public.profiles running this function. */
export const PROFILES_AUTHORITY_TRIGGER = "trg_profiles_authority_privileged";
export const PROFILES_AUTHORITY_FUNCTION = "public.enforce_profile_authority_privileged()";
/** The columns that trigger compares, NEW against OLD, before asking who is writing — exactly 3742's v_guarded. */
export const PROFILES_TRIGGER_GUARDED = [
  "verified", "verified_at", "trust_score", "trust_label", "verification_method", "featured_count", "created_at",
] as const;
/**
 * The predicate every profiles guard trusts (2078; 3742's trigger, 2163's, 0106/2079's, 3600's). One CREATE OR REPLACE
 * returning true would open every authority column behind all of them while the trigger itself still looks right.
 */
export const PROFILES_ROLE_PREDICATE = "public.caller_may_write_profile_role()";

/**
 * What a passing step f has verified, as beta-config.yml's run-name states it. beta:status (gate 3c) accepts only a
 * configuration run whose title carries this marker: a run made by older code checked less. Change the boundary,
 * change the marker (the workflow's run-name is pinned to it by test). v2 (verifier BETA2b F3): step f also refuses a
 * conditional (WHEN) trigger, a trigger function that no longer compares or refuses, and a replaced predicate. v3
 * (verifier BETA2c F6): and a trigger limited to a column list (`UPDATE OF …`, tgattr non-empty).
 */
export const PROFILES_BOUNDARY_MARKER = "profiles boundary 3740+3742 v3";

const sqlList = (xs: readonly string[]) => `ARRAY[${xs.map((c) => `'${c}'`).join(", ")}]::name[]`;
const AUTH_FN = `to_regprocedure('${PROFILES_AUTHORITY_FUNCTION}')`;
const PREDICATE = `to_regprocedure('${PROFILES_ROLE_PREDICATE}')`;
/** 3742's $post$ regex for "the refusal": IF NOT <predicate> THEN RAISE EXCEPTION (in the comment-stripped source). */
const REFUSAL_RE = "IF\\s+NOT\\s+public\\.caller_may_write_profile_role\\(\\)\\s+THEN\\s+RAISE\\s+EXCEPTION";

/**
 * One row: does public.profiles exist, and what breaks the boundary. Every branch is a READ of the catalog:
 *  - a TABLE-level SELECT or UPDATE held by anon/authenticated (directly or through PUBLIC);
 *  - SELECT on a never-read column (3740);
 *  - UPDATE on a server-only authority column (3742; `role` among them, 2078) — has_column_privilege, so a column,
 *    table-level, PUBLIC or role-membership grant all count;
 *  - 3742's trigger missing, disabled, CONDITIONAL (a WHEN clause: WHEN (false) never fires), LIMITED TO A COLUMN
 *    LIST (`BEFORE INSERT OR UPDATE OF username` never fires for an UPDATE of `verified`; tgattr non-empty — verifier
 *    BETA2c F6, being added to 3742's $post$ on #653; step f has it already, so it is stricter than #653 until then),
 *    or not the BEFORE INSERT OR UPDATE row trigger running its function (tgtype bits 1 ROW, 2 BEFORE, 4 INSERT, 16 UPDATE);
 *  - its function no longer comparing a present guarded column, not consulting the predicate, or not reaching
 *    `IF NOT <predicate> THEN RAISE EXCEPTION … ERRCODE = '42501'` before its first RETURN;
 *  - the predicate missing, or its definition no longer reading current_setting('role') and session_user.
 * These are the TEXTUAL assertions of 3742's own $post$ block (PR #653 head 9b7d0af29b), with its regexes. Not
 * mirrored: its EXECUTED probe (SET ROLE anon/authenticated, call the predicate), which needs a DO block; step f
 * stays one read-only SELECT (lead ruling PR-BETA2-5). Like $post$, the textual checks can be satisfied by a body
 * that keeps these shapes and never reaches them (IF false THEN …); the executed proof of the shipped function is
 * 3742's own db test.
 * OID forms of has_*_privilege, so a missing table yields NULL (no error) and the row still answers; every branch
 * but the first three is conditioned on the table, so a missing table is reported once, by profiles_exists.
 */
export const PROFILES_CLIENT_GRANT_SQL =
  "SELECT to_regclass('public.profiles') IS NOT NULL AS profiles_exists, (" +
  "SELECT coalesce(json_agg(f ORDER BY f), '[]'::json) FROM (" +
  "SELECT r::text || ' holds TABLE-level ' || p AS f" +
  " FROM unnest(ARRAY['anon', 'authenticated']::name[]) AS r CROSS JOIN unnest(ARRAY['SELECT', 'UPDATE']) AS p" +
  " WHERE has_table_privilege(r, to_regclass('public.profiles'), p)" +
  " UNION ALL " +
  "SELECT r::text || ' can SELECT ' || a.attname::text" +
  " FROM unnest(ARRAY['anon', 'authenticated']::name[]) AS r CROSS JOIN pg_catalog.pg_attribute AS a" +
  " WHERE a.attrelid = to_regclass('public.profiles') AND a.attnum > 0 AND NOT a.attisdropped" +
  ` AND a.attname = ANY(ARRAY[${PROFILES_NEVER_READ.map((c) => `'${c}'`).join(", ")}]::name[])` +
  " AND has_column_privilege(r, a.attrelid, a.attnum, 'SELECT')" +
  " UNION ALL " +
  "SELECT r::text || ' can UPDATE ' || a.attname::text" +
  " FROM unnest(ARRAY['anon', 'authenticated']::name[]) AS r CROSS JOIN pg_catalog.pg_attribute AS a" +
  " WHERE a.attrelid = to_regclass('public.profiles') AND a.attnum > 0 AND NOT a.attisdropped" +
  ` AND a.attname = ANY(ARRAY[${PROFILES_SERVER_ONLY.map((c) => `'${c}'`).join(", ")}]::name[])` +
  " AND has_column_privilege(r, a.attrelid, a.attnum, 'UPDATE')" +
  " UNION ALL " +
  `SELECT '${PROFILES_AUTHORITY_TRIGGER} (3742) is missing, disabled, conditional (WHEN), limited to listed columns (UPDATE OF …), or not a BEFORE INSERT OR UPDATE row trigger running ${PROFILES_AUTHORITY_FUNCTION}'` +
  " WHERE to_regclass('public.profiles') IS NOT NULL AND NOT EXISTS (" +
  "SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = to_regclass('public.profiles') AND NOT t.tgisinternal" +
  ` AND t.tgname = '${PROFILES_AUTHORITY_TRIGGER}' AND t.tgfoid = ${AUTH_FN}` +
  " AND t.tgenabled = 'O' AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16" +
  " AND t.tgqual IS NULL AND t.tgattr = '')" +
  " UNION ALL " +
  `SELECT '${PROFILES_AUTHORITY_FUNCTION} (3742) no longer compares ' || c::text` +
  ` FROM unnest(${sqlList(PROFILES_TRIGGER_GUARDED)}) AS c` +
  ` WHERE ${AUTH_FN} IS NOT NULL` +
  " AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = to_regclass('public.profiles') AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped)" +
  ` AND pg_get_functiondef(${AUTH_FN}) !~* ('NEW\\.' || c::text || '\\s+IS\\s+DISTINCT\\s+FROM\\s+OLD\\.' || c::text || '\\M')` +
  " UNION ALL " +
  `SELECT '${PROFILES_AUTHORITY_FUNCTION} (3742) does not refuse through ${PROFILES_ROLE_PREDICATE} (IF NOT … THEN RAISE EXCEPTION … ERRCODE = ''42501'') before its first RETURN'` +
  " FROM (SELECT pg_get_functiondef(p.oid) AS def, regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') AS src" +
  ` FROM pg_catalog.pg_proc AS p WHERE p.oid = ${AUTH_FN}) AS fn` +
  " WHERE to_regclass('public.profiles') IS NOT NULL AND (" +
  "fn.def !~* 'public\\.caller_may_write_profile_role\\(\\)'" +
  ` OR regexp_instr(fn.src, '${REFUSAL_RE}', 1, 1, 0, 'i') = 0` +
  " OR fn.src !~* 'ERRCODE\\s*=\\s*''42501'''" +
  " OR regexp_instr(fn.src, '\\mRETURN\\M', 1, 1, 0, 'i') = 0" +
  ` OR regexp_instr(fn.src, '\\mRETURN\\M', 1, 1, 0, 'i') < regexp_instr(fn.src, '${REFUSAL_RE}', 1, 1, 0, 'i'))` +
  " UNION ALL " +
  `SELECT CASE WHEN ${PREDICATE} IS NULL THEN '${PROFILES_ROLE_PREDICATE} (2078), the predicate the 3742 trigger trusts, is missing'` +
  ` ELSE '${PROFILES_ROLE_PREDICATE} (2078), the predicate the 3742 trigger trusts, no longer decides on current_setting(''role'') and session_user' END` +
  " WHERE to_regclass('public.profiles') IS NOT NULL AND (" +
  `${PREDICATE} IS NULL` +
  ` OR pg_get_functiondef(${PREDICATE}) !~* 'current_setting\\(\\s*''role'''` +
  ` OR pg_get_functiondef(${PREDICATE}) !~* '\\msession_user\\M')` +
  ") AS s) AS findings";

/** Problems from PROFILES_CLIENT_GRANT_SQL's row (empty = the 3740 + 3742 boundary holds). */
export function profilesGrantProblems(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  if (rows.length !== 1) return [`the profiles grant read returned ${rows.length} rows, expected 1`];
  const r = rows[0];
  const exists = r.profiles_exists === true || r.profiles_exists === "t" || r.profiles_exists === "true";
  if (!exists) return ["public.profiles does not exist: the schema is not built, so the boundary cannot be verified"];
  let findings: unknown = r.findings;
  if (typeof r.findings === "string") {
    const raw = r.findings;
    try { findings = JSON.parse(raw); } catch { return [`unreadable findings: ${raw.slice(0, 200)}`]; }
  }
  if (!Array.isArray(findings) || findings.some((f) => typeof f !== "string")) return [`unexpected findings ${JSON.stringify(findings).slice(0, 200)}`];
  return findings as string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// THE MANAGEMENT API CLIENT — injectable fetch; never reads the environment.
// ─────────────────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface BetaManagementClient {
  query(sql: string): Promise<Array<Record<string, unknown>>>;
  getAuthConfig(): Promise<unknown>;
  patchAuthConfig(body: AuthConfig): Promise<unknown>;
}

export function betaManagementClient(ref: string, token: string, fetchImpl: FetchLike, timeoutMs = 120_000): BetaManagementClient {
  if (ref !== BETA_PROJECT_REF) throw new Error(`the configuration client is hard-wired to ${BETA_PROJECT_REF}; refusing ${ref}`);
  const base = `https://api.supabase.com/v1/projects/${ref}`;
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403
        ? " The token was refused for this project: BETA_SUPABASE_PROJECT_TOKEN must be a Management API token that can reach portava-beta."
        : "";
      throw new Error(`Management API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}${hint}`);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Management API ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
  return {
    async query(sql) {
      const json = await call("POST", "/database/query", { query: sql });
      if (!Array.isArray(json)) throw new Error(`unexpected query response: ${JSON.stringify(json).slice(0, 200)}`);
      return json as Array<Record<string, unknown>>;
    },
    getAuthConfig: () => call("GET", "/config/auth"),
    patchAuthConfig: (body) => call("PATCH", "/config/auth", body),
  };
}

/** feature_flags rows from the query endpoint, strictly typed. */
export function parseFlagRows(rows: ReadonlyArray<Record<string, unknown>>): FlagRow[] {
  return rows.map((r) => {
    const flag = r.flag;
    const enabled = r.enabled === true || r.enabled === "t" || r.enabled === "true" ? true
      : r.enabled === false || r.enabled === "f" || r.enabled === "false" ? false : null;
    if (typeof flag !== "string" || enabled === null) throw new Error(`unexpected feature_flags row ${JSON.stringify(r).slice(0, 200)}`);
    return { flag, enabled };
  });
}
