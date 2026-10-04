/**
 * The Rent-a-Buddy commission: a flat 10 %, stored as 1000 basis points.
 *
 * ── THE DECISIONS THIS PINS (owner, 2026-10-04) ─────────────────────────────
 *   "Set the Rent-a-Buddy commission to a flat 10% across Buddy levels. Store
 *    it in basis points (1000); allow market overrides only when separately
 *    approved."
 *
 * ── WHY BASIS POINTS WERE FORCED, NOT CHOSEN ────────────────────────────────
 * `rent_buddy_fee_rules.platform_fee_percent` is `integer`. An integer percent
 * cannot express 10.5 %, so the "market overrides when separately approved"
 * half of that decision was unrepresentable in the column it would live in.
 * Migration 3520 adds `platform_fee_basis_points` and this file reads it as
 * text: the conversion is faithful (25 % -> 2500, never 25), every level lands
 * on 1000, and an unapproved off-flat rate is unwritable.
 *
 * ── THE FOUR PROPERTIES THAT ARE ABOUT MONEY, NOT SCHEMA ───────────────────
 *   1. ROUNDING. One rule, in one function, half-up on the cent in integer
 *      cents. The boundary case is $1.15 at 1000 basis points: $0.115 must
 *      round to $0.12, and the float spelling this replaced yields $0.11.
 *   2. AN UNREADABLE FEE RULE REFUSES. Not 0 %, not 10 %, not the flat rate —
 *      no price at all, at every call site that computes one.
 *   3. A TIP CREDITS THE BUDDY IN FULL. The commission base is the booking
 *      total; the tip transaction has two legs and no platform leg.
 *   4. NO MARKET OVERRIDE IS APPROVED TODAY, and the admin editor cannot
 *      approve one.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyCommissionBasisPoints.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASIS_POINTS_PER_UNIT,
  FEE_SCHEDULE_TABLE,
  FLAT_COMMISSION_BASIS_POINTS,
  applyBasisPoints,
  basisPointsAsRateFraction,
  basisPointsToPercent,
  percentToBasisPoints,
  platformFeeUsdFor,
  resolveFeeSchedule,
  roundUsd,
  travelerServiceFeeUsdFor,
  type FeeScheduleRule,
} from "../lib/rentBuddyFeeSchedule.js";
import { buildBookingEntries, reconstructBalances, toMinor } from "../lib/creatorLedgerEntries.js";
import { RENT_BUDDY_FEE_RULE_VERSION } from "../lib/creatorLedgerRows.js";
import { judgeFeeRuleUpdate, toLedgerEntryView } from "../routes/rentABuddyMarketplace.js";
import { foldEarningsRows } from "../routes/rentABuddy.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = "3520_rent_buddy_commission_basis_points.sql";
const migrationText = readFileSync(join(SRC, "migrations", MIGRATION), "utf8");

/**
 * The EXECUTABLE half of the migration. These files carry more prose than SQL
 * and the prose quotes the constraints it explains, so a search over the raw
 * text would match an explanation and report it as the thing explained.
 */
const migrationStatements = migrationText
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

/** Every buddy level the schedule has ever been seeded with, plus 'standard'. */
const SEEDED_LEVELS = ["new", "rising", "pro", "elite", "city_ambassador"] as const;

const FLAT_RULE: FeeScheduleRule = {
  buddyLevel: "new",
  platformFeeBasisPoints: FLAT_COMMISSION_BASIS_POINTS,
  travelerServiceFeeUsd: 0,
  travelerServiceFeePct: 0,
  commissionOverrideApproval: null,
};

// ── A fake client that answers exactly one table ─────────────────────────────

function feeClient(opts: { row?: any; error?: any } = {}) {
  return {
    from() {
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: opts.row ?? null, error: opts.error ?? null }),
      };
      return b;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The decided rate
// ═══════════════════════════════════════════════════════════════════════════

describe("the commission is a flat 10 %, carried as 1000 basis points", () => {
  it("1000 basis points IS 10 %, and the constant says so", () => {
    assert.equal(FLAT_COMMISSION_BASIS_POINTS, 1000);
    assert.equal(basisPointsToPercent(FLAT_COMMISSION_BASIS_POINTS), 10);
    assert.equal(BASIS_POINTS_PER_UNIT, 10000);
    assert.equal(basisPointsAsRateFraction(FLAT_COMMISSION_BASIS_POINTS), 0.1);
  });

  it("is 10 % for EVERY buddy level, not a per-level ladder", async () => {
    // The storage decision and the rate decision are separate; this is the rate
    // one. Every level the schedule has ever carried resolves to the same rate,
    // which is what "flat across Buddy levels" means operationally.
    for (const level of SEEDED_LEVELS) {
      const client = feeClient({
        row: {
          buddy_level: level,
          platform_fee_basis_points: FLAT_COMMISSION_BASIS_POINTS,
          commission_override_approval: null,
          traveler_service_fee_usd: 0,
          traveler_service_fee_pct: 0,
        },
      });
      const res = await resolveFeeSchedule(client, level);
      assert.equal(res.status, "resolved", `${level} must resolve`);
      assert.equal(
        res.status === "resolved" && res.rule.platformFeeBasisPoints, 1000,
        `${level} must be priced at 1000 basis points`,
      );
      assert.equal(platformFeeUsdFor(200, (res as any).rule), 20, `${level}: 10 % of 200`);
    }
  });

  it("migration 3520 sets every row to 1000 and converts the old ones faithfully", () => {
    // Faithful: 25 % must become 2500, not 25. The multiply is the assertion —
    // a migration that copied the percent across would leave the schedule
    // claiming 0.25 %, which is a rate 100x too small on a money record.
    assert.match(
      migrationStatements,
      /SET\s+platform_fee_basis_points\s*=\s*platform_fee_percent\s*\*\s*100/,
      "the backfill must MULTIPLY the old percent by 100, not copy it",
    );
    assert.match(
      migrationStatements,
      /SET\s+platform_fee_basis_points\s*=\s*1000/,
      "and then every unapproved row must land on the decided flat rate",
    );
    // Convergent: the backfill only touches rows that have not been converted,
    // so a second run cannot multiply twice.
    assert.match(
      migrationStatements,
      /platform_fee_basis_points\s*=\s*platform_fee_percent\s*\*\s*100\s*\n\s*WHERE platform_fee_basis_points IS NULL/,
      "the backfill must be guarded so a re-run does not multiply a converted row again",
    );
  });

  it("3520 is additive and idempotent, and writes no ledger row for itself", () => {
    assert.match(migrationStatements, /ADD COLUMN IF NOT EXISTS\s+platform_fee_basis_points/);
    assert.match(migrationStatements, /ADD COLUMN IF NOT EXISTS\s+commission_override_approval/);
    for (const forbidden of [/DROP TABLE/i, /DROP COLUMN/i, /TRUNCATE/i, /DELETE FROM/i]) {
      assert.equal(
        forbidden.test(migrationStatements), false,
        `3520 must be additive; found ${forbidden}`,
      );
    }
    assert.equal(
      /schema_migration_ledger/.test(migrationStatements), false,
      "a migration must not record its own application",
    );
    // Guarded constraint adds: a second run must not fail on a duplicate name.
    for (const name of ["rbfr_basis_points_range", "rbfr_flat_rate_unless_approved", "rbel_basis_points_range"]) {
      assert.match(
        migrationStatements, new RegExp(`conname\\s*=\\s*'${name}'`),
        `${name} must be added only when absent`,
      );
    }
  });

  it("3520 carries postconditions that can actually fail", () => {
    const raises = migrationStatements.match(/RAISE EXCEPTION/g) ?? [];
    assert.ok(
      raises.length >= 8,
      `expected the postcondition block to be able to fail on every property it states; found ${raises.length} RAISE EXCEPTION`,
    );
    assert.match(
      migrationStatements, /platform_fee_basis_points is nullable/,
      "a schedule row with no rate must be impossible, and the postcondition must say so",
    );
    assert.match(
      migrationStatements, /rbfr_flat_rate_unless_approved is missing/,
      "a CHECK that was never added is the difference between a rule and a comment",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. No market override is approved today
// ═══════════════════════════════════════════════════════════════════════════

describe("market overrides are permitted only when separately approved", () => {
  it("the CHECK makes an unapproved off-flat rate unwritable", () => {
    const at = migrationStatements.indexOf("CONSTRAINT rbfr_flat_rate_unless_approved");
    assert.notEqual(at, -1, "the constraint must exist");
    const body = migrationStatements.slice(at, at + 400);
    assert.match(body, /platform_fee_basis_points\s*=\s*1000/);
    assert.match(body, /commission_override_approval IS NOT NULL/);
  });

  it("the migration asserts that NO row carries an approval", () => {
    assert.match(
      migrationStatements,
      /commission_override_approval IS NOT NULL\)\s*\n?\s*INTO|count\(\*\) FILTER \(WHERE commission_override_approval IS NOT NULL\)/,
      "the migration must COUNT approvals so it can refuse to be the thing that grants one",
    );
    assert.match(
      migrationStatements, /No market override is approved as of 2026-10-04/,
      "and say so in the failure, so a future reader knows the baseline",
    );
  });

  it("no route writes commission_override_approval — only a migration can", () => {
    const files = walk(join(SRC, "lib")).concat(walk(join(SRC, "routes")), walk(join(SRC, "services")));
    assert.ok(files.length > 50, `expected to scan lib + routes + services, found ${files.length}`);
    const writers = files
      .filter((f) => {
        const src = stripComments(readFileSync(f, "utf8"));
        // A WRITE is the column name appearing as an object key in a payload.
        return /commission_override_approval\s*:/.test(src);
      })
      .map((f) => relative(SRC, f));
    assert.deepEqual(
      writers, [],
      "approving a market override must be a reviewed migration, not a route. " +
      "A handler that can set this column can approve its own override.",
    );
  });

  it("the resolver refuses an off-flat rate with no approval, even without the CHECK", async () => {
    const res = await resolveFeeSchedule(
      feeClient({ row: { platform_fee_basis_points: 1500, commission_override_approval: null } }),
      "pro",
    );
    assert.equal(res.status, "read_failed", "an unapproved override is not a price");
    assert.equal(
      Object.prototype.hasOwnProperty.call(res, "rule"), false,
      "and it must carry no rate at all",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The rounding rule, at its boundary
// ═══════════════════════════════════════════════════════════════════════════

describe("one rounding rule: half-up on the cent, in integer cents", () => {
  it("$0.35 at 1000 basis points is $0.04, not $0.03", () => {
    // THE boundary. $0.35 x 10 % = $0.035 exactly, which rounds up to $0.04.
    // The float spelling this replaced — Math.round(0.35 * 0.1 * 100) / 100 —
    // yields 0.03, because 0.35 * 0.1 is 0.034999999999999996 in IEEE 754.
    assert.equal(applyBasisPoints(0.35, 1000), 0.04);
    assert.notEqual(
      applyBasisPoints(0.35, 1000), 0.03,
      "0.03 is the float answer: one cent, on the half, against the buddy",
    );
    // THE CONTROL. Without this the assertion above could be a tautology — a
    // test of a repair has to show that the thing it replaced was broken.
    assert.equal(
      Math.round(0.35 * 0.1 * 100) / 100, 0.03,
      "the arithmetic this replaced really did answer 0.03",
    );
  });

  it("the divergence is systematic, not one unlucky amount", () => {
    // Every cent amount up to $2,000, both ways. If the two rules differed only
    // on a handful of values the integer form would be a micro-optimisation;
    // the count is what makes it a correctness fix. Both directions are
    // reported so a regression that rounds the OTHER way is also caught.
    const floatRule = (usd: number) => Math.round(usd * 0.1 * 100) / 100;
    let integerHigher = 0;
    let floatHigher = 0;
    for (let cents = 1; cents <= 200_000; cents++) {
      const usd = cents / 100;
      const diff = applyBasisPoints(usd, 1000)! - floatRule(usd);
      if (diff > 1e-12) integerHigher += 1;
      else if (diff < -1e-12) floatHigher += 1;
    }
    assert.ok(
      integerHigher >= 400,
      `the float spelling rounds a half-cent DOWN on ${integerHigher} of 200000 cent amounts; ` +
      "expected the divergence to be systematic (>=400), which is what makes this a money " +
      "bug rather than a micro-optimisation",
    );
    assert.equal(
      floatHigher, 0,
      "half-up never rounds BELOW the float spelling; a non-zero count here means " +
      "the rounding rule has started going the other way on some amounts",
    );
  });

  it("rounds a half cent up and anything under it down", () => {
    assert.equal(applyBasisPoints(0.05, 1000), 0.01, "$0.005 -> $0.01");
    assert.equal(applyBasisPoints(0.04, 1000), 0.00, "$0.004 -> $0.00");
    assert.equal(applyBasisPoints(0.15, 1000), 0.02, "$0.015 -> $0.02");
    assert.equal(applyBasisPoints(0.25, 1000), 0.03, "$0.025 -> $0.03");
  });

  it("is exact on the amounts that have no half cent", () => {
    assert.equal(applyBasisPoints(100, 1000), 10);
    assert.equal(applyBasisPoints(0, 1000), 0);
    assert.equal(applyBasisPoints(33.33, 1000), 3.33);
    assert.equal(applyBasisPoints(99.99, 1000), 10);
    assert.equal(applyBasisPoints(1_000_000, 1000), 100_000);
  });

  it("a 0 % rate costs nothing and a 100 % rate costs everything", () => {
    assert.equal(applyBasisPoints(123.45, 0), 0);
    assert.equal(applyBasisPoints(123.45, BASIS_POINTS_PER_UNIT), 123.45);
  });

  it("agrees with the SQL path's fraction on the same boundary", () => {
    // `rb_buddy_earnings_summary` computes ROUND(total::numeric * rate, 2),
    // and PostgreSQL rounds halves AWAY FROM ZERO on numeric. Amounts here are
    // non-negative, so that is the same rule. This asserts the FRACTION handed
    // to SQL is the exact decimal, which is what makes the two agree — a
    // fraction that arrived as 0.09999999999999999 would not.
    const fraction = basisPointsAsRateFraction(1000);
    assert.equal(JSON.stringify(fraction), "0.1", "SQL must receive an exact numeric");
    assert.equal(JSON.stringify(basisPointsAsRateFraction(1050)), "0.105");
    assert.equal(JSON.stringify(basisPointsAsRateFraction(1)), "0.0001");
  });

  it("the fold over bookings uses the same rule, not a float multiply", () => {
    const folded = foldEarningsRows(
      [
        { id: "a", total_usd: 1.15, deposit_usd: 1.15, cash_balance_usd: 0, status: "completed", booking_date: "2026-03-01" },
      ],
      1000,
      new Date("2026-06-01T00:00:00Z"),
    );
    assert.equal(folded.totalPlatformFeesUsd, 0.12, "the fold must round like the resolver");
    assert.deepEqual(folded.unpriceableBookingIds, []);
  });

  it("a fractional rate is expressible at all, which is the whole point", () => {
    // Unrepresentable in the integer percent column this replaces.
    assert.equal(percentToBasisPoints(10.5), 1050);
    assert.equal(basisPointsToPercent(1050), 10.5);
    assert.equal(applyBasisPoints(200, 1050), 21);
    assert.equal(applyBasisPoints(19.1, 1050), 2.01, "$2.00550 -> $2.01");
  });

  it("refuses a rate that is not a whole number of basis points", () => {
    assert.equal(applyBasisPoints(100, 1000.5), null);
    assert.equal(applyBasisPoints(100, -1), null);
    assert.equal(applyBasisPoints(100, BASIS_POINTS_PER_UNIT + 1), null);
    assert.equal(percentToBasisPoints(10.005), null, "a tenth of a basis point is not a rate");
  });

  it("roundUsd is the same half-up rule for a bare amount", () => {
    assert.equal(roundUsd(0.125), 0.13);
    assert.equal(roundUsd(0.124), 0.12);
    assert.equal(roundUsd(7.000000000000001), 7);
    assert.equal(roundUsd(Number("x")), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. An unreadable fee rule REFUSES
// ═══════════════════════════════════════════════════════════════════════════

describe("an unreadable fee rule refuses — never 0 %, never the flat rate", () => {
  const unreadable: Array<[string, any]> = [
    ["the table errored", { error: { message: "permission denied" } }],
    ["the basis-point column does not exist (3520 unapplied)", {
      error: { message: "column rent_buddy_fee_rules.platform_fee_basis_points does not exist" },
    }],
    ["the row carries no rate", { row: { platform_fee_basis_points: null } }],
    ["the rate is not a number", { row: { platform_fee_basis_points: "ten percent" } }],
    ["the rate is out of range", { row: { platform_fee_basis_points: 20000 } }],
  ];

  for (const [label, opts] of unreadable) {
    it(`refuses when ${label}`, async () => {
      const res = await resolveFeeSchedule(feeClient(opts), "new");
      assert.equal(res.status, "read_failed", `${label} must not resolve`);
      assert.equal(
        Object.prototype.hasOwnProperty.call(res, "rule"), false,
        "a refusal must carry no rate, so no caller can read one off it",
      );
      // The two numbers a lazy fallback would reach for.
      assert.equal(JSON.stringify(res).includes('"platformFeeBasisPoints":0'), false);
      assert.equal(JSON.stringify(res).includes('"platformFeeBasisPoints":1000'), false);
    });
  }

  it("an unreadable BOOKING TOTAL refuses too, rather than pricing it at zero", () => {
    // The other half of the same invariant: the rule resolved, but the amount
    // it would be applied to did not. A zero fee here is a money figure
    // invented from a failed read.
    for (const bad of [Number("x"), Infinity, -0.01]) {
      assert.equal(platformFeeUsdFor(bad, FLAT_RULE), null, `total=${bad} must not price`);
      assert.equal(travelerServiceFeeUsdFor(bad, FLAT_RULE), null);
    }
  });

  it("the fold names the bookings it could not price instead of folding zeros", () => {
    const folded = foldEarningsRows(
      [
        { id: "good", total_usd: 100, deposit_usd: 100, cash_balance_usd: 0, status: "completed", booking_date: "2026-03-01" },
        { id: "bad", total_usd: "not a number", deposit_usd: 0, cash_balance_usd: 0, status: "completed", booking_date: "2026-03-01" },
      ],
      1000,
      new Date("2026-06-01T00:00:00Z"),
    );
    assert.deepEqual(folded.unpriceableBookingIds, ["bad"]);
    assert.equal(folded.totalPlatformFeesUsd, 10, "only the priceable booking contributes a fee");
    assert.equal(
      folded.totalInAppUsd, 100,
      "and the unpriceable one contributes NOTHING, rather than a zero that reads as a fact",
    );
  });

  it("a view of a pre-3520 ledger row publishes its rate, and never invents one", () => {
    const withBps = toLedgerEntryView({ platform_fee_basis_points: 1000, platform_fee_percent: 10 });
    assert.equal(withBps.platformFeeBasisPoints, 1000);
    assert.equal(withBps.platformFeePercent, 10);

    const legacy = toLedgerEntryView({ platform_fee_basis_points: null, platform_fee_percent: 22 });
    assert.equal(legacy.platformFeeBasisPoints, null);
    assert.equal(legacy.platformFeePercent, 22, "the row's own recorded rate, not a derived one");

    const rateless = toLedgerEntryView({});
    assert.equal(rateless.platformFeeBasisPoints, null);
    assert.equal(
      rateless.platformFeePercent, null,
      "a row with no rate publishes no rate — the mobile screen used to render `?? 22` here",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. A tip credits the buddy in full
// ═══════════════════════════════════════════════════════════════════════════

describe("a tip credits the buddy in full — no platform leg, no commission", () => {
  const built = buildBookingEntries({
    bookingId: "bk-tip",
    beneficiaryUserId: "buddy-user-1",
    ruleVersion: RENT_BUDDY_FEE_RULE_VERSION,
    totalUsd: 100,
    tipUsd: 25,
    platformFeeUsd: applyBasisPoints(100, FLAT_COMMISSION_BASIS_POINTS)!,
    travelerServiceFeeUsd: 0,
    collectedMinor: 0,
  });

  it("the entry set builds", () => {
    assert.equal(built.status, "built", JSON.stringify(built));
  });

  it("the tip transaction has exactly two legs, and neither is the platform", () => {
    assert.equal(built.status, "built");
    const tipLegs = built.status === "built"
      ? built.entries.filter((e) => e.entryReason === "tip")
      : [];
    assert.equal(tipLegs.length, 2, "a tip is traveller-receivable -> buddy-payable and nothing else");
    assert.deepEqual(
      tipLegs.map((e) => e.account).sort(),
      ["buddy_payable", "traveler_receivable"],
      "a platform_revenue leg on a tip transaction IS a commission on tips",
    );
    assert.equal(
      tipLegs.some((e) => e.account === "platform_revenue"), false,
    );
    assert.equal(
      tipLegs.find((e) => e.account === "buddy_payable")?.amountMinor,
      toMinor(25),
      "the buddy is credited the whole tip",
    );
  });

  it("the commission base is the booking total, so the tip does not raise the fee", () => {
    assert.equal(built.status, "built");
    const feeLegs = built.status === "built"
      ? built.entries.filter((e) => e.entryReason === "platform_fee")
      : [];
    const platformTake = feeLegs
      .filter((e) => e.account === "platform_revenue")
      .reduce((n, e) => n + e.amountMinor, 0);
    assert.equal(platformTake, toMinor(10), "10 % of the 100 total; the 25 tip is not in the base");
    assert.notEqual(platformTake, toMinor(12.5), "12.50 would be 10 % of total + tip");
  });

  it("the buddy's balance is total + tip - commission", () => {
    assert.equal(built.status, "built");
    const balances = built.status === "built" ? reconstructBalances(built.entries) : null;
    assert.equal(balances!.buddy_payable, toMinor(100 + 25 - 10));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Structure — read as text
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Comments are where a superseded column name is SUPPOSED to appear: the
 * modules explain at length why they no longer read it. The scans below must
 * therefore see code only.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "generated" || name === "__tests__") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("the superseded percent column is not a pricing input", () => {
  it(`the resolver reads ${FEE_SCHEDULE_TABLE}'s basis points and not its percent`, () => {
    const src = stripComments(readFileSync(join(SRC, "lib/rentBuddyFeeSchedule.ts"), "utf8"));
    assert.ok(
      src.includes("platform_fee_basis_points"),
      "the rate of record is the basis-point column",
    );
    assert.equal(
      src.includes("platform_fee_percent"), false,
      "reading the rounded legacy mirror to compute money would reintroduce the " +
      "expressibility defect 3520 removed — an approved 10.5 % would price at 10 % or 11 %",
    );
  });

  it("no module prices from `platformFeePercent` on a resolved rule any more", () => {
    const files = walk(join(SRC, "lib")).concat(walk(join(SRC, "routes")), walk(join(SRC, "services")));
    assert.ok(files.length > 50, `expected a non-trivial scan, found ${files.length} files`);
    const hits = files
      .filter((f) => /rule\.platformFeePercent|\.rule\.platformFeePercent/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f));
    assert.deepEqual(
      hits, [],
      "a FeeScheduleRule no longer carries a percentage; a reference to one is a " +
      "rate being re-derived through a lossy unit",
    );
  });

  it("the admin editor REFUSES a rate other than the flat one", () => {
    // Behavioural, not a source scan. A guard asserted by reading the handler
    // survives being short-circuited: `if (false)` in its place left the
    // source-scan version of this test green, which is what moved the decision
    // into an exported pure function.
    assert.deepEqual(
      judgeFeeRuleUpdate({ buddyLevel: "pro", platformFeeBasisPoints: 1000 }),
      { ok: true, basisPoints: 1000 },
      "the flat rate is writable",
    );

    for (const bps of [0, 900, 1001, 1500, 2500, 10000]) {
      const v = judgeFeeRuleUpdate({ buddyLevel: "pro", platformFeeBasisPoints: bps });
      assert.equal(v.ok, false, `${bps} basis points must be refused from this screen`);
      assert.equal(v.ok === false && v.code, "conflict");
      assert.match(
        v.ok === false ? v.message : "", /separate approval/,
        "and the refusal must say that an override needs separate approval",
      );
    }
  });

  it("the admin editor refuses a rate it cannot read, and refuses the percent field", () => {
    for (const bad of [undefined, null]) {
      const v = judgeFeeRuleUpdate({ buddyLevel: "pro", platformFeeBasisPoints: bad });
      assert.equal(v.ok, false, "a missing rate is not a rate");
      assert.equal(v.ok === false && v.code, "invalid_payload");
    }
    // The old field is NOT silently converted: a client still speaking percent
    // would otherwise keep editing the rate through the lossy integer unit.
    const legacy = judgeFeeRuleUpdate({ buddyLevel: "pro", platformFeePercent: 10 });
    assert.equal(legacy.ok, false);
    assert.match(legacy.ok === false ? legacy.message : "", /percent field is no longer accepted/);

    for (const bad of [1000.5, -1, 10001, "ten", NaN]) {
      const v = judgeFeeRuleUpdate({ buddyLevel: "pro", platformFeeBasisPoints: bad });
      assert.equal(v.ok, false, `${String(bad)} is not a whole number of basis points`);
      assert.equal(v.ok === false && v.code, "invalid_payload");
    }
  });

  it("the admin editor's source still routes through the flat-rate decision", () => {
    const src = stripComments(readFileSync(join(SRC, "routes/rentABuddyMarketplace.ts"), "utf8"));
    assert.ok(
      src.includes("platformFeeBasisPoints"),
      "the editor takes basis points",
    );
    assert.ok(
      src.includes("FLAT_COMMISSION_BASIS_POINTS"),
      "and compares what it is handed against the decided flat rate",
    );
    assert.equal(
      /platformFeePercent\s*\?\?|upd\.platformFeePercent/.test(src), false,
      "accepting the old percent field would let a client keep editing the rate " +
      "through a lossy integer",
    );
  });
});
