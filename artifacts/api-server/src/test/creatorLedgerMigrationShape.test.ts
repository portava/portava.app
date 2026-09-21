/**
 * The ledger migrations, read as text.
 *
 * ── WHY A STATIC TEST ───────────────────────────────────────────────────────
 * `10` §7 forbids editing an APPLIED migration. 2170 and 2277 are applied, so
 * the constraint change that makes a reversal expressible had to be a NEW file
 * that supersedes. The obvious way for that rule to be broken later is not
 * malice — it is somebody "tidying" 2170's CHECK to match 2900's. This reads the
 * applied files and fails if they moved.
 *
 * It also pins the two properties that are easy to lose in a rebase and
 * invisible in a runtime test: the financial-control boundary
 * (`CHECK (cash_amount = 0)` at 2170:40, `cash_settled_minor = 0` in 2901) and
 * the absence of any UPDATE grant.
 *
 * Run: node --import tsx/esm --test src/test/creatorLedgerMigrationShape.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const M = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const read = (f: string) => readFileSync(join(M, f), "utf8");

/**
 * The EXECUTABLE half of a migration. These files carry more prose than SQL and
 * the prose says things like "NO FOR EACH STATEMENT TRIGGER" and "2170 granted
 * service_role only INSERT + SELECT" — so a regex over the raw text matches the
 * explanation of a rule and reports it as a violation of that rule. Every
 * assertion about what a migration DOES runs over this; assertions about what it
 * SAYS (the reversal block, the postcondition messages) run over the raw text.
 */
const statementsOf = (f: string) =>
  read(f).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const M2170 = "2170_intel_reward_ledger.sql";
const M2900 = "2900_intel_reward_ledger_reversals.sql";
const M2901 = "2901_rent_buddy_earnings_entries.sql";

// ═══════════════════════════════════════════════════════════════════════════
describe("2170 is APPLIED and must not be edited (`10` §7)", () => {
  const src = read(M2170);

  it("still carries the two non-negativity CHECKs verbatim", () => {
    assert.match(src, /qiu\s+numeric NOT NULL DEFAULT 0 CHECK \(qiu >= 0\)/,
      "2170 was edited. A constraint change is a NEW migration that supersedes.");
    assert.match(src, /earned_units\s+integer NOT NULL DEFAULT 0 CHECK \(earned_units >= 0\)/,
      "2170 was edited. A constraint change is a NEW migration that supersedes.");
  });

  it("still carries the financial-control boundary", () => {
    assert.match(src, /cash_amount\s+numeric NOT NULL DEFAULT 0 CHECK \(cash_amount = 0\)/);
  });

  it("still grants service_role INSERT + SELECT only", () => {
    assert.match(src, /GRANT INSERT, SELECT ON public\.intel_reward_ledger TO service_role;/);
    assert.ok(!/^[^\n]*\bGRANT\b[^\n]*\bUPDATE\b/im.test(statementsOf(M2170)));
  });

  it("does not mention the new column — the supersession lives entirely in 2900", () => {
    assert.ok(!src.includes("reverses_entry_id"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("2900 supersedes rather than relaxes", () => {
  const src = read(M2900);

  it("drops the two superseded CHECKs by name", () => {
    assert.match(src, /DROP CONSTRAINT IF EXISTS intel_reward_ledger_qiu_check;/);
    assert.match(src, /DROP CONSTRAINT IF EXISTS intel_reward_ledger_earned_units_check;/);
  });

  // Over the EXECUTABLE SQL only. The header argues the rule in prose using the
  // same words, so a raw-text match would be satisfied by the explanation even
  // if the constraint itself had been relaxed.
  it("keeps an ORIGINAL entry non-negative — nothing 2170 refused becomes possible", () => {
    assert.match(statementsOf(M2900), /reverses_entry_id IS NULL\s+AND qiu >= 0 AND earned_units >= 0/);
  });

  it("admits a negative ONLY on a row that NAMES what it reverses", () => {
    assert.match(statementsOf(M2900), /reverses_entry_id IS NOT NULL AND qiu <= 0 AND earned_units <= 0/);
  });

  it("bounds reversal to at most one per entry", () => {
    assert.match(src, /CREATE UNIQUE INDEX IF NOT EXISTS intel_reward_ledger_one_reversal_per_entry[\s\S]*?WHERE reverses_entry_id IS NOT NULL/);
  });

  it("never grants UPDATE — corrections stay new rows", () => {
    assert.match(src, /REVOKE UPDATE ON public\.intel_reward_ledger FROM service_role;/);
    assert.ok(!/^[^\n]*\bGRANT\b[^\n]*\bUPDATE\b/im.test(statementsOf(M2900)));
  });

  it("proves the non-cash boundary survived, in a postcondition", () => {
    assert.match(src, /intel_reward_ledger_cash_amount_check/);
    assert.match(src, /POSTCONDITION FAILED: CHECK \(cash_amount = 0\) is gone/);
  });

  it("does NOT block DELETE — 2204 grants it for account erasure", () => {
    assert.ok(!/BEFORE\s+(UPDATE\s+OR\s+)?DELETE\s+ON public\.intel_reward_ledger/i.test(statementsOf(M2900)),
      "a DELETE trigger would silently reinstate the GDPR hole 2204 closed");
    assert.match(src, /BEFORE UPDATE ON public\.intel_reward_ledger/);
  });

  it("installs NO statement-level append-only trigger (`09` §5.3 I3 / 2292)", () => {
    assert.ok(!/FOR EACH STATEMENT/i.test(statementsOf(M2900)));
  });

  it("carries an exact, conditional REVERSAL block", () => {
    assert.match(src, /-- REVERSAL/);
    assert.match(src, /WHERE reverses_entry_id IS NOT NULL;/);
    assert.match(src, /ADD CONSTRAINT intel_reward_ledger_qiu_check CHECK \(qiu >= 0\)/);
  });

  it("does not seed or flip any feature flag", () => {
    assert.ok(!/INSERT INTO public\.feature_flags/i.test(statementsOf(M2900)));
    assert.ok(!/UPDATE public\.feature_flags/i.test(statementsOf(M2900)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("2901 is additive and records no settlement", () => {
  const src = read(M2901);

  it("touches rent_buddy_earnings_ledger in no way at all", () => {
    const statements = statementsOf(M2901);
    assert.ok(!/ALTER TABLE public\.rent_buddy_earnings_ledger/i.test(statements),
      "the summary table has live production rows; this migration must not reshape it");
    assert.ok(!/(INSERT INTO|UPDATE|DELETE FROM)\s+public\.rent_buddy_earnings_ledger/i.test(statements));
    assert.ok(!/DROP TABLE[^;]*rent_buddy_earnings_ledger/i.test(statements));
  });

  it("makes recording a settlement structurally impossible", () => {
    assert.match(src, /cash_settled_minor\s+bigint NOT NULL DEFAULT 0 CHECK \(cash_settled_minor = 0\)/);
  });

  it("has no entry_reason that asserts money arrived, left, or settled", () => {
    const m = /entry_reason IN \(([^)]*)\)/.exec(src);
    assert.ok(m, "entry_reason CHECK not found");
    for (const forbidden of ["collection", "capture", "payout", "settlement", "collected"]) {
      assert.ok(!m[1].includes(forbidden), `entry_reason admits ${forbidden}`);
    }
  });

  it("stores amounts in minor units WITH a currency (`09` §3 refusal 1)", () => {
    assert.match(src, /amount_minor\s+bigint NOT NULL CHECK \(amount_minor <> 0\)/);
    assert.match(src, /currency\s+char\(3\) NOT NULL DEFAULT 'USD'/);
  });

  it("leaves provider unconstrained so a processor can be named later", () => {
    assert.match(src, /provider\s+text NOT NULL DEFAULT 'none'/);
    assert.ok(!/CHECK \(provider/i.test(statementsOf(M2901)),
      "a CHECK on provider would prevent the swap it is meant to allow");
  });

  it("requires a rule version and a cause on every entry", () => {
    assert.match(src, /rule_version\s+text NOT NULL/);
    assert.match(src, /attribution_kind\s+text NOT NULL/);
    assert.match(src, /attribution_id\s+uuid NOT NULL/);
  });

  it("ties reversal and link together in both directions", () => {
    assert.match(src, /\(entry_reason = 'reversal'\) = \(reverses_entry_id IS NOT NULL\)/);
  });

  it("uses a TOTAL unique index on idempotency_key, so DO NOTHING can infer it", () => {
    const m = /CREATE UNIQUE INDEX IF NOT EXISTS rbee_idempotency_key_once[\s\S]*?;/.exec(src);
    assert.ok(m, "idempotency index not found");
    assert.ok(!/WHERE/i.test(m[0]), "2180:17-19 — inference does not match a PARTIAL index");
  });

  it("grants no client role anything", () => {
    assert.ok(!/^[^\n]*\bGRANT\b[^\n]*\bTO\s+(anon|authenticated)\b/im.test(statementsOf(M2901)));
    assert.match(src, /GRANT INSERT, SELECT, DELETE ON public\.rent_buddy_earnings_entries TO service_role;/);
  });

  it("enables RLS and installs no statement-level trigger", () => {
    assert.match(src, /ALTER TABLE public\.rent_buddy_earnings_entries ENABLE ROW LEVEL SECURITY;/);
    assert.ok(!/FOR EACH STATEMENT/i.test(statementsOf(M2901)));
  });

  it("does not seed or flip any feature flag", () => {
    assert.ok(!/INSERT INTO public\.feature_flags/i.test(statementsOf(M2901)));
    assert.ok(!/UPDATE public\.feature_flags/i.test(statementsOf(M2901)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("neither migration touches another lane's tables", () => {
  const FORBIDDEN = [
    "rank_events", "place_momentum", "protected_zones", "canonical_locations",
    "trails", "trail_", "discovery_",
  ];
  for (const f of [M2900, M2901]) {
    it(`${f} names none of them`, () => {
      const statements = statementsOf(f);
      for (const t of FORBIDDEN) {
        assert.ok(!statements.includes(t), `${f} references ${t}`);
      }
    });
  }
});
