/**
 * census-discovery §107 — the C-11 erasure design, pinned on the files, with no
 * database (the database behaviour is creatorLedgerErasurePolicy.db.test.ts).
 *
 *   E1  3510 is in the canonical chain and the two answers are NOT: an answer
 *       reaching src/migrations/ would be applied by CI to portava-ci and by the
 *       operator to travel-buddy, i.e. decide C-11 by merge
 *   E2  3510 decides nothing: ROW-level BEFORE DELETE guards on exactly the four
 *       ledgers, no statement-level trigger, no table, no grant change, no row
 *       written outside its always-rolled-back probe
 *   E3  the answers are mutually exclusive, each requires 3510, and each
 *       rollback re-installs 3510's guard with 3510's function body verbatim
 *   E4  3512 never stores or returns the id -> pseudonym mapping, and says
 *       "pseudonymised, not anonymous" where a reader will see it
 *
 * Run: node --import tsx/esm --test src/test/creatorLedgerErasurePolicyShape.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const REPO = new URL("../../../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, REPO), "utf8");
const CHAIN = "artifacts/api-server/src/migrations/";
const G = read(`${CHAIN}3510_creator_ledger_erasure_policy_undecided.sql`);
const A = read("reconciliation-staging/3511_creator_ledger_erasure_delete_on_erasure.sql");
const B = read("reconciliation-staging/3512_creator_ledger_erasure_retain_pseudonymised.sql");
const A_RB = read("reconciliation-staging/2026-09-30-3511-creator-ledger-erasure-delete-on-erasure-rollback.sql");
const B_RB = read("reconciliation-staging/2026-09-30-3512-creator-ledger-erasure-retain-pseudonymised-rollback.sql");
const G_RB = read("db/rollback/2026-09-30-3510-creator-ledger-erasure-policy-undecided-rollback.sql");

/** SQL with `--` comments removed, so a sentence in a header cannot satisfy or trip a check. */
const code = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const guardBody = (sql: string) => {
  const m = /CREATE OR REPLACE FUNCTION public\.creator_ledger_erasure_policy_undecided\(\)[\s\S]*?\$fn\$;/.exec(sql);
  assert.ok(m, "the guard function is defined");
  return m![0];
};
const LEDGERS = ["rent_buddy_earnings_entries", "creator_attributions", "creator_earning_entries", "creator_ledger_audit_events"];

describe("C-11 erasure design, on the files (census-discovery §107)", () => {
  it("E1. 3510 is in the canonical chain after everything it depends on; neither answer is", () => {
    const chain = readdirSync(new URL(CHAIN, REPO)).filter((f) => f.endsWith(".sql")).sort();
    for (const dep of ["2901_", "2920_", "2921_", "3387_"]) {
      const i = chain.findIndex((f) => f.startsWith(dep));
      assert.ok(i >= 0 && i < chain.indexOf("3510_creator_ledger_erasure_policy_undecided.sql"), dep);
    }
    assert.deepEqual(chain.filter((f) => /erasure_(delete_on_erasure|retain_pseudonymised)/.test(f)), [],
      "an answer to C-11 in the chain would be applied by merge");
    assert.doesNotMatch(chain.join("\n"), /^351[12]_/m, "3511 / 3512 are held numbers, not chain files");
  });

  it("E2. 3510 only refuses: four row-level BEFORE DELETE guards, no statement trigger, no table, no grant change, no row written outside the rolled-back probe", () => {
    const c = code(G);
    for (const t of LEDGERS) {
      assert.match(c, new RegExp(`CREATE TRIGGER \\w+_erasure_policy_undecided\\s+BEFORE DELETE ON public\\.${t}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.creator_ledger_erasure_policy_undecided\\(\\)`), t);
    }
    assert.equal((c.match(/CREATE TRIGGER/g) ?? []).length, 4);
    assert.doesNotMatch(c, /FOR EACH STATEMENT/);
    assert.doesNotMatch(c, /CREATE TABLE/);
    assert.doesNotMatch(c, /\bGRANT\b/);
    assert.doesNotMatch(c, /REVOKE[^;]*\bON\s+(TABLE\s+)?public\.(rent_buddy|creator_)/);
    // The only INSERT/DELETE is the probe, which ends in the CL999 sentinel that rolls it back.
    const outside = c.replace(/DO \$probe\$[\s\S]*?\$probe\$;/, "");
    assert.doesNotMatch(outside, /\b(INSERT INTO|UPDATE public|DELETE FROM)\b/);
    assert.match(c, /RAISE EXCEPTION USING ERRCODE = 'CL999'/);
    assert.match(c, /ERRCODE = 'CL451'/);
    // 2901's SET NULL becomes CASCADE, and only on the beneficiary key.
    assert.match(c, /ADD CONSTRAINT rbee_beneficiary_fk FOREIGN KEY \(beneficiary_user_id\)\s+REFERENCES public\.profiles\(id\) ON DELETE CASCADE/);
  });

  it("E3. the answers exclude each other, each needs 3510, and each rollback restores 3510's guard verbatim", () => {
    assert.match(code(A), /creator_ledger_remove_identity[\s\S]*?mutually exclusive/);
    assert.match(code(B), /creator_ledger_erase_beneficiary[\s\S]*?mutually exclusive/);
    for (const [name, sql] of [["3511", A], ["3512", B]] as const) {
      assert.match(code(sql), /creator_ledger_erasure_policy_undecided\(\)'\) IS NULL THEN\s+RAISE EXCEPTION '35\d\d: PRECONDITION FAILED: 3510/, name);
    }
    const body = guardBody(G);
    assert.equal(guardBody(A_RB), body, "3511's rollback re-installs 3510's function exactly");
    assert.equal(guardBody(B_RB), body, "3512's rollback re-installs 3510's function exactly");
    assert.match(code(G_RB), /ON DELETE SET NULL/, "3510's rollback restores 2901's key as 2901 wrote it");
    assert.match(code(G_RB), /ROLLBACK REFUSED \(3510\)/);
  });

  it("E4. 3512 stores and returns no id -> pseudonym mapping, and calls the result pseudonymised, not anonymous", () => {
    const c = code(B);
    const receipt = /CREATE TABLE IF NOT EXISTS public\.creator_ledger_identity_removals \(([\s\S]*?)\n\);/.exec(c)![1]!;
    assert.deepEqual(
      [...receipt.matchAll(/^\s+(\w+)\s+(uuid|date|text)/gm)].map((m) => m[1]),
      ["id", "removed_on", "actor_kind", "actor_user_id", "reason"],
      "the receipt has no subject, pseudonym or count column");
    assert.match(c, /pseudonym text := gen_random_uuid\(\)::text/, "the pseudonym is random, derived from nothing");
    assert.match(c, /RETURN counts;/, "the door returns counts, never the pseudonym");
    assert.match(B, /PSEUDONYMISED, NOT ANONYMOUS/);
    assert.match(B, /booking_id \/ subject_id \/ value_event_id -> rent_buddy_bookings\.buddy_id/);
  });
});
