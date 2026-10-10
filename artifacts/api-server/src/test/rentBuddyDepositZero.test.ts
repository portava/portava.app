/**
 * The booking deposit is ZERO, on every path, unconditionally.
 *
 * ── THE DECISION THIS PINS (owner, 2026-10-04) ──────────────────────────────
 *   "Set the booking deposit to 0% for the first release. Remove the shipped
 *    30% default."
 *
 * ── WHAT "REMOVE" HAD TO MEAN ───────────────────────────────────────────────
 * Two independent deposit computations shipped, and the decision names one of
 * them. The other was a six-rule ladder in `PricingService.calculateDeposit`
 * producing 20 / 25 / 35 / 40 %. Both are deleted. The deposit CONCEPT survives
 * because it cannot be removed additively and because `deposit_usd` is also the
 * in-app leg of a fully prepaid booking (`foldEarningsRows` reads it as `inApp`,
 * and so does `rb_buddy_earnings_summary`), so what is asserted here is that
 * the only two answers any path can give are:
 *
 *   NOTHING UP FRONT  — deposit 0, the whole amount settled with the buddy; or
 *   FULL PREPAYMENT   — the whole price in app, no balance due later.
 *
 * A FRACTION of the total charged up front IS a deposit, and no input produces
 * one. That is the property, and it is quantified over the whole input space
 * below rather than sampled.
 *
 * ── AND IT CANNOT COME BACK ─────────────────────────────────────────────────
 * The last suite reads the two source files as TEXT. A percentage that one
 * careless edit can re-add is not a removed percentage, and the repo asserts
 * deleted money literals against the source elsewhere for exactly this reason
 * (`rentBuddyFeeSchedule.test.ts`' "one take rate, one reader").
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyDepositZero.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPOSIT_RULES_APPLIED,
  IN_APP_SHARE_PERCENT,
  calculateDeposit,
  splitBookingPayment,
  type DepositCalculationInput,
} from "../services/rentBuddy/PricingService.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const PRICING_SERVICE = "services/rentBuddy/PricingService.ts";
const BOOKING_ROUTE = "routes/rentABuddy.ts";
const MARKETPLACE_ROUTE = "routes/rentABuddyMarketplace.ts";

/** Comments are where a deleted literal is SUPPOSED to appear, by name. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");
}

/** Every combination of the five booleans `calculateDeposit` still reads. */
function everyInput(totalUsd: number): DepositCalculationInput[] {
  const out: DepositCalculationInput[] = [];
  for (let mask = 0; mask < 32; mask++) {
    out.push({
      cashBalanceDisabled: Boolean(mask & 1),
      fullInAppRequired: Boolean(mask & 2),
      disableDepositCash: Boolean(mask & 4),
      buddyCashBalanceAccepted: Boolean(mask & 8),
      riskHold: Boolean(mask & 16),
      totalUsd,
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. No fractional deposit exists, for any input
// ═══════════════════════════════════════════════════════════════════════════

describe("no booking path charges a deposit", () => {
  it("exhaustively: every input yields either nothing up front or the full price", () => {
    // 32 input combinations x 6 totals. The old ladder had SIX rules keyed on
    // category, pricing type, buddy level, group size and traveller history —
    // inputs that no longer exist — so sweeping the booleans that remain is
    // sweeping the whole decision space.
    for (const total of [0, 0.35, 12.5, 100, 1999.99, 100000]) {
      for (const input of everyInput(total)) {
        const r = calculateDeposit(input);
        const label = JSON.stringify(input);

        assert.ok(
          r.depositUsd === 0 || r.depositUsd === total,
          `${label}: depositUsd=${r.depositUsd} is a FRACTION of ${total}, i.e. a deposit`,
        );
        assert.ok(
          r.depositPercent === 0 || r.depositPercent === 100,
          `${label}: depositPercent=${r.depositPercent}; only 0 (cash) and 100 (full prepayment) exist`,
        );
        assert.equal(
          r.depositUsd + r.cashBalanceDue, total,
          `${label}: the two legs must account for the whole price exactly`,
        );
        // The specific fractions the deleted ladder and the deleted 30 %
        // literal would have produced, named so a regression is legible.
        for (const gone of [20, 25, 30, 35, 40]) {
          assert.notEqual(
            r.depositPercent, gone,
            `${label}: ${gone}% is a deleted deposit rate and must not reappear`,
          );
        }
      }
    }
  });

  it("a cash booking takes NOTHING up front", () => {
    const r = calculateDeposit({
      cashBalanceDisabled: false,
      fullInAppRequired: false,
      disableDepositCash: false,
      buddyCashBalanceAccepted: true,
      riskHold: false,
      totalUsd: 200,
    });
    assert.equal(r.depositUsd, 0, "this is the 0 % deposit");
    assert.equal(r.cashBalanceDue, 200);
    assert.equal(r.paymentMode, "deposit_plus_cash");
    assert.equal(r.depositPercent, 0);
    assert.equal(r.isFullInApp, false);
    assert.equal(r.depositRuleApplied, "no_deposit_first_release");
    assert.match(r.depositReason, /No deposit/i);
    // The old behaviour, named: a 30 % literal would have made this 60.00.
    assert.notEqual(r.depositUsd, 60, "60.00 is 30 % of 200 — the deleted literal");
  });

  it("a prepaid booking charges the whole price, which is not a deposit", () => {
    for (const [field, rule] of [
      ["riskHold", "risk_hold"],
      ["cashBalanceDisabled", "admin_full_in_app"],
      ["fullInAppRequired", "admin_full_in_app"],
      ["disableDepositCash", "cash_not_accepted"],
    ] as const) {
      const r = calculateDeposit({
        cashBalanceDisabled: false,
        fullInAppRequired: false,
        disableDepositCash: false,
        buddyCashBalanceAccepted: true,
        riskHold: false,
        totalUsd: 200,
        [field]: true,
      } as DepositCalculationInput);
      assert.equal(r.depositUsd, 200, `${field}: the whole price, not a part of it`);
      assert.equal(r.cashBalanceDue, 0, `${field}: nothing is due later, so nothing was held back`);
      assert.equal(r.paymentMode, "full_in_app");
      assert.equal(r.depositPercent, 100);
      assert.equal(r.depositRuleApplied, rule);
    }
  });

  it("a buddy who does not accept cash gets full prepayment, not a part-payment", () => {
    const r = calculateDeposit({
      cashBalanceDisabled: false,
      fullInAppRequired: false,
      disableDepositCash: false,
      buddyCashBalanceAccepted: false,
      riskHold: false,
      totalUsd: 150,
    });
    assert.equal(r.depositUsd, 150);
    assert.equal(r.cashBalanceDue, 0);
    assert.equal(r.paymentMode, "full_in_app");
    assert.equal(r.depositRuleApplied, "cash_not_accepted");
  });

  it("the vocabulary of deposit rules holds no rate at all", () => {
    for (const rule of DEPOSIT_RULES_APPLIED) {
      assert.equal(
        /\d/.test(rule), false,
        `'${rule}' carries a number; a rule name that states a rate is a rate`,
      );
    }
    assert.deepEqual(IN_APP_SHARE_PERCENT, { none: 0, full: 100 });
  });

  it("the split itself is the one place the two legs are decided", () => {
    assert.deepEqual(splitBookingPayment(200, "none"), { depositUsd: 0, cashBalanceUsd: 200 });
    assert.deepEqual(splitBookingPayment(200, "full"), { depositUsd: 200, cashBalanceUsd: 0 });
    assert.deepEqual(splitBookingPayment(0, "none"), { depositUsd: 0, cashBalanceUsd: 0 });
    // Rounds to the cent, so an hourly rate times a fractional duration cannot
    // leave a sub-cent residue on a money column.
    assert.deepEqual(
      splitBookingPayment(33.333, "none"),
      { depositUsd: 0, cashBalanceUsd: 33.33 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The deleted percentages cannot reappear — read as source
// ═══════════════════════════════════════════════════════════════════════════

describe("a 30 % deposit cannot reappear", () => {
  it("the booking route holds no deposit fraction of the total", () => {
    const src = stripComments(read(BOOKING_ROUTE));
    // The exact shape that shipped: `totalUsd * 0.3`, in any spelling of the
    // fraction and with or without the cent rounding around it.
    assert.equal(
      /total\w*\s*\*\s*0?\.3/i.test(src), false,
      "the 30 % deposit literal is back in routes/rentABuddy.ts",
    );
    for (const frac of ["0.2", "0.25", "0.3", "0.35", "0.4"]) {
      assert.equal(
        new RegExp(`total\\w*\\s*\\*\\s*${frac.replace(".", "\\.")}\\b`, "i").test(src), false,
        `a ${frac} fraction of a booking total is a deposit rate`,
      );
    }
  });

  it("PricingService computes no deposit percentage at all", () => {
    const src = stripComments(read(PRICING_SERVICE));
    // The ladder's assignments, in the spelling it used.
    assert.equal(
      /depositPercent\s*=\s*\d/.test(src), false,
      "a numeric assignment to depositPercent is the ladder growing back",
    );
    assert.equal(
      /Math\.max\(\s*depositPercent/.test(src), false,
      "the ladder's floors (`Math.max(depositPercent, 35)`) must not return",
    );
    assert.equal(
      /totalUsd\s*\*\s*depositPercent/.test(src), false,
      "a deposit computed as a percentage of the total is the thing that was removed",
    );
    // Scoped to the calculator's own body: 'arrival' and 'nightlife' are also
    // CATEGORY names in getPricingSuggestion, which is a suggested price range
    // shown to a buddy and never a deposit.
    const at = src.indexOf("export function calculateDeposit");
    assert.notEqual(at, -1, "calculateDeposit must still exist");
    const body = src.slice(at);
    for (const gone of ["arrival", "nightlife", "repeat_trusted", "new_traveler", "limited_history", "new_buddy", "group", "content"]) {
      assert.equal(
        body.includes(`'${gone}'`), false,
        `the '${gone}' deposit rule is back; each one carried its own percentage`,
      );
    }
    assert.equal(
      /\b(20|25|30|35|40)\b/.test(body), false,
      "calculateDeposit must contain no deposit percentage at all",
    );
  });

  it("the deposit calculator can no longer SEE the ladder's inputs", () => {
    // The strongest form of "it cannot come back": the category, the buddy
    // level and the traveller's history are not parameters any more, so
    // re-deriving a deposit from them means re-adding a parameter and saying
    // why. A field left in place but unread is a decoy — the next reader
    // believes a nightlife booking is priced differently because the call site
    // still says so.
    const src = stripComments(read(PRICING_SERVICE));
    const at = src.indexOf("interface DepositCalculationInput");
    assert.notEqual(at, -1);
    const body = src.slice(at, src.indexOf("}", at));
    for (const gone of ["category", "pricingType", "buddyLevel", "travelerCompletedBookings", "isGroupBooking", "travelerId"]) {
      assert.equal(
        new RegExp(`\\b${gone}\\b`).test(body), false,
        `${gone} is back in DepositCalculationInput, and it only ever fed the deposit ladder`,
      );
    }
  });

  it("no booking-creation path writes a deposit it computed itself", () => {
    // Every path goes through the shared split or the calculator that calls it,
    // so the three columns cannot disagree between paths. A path assembling
    // `deposit_usd` from its own arithmetic is how the 30 % literal survived
    // the existence of `deposit_percent` columns in the first place.
    for (const rel of [BOOKING_ROUTE, MARKETPLACE_ROUTE]) {
      const src = stripComments(read(rel));
      assert.ok(
        src.includes("splitBookingPayment") || src.includes("calculateDeposit"),
        `${rel} must derive the split from the shared decision`,
      );
    }
    const booking = stripComments(read(BOOKING_ROUTE));
    assert.ok(
      booking.includes("splitBookingPayment"),
      "the canonical booking route is the path the 30 % literal lived on",
    );
  });

  it("the launch-control deposit floor no longer defaults to 30", () => {
    const src = stripComments(read(BOOKING_ROUTE));
    assert.equal(
      /minDepositPct\s*=\s*30/.test(src), false,
      "an admin who omits the field used to ship a 30 % floor",
    );
    assert.match(src, /minDepositPct\s*=\s*0/);
  });

  it("an experience created without a deposit does not advertise one", () => {
    const src = stripComments(read(MARKETPLACE_ROUTE));
    assert.equal(
      /deposit_percent:\s*depositPercent\s*\?\?\s*(?!0)\d/.test(src), false,
      "a non-zero default told travellers a deposit was required on a booking that charges none",
    );
    assert.match(src, /deposit_percent:\s*depositPercent\s*\?\?\s*0/);
    assert.match(src, /deposit_required:\s*depositRequired\s*\?\?\s*false/);
  });

  it("the one path that can charge (lane B's checkout, #640) charges only a FULL prepayment: every 'nothing up front' answer is refused, and nothing is created", async () => {
    // RE-READ AFTER #640 (verifier 2026-10-08). This used to assert only that the
    // strings `pay-deposit` and `payment_stub` appear in routes/rentABuddy.ts, and
    // said itself that the deposit decision must be re-read "if either stub ever
    // starts doing something". Lane B's checkout now exists (behind
    // rent_buddy_enabled and an operational PAYMENT_PROVIDER), so the property is
    // checked against IT, over calculateDeposit's whole decision space: the
    // booking's payment_mode is what calculateDeposit chose, and the real
    // quote/checkout functions are asked to charge it.
    //   deposit 0 ("nothing up front", cash with the buddy) -> deposit_plus_cash ->
    //     409 payment_not_in_app from quote AND checkout; no payment row.
    //   the full price in app -> full_in_app -> passes the mode check (it then
    //     stops at the next gate, the buddy's unready payment account).
    // OWNER QUESTION, recorded not decided (lane P, 2026-10-08): so a cash-accepting
    // buddy's booking is settled entirely in cash and no commission is collected on it.
    const { quoteBookingPayment, startBookingCheckout } = await import("../services/payments/bookingPayments/checkout.js");
    const { createMemoryStore } = await import("./helpers/memoryBookingPayments.js");
    let cash = 0;
    let full = 0;
    for (const input of everyInput(40)) {
      const r = calculateDeposit(input);
      const label = JSON.stringify(input);
      const store = createMemoryStore();
      store.bookings.set("b-1", {
        bookingId: "b-1", status: "confirmed", paymentStatus: "not_required", travelerId: "t-1",
        buddyProfileId: "bp-1", buddyUserId: "u-b", serviceCountry: "US", serviceMinor: 4000, currency: "USD",
        startsAt: "2026-08-20T15:00:00.000Z", startBasis: "city_timezone", completedAt: null,
        disputeWindowExpiresAt: null, isTestBooking: false, paymentMode: r.paymentMode,
      });
      const deps = { store, paymentsOperational: () => ({ operational: true, reason: "test" }) } as unknown as Parameters<typeof quoteBookingPayment>[0]; // the two the mode check reaches
      const q = await quoteBookingPayment(deps, { bookingId: "b-1", actorUserId: "t-1" });
      if (r.depositUsd === 0) {
        cash++;
        assert.equal(r.paymentMode, "deposit_plus_cash", label);
        assert.equal(q.httpStatus, 409, `${label}: ${JSON.stringify(q.body)}`);
        assert.equal(q.body["error"], "payment_not_in_app", label);
        const c = await startBookingCheckout(deps, { bookingId: "b-1", actorUserId: "t-1" });
        assert.equal(c.body["error"], "payment_not_in_app", label);
        assert.equal(store.payments.size, 0, `${label}: no payment row for a cash booking`);
      } else {
        full++;
        assert.equal(r.paymentMode, "full_in_app", label);
        assert.equal(r.depositUsd, 40, `${label}: the in-app leg is the whole price`);
        assert.notEqual(q.body["error"], "payment_not_in_app", `${label}: a full prepayment passes the mode check`);
        assert.equal(q.body["error"], "buddy_payments_not_ready", `${label}: …and stops at the next gate`);
      }
    }
    assert.ok(cash > 0 && full > 0, `both answers are reachable (cash ${cash}, full ${full})`);
  });
});
