/**
 * Migration 2930, read as text — and held against the module that folds it.
 *
 * ── WHY A STATIC TEST ───────────────────────────────────────────────────────
 * `10` §7 forbids editing an applied migration, so 2930 could not reshape 2170,
 * 2900 or 2901 and did not try: it adds a VIEW and nothing else. That is the
 * whole losslessness argument — a file containing no DML cannot lose a row —
 * and it is a property of the TEXT, which is where it has to be checked. A
 * runtime test cannot notice that somebody later "tidied" an `ALTER TABLE` into
 * this file; this can.
 *
 * It also pins the two things that would quietly turn a safe read model into an
 * unsafe one:
 *
 *   • `security_invoker = true`. Without it the view evaluates as its OWNER,
 *     which is the definer-shaped RLS bypass `10` §6 warns about, on money data.
 *   • NO WRITE GRANT. A UNION ALL view is not auto-updatable, so there is
 *     nothing to grant — but a future edit that collapsed the UNION would make
 *     one possible, and 2930's own postcondition asserts
 *     `pg_relation_is_updatable(...) = 0` so that edit fails loudly.
 *
 * And the one that this unit is actually about: the SQL's account→role CASE and
 * its unit vocabulary must be the SAME mapping `lib/creatorShareCanonical.ts`
 * uses, or the canonical relation and the fold over it disagree about what a
 * creator's leg even is.
 *
 * Run: node --import tsx/esm --test src/test/creatorShareCanonicalViewShape.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_PARTY_ROLE,
  UNIT_KINDS,
} from "../lib/creatorShareCanonical.js";

const M = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const read = (f: string) => readFileSync(join(M, f), "utf8");

/**
 * The EXECUTABLE half. This file carries far more prose than SQL, and the prose
 * argues about UPDATE grants, parallel tables and fabricated conversions using
 * the very words a naive regex would treat as violations. Every assertion about
 * what the migration DOES runs over this; assertions about what it SAYS (the
 * reversal block) run over the raw text.
 */
const statementsOf = (f: string) =>
  read(f).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const M2930 = "2930_creator_share_canonical_view.sql";
const M2170 = "2170_intel_reward_ledger.sql";
const M2900 = "2900_intel_reward_ledger_reversals.sql";
const M2901 = "2901_rent_buddy_earnings_entries.sql";

// ═══════════════════════════════════════════════════════════════════════════
describe("2930 adds a VIEW and touches nothing else", () => {
  const sql = statementsOf(M2930);

  it("creates public.creator_share_ledger as a view", () => {
    assert.match(sql, /CREATE OR REPLACE VIEW public\.creator_share_ledger/);
    assert.ok(!/CREATE TABLE/i.test(sql),
      "2930 created a table. A third physical earnings table is the parallel system `10` §1 forbids.");
    assert.ok(!/CREATE MATERIALIZED VIEW/i.test(sql),
      "a materialized view has rows of its own, which can go stale — that is a cache, not a projection");
  });

  it("contains NO DML and NO table DDL — the losslessness argument in one assertion", () => {
    // STATEMENT-ANCHORED, not word-anchored. The postcondition block legitimately
    // contains the string "UPDATE" inside has_table_privilege() calls and inside
    // the message that fires when a base ledger gains one; a bare /\bUPDATE\b/
    // would report the guard as the violation it guards against.
    for (const verb of [/(^|\n)\s*ALTER\s+TABLE\b/i, /(^|\n)\s*INSERT\s+INTO\b/i,
                        /(^|\n)\s*UPDATE\s+\w/i, /(^|\n)\s*DELETE\s+FROM\b/i,
                        /(^|\n)\s*DROP\s+TABLE\b/i, /(^|\n)\s*DROP\s+CONSTRAINT\b/i,
                        /(^|\n)\s*TRUNCATE\b/i]) {
      assert.ok(!verb.test(sql),
        `2930 contains ${verb} in executable SQL. It must write no row and alter no table: ` +
        "that is why every existing entry and identifier survives it.");
    }
  });

  it("is security_invoker, not a definer-shaped bypass on money data (`10` §6)", () => {
    assert.match(sql, /WITH \(security_invoker = true\)/);
    assert.match(sql, /security_invoker=true' = ANY \(opts\)/,
      "nothing asserts security_invoker after the fact; a later CREATE OR REPLACE could drop it");
  });

  it("grants SELECT to service_role and to nobody else", () => {
    const grants = sql.split("\n").filter((l) => /^\s*GRANT\b/.test(l));
    assert.deepEqual(
      grants.map((l) => l.trim()),
      ["GRANT SELECT ON public.creator_share_ledger TO service_role;"],
      "the only grant on the canonical surface must be SELECT to service_role (`09` §10)",
    );
    for (const role of ["anon", "authenticated", "PUBLIC"]) {
      assert.match(sql, new RegExp(`REVOKE ALL ON public\\.creator_share_ledger FROM ${role};`));
    }
  });

  it("asserts it has NO WRITE PATH at all", () => {
    assert.match(sql, /pg_relation_is_updatable\('public\.creator_share_ledger'::regclass, true\) <> 0/,
      "nothing proves the canonical surface is unwritable; a later edit could open a door into two append-only ledgers");
  });

  it("re-asserts the base ledgers' append-only posture and cash boundaries", () => {
    assert.match(sql, /has_table_privilege\('service_role', 'public\.intel_reward_ledger', 'UPDATE'\)/);
    assert.match(sql, /has_table_privilege\('service_role', 'public\.rent_buddy_earnings_entries', 'UPDATE'\)/);
    assert.match(sql, /intel_reward_ledger_cash_amount_check/);
    assert.match(sql, /cash_settled_minor = 0/);
  });

  it("reconciles per unit, in both directions, as a postcondition", () => {
    assert.match(sql, /n_canon <> \(2 \* n_irl \+ n_rbee\)/,
      "the row-count reconciliation is gone; the projection could lose or invent rows silently");
    assert.match(sql, /source_ledger, source_entry_id, unit_kind\n\s*FROM public\.creator_share_ledger\n\s*GROUP BY 1, 2, 3 HAVING count\(\*\) > 1/,
      "nothing proves the canonical key is unique");
    assert.match(sql, /canonical row\(s\) name no source entry/,
      "nothing checks the backward direction — a canonical row with no source");
    assert.match(sql, /can_qiu <> src_qiu OR can_credits <> src_credits OR can_minor <> src_minor/,
      "the per-unit total reconciliation is gone");
  });

  it("declares its own vacuity rather than hiding it", () => {
    assert.match(read(M2930), /VACUOUS \(both ledgers empty\)/,
      "both ledgers ship empty, so every equality can hold over zero rows. Say so.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the SQL and the fold agree about what a creator's leg is", () => {
  const sql = statementsOf(M2930);

  it("maps every 2901 account to the same role the module does", () => {
    for (const [account, role] of Object.entries(ACCOUNT_PARTY_ROLE)) {
      assert.match(
        sql, new RegExp(`WHEN '${account}'\\s+THEN '${role}'`),
        `2930's CASE and ACCOUNT_PARTY_ROLE disagree about ${account}. ` +
        "The view and the fold over it would then disagree about whose money it is.",
      );
    }
  });

  it("maps the 2901 account domain exhaustively, with no catch-all ELSE", () => {
    const whens = [...sql.matchAll(/WHEN '(\w+)'\s+THEN '(creator|platform|traveler|external)'/g)]
      .map((m) => m[1]!);
    assert.deepEqual(whens.sort(), Object.keys(ACCOUNT_PARTY_ROLE).sort());
    // Scoped to the account CASE. The postcondition block has an unrelated CASE
    // expression (the vacuity NOTICE) whose ELSE is not a role default, and a
    // whole-file `ELSE` search would report that one instead of this one.
    const caseBlock = sql.slice(sql.indexOf("CASE e.account"));
    const accountCase = caseBlock.slice(0, caseBlock.indexOf("END"));
    assert.ok(accountCase.includes("WHEN 'cash_external'"), "the account CASE was not located");
    assert.ok(!/\bELSE\b/i.test(accountCase),
      "an ELSE would silently give an unmapped future account somebody's money or lose it entirely");
  });

  it("emits exactly the module's unit vocabulary", () => {
    for (const kind of UNIT_KINDS) {
      assert.match(sql, new RegExp(`'${kind}'::text`),
        `2930 never emits unit_kind '${kind}', which the fold expects`);
    }
    // One reward row must project to TWO rows, one per unit it carries — the
    // shape that refuses to convert qiu into credits.
    const rewardPartitions = [...sql.matchAll(/FROM public\.intel_reward_ledger irl/g)];
    assert.equal(rewardPartitions.length, 2,
      "intel_reward_ledger must be projected once per unit it carries (qiu, credit)");
    assert.equal([...sql.matchAll(/FROM public\.rent_buddy_earnings_entries e/g)].length, 1);
  });

  it("never converts one unit into another", () => {
    assert.ok(!/QIU_TO_CREDITS|qiu\s*\*\s*100|earned_units\s*\/\s*100/.test(sql),
      "2930 applied a qiu<->credit rate. Both figures are already recorded on the row; " +
      "converting would restate one earning twice.");
    assert.ok(!/fx_rates/.test(sql),
      "2930 reached for an FX rate. There is no credit->currency rate anywhere, and " +
      "docs/architecture/09_Payment_Architecture.md §8 refuses to book on a missing one.");
  });

  it("says NULL rather than inventing an attribution id for the reward ledger", () => {
    assert.match(sql, /NULL::uuid\s+AS attribution_id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the reversal is exact, executable, and complete", () => {
  const raw = read(M2930);

  it("is a single DROP VIEW and nothing more", () => {
    const block = raw.slice(raw.indexOf("-- REVERSAL"));
    const statements = block.split("\n")
      .map((l) => l.replace(/^--\s?/, "").trim())
      .filter((l) => /^(DROP|ALTER|CREATE|INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/i.test(l));
    assert.deepEqual(statements, ["DROP VIEW IF EXISTS public.creator_share_ledger;"],
      "the reversal must undo exactly what the migration did — one view, and nothing else");
  });

  it("states what reversing costs, rather than claiming it costs nothing", () => {
    assert.match(raw, /destroys nothing, because\s*\n--\s*a view holds no data/);
    assert.match(raw, /What is lost is the ABILITY to compute the creator\s*\n-- share from one relation/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the applied migrations 2930 builds on are untouched by it", () => {
  it("names them only in preconditions and postconditions, never in DDL", () => {
    const sql = statementsOf(M2930);
    for (const table of ["intel_reward_ledger", "rent_buddy_earnings_entries"]) {
      const ddl = new RegExp(`(ALTER|DROP|TRUNCATE)[^\\n]*public\\.${table}`, "i");
      assert.ok(!ddl.test(sql), `2930 issues DDL against public.${table}`);
    }
  });

  it("still finds 2170, 2900 and 2901 carrying the shapes it depends on", () => {
    // Narrow, and deliberately not a duplicate of creatorLedgerMigrationShape's
    // coverage: these are the three facts 2930's SELECT list would be WRONG
    // about if they moved.
    assert.match(read(M2170), /qiu\s+numeric NOT NULL DEFAULT 0/);
    assert.match(read(M2170), /earned_units\s+integer NOT NULL DEFAULT 0/);
    assert.match(read(M2900), /ADD COLUMN IF NOT EXISTS reverses_entry_id uuid NULL/);
    assert.match(read(M2901), /account IN \('buddy_payable', 'platform_revenue', 'traveler_receivable', 'cash_external'\)/);
    assert.match(read(M2901), /amount_minor\s+bigint NOT NULL CHECK \(amount_minor <> 0\)/);
  });
});
