/**
 * census-discovery §107 — the C-11 erasure design, pinned on the files, with no
 * database (the database behaviour is creatorLedgerErasurePolicy.db.test.ts).
 *
 *   E1  C-11 IS ANSWERED: answer B is in the canonical chain as 3600, after
 *       everything it depends on and after the 3510 guard it replaces; answer A
 *       is NOT, and the two held numbers 3511 / 3512 are not chain files
 *   E2  3510 decides nothing: ROW-level BEFORE DELETE guards on exactly the four
 *       ledgers, no statement-level trigger, no table, no grant change, no row
 *       written outside its always-rolled-back probe
 *   E3  the answers are mutually exclusive, each requires 3510, and each
 *       rollback re-installs 3510's guard with 3510's function body verbatim
 *   E4  3600 never stores or returns the id -> pseudonym mapping, and says
 *       "pseudonymised, not anonymous" where a reader will see it
 *   E5  the chosen answer carries the owner's decision verbatim, says it is not
 *       yet applied to a hosted database, and does not invent the retention
 *       period the decision asks for and legal review has not set
 *   E6  (4b) an ERASED person is never written back: the frozen guard reads the
 *       named person's profile FOR SHARE and refuses a tombstone CL452
 *       `creator_ledger_subject_erased` on all four ledgers, and the
 *       postconditions assert it (review of PR #592: "the producer
 *       re-identifies an erased beneficiary")
 *   E7  (4c) a re-sent key of a retained attribution is refused by the BEFORE
 *       INSERT guard — ahead of ON CONFLICT — so 3387's NULL-unsafe replay
 *       compare is never reached for a pseudonymised row (same review)
 *
 * Run: node --import tsx/esm --test src/test/creatorLedgerErasurePolicyShape.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const REPO = new URL("../../../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, REPO), "utf8");
const CHAIN = "artifacts/api-server/src/migrations/";
const CHOSEN = "3600_creator_ledger_erasure_retain_pseudonymised.sql";
const G = read(`${CHAIN}3510_creator_ledger_erasure_policy_undecided.sql`);
const A = read("reconciliation-staging/3511_creator_ledger_erasure_delete_on_erasure.sql");
const B = read(`${CHAIN}${CHOSEN}`);
const A_RB = read("reconciliation-staging/2026-09-30-3511-creator-ledger-erasure-delete-on-erasure-rollback.sql");
const B_RB = read("db/rollback/2026-10-04-3600-creator-ledger-erasure-retain-pseudonymised-rollback.sql");
const G_RB = read("db/rollback/2026-09-30-3510-creator-ledger-erasure-policy-undecided-rollback.sql");

/** SQL with `--` comments removed, so a sentence in a header cannot satisfy or trip a check. */
const code = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const guardBody = (sql: string) => {
  const m = /CREATE OR REPLACE FUNCTION public\.creator_ledger_erasure_policy_undecided\(\)[\s\S]*?\$fn\$;/.exec(sql);
  assert.ok(m, "the guard function is defined");
  return m![0];
};
const LEDGERS = ["rent_buddy_earnings_entries", "creator_attributions", "creator_earning_entries", "creator_ledger_audit_events"];
const frozenBody = (sql: string) => {
  const m = /CREATE OR REPLACE FUNCTION public\.creator_ledger_pseudonymised_is_frozen\(\)[\s\S]*?\$fn\$;/.exec(code(sql));
  assert.ok(m, "the frozen guard is defined");
  return m![0];
};
const TRIGGER_PREFIX: Record<string, string> = {
  rent_buddy_earnings_entries: "rbee", creator_attributions: "ca", creator_earning_entries: "cee", creator_ledger_audit_events: "clae",
};

describe("C-11 erasure design, on the files (census-discovery §107)", () => {
  it("E1. C-11 is answered: answer B is in the chain as 3600, after its dependencies and after 3510; answer A is not, and the held numbers are not chain files", () => {
    const chain = readdirSync(new URL(CHAIN, REPO)).filter((f) => f.endsWith(".sql")).sort();
    const undecided = chain.indexOf("3510_creator_ledger_erasure_policy_undecided.sql");
    for (const dep of ["2901_", "2920_", "2921_", "3387_"]) {
      const i = chain.findIndex((f) => f.startsWith(dep));
      assert.ok(i >= 0 && i < undecided, dep);
    }
    // Lexicographic order IS apply order (scripts/local-db/up.sh, and the CI
    // apply step), so the answer must sort AFTER the guard it replaces: applied
    // the other way round, 3510 would re-impose "undecided" over the decision —
    // which is exactly what 3510's own precondition refuses.
    const chosen = chain.indexOf(CHOSEN);
    assert.ok(chosen > undecided, "the chosen answer must be applied after 3510, never before it");
    assert.deepEqual(chain.filter((f) => /erasure_delete_on_erasure/.test(f)), [],
      "answer A is NOT chosen and must stay out of the chain");
    assert.deepEqual(chain.filter((f) => /erasure_retain_pseudonymised/.test(f)), [CHOSEN],
      "exactly one copy of the chosen answer, at exactly one prefix");
    assert.doesNotMatch(chain.join("\n"), /^351[12]_/m, "3511 / 3512 are held numbers, not chain files");
    // Answer A is still held, unapplied and unaltered.
    assert.match(A, /HELD — C-11 ANSWER A/);
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
    // Each refusal names its OWN file: answer A is still 3511, answer B was
    // promoted as 3513 and renumbered 3600 (main took 3513 for layover).
    for (const [name, sql] of [["3511", A], ["3600", B]] as const) {
      assert.match(code(sql), new RegExp(`creator_ledger_erasure_policy_undecided\\(\\)'\\) IS NULL THEN\\s+RAISE EXCEPTION '${name}: PRECONDITION FAILED: 3510`), name);
    }
    const body = guardBody(G);
    assert.equal(guardBody(A_RB), body, "3511's rollback re-installs 3510's function exactly");
    assert.equal(guardBody(B_RB), body, "3512's rollback re-installs 3510's function exactly");
    assert.match(code(G_RB), /ON DELETE SET NULL/, "3510's rollback restores 2901's key as 2901 wrote it");
    assert.match(code(G_RB), /ROLLBACK REFUSED \(3510\)/);
  });

  it("E4. 3600 stores and returns no id -> pseudonym mapping, and calls the result pseudonymised, not anonymous", () => {
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

  it("E5. the chosen answer carries the owner's decision verbatim, is not claimed applied, and invents no retention period", () => {
    // The decision, in the owner's words, on the file that implements it — so a
    // reader of the migration can check the implementation against the ruling
    // without leaving the file.
    for (const clause of [
      "Pseudonymize accounting entries, removing direct",
      "identifiers and the identity link when deletion is requested",
      "tax, accounting, disputes, or legal claims",
      "defined retention period and access controls",
      "[GDPR Article 17]",
    ]) {
      assert.ok(B.includes(clause), `the owner's decision must be quoted verbatim: ${clause}`);
    }

    // The same ruling withholds the apply until legal review confirms Q11(a).
    // A migration in the chain that did not say so would read as applied.
    assert.match(B, /NOT YET APPLIED TO ANY HOSTED DATABASE/);
    assert.match(B, /ajrurzioarfkagpuxfnb/, "the production project must be named as untouched");
    assert.match(B, /hwokxgbmezheskbzskfr/, "and so must CI");

    // THE PERIOD IS NOT INVENTED. The decision asks for one, legal review has
    // not set it, so the file must say that and must not build a purge or name a
    // number. A day/month interval literal here would be a retention policy
    // nobody decided.
    assert.match(B, /NOT IN THIS FILE, AND NOT INVENTED HERE/);
    const c = code(B);
    assert.doesNotMatch(c, /interval\s*'/i, "no interval literal: there is no decided retention period to enforce");
    assert.doesNotMatch(c, /\bDELETE FROM\b/, "a purge is not part of this answer — rows are retained");
    assert.doesNotMatch(c, /pg_cron|cron\.schedule/, "and nothing is scheduled to delete them");

    // The access controls the decision asks for are asserted by the migration
    // itself, not left to the reader.
    assert.match(c, /client grant\(s\) \(anon \/ authenticated\) on a retained ledger table/);
    assert.match(c, /row-level security is off on the receipt/);
  });

  it("E6. (4b) an erased person is never written back: the named person's profile is read FOR SHARE and a tombstone is refused CL452 on all four ledgers", () => {
    const body = frozenBody(B);
    // The person a row names: the acting admin on the audit, the beneficiary on the other three.
    assert.match(body, /who := CASE WHEN TG_TABLE_NAME = 'creator_ledger_audit_events'\s+THEN \(j->>'actor_user_id'\)::uuid\s+ELSE \(j->>'beneficiary_user_id'\)::uuid END;/);
    // Read under a share lock, so the deletion's anonymise UPDATE waits for an insert in flight.
    assert.match(body, /SELECT p\.account_status INTO who_status FROM public\.profiles p WHERE p\.id = who FOR SHARE;/);
    assert.match(body, /IF who_status = 'deleted' THEN\s+RAISE EXCEPTION\s+'creator_ledger_subject_erased — [\s\S]*?USING ERRCODE = 'CL452'/);
    // Before any table-specific branch, so no ledger is exempt.
    assert.ok(body.indexOf("creator_ledger_subject_erased") < body.indexOf("IF TG_TABLE_NAME = 'creator_attributions' THEN"),
      "the erased-person refusal runs for every ledger, before the per-table checks");
    for (const t of LEDGERS) {
      assert.match(code(B), new RegExp(`CREATE TRIGGER ${TRIGGER_PREFIX[t]}_pseudonymised_is_frozen BEFORE INSERT ON public\\.${t}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.creator_ledger_pseudonymised_is_frozen\\(\\);`), t);
    }
    // The migration asserts it about itself, so a hand-edited function cannot drop it unnoticed.
    assert.match(code(B), /position\('FOR SHARE' IN pg_get_functiondef\('public\.creator_ledger_pseudonymised_is_frozen\(\)'::regprocedure\)\) = 0/);
    assert.match(code(B), /position\('creator_ledger_subject_erased' IN pg_get_functiondef/);
    // The marker it trusts is server-only: a person who could set their own
    // account_status could mark themselves erased and switch off every hold,
    // recompute and reversal of their own records.
    for (const role of ["anon", "authenticated"]) {
      assert.match(code(B), new RegExp(`REVOKE UPDATE \\(account_status\\) ON public\\.profiles FROM ${role};`), role);
      assert.match(code(B), new RegExp(`has_column_privilege\\('${role}', 'public\\.profiles', 'account_status', 'UPDATE'\\)`), `${role}: asserted by a postcondition`);
    }
    assert.doesNotMatch(code(B_RB), /GRANT[^;]*account_status/, "the rollback does not hand the column back to the client roles");
  });

  it("E7. (4c) a re-sent key of a retained attribution is refused by the BEFORE INSERT guard, ahead of ON CONFLICT, so 3387's NULL-unsafe replay compare is never reached for it", () => {
    const body = frozenBody(B);
    assert.match(body,
      /IF TG_TABLE_NAME = 'creator_attributions' THEN\s+IF EXISTS \(SELECT 1 FROM public\.creator_attributions a\s+WHERE a\.idempotency_key = NEW\.idempotency_key AND a\.beneficiary_pseudonym IS NOT NULL\) THEN\s+RAISE EXCEPTION\s+'creator_ledger_subject_pseudonymised — [\s\S]*?USING ERRCODE = 'CL452'/);
    // The guard is a BEFORE INSERT ROW trigger: PostgreSQL runs it before it arbitrates ON CONFLICT
    // (and evaluates CHECK constraints before that too), which is what keeps the compare unreachable.
    assert.match(code(B), /CREATE TRIGGER ca_pseudonymised_is_frozen BEFORE INSERT ON public\.creator_attributions\s+FOR EACH ROW/);
    // The other NULL the compare could meet — a payload with no beneficiary — is refused by a CHECK.
    assert.match(code(B), /ADD CONSTRAINT ca_one_beneficiary_identity\s+CHECK \(\(beneficiary_user_id IS NULL\) <> \(beneficiary_pseudonym IS NULL\)\)/);
    // 3387 is applied and is not edited; the compare it carries is the one this guards.
    const door = read(`${CHAIN}3387_creator_ledger_integrity_and_audit.sql`);
    assert.match(door, /OR ex\.beneficiary_user_id <> \(a->>'beneficiary_user_id'\)::uuid/);
    assert.match(code(B), /position\('a\.idempotency_key = NEW\.idempotency_key' IN pg_get_functiondef/);
  });
});
