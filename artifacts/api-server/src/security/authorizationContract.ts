/**
 * authorizationContract.ts — the pure model + evaluator for the client-write
 * authorization boundary. NO I/O to Supabase; safe to import from tests.
 *
 * The CLI guard (src/scripts/checkAuthorizationContract.ts) fetches the live state
 * and calls evaluateContract(); the self-test
 * (src/test/authorizationContractGuard.test.ts) imports the same pure functions.
 * The approved boundary itself is src/security/authorization-contract.json.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_PATH = join(__dirname, "authorization-contract.json");

export interface PolicyContract { name: string; cmd: string; permissive: boolean; roles: string[]; }
export interface TableContract {
  note?: string;
  tableGrants: Record<string, string[]>;
  insertCols: Record<string, string[]>;
  updateCols: Record<string, string[]>;
  policies: PolicyContract[];
}
export interface Contract { tables: Record<string, TableContract>; }

export interface GrantRow { table_name: string; grantee: string; privilege_type: string; }
export interface ColRow { table_name: string; grantee: string; privilege_type: string; column_name: string; }
export interface PolicyRow { table_name: string; name: string; cmd: string; permissive: boolean; roles: string[]; }

const CLIENT_ROLES = ["anon", "authenticated"];
const sortUniq = (a: string[]): string[] => Array.from(new Set(a)).sort();
const eqSet = (a: string[], b: string[]): boolean => {
  const x = sortUniq(a), y = sortUniq(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

export function loadContract(): Contract {
  return JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as Contract;
}

/**
 * The pure comparison: given the approved contract and the live authorization
 * state, return human-readable violations (empty = the contract holds). No I/O,
 * so the self-test can exercise every branch offline.
 */
export function evaluateContract(
  contract: Contract,
  grantRows: GrantRow[],
  colRows: ColRow[],
  polRows: PolicyRow[],
): string[] {
  const violations: string[] = [];
  const violation = (table: string, msg: string): void => { violations.push(`  [${table}] ${msg}`); };

  for (const table of Object.keys(contract.tables)) {
    const c = contract.tables[table];

    // ── Invariant 1: table-level client grants must EQUAL the approved set ──
    for (const role of CLIENT_ROLES) {
      const live = sortUniq(grantRows.filter((r) => r.table_name === table && r.grantee === role).map((r) => r.privilege_type));
      const approved = sortUniq(c.tableGrants[role] ?? []);
      if (!eqSet(live, approved)) {
        const extra = live.filter((p) => !approved.includes(p));
        const missing = approved.filter((p) => !live.includes(p));
        violation(table, `table grants for ${role} drifted: live=[${live.join(",") || "none"}] approved=[${approved.join(",") || "none"}]`
          + (extra.length ? ` — BROADENED: +[${extra.join(",")}]` : "")
          + (missing.length ? ` — narrowed: -[${missing.join(",")}]` : ""));
      }
    }

    // ── Invariant 2: client INSERT/UPDATE column grants must EQUAL the approved allowlist ──
    for (const [priv, approvedMap] of [["INSERT", c.insertCols], ["UPDATE", c.updateCols]] as const) {
      for (const role of CLIENT_ROLES) {
        const live = sortUniq(colRows.filter((r) => r.table_name === table && r.grantee === role && r.privilege_type === priv).map((r) => r.column_name));
        const approved = sortUniq(approvedMap[role] ?? []);
        if (!eqSet(live, approved)) {
          const extra = live.filter((col) => !approved.includes(col));
          violation(table, `${role} ${priv} columns drifted: live=[${live.join(",") || "none"}] approved=[${approved.join(",") || "none"}]`
            + (extra.length ? ` — NEWLY CLIENT-WRITABLE (server-owned?): +[${extra.join(",")}]` : ""));
        }
      }
    }

    // ── Invariant 3: RLS policy set must EQUAL the approved set ──
    const key = (p: { name: string; cmd: string; permissive: boolean; roles: string[] }) =>
      `${p.name}|${p.cmd}|${p.permissive ? "P" : "R"}|${sortUniq(p.roles).join("+")}`;
    const livePolicies = polRows.filter((r) => r.table_name === table).map(key).sort();
    const approvedPolicies = c.policies.map(key).sort();
    if (!eqSet(livePolicies, approvedPolicies)) {
      const added = livePolicies.filter((p) => !approvedPolicies.includes(p));
      const removed = approvedPolicies.filter((p) => !livePolicies.includes(p));
      if (added.length) violation(table, `UNAPPROVED RLS policy present: ${added.join("  ,  ")} — add it to the contract in this PR if intentional.`);
      if (removed.length) violation(table, `approved RLS policy missing: ${removed.join("  ,  ")} — update the contract if this removal is intentional.`);
    }
  }
  return violations;
}
