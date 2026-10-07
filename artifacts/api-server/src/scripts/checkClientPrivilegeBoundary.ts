/**
 * No migration may hand a CLIENT role a privilege that row level security
 * cannot police.
 *
 * ── THE DEFECT THIS EXISTS TO PREVENT ────────────────────────────────────────
 * PostgreSQL applies RLS to SELECT / INSERT / UPDATE / DELETE. It does NOT apply
 * it to TRUNCATE, REFERENCES, TRIGGER or MAINTAIN. A policy cannot restrict,
 * narrow or log those four — it is never consulted.
 *
 * Supabase's `ALTER DEFAULT PRIVILEGES` grants the full set `arwdDxtm` to
 * `anon`, `authenticated` and `service_role` on every table created in `public`.
 * Measured on production 2026-09-08, that left `anon` — the UNAUTHENTICATED
 * public role — holding TRUNCATE on **375 application-owned tables**. Every
 * carefully written policy on those tables sat behind a privilege that discards
 * the whole table without consulting the policy once. Migration 2490 revoked
 * them and fixed the `postgres` default ACL so new tables do not re-inherit
 * them.
 *
 * This check is the ratchet that keeps it that way. It is **entirely offline**:
 * it reads the migration SQL in the repository and makes no database
 * connection, so ordinary CI gains no production dependency.
 *
 * ── WHAT IS CHECKED, AND WHY EXACTLY THESE RULES ─────────────────────────────
 *   1. No GRANT to `anon` / `authenticated` of any privilege outside
 *      SELECT / INSERT / UPDATE / DELETE. Stated as an ALLOW-list of the four
 *      RLS-policed verbs rather than a deny-list of the four unpoliced ones, so
 *      a privilege PostgreSQL adds in some future version is caught the day it
 *      appears instead of the day someone remembers to add it here.
 *   2. No `GRANT ALL` to a client role. `ALL` is the blanket set by another
 *      name, and it is how 2332's recorded rollback would re-breach the
 *      boundary if it were ever executed.
 *   3. No GRANT to `PUBLIC`. A grant to the PUBLIC pseudo-role has grantee `0`,
 *      does not join to `pg_roles`, and is therefore INVISIBLE to the ACL
 *      queries normally used to audit this — the one shape a reviewer is least
 *      likely to catch by eye.
 *   4. Every table the post-baseline chain CREATEs must be followed (same file
 *      or later) by a table-level REVOKE of its default DML from `anon` AND
 *      `authenticated`. Supabase's default ACL hands both roles SELECT, INSERT,
 *      UPDATE and DELETE at CREATE TABLE time; a migration that only creates
 *      the table leaves the anonymous key holding them, policed by nothing but
 *      the absence of a permissive policy. Nine tables reached portava-ci that
 *      way (2720-2722, 2811, 2951-2952; audit:live-unexplained run 37608414616)
 *      and 3740 took the grants back. The REVOKE shapes it recognises —
 *      including FOREACH and temp-table loops — and what it does not prove are
 *      in lib/clientTableAclDecisions.ts. It is NOT the "revoke before grant"
 *      rule described below: it asks only that a decision exists somewhere in
 *      the chain after the CREATE, which every correct shape satisfies.
 *   5. No view may END client-readable (anon or authenticated, by GRANT or by
 *      the default ACL a chain CREATE VIEW takes) without security_invoker =
 *      true: a definer view reads its tables with the owner's rights, past
 *      their RLS. 2776's trip_presence_current did, in production; 3741 fixes
 *      it. No exemptions: PostGIS's own metadata views are extension members
 *      the baseline and the chain never define (verifier G2-3).
 *   6. Every profiles AUTHORITY column (lib/profileAuthorityColumns.ts — the
 *      columns the server reads as facts about a user: role, is_official, the
 *      verification columns, verified, verified_at, trust_score, trust_label,
 *      featured_count, created_at, account_status) must END the chain with no
 *      client UPDATE privilege — replayed over every GRANT/REVOKE in apply
 *      order, column and table level, from both the production ACL and the
 *      Supabase default ACL a replayed baseline takes — AND an enabled BEFORE
 *      INSERT OR UPDATE row trigger whose function compares the column and
 *      consults caller_may_write_profile_role(). profiles_update admits a
 *      user's own row, so either barrier missing lets a user write it: 3742
 *      closed seven columns that had neither. account_status's trigger is
 *      PENDING until 3600 (PR #592) lands, and required from then on.
 *
 * ── ONE RULE DELIBERATELY NOT IMPLEMENTED ────────────────────────────────────
 * "A GRANT to a client role must be preceded by REVOKE ALL in the same file"
 * was tried and REMOVED. It is the right idea — a bare GRANT establishes no
 * limit, which is the 2092 defect 2093 repaired — but it cannot be decided from
 * one file. `2130` revokes through a `FOREACH ... EXECUTE format(...)` loop that
 * no literal scan can see, and `2333` grants on tables whose REVOKE happened in
 * the migration that CREATED them. Both were checked against the live database:
 * `authenticated` holds exactly `SELECT` and `anon` holds nothing on all four
 * relations involved. Shipping that rule would have meant four false failures on
 * correct code, and a guard that cries wolf gets disabled. The outcome it wants
 * needs live ACLs; `auditLiveVsCanonical.ts` is where that belongs.
 *
 * Run: node --import tsx/esm src/scripts/checkClientPrivilegeBoundary.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSqlComments } from "./lib/canonicalSchema.js";
import { CHAIN_START_PREFIX } from "./lib/liveVsCanonicalCore.js";
import {
  countViews,
  createdTables,
  findClientDefinerViews,
  findUndecidedTables,
} from "./lib/clientTableAclDecisions.js";
import {
  clientUpdatableAuthorityColumns,
  PROFILE_AUTHORITY_COLUMNS,
  replayProfilesTriggers,
  replayProfilesUpdateAcl,
  unguardedAuthorityColumns,
} from "./lib/profileAuthorityColumns.js";
import { BASELINE_PATH, parseBaselineTables } from "./parseBaselineSchema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const SRC = join(API_ROOT, "src");

/** Override for the mutation fixture, which points the check at a crafted file. */
const DIRS = process.env.CLIENT_PRIVILEGE_DIRS
  ? process.env.CLIENT_PRIVILEGE_DIRS.split(":").map((d) => resolve(d))
  : [join(SRC, "migrations"), join(API_ROOT, "migrations")];

/** The only privileges RLS actually polices, and therefore the only ones a client role may hold. */
const RLS_POLICED = new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]);
const CLIENT_ROLES = /\b(anon|authenticated)\b/i;

/**
 * A minimum number of GRANT statements must be examined. A scan that finds
 * nothing must FAIL rather than report success: a moved directory or a broken
 * glob would otherwise read as "no violations".
 */
const MIN_GRANTS_EXAMINED = 50;

/**
 * Rule 4's floor: the post-baseline chain created 140 tables when the rule was
 * written (2026-10-07). Far fewer means the directory or the baseline moved and
 * the rule is reading nothing.
 */
const MIN_TABLES_EXAMINED = 100;

/** Rule 5's floor: the baseline and the chain defined 13 views on 2026-10-07. */
const MIN_VIEWS_EXAMINED = 10;

type Finding = { file: string; rule: string; statement: string };

function sqlFiles(): string[] {
  const out: string[] = [];
  for (const d of DIRS) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith(".sql")).sort()) out.push(join(d, f));
  }
  return out;
}

/** Split on `;` outside dollar-quoted bodies, so a function body is one unit. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let tag: string | null = null;
  while (i < sql.length) {
    if (!tag) {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (m) { tag = m[0]; cur += tag; i += tag.length; continue; }
      if (sql[i] === ";") { out.push(cur); cur = ""; i += 1; continue; }
    } else if (sql.startsWith(tag, i)) {
      cur += tag; i += tag.length; tag = null; continue;
    }
    cur += sql[i]; i += 1;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function main(): void {
  const files = sqlFiles();
  const findings: Finding[] = [];
  let grantsExamined = 0;

  for (const path of files) {
    const file = path.split("/").slice(-1)[0];
    const sql = stripSqlComments(readFileSync(path, "utf8"));
    for (const raw of statements(sql)) {
      const s = raw.replace(/\s+/g, " ").trim();
      if (!/^GRANT\b/i.test(s)) continue;
      grantsExamined += 1;

      const m = /^GRANT\s+(.*?)\s+ON\s+(.*?)\s+TO\s+(.*)$/is.exec(s);
      if (!m) continue;
      const [, privsRaw, target, granteesRaw] = m;

      // Rule 3 — a grant to PUBLIC is invisible to pg_roles-joined ACL audits.
      if (/\bPUBLIC\b/i.test(granteesRaw)) {
        findings.push({ file, rule: "GRANT TO PUBLIC", statement: s.slice(0, 160) });
      }

      if (!CLIENT_ROLES.test(granteesRaw)) continue;

      // Function/sequence/schema grants are a different vocabulary (EXECUTE,
      // USAGE) and are not what this boundary is about.
      if (/^\s*(FUNCTION|PROCEDURE|ROUTINE|SEQUENCE|SCHEMA|DATABASE|LARGE OBJECT)\b/i.test(target)) continue;

      // Rule 2 — ALL is the blanket set by another name.
      if (/^\s*ALL\b/i.test(privsRaw)) {
        findings.push({ file, rule: "GRANT ALL to a client role", statement: s.slice(0, 160) });
        continue;
      }

      // Rule 1 — allow-list the RLS-policed verbs; anything else is unpoliceable.
      // STRIP THE COLUMN LISTS FIRST, THEN SPLIT. `GRANT UPDATE (a, b, c)` is a
      // COLUMN-level grant — the narrowest grant PostgreSQL offers and the exact
      // opposite of this defect. Splitting on commas first tears the column list
      // apart and reports "UPDATE (A" and "B)" as two unknown privileges, which
      // is how the first version of this check produced 18 false failures
      // against the 21xx write-boundary migrations that are doing the right
      // thing. Same ordering bug as the cast-before-alias one in
      // prerequisitesCore.selectListColumns.
      const privs = privsRaw
        .replace(/\([^)]*\)/g, "")
        .split(/\s*,\s*/)
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean);
      const unpoliced = privs.filter((p) => !RLS_POLICED.has(p));
      if (unpoliced.length) {
        findings.push({
          file,
          rule: `grants ${unpoliced.join(", ")} to a client role — RLS does not police it`,
          statement: s.slice(0, 160),
        });
      }
    }
  }

  // Rule 4 — every table the post-baseline chain creates carries an explicit
  // client-privilege decision (a REVOKE from anon and authenticated), so none
  // keeps Supabase's default DML grants by omission. Canonical chain only: the
  // legacy directory is frozen and sorts below the chain start.
  const chainFiles = (process.env.CLIENT_PRIVILEGE_DIRS ? files : files.filter((p) => p.startsWith(join(SRC, "migrations"))))
    .map((p) => ({ name: p.split("/").slice(-1)[0]!, sql: readFileSync(p, "utf8") }));
  const baselineTables = new Set(
    [...parseBaselineTables(readFileSync(BASELINE_PATH, "utf8")).keys()].map((t) => t.toLowerCase()),
  );
  let tablesExamined = 0;
  {
    const seen = new Set<string>();
    for (const f of chainFiles) {
      if (f.name < CHAIN_START_PREFIX) continue;
      for (const t of createdTables(f.sql)) if (!baselineTables.has(t)) seen.add(t);
    }
    tablesExamined = seen.size;
  }
  for (const u of findUndecidedTables(chainFiles, baselineTables)) {
    findings.push({
      file: u.file,
      rule: `creates public.${u.table} and no migration REVOKEs its default client DML from ${u.missing.join(" and ")}`,
      statement:
        `Supabase's default ACL leaves ${u.missing.join(" and ")} holding SELECT, INSERT, UPDATE and DELETE on ${u.table}. ` +
        `Add REVOKE ALL ON public.${u.table} FROM PUBLIC, anon, authenticated (then GRANT exactly what a client path needs).`,
    });
  }

  // Rule 5 — client-readable views must be security_invoker.
  // Fixture mode judges only the fixture's own SQL: the real baseline's nine
  // compatibility views are made invoker by 3820, which a fixture directory
  // does not carry.
  const baselineText = process.env.CLIENT_PRIVILEGE_DIRS ? "" : readFileSync(BASELINE_PATH, "utf8");
  const viewsExamined = countViews(chainFiles, baselineText);
  for (const v of findClientDefinerViews(chainFiles, baselineText)) {
    findings.push({
      file: v.definedIn,
      rule: `view public.${v.view} is readable by ${v.roles.join(" and ")} without security_invoker = true`,
      statement:
        `A view without security_invoker reads its tables with its OWNER's rights, past their row-level security. ` +
        `Add ALTER VIEW public.${v.view} SET (security_invoker = true), or revoke the client roles.`,
    });
  }

  // Rule 6 — profiles authority columns are server-only. Real tree only: a
  // fixture directory carries no profiles table, so it would read as nothing
  // guarded; the rule's own shapes are tested on lib/profileAuthorityColumns.ts.
  const pendingAuthority: string[] = [];
  if (!process.env.CLIENT_PRIVILEGE_DIRS) {
    const realBaseline = readFileSync(BASELINE_PATH, "utf8");
    // VACUITY: the baseline alone grants the client roles UPDATE on 80 profiles
    // columns, and four triggers guard authority columns. Reading far less
    // means the parser or the paths broke and "nothing is writable" is noise.
    const baselineUpdateCols = replayProfilesUpdateAcl([], realBaseline, "production").authenticated.cols.size;
    const triggersSeen = replayProfilesTriggers(chainFiles, realBaseline).length;
    if (baselineUpdateCols < 50 || triggersSeen < 4) {
      console.error(
        `\nFAIL — VACUOUS: rule 6 read ${baselineUpdateCols} baseline profiles UPDATE column grant(s) (expected >= 50) and ` +
          `${triggersSeen} trigger(s) on profiles (expected >= 4).`,
      );
      process.exit(1);
    }
    for (const c of clientUpdatableAuthorityColumns(chainFiles, realBaseline)) {
      findings.push({
        file: "(replayed chain)",
        rule: `profiles.${c.column} ends the chain UPDATE-able by ${c.roles.join(" and ")} (${c.models.join(", ")} ACL)`,
        statement:
          `An authority column the server trusts must not be client-writable. Add REVOKE UPDATE (${c.column}) ON public.profiles ` +
          `FROM PUBLIC, anon, authenticated, or drop the grant that re-opened it.`,
      });
    }
    for (const g of unguardedAuthorityColumns(chainFiles, realBaseline)) {
      if (g.pending) {
        pendingAuthority.push(`${g.column} (${g.note})`);
        continue;
      }
      findings.push({
        file: "(replayed chain)",
        rule: `profiles.${g.column} has no guarding trigger`,
        statement: `${g.note}. A column grant alone is undone by one careless GRANT UPDATE ON profiles (2078's header).`,
      });
    }
  }

  console.log(
    `check:client-privilege-boundary — ${files.length} migration file(s), ${grantsExamined} GRANT statement(s) examined, ` +
      `${tablesExamined} post-baseline table(s) checked for a client-privilege decision, ${viewsExamined} view(s) checked for security_invoker`,
  );

  if (!process.env.CLIENT_PRIVILEGE_DIRS && viewsExamined < MIN_VIEWS_EXAMINED) {
    console.error(
      `\nFAIL — VACUOUS: only ${viewsExamined} view(s) found, expected at least ${MIN_VIEWS_EXAMINED}. Rule 5 read nothing worth trusting.`,
    );
    process.exit(1);
  }

  if (!process.env.CLIENT_PRIVILEGE_DIRS && tablesExamined < MIN_TABLES_EXAMINED) {
    console.error(
      `\nFAIL — VACUOUS: only ${tablesExamined} post-baseline CREATE TABLE(s) found, expected at least ${MIN_TABLES_EXAMINED}. ` +
        `Rule 4 examined nothing worth trusting; the migration directory or the baseline path is probably wrong.`,
    );
    process.exit(1);
  }

  if (grantsExamined < MIN_GRANTS_EXAMINED) {
    console.error(
      `\nFAIL — VACUOUS: only ${grantsExamined} GRANT statement(s) examined, expected at least ${MIN_GRANTS_EXAMINED}. ` +
        `A check that examines nothing must not report success; the migration directories are probably wrong (${DIRS.join(", ")}).`,
    );
    process.exit(1);
  }

  if (findings.length) {
    console.error(`\nFAIL — ${findings.length} client-privilege boundary violation(s):`);
    for (const f of findings) {
      console.error(`  • ${f.file}: ${f.rule}`);
      console.error(`      ${f.statement}`);
    }
    console.error(
      `\nRLS does not police TRUNCATE, REFERENCES, TRIGGER or MAINTAIN. A client role holding one of them ` +
        `can act on the whole table without any policy being consulted. Grant only SELECT/INSERT/UPDATE/DELETE ` +
        `to anon/authenticated, and revoke first (REVOKE ALL ... then GRANT ...) so the grant establishes a limit ` +
        `rather than sitting on top of Supabase's blanket default. A table the chain creates keeps that blanket ` +
        `default (SELECT/INSERT/UPDATE/DELETE for anon and authenticated) until a migration revokes it (rule 4).\n`,
    );
    process.exit(1);
  }

  console.log("✅ no migration grants a client role a privilege RLS cannot police.");
  console.log(`✅ every one of the ${tablesExamined} post-baseline table(s) carries a client-privilege decision (rule 4).`);
  console.log(
    `✅ no client-readable view lacks security_invoker (rule 5; ${viewsExamined} view(s) checked, none exempt).`,
  );
  if (!process.env.CLIENT_PRIVILEGE_DIRS) {
    console.log(
      `✅ every one of the ${PROFILE_AUTHORITY_COLUMNS.length} profiles authority column(s) is server-only: no client UPDATE grant, a guarding trigger (rule 6` +
        (pendingAuthority.length ? `; trigger PENDING: ${pendingAuthority.join("; ")}).` : ")."),
    );
  }
}

main();
