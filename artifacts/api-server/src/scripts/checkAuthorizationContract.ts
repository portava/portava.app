/**
 * checkAuthorizationContract.ts — the client-write authorization regression guard (CLI).
 *
 * Fails CI when the live database drifts from the approved authorization contract
 * (src/security/authorization-contract.json) on a protected table:
 *   1. anon/authenticated regain broad table-level mutation privileges;
 *   2. a server-derived verification/provenance column becomes client-writable;
 *   3. an RLS policy appears/changes without a matching contract entry.
 *
 * Turns the 2144-2154 cleanup into a standing invariant: a migration that reopens
 * one of these must update the contract IN THE SAME PR or CI goes red.
 *
 * READS the live CI database (SELECTs on information_schema + pg_policy via the
 * Supabase Management API). It imports the prod read-only-audit guard front door,
 * which asserts a non-production target before any query; the pure model/evaluator
 * live in src/security/authorizationContract.ts (imported by the self-test).
 *
 * Exit codes: 0 = contract holds; 1 = drift found; 2 = cannot run (missing creds).
 */
import "../lib/ciProdReadOnlyAuditGuard.mjs";
import {
  evaluateContract,
  loadContract,
  type GrantRow,
  type ColRow,
  type PolicyRow,
} from "../security/authorizationContract.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN = process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and SUPABASE_PROJECT_TOKEN (or SUPABASE_ACCESS_TOKEN) must be set.\n" +
      "       This guard reads the live authorization state; it cannot run without them.",
  );
  process.exit(2);
}
const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Management API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

async function main(): Promise<void> {
  const contract = loadContract();
  const tables = Object.keys(contract.tables);
  const tableList = tables.map((t) => `'${t}'`).join(",");

  const grantRows = await liveQuery<GrantRow>(
    `select table_name, grantee, privilege_type
       from information_schema.role_table_grants
      where table_schema='public' and table_name in (${tableList})
        and grantee in ('anon','authenticated')`,
  );
  const colRows = await liveQuery<ColRow>(
    `select table_name, grantee, privilege_type, column_name
       from information_schema.column_privileges
      where table_schema='public' and table_name in (${tableList})
        and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE')`,
  );
  const polRows = await liveQuery<PolicyRow>(
    `select c.relname as table_name, p.polname as name,
            case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' when '*' then 'ALL' end as cmd,
            p.polpermissive as permissive,
            coalesce((select array_agg(rolname order by rolname) from pg_roles where oid = any(p.polroles)), array['public']) as roles
       from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname in (${tableList})`,
  );

  const violations = evaluateContract(contract, grantRows, colRows, polRows);
  if (violations.length) {
    console.error(
      `\ncheck:authorization-contract FAILED — the live authorization boundary drifted from the approved\n` +
      `contract (src/security/authorization-contract.json). ${violations.length} violation(s):\n\n` +
      violations.join("\n") +
      `\n\nIf this change is intentional and reviewed, update authorization-contract.json in the same PR.\n` +
      `If it is NOT intentional, a migration re-opened a client-write authorization hole (see 2144-2154).\n`,
    );
    process.exit(1);
  }
  console.log(`check:authorization-contract PASSED — ${tables.length} protected tables match the approved boundary (grants, client-writable columns, and RLS policies).`);
}

main().catch((err) => {
  console.error("check:authorization-contract ERROR (could not verify):", err instanceof Error ? err.message : err);
  process.exit(2);
});
