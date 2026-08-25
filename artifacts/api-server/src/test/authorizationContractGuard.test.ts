/**
 * authorizationContractGuard.test.ts — self-test for the authorization regression guard.
 *
 * Exercises the guard's PURE evaluator (evaluateContract) with a clean live state
 * derived from the committed contract, then perturbs it once per invariant to prove
 * each regression is caught:
 *   1. restored broad table-level client grant,
 *   2. a new client-writable column (server-derived column exposed),
 *   3. an unapproved RLS policy (and a removed approved policy).
 *
 * Pure and offline — part of the curated `npm test`, no live database. The live
 * comparison against the CI database is what check:authorization-contract runs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateContract,
  loadContract,
  type Contract,
  type GrantRow,
  type ColRow,
  type PolicyRow,
} from "../security/authorizationContract.js";

// Expand the committed contract into the exact live rows that would satisfy it.
function cleanState(contract: Contract): { grants: GrantRow[]; cols: ColRow[]; pols: PolicyRow[] } {
  const grants: GrantRow[] = [];
  const cols: ColRow[] = [];
  const pols: PolicyRow[] = [];
  for (const [table, c] of Object.entries(contract.tables)) {
    for (const [role, privs] of Object.entries(c.tableGrants)) {
      for (const p of privs) grants.push({ table_name: table, grantee: role, privilege_type: p });
    }
    for (const [role, list] of Object.entries(c.insertCols)) {
      for (const col of list) cols.push({ table_name: table, grantee: role, privilege_type: "INSERT", column_name: col });
    }
    for (const [role, list] of Object.entries(c.updateCols)) {
      for (const col of list) cols.push({ table_name: table, grantee: role, privilege_type: "UPDATE", column_name: col });
    }
    for (const p of c.policies) pols.push({ table_name: table, name: p.name, cmd: p.cmd, permissive: p.permissive, roles: p.roles });
  }
  return { grants, cols, pols };
}

describe("authorization contract guard (self-test)", () => {
  const contract = loadContract();

  it("the committed contract is well-formed", () => {
    assert.ok(Object.keys(contract.tables).length >= 10, "expected the 10 protected tables");
    for (const [t, c] of Object.entries(contract.tables)) {
      assert.ok(c.tableGrants, `${t}: tableGrants missing`);
      assert.ok(Array.isArray(c.policies), `${t}: policies missing`);
    }
  });

  it("a live state that matches the contract yields ZERO violations", () => {
    const { grants, cols, pols } = cleanState(contract);
    const v = evaluateContract(contract, grants, cols, pols);
    assert.deepEqual(v, [], `expected no violations, got:\n${v.join("\n")}`);
  });

  it("INVARIANT 1: a restored broad table-level client grant is caught", () => {
    const { grants, cols, pols } = cleanState(contract);
    // simulate a migration re-granting authenticated INSERT on discovery_places
    grants.push({ table_name: "discovery_places", grantee: "authenticated", privilege_type: "INSERT" });
    const v = evaluateContract(contract, grants, cols, pols);
    assert.equal(v.length, 1, `expected exactly one violation, got:\n${v.join("\n")}`);
    assert.match(v[0], /discovery_places/);
    assert.match(v[0], /BROADENED: \+\[INSERT\]/);
  });

  it("INVARIANT 2: a newly client-writable (server-derived) column is caught", () => {
    const { grants, cols, pols } = cleanState(contract);
    // simulate exposing hidden_gems.status to authenticated UPDATE
    cols.push({ table_name: "hidden_gems", grantee: "authenticated", privilege_type: "UPDATE", column_name: "status" });
    const v = evaluateContract(contract, grants, cols, pols);
    assert.equal(v.length, 1, `expected exactly one violation, got:\n${v.join("\n")}`);
    assert.match(v[0], /hidden_gems/);
    assert.match(v[0], /NEWLY CLIENT-WRITABLE .*\+\[status\]/);
  });

  it("INVARIANT 2b: trust_level re-exposed on hidden_gem_visits INSERT is caught", () => {
    const { grants, cols, pols } = cleanState(contract);
    cols.push({ table_name: "hidden_gem_visits", grantee: "authenticated", privilege_type: "INSERT", column_name: "trust_level" });
    const v = evaluateContract(contract, grants, cols, pols);
    assert.equal(v.length, 1);
    assert.match(v[0], /hidden_gem_visits/);
    assert.match(v[0], /\+\[trust_level\]/);
  });

  it("INVARIANT 3: an unapproved new RLS policy is caught", () => {
    const { grants, cols, pols } = cleanState(contract);
    pols.push({ table_name: "posts", name: "posts_public_write", cmd: "UPDATE", permissive: true, roles: ["authenticated"] });
    const v = evaluateContract(contract, grants, cols, pols);
    assert.equal(v.length, 1);
    assert.match(v[0], /posts/);
    assert.match(v[0], /UNAPPROVED RLS policy present.*posts_public_write/);
  });

  it("INVARIANT 3b: a removed approved RLS policy is caught", () => {
    const { grants, cols, pols } = cleanState(contract);
    const filtered = pols.filter((p) => !(p.table_name === "posts" && p.name === "posts_update"));
    const v = evaluateContract(contract, grants, cols, filtered);
    assert.equal(v.length, 1);
    assert.match(v[0], /approved RLS policy missing.*posts_update/);
  });

  it("a policy whose roles change (e.g. authenticated -> public) is caught", () => {
    const { grants, cols, pols } = cleanState(contract);
    const p = pols.find((x) => x.table_name === "posts" && x.name === "posts_update");
    assert.ok(p);
    p!.roles = ["public"]; // was ['authenticated']
    const v = evaluateContract(contract, grants, cols, pols);
    // one removed (the authenticated version) + one added (the public version)
    assert.ok(v.some((m) => /posts_update.*public/.test(m)) || v.some((m) => /posts_update.*authenticated/.test(m)), v.join("\n"));
  });
});
