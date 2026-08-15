/**
 * discovery_shadow_serves append-only audit — READ-ONLY (SELECT only).
 *
 * WHY THIS EXISTS
 * ===============
 * `audit:schema` compares migrations against the live schema and reports
 * missing OBJECTS: tables, columns, functions, indexes, policies, triggers.
 * It does not compare PRIVILEGES, and privileges are where this table's whole
 * argument lives.
 *
 * That gap was not theoretical. Migration 2092 states, in its own header, that
 * `service_role` receives INSERT and SELECT "and nothing else". After the apply,
 * the live grants were:
 *
 *     service_role: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
 *
 * The migration's REVOKE statements named PUBLIC, anon and authenticated but not
 * service_role, and Supabase's default privileges on the public schema grant ALL
 * to service_role at CREATE TABLE time. So the explicit GRANT added nothing that
 * was not already there, the documented mechanism did not land, and every gate
 * in CI went green anyway because no gate looks at grants.
 *
 * The append-only property may well have survived on the trigger alone. That is
 * exactly the problem: the belt was missing and only the braces were holding,
 * and nothing in the system could tell anyone. D7=A's ground is that this table
 * cannot be mutated; a claim of that kind has to be checked against the live
 * catalog or it is a comment, not a constraint.
 *
 * WHAT IT ASSERTS
 * ===============
 *   1. GRANTS. service_role holds INSERT and SELECT and NOTHING else — in
 *      particular not UPDATE, not DELETE, and not TRUNCATE. TRUNCATE matters on
 *      its own: it would empty the table without firing either UPDATE trigger.
 *   2. NO CLIENT SURFACE. anon and authenticated hold no privilege at all.
 *   3. RLS is enabled.
 *   4. Both append-only triggers exist and are enabled — the row-level one and
 *      the statement-level one that makes `UPDATE ... WHERE false` fail, so the
 *      property is verifiable without writing to production.
 *
 * WHAT IT CANNOT SEE
 * ==================
 * It reads the catalog; it does not attempt a write. A privilege set that looks
 * correct but is overridden by something this query does not model would pass
 * here. The catalog is the best available evidence short of mutating production,
 * which is not a thing an audit may do.
 *
 * It also says nothing about whether the table is being WRITTEN correctly — only
 * that it cannot be rewritten afterwards.
 *
 * Exit codes:
 *   0  every assertion holds
 *   1  at least one assertion fails — the live state contradicts 2092/2093
 *   2  environment or API error; nothing was established
 *
 * Usage:
 *   pnpm run audit:shadow-append-only
 */

// Read-only audit front door. Imported for its side effect and hoisted, so it
// runs before any client is constructed whatever its textual position.
// See src/lib/ciProdReadOnlyAuditGuard.mjs and docs/ci/BOOTSTRAP.md.
import "../lib/ciProdReadOnlyAuditGuard.mjs";

export {};

const TABLE = "discovery_shadow_serves";

/** Exactly what service_role may do. Anything else is a finding. */
const ALLOWED_SERVICE_ROLE = new Set(["INSERT", "SELECT"]);
/** Roles that must hold nothing at all. */
const MUST_HOLD_NOTHING = ["anon", "authenticated"];
const REQUIRED_TRIGGERS = [
  "discovery_shadow_serves_no_update",
  "discovery_shadow_serves_no_update_stmt",
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
      "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
      "       or SUPABASE_ACCESS_TOKEN (personal access token).",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) throw new Error(`Management API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

const findings: string[] = [];
function fail(msg: string) { findings.push(msg); }

async function main(): Promise<void> {
  // ── Does the table exist at all? ────────────────────────────────────────────
  const [rel] = await liveQuery<{ exists: boolean; rls: boolean }>(`
    SELECT to_regclass('public.${TABLE}') IS NOT NULL AS exists,
           COALESCE((SELECT relrowsecurity FROM pg_class
                      WHERE oid = to_regclass('public.${TABLE}')), false) AS rls;
  `);

  if (!rel?.exists) {
    console.error(
      `\n✖ ${TABLE} does not exist in this project.\n` +
      `  If migration 2092 has not been applied here, that is expected and this\n` +
      `  audit has established nothing. It exits 2 rather than 1: absence is not\n` +
      `  the same finding as a wrong privilege set.\n`,
    );
    process.exit(2);
  }

  console.log(`\n  table ${TABLE} .......... present`);
  if (rel.rls) {
    console.log("  row level security ...... ENABLED");
  } else {
    fail("RLS is DISABLED. 2092 enables it; a future route reaching this table with a user JWT would read every row.");
  }

  // ── Privileges ──────────────────────────────────────────────────────────────
  const grants = await liveQuery<{ grantee: string; privilege_type: string }>(`
    SELECT grantee, privilege_type
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = '${TABLE}'
     ORDER BY grantee, privilege_type;
  `);

  const byRole = new Map<string, Set<string>>();
  for (const g of grants) {
    if (!byRole.has(g.grantee)) byRole.set(g.grantee, new Set());
    byRole.get(g.grantee)!.add(g.privilege_type);
  }

  console.log("\n  live grants:");
  if (byRole.size === 0) console.log("    (none)");
  for (const [role, privs] of [...byRole].sort()) {
    console.log(`    ${role.padEnd(16)} ${[...privs].sort().join(", ")}`);
  }

  const svc = byRole.get("service_role") ?? new Set<string>();
  const extra = [...svc].filter((p) => !ALLOWED_SERVICE_ROLE.has(p)).sort();
  const missing = [...ALLOWED_SERVICE_ROLE].filter((p) => !svc.has(p)).sort();

  if (extra.length > 0) {
    fail(
      `service_role holds ${extra.join(", ")} on ${TABLE}. 2092's header claims INSERT and SELECT ` +
      `"and nothing else", and D7=A's ground is that this table cannot be mutated.` +
      (extra.includes("TRUNCATE")
        ? " TRUNCATE is the sharpest of these: it empties the table without firing either UPDATE trigger."
        : ""),
    );
  }
  if (missing.length > 0) {
    fail(`service_role is MISSING ${missing.join(", ")} on ${TABLE}. Shadow observations cannot be written.`);
  }

  for (const role of MUST_HOLD_NOTHING) {
    const held = byRole.get(role);
    if (held && held.size > 0) {
      fail(`${role} holds ${[...held].sort().join(", ")} on ${TABLE}. This table has no client surface by design.`);
    }
  }

  // ── Triggers ────────────────────────────────────────────────────────────────
  // pg_trigger, not information_schema.triggers: the latter does not list
  // TRUNCATE triggers and reports one row per event, which makes "is it enabled"
  // unanswerable. tgenabled 'D' is a disabled trigger — present, and doing
  // nothing, which is the worst of both states to be blind to.
  const triggers = await liveQuery<{ tgname: string; tgenabled: string }>(`
    SELECT tgname, tgenabled
      FROM pg_trigger
     WHERE tgrelid = to_regclass('public.${TABLE}') AND NOT tgisinternal
     ORDER BY tgname;
  `);
  const trigByName = new Map(triggers.map((t) => [t.tgname, t.tgenabled]));

  console.log("\n  append-only triggers:");
  for (const name of REQUIRED_TRIGGERS) {
    const state = trigByName.get(name);
    if (state === undefined) {
      console.log(`    ${name.padEnd(42)} MISSING`);
      fail(`trigger ${name} is missing. The append-only property is not enforced.`);
    } else if (state === "D") {
      console.log(`    ${name.padEnd(42)} DISABLED`);
      fail(`trigger ${name} exists but is DISABLED — present and doing nothing.`);
    } else {
      console.log(`    ${name.padEnd(42)} enabled`);
    }
  }

  // ── Verdict ─────────────────────────────────────────────────────────────────
  if (findings.length === 0) {
    console.log(
      `\n✔ ${TABLE} is append-only as documented.\n` +
      `  service_role: INSERT, SELECT only. anon/authenticated: nothing. RLS on.\n` +
      `  Both UPDATE triggers present and enabled.\n`,
    );
    return;
  }

  console.error(`\n✖ ${findings.length} finding(s) — the live state contradicts what the migrations claim:\n`);
  for (const f of findings) console.error(`  • ${f}`);
  console.error(
    `\n  This is the stated-intent-versus-live-state gap. Fix the DATABASE to match\n` +
    `  the claim, or change the claim — but do not leave a migration asserting a\n` +
    `  constraint the catalog does not have.\n`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(`\n✖ audit could not run: ${err instanceof Error ? err.message : String(err)}`);
  console.error("  Nothing was established.\n");
  process.exit(2);
});
