/**
 * The four 0127 layover tables are not client-writable — census-layover L200
 * and L199, owner decision L199-b, migration 3620 (lane R, 2026-10-07).
 *
 * node:test + node:assert. Static: reads the committed migration SQL and the
 * authorization contract, and drives the contract's own evaluator. No database
 * — 3620 is applied to none, and `*.db.test.ts` / certify:migrations cannot run
 * on this machine; CI replays the chain. 3620's postconditions are what assert
 * the live state when it is applied.
 *
 * THE DEFECT. 0127's default-privileges grant left `anon` and `authenticated`
 * holding DELETE, INSERT, SELECT and UPDATE on layover_sessions,
 * layover_plan_stops, layover_events and airport_profiles. layover_sessions'
 * owner policy is FOR ALL with a WITH CHECK on user_id — ownership-correct and
 * column-blind — so a traveller could PATCH their own session's `status`,
 * `return_reminder_at` and `share_city_status` through PostgREST, around every
 * rule the routes apply. No application path writes these tables as a user.
 *
 * What these cases hold:
 *   1. 3620 revokes every write verb from `authenticated`, everything from
 *      `anon`, keeps SELECT for `authenticated`, and asserts each of those in a
 *      postcondition inside its transaction.
 *   2. No later migration re-grants a write on these tables to a client role.
 *   3. The authorization contract states exactly that boundary, and its own
 *      evaluator reports the PRE-3620 grants as a broadened boundary — so a
 *      database 3620 has not reached, or one where a write is re-granted, is
 *      red on check:authorization-contract.
 *
 * Run: node --import tsx/esm --test src/test/layoverClientWriteBoundary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateContract,
  loadContract,
  type ColRow,
  type GrantRow,
  type PolicyRow,
} from "../security/authorizationContract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");
const FILE = "3620_layover_client_write_boundary.sql";
const TABLES = ["layover_sessions", "layover_plan_stops", "layover_events", "airport_profiles"] as const;

const sql = readFileSync(join(MIGRATIONS_DIR, FILE), "utf8");
/** The SQL with comment lines removed, so a sentence in the header cannot satisfy an assertion. */
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("3620 — what the migration does", () => {
  it("is one transaction, with its postconditions inside it", () => {
    const begin = code.indexOf("BEGIN;");
    const post = code.indexOf("DO $post$");
    const commit = code.lastIndexOf("COMMIT;");
    assert.ok(begin >= 0 && post > begin && commit > post, "BEGIN; … DO $post$ … COMMIT; in that order");
  });

  for (const t of TABLES) {
    it(`${t}: anon loses everything, authenticated loses every write verb and keeps SELECT`, () => {
      assert.match(code, new RegExp(`REVOKE ALL ON TABLE public\\.${t}\\s+FROM anon;`));
      assert.match(code, new RegExp(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\\.${t}\\s+FROM authenticated;`));
      assert.match(code, new RegExp(`GRANT SELECT ON TABLE public\\.${t}\\s+TO authenticated;`));
    });
  }

  it("revokes column-level grants too, which a table-level REVOKE leaves in place", () => {
    assert.match(code, /a\.attacl IS NOT NULL/);
    assert.match(code, /REVOKE ALL \(%I\) ON TABLE public\.%I FROM anon, authenticated/);
  });

  it("asserts the boundary it creates, verb by verb, for both client roles and the service role", () => {
    const post = code.slice(code.indexOf("DO $post$"));
    assert.match(post, /ARRAY\['layover_sessions', 'layover_plan_stops', 'layover_events', 'airport_profiles'\]/);
    assert.match(post, /has_table_privilege\('authenticated', format\('public\.%I', t\), 'SELECT'\)/);
    assert.match(post, /ARRAY\['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'\]/);
    assert.match(post, /has_any_column_privilege\('authenticated'/);
    assert.match(post, /has_table_privilege\('anon', format\('public\.%I', t\), v\)/);
    assert.match(post, /has_table_privilege\('service_role', format\('public\.%I', t\), v\)/);
    assert.match(post, /relrowsecurity/);
  });

  it("the postconditions are the LAST statement: nothing but COMMIT follows `END $post$;` (wave-2 verification F4)", () => {
    // A GRANT appended after the postconditions would commit with them already
    // green. Comments are stripped above; whitespace is all that may remain.
    const end = code.indexOf("END $post$;");
    const commit = code.lastIndexOf("COMMIT;");
    assert.ok(end > 0 && commit > end, "END $post$; precedes COMMIT;");
    assert.equal(code.slice(end + "END $post$;".length, commit).trim(), "", "a statement sits between the postconditions and COMMIT");
    assert.equal(code.slice(commit + "COMMIT;".length).trim(), "", "a statement follows COMMIT");
  });

  it("grants no write verb ANYWHERE in the file to anon, authenticated or PUBLIC (wave-2 verification F4)", () => {
    const grants = code.match(/GRANT\s+[^;]*;/gi) ?? [];
    const writes = grants.filter((g) => /\b(ALL|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN)\b/i.test(g.split(/\bON\b/i)[0] ?? "") && /\bTO\s+[^;]*\b(anon|authenticated|PUBLIC)\b/i.test(g));
    assert.deepEqual(writes, []);
  });

  it("changes no policy, row or flag", () => {
    assert.doesNotMatch(code, /\b(CREATE|DROP|ALTER)\s+POLICY\b/i);
    assert.doesNotMatch(code, /\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)\b/i);
    assert.doesNotMatch(code, /feature_flags/);
  });
});

describe("3620 — nothing after it re-opens a client write", () => {
  it("no later migration grants a write verb on these tables to anon, authenticated or PUBLIC", () => {
    const later = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f > FILE).sort();
    const offenders: string[] = [];
    for (const f of later) {
      const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8")
        .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      for (const t of TABLES) {
        const re = new RegExp(`GRANT\\s+[^;]*\\b(ALL|INSERT|UPDATE|DELETE|TRUNCATE)\\b[^;]*\\bON\\s+(TABLE\\s+)?(public\\.)?${t}\\b[^;]*\\bTO\\s+[^;]*\\b(anon|authenticated|PUBLIC)\\b`, "i");
        if (re.test(text)) offenders.push(`${f} → ${t}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe("the authorization contract states 3620's boundary, and catches the old one", () => {
  const contract = loadContract();

  for (const t of TABLES) {
    it(`${t}: authenticated=SELECT, anon=nothing, no client-writable column`, () => {
      const e = contract.tables[t];
      assert.ok(e, `${t} is a contracted table`);
      assert.deepEqual(e.tableGrants, { authenticated: ["SELECT"] });
      assert.deepEqual(e.insertCols, {});
      assert.deepEqual(e.updateCols, {});
    });
  }

  it("the contract's evaluator reports the PRE-3620 grants as a broadened boundary on all four tables", () => {
    // The clean state for every OTHER table, exactly as the contract states it…
    const grants: GrantRow[] = [];
    const cols: ColRow[] = [];
    const pols: PolicyRow[] = [];
    for (const [table, c] of Object.entries(contract.tables)) {
      for (const [role, privs] of Object.entries(c.tableGrants)) for (const p of privs) grants.push({ table_name: table, grantee: role, privilege_type: p });
      for (const [role, list] of Object.entries(c.insertCols)) for (const col of list) cols.push({ table_name: table, grantee: role, privilege_type: "INSERT", column_name: col });
      for (const [role, list] of Object.entries(c.updateCols)) for (const col of list) cols.push({ table_name: table, grantee: role, privilege_type: "UPDATE", column_name: col });
      for (const p of c.policies) pols.push({ table_name: table, name: p.name, cmd: p.cmd, permissive: p.permissive, roles: p.roles });
    }
    assert.deepEqual(evaluateContract(contract, grants, cols, pols), [], "the contract as stated is clean");
    // …plus the grants portava-ci measured before 3620 on these four.
    for (const t of TABLES) {
      for (const role of ["anon", "authenticated"]) {
        for (const p of ["DELETE", "INSERT", "SELECT", "UPDATE"]) {
          if (!grants.some((g) => g.table_name === t && g.grantee === role && g.privilege_type === p)) {
            grants.push({ table_name: t, grantee: role, privilege_type: p });
          }
        }
      }
    }
    const v = evaluateContract(contract, grants, cols, pols);
    for (const t of TABLES) {
      assert.ok(v.some((line) => line.includes(t) && /BROADENED/.test(line)), `${t} is reported broadened: ${v.join("\n")}`);
    }
  });
});
