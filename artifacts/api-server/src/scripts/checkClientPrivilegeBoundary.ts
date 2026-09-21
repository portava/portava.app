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

  console.log(
    `check:client-privilege-boundary — ${files.length} migration file(s), ${grantsExamined} GRANT statement(s) examined`,
  );

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
        `rather than sitting on top of Supabase's blanket default.\n`,
    );
    process.exit(1);
  }

  console.log("✅ no migration grants a client role a privilege RLS cannot police.");
}

main();
