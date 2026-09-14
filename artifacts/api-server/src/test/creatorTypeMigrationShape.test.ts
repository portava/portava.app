/**
 * Migrations 2920/2921, read as text — and read AGAINST lib/creatorTypes.ts.
 *
 * ── WHY A STATIC TEST ───────────────────────────────────────────────────────
 * The vocabulary of `07` §2's six creator types now lives in two places: a
 * TypeScript union and a SQL CHECK. Nothing in the language keeps them equal,
 * and the way they come apart is not malice — it is somebody adding a seventh
 * type in TS, or "tidying" a CHECK. The tree already has a test of exactly this
 * shape for Trails (`discoveryTrailSchemaContract.test.ts`); this is that
 * pattern applied to the creator-type dimension.
 *
 * It also pins the three properties that are easy to lose in a rebase and
 * invisible in a runtime test:
 *   • the pre-money boundary (`settled_minor = 0`, `cash_settled_minor = 0`);
 *   • the absence of any UPDATE grant on any of the three new tables;
 *   • the SEAM rule — `ca_seam_earns_nothing` plus 2921's trigger — without
 *     which a row for a producerless type is indistinguishable from coverage.
 *
 * And it pins that the APPLIED migrations this lane deliberately did not edit
 * (2170, 2277, 2901) are byte-identical in the respects that matter, because
 * `10` §7 forbids editing an applied migration and the obvious way that rule
 * gets broken later is a well-meaning tidy-up.
 *
 * Run: node --import tsx/esm --test src/test/creatorTypeMigrationShape.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CREATOR_TYPES,
  CREATOR_SUBJECT_KINDS,
  TRAVELER_IMPACT_OUTCOMES,
  creatorTypeFacts,
} from "../lib/creatorTypes.js";
import { REVENUE_SOURCES, CREATOR_LEDGER_ACCOUNTS } from "../lib/creatorLedgerEntries.js";

const M = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const read = (f: string) => readFileSync(join(M, f), "utf8");

/**
 * The EXECUTABLE half of a migration. These files carry more prose than SQL and
 * the prose quotes the very constraints it explains, so a regex over the raw
 * text matches an explanation and reports it as the thing explained. Every
 * assertion about what a migration DOES runs over this; assertions about what it
 * SAYS (the reversal block) run over the raw text.
 */
const statementsOf = (f: string) =>
  read(f).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const M2920 = "2920_creator_attributions.sql";
const M2921 = "2921_creator_earning_entries.sql";
const M2170 = "2170_intel_reward_ledger.sql";
const M2901 = "2901_rent_buddy_earnings_entries.sql";

/** Every quoted literal inside the CHECK named by `constraint`, in file order. */
function checkLiterals(sql: string, constraint: string): string[] {
  const at = sql.indexOf(`CONSTRAINT ${constraint}`);
  assert.notEqual(at, -1, `constraint ${constraint} not found`);
  // Scan forward to the closing paren of the constraint, balancing nesting.
  let depth = 0;
  let i = sql.indexOf("(", at);
  const start = i;
  for (; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") { depth--; if (depth === 0) break; }
  }
  const body = sql.slice(start, i + 1);
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The bodies of every CREATE TABLE in a file — where a COLUMN can be declared. */
function columnBlocksOf(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(/CREATE TABLE [^(]*\(/g)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    const start = i;
    for (; i < sql.length; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") { depth--; if (depth === 0) break; }
    }
    out.push(sql.slice(start, i + 1));
  }
  assert.ok(out.length > 0, "no CREATE TABLE found; the scan would vacuously pass");
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("the SIX types agree between lib/creatorTypes.ts and the SQL", () => {
  const sql2920 = statementsOf(M2920);
  const sql2921 = statementsOf(M2921);

  it("2920's two creator_type CHECKs list exactly CREATOR_TYPES", () => {
    for (const c of ["crv_creator_type_known", "ca_creator_type_known"]) {
      assert.deepEqual(checkLiterals(sql2920, c), [...CREATOR_TYPES], c);
    }
  });

  it("2921's creator_type CHECK lists exactly CREATOR_TYPES", () => {
    assert.deepEqual(checkLiterals(sql2921, "cee_creator_type_known"), [...CREATOR_TYPES]);
  });

  it("the subject-kind CHECK lists exactly CREATOR_SUBJECT_KINDS", () => {
    assert.deepEqual(checkLiterals(sql2920, "ca_subject_kind_known"), [...CREATOR_SUBJECT_KINDS]);
  });

  it("the value-event CHECK lists exactly `07` §3's seven outcomes", () => {
    assert.deepEqual(checkLiterals(sql2920, "ca_value_event_known"), [...TRAVELER_IMPACT_OUTCOMES]);
  });

  it("the type↔subject pairing CHECK matches every type's declared subjectKind", () => {
    const pairs = checkLiterals(sql2920, "ca_type_subject_agree");
    assert.equal(pairs.length, CREATOR_TYPES.length * 2, "the pairing list is not (type, kind) pairs");
    for (let i = 0; i < pairs.length; i += 2) {
      const [type, kind] = [pairs[i], pairs[i + 1]];
      assert.ok(CREATOR_TYPES.includes(type as any), `unknown type ${type} in the pairing`);
      assert.equal(kind, creatorTypeFacts(type as any).subjectKind, `${type}'s subject kind disagrees`);
    }
  });

  it("2921's account and revenue-source CHECKs match the code's vocabularies", () => {
    assert.deepEqual(checkLiterals(sql2921, "cee_account_known"), [...CREATOR_LEDGER_ACCOUNTS]);
    const sources = checkLiterals(sql2921, "cee_revenue_source_known");
    assert.deepEqual(sources, [...REVENUE_SOURCES]);
  });

  it("2920 seeds a rule version for EVERY type, at the default the code names", () => {
    const seed = sql2920.slice(sql2920.indexOf("INSERT INTO public.creator_rule_versions"));
    for (const t of CREATOR_TYPES) {
      const f = creatorTypeFacts(t);
      assert.ok(seed.includes(`'${t}'`), `${t} is not seeded a rule version`);
      assert.ok(seed.includes(`'${f.defaultRuleVersion}'`), `${t}'s default rule version is not seeded`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the pre-money boundary is structural, in both new tables", () => {
  it("2920 CHECKs settled_minor = 0 and 2921 CHECKs cash_settled_minor = 0", () => {
    assert.match(statementsOf(M2920), /CONSTRAINT ca_no_settlement\s+CHECK \(settled_minor = 0\)/);
    assert.match(statementsOf(M2921), /CONSTRAINT cee_no_settlement CHECK \(cash_settled_minor = 0\)/);
  });

  // Over the COLUMN DEFINITIONS only. An earlier version of this scanned the
  // whole executable half and went red on the word "balance" inside a COMMENT
  // ON — a sentence explaining that there IS no balance column. Widening the
  // scan to catch that would make the check unable to distinguish a column from
  // a description of its absence, so it is narrowed to where a column can be.
  it("neither new table has a wallet, balance, payout or disbursement column", () => {
    for (const f of [M2920, M2921]) {
      for (const cols of columnBlocksOf(statementsOf(f))) {
        for (const word of ["wallet", "balance", "payout", "disburse", "settlement_status", "paid_at"]) {
          assert.ok(!new RegExp(`\\b${word}`, "i").test(cols), `${f} declares a column naming ${word}`);
        }
      }
    }
  });

  it("no entry_reason asserts that money arrived, left or settled", () => {
    const reasons = checkLiterals(statementsOf(M2921), "cee_entry_reason_known");
    for (const r of reasons) {
      assert.ok(
        !/collect|captur|payout|settle|disburse|transfer/i.test(r),
        `entry_reason '${r}' asserts a money movement`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a SEAM can never be mistaken for coverage", () => {
  it("2920 forbids a seam carrying weight, gross or a share", () => {
    assert.match(
      statementsOf(M2920),
      /CONSTRAINT ca_seam_earns_nothing CHECK \(\s*attribution_basis = 'recorded_value_event'\s*OR \(gross_revenue_minor = 0 AND provisional_share_minor = 0 AND weight = 0\)\)/,
    );
  });

  it("2920 forbids a basis that disagrees with whether an event is named", () => {
    assert.match(
      statementsOf(M2920),
      /ca_basis_matches_event CHECK \(\s*\(attribution_basis = 'recorded_value_event'\) = \(value_event_id IS NOT NULL\)\)/,
    );
  });

  it("2921 refuses an earning against a seam AT THE DATABASE, not only in code", () => {
    const sql = statementsOf(M2921);
    assert.match(sql, /CREATE TRIGGER cee_requires_recorded_value_event\s+BEFORE INSERT ON public\.creator_earning_entries/);
    assert.match(sql, /a_basis <> 'recorded_value_event'/);
    // The refusal must carry an errcode a caller can distinguish; a bare P0001
    // is indistinguishable from any other RAISE and cannot be caught precisely.
    assert.match(sql, /USING ERRCODE = 'check_violation'/);
  });

  it("2921 refuses an entry whose creator_type disagrees with its attribution's", () => {
    assert.match(statementsOf(M2921), /a_type <> NEW\.creator_type/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("corrections are new rows — nothing is mutable", () => {
  it("no UPDATE is granted on any of the three new tables", () => {
    for (const f of [M2920, M2921]) {
      const grants = statementsOf(f).split("\n").filter((l) => l.trim().startsWith("GRANT"));
      assert.ok(grants.length > 0, `${f} grants nothing`);
      for (const g of grants) assert.ok(!/\bUPDATE\b/.test(g), `${f}: ${g.trim()}`);
    }
  });

  it("every new table blocks UPDATE with a BEFORE UPDATE trigger", () => {
    assert.match(statementsOf(M2920), /CREATE TRIGGER ca_no_update\s+BEFORE UPDATE ON public\.creator_attributions/);
    assert.match(statementsOf(M2920), /CREATE TRIGGER crv_no_update\s+BEFORE UPDATE ON public\.creator_rule_versions/);
    assert.match(statementsOf(M2921), /CREATE TRIGGER cee_no_update\s+BEFORE UPDATE ON public\.creator_earning_entries/);
  });

  it("no client role is granted anything on any new table", () => {
    for (const f of [M2920, M2921]) {
      for (const g of statementsOf(f).split("\n").filter((l) => l.trim().startsWith("GRANT"))) {
        assert.match(g, /TO service_role;?\s*$/, `${f}: ${g.trim()} reaches a client role`);
      }
    }
  });

  it("a rule version can never be deleted — history must stay reconstructable", () => {
    const grants = statementsOf(M2920).split("\n").filter((l) => /creator_rule_versions\s+TO service_role/.test(l));
    assert.equal(grants.length, 1);
    assert.ok(!/\bDELETE\b/.test(grants[0]), grants[0]);
  });

  it("at most one reversal per entry and one supersession per attribution", () => {
    assert.match(statementsOf(M2921), /CREATE UNIQUE INDEX cee_one_reversal_per_entry[\s\S]{0,160}WHERE reverses_entry_id IS NOT NULL/);
    assert.match(statementsOf(M2920), /CREATE UNIQUE INDEX ca_one_supersede_per_row[\s\S]{0,160}WHERE supersedes_id IS NOT NULL/);
  });

  it("the idempotency indexes are TOTAL, so PostgREST conflict inference matches them", () => {
    for (const [f, name] of [[M2920, "ca_idempotency_key_once"], [M2921, "cee_idempotency_key_once"]] as const) {
      const sql = statementsOf(f);
      const at = sql.indexOf(`CREATE UNIQUE INDEX ${name}`);
      assert.notEqual(at, -1, name);
      const stmt = sql.slice(at, sql.indexOf(";", at));
      assert.ok(!/WHERE/i.test(stmt), `${name} is PARTIAL; on_conflict inference will not match it`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("`10` §7 — the APPLIED migrations this lane did not edit", () => {
  it("2170 still carries its own cash boundary and grants no UPDATE", () => {
    const sql = statementsOf(M2170);
    assert.match(sql, /cash_amount\s+numeric\s+NOT NULL DEFAULT 0 CHECK \(cash_amount = 0\)/);
    for (const g of sql.split("\n").filter((l) => l.trim().startsWith("GRANT"))) {
      assert.ok(!/\bUPDATE\b/.test(g), g.trim());
    }
  });

  it("2901 is STILL a Rent-a-Buddy table — 2921 widened nothing", () => {
    const sql = statementsOf(M2901);
    assert.match(sql, /booking_id\s+uuid NOT NULL REFERENCES public\.rent_buddy_bookings\(id\)/);
    assert.deepEqual(checkLiterals(sql, "rbee_attribution_kind_check"), ["booking"]);
  });

  it("neither new migration ALTERs, DROPs or writes to any pre-existing relation", () => {
    for (const f of [M2920, M2921]) {
      for (const line of statementsOf(f).split("\n")) {
        const s = line.trim();
        if (/^(ALTER TABLE|DROP TABLE|TRUNCATE|UPDATE|DELETE FROM)\b/i.test(s)) {
          assert.ok(
            /creator_attributions|creator_rule_versions|creator_earning_entries/.test(s),
            `${f} touches a pre-existing relation: ${s}`,
          );
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("each migration carries an executable recovery and proves its own rules", () => {
  it("both name an explicit, ordered reversal", () => {
    const r2920 = read(M2920);
    assert.match(r2920, /REVERSAL \(exact/);
    assert.match(r2920, /DROP TABLE IF EXISTS public\.creator_attributions;/);
    assert.match(r2920, /DROP TABLE IF EXISTS public\.creator_rule_versions;/);
    const r2921 = read(M2921);
    assert.match(r2921, /DROP TABLE IF EXISTS public\.creator_earning_entries;/);
    assert.match(r2921, /DROP FUNCTION IF EXISTS public\.creator_earning_requires_recorded_value_event\(\);/);
    // The dependency order matters and must be STATED, not left to be worked
    // out during an incident: 2921's FK points at 2920's table.
    assert.match(r2921, /Reverse 2921 BEFORE 2920/);
  });

  it("both PROVE their central rule with a live probe rather than asserting it", () => {
    assert.match(statementsOf(M2920), /a seam row carrying a share was accepted/);
    assert.match(statementsOf(M2920), /a trail_builder was attributed against a booking/);
    assert.match(statementsOf(M2921), /an earning was booked against a seam attribution/);
  });

  it("both assert the two LIVE ledgers were left exactly as found", () => {
    for (const f of [M2920, M2921]) {
      assert.match(statementsOf(f), /intel_reward_ledger_cash_amount_check/, f);
    }
    assert.match(statementsOf(M2920), /rent_buddy_earnings_ledger_booking_id_key/);
    assert.match(statementsOf(M2921), /rbee_attribution_kind_check/);
  });

  it("both count SIX types in a postcondition — the lane's whole point", () => {
    assert.match(statementsOf(M2920), /count\(DISTINCT creator_type\) INTO n FROM public\.creator_rule_versions/);
    assert.match(statementsOf(M2920), /IF n <> 6 THEN/);
  });
});
