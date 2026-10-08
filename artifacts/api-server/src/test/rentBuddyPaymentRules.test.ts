/**
 * The pure rules of the Rent-a-Buddy payment slice: commission (owner: 10% of
 * the pre-tax service price, none on tips, configurable by product and
 * market), the quote's arithmetic, money parsing without floats, the ledger
 * postings' balance and idempotent keys, the refund decision table, and the
 * payout policy's refusal to invent a minimum.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyPaymentRules.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMISSION_RULES, commissionMinor, formatBps, resolveCommission, RAB_SERVICE_PRODUCT, type CommissionRule } from "../services/payments/bookingPayments/commissionPolicy.js";
import { majorDecimalToMinor, quoteBookingCharge } from "../services/payments/bookingPayments/bookingQuote.js";
import { planPaymentPostings, planPayoutPaidPosting, planPayoutReturnedPosting, planChargebackPosting, planProviderFeePosting, postingBalance } from "../services/payments/bookingPayments/ledgerPostings.js";
import { decideRefund } from "../services/payments/bookingPayments/refunds.js";
import { payoutPolicyFromEnv, periodBounds, netForRecipientMinor } from "../services/payments/bookingPayments/payouts.js";
import { createFakeTaxProvider, NONE_TAX_PROVIDER } from "../services/payments/TaxProvider.js";
import type { BookingPaymentRecord } from "../services/payments/bookingPayments/model.js";

const LOCAL = { NODE_TEST_CONTEXT: "child-v8" } as unknown as NodeJS.ProcessEnv; // the test runner: a dev host no longer counts (N-2)

describe("commission policy", () => {
  it("the owner's default is 1000 bps (10%) with a version and a stated source", () => {
    const r = resolveCommission(RAB_SERVICE_PRODUCT, "US");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.bps, 1000);
    assert.match(r.version, /owner-2026-10-04/);
    assert.match(r.source, /10%/);
    assert.equal(COMMISSION_RULES.length, 1, "no regional rate has been decided, so none is configured");
  });

  it("an exact market rule wins over the product default (configurable by market)", () => {
    const rules: CommissionRule[] = [...COMMISSION_RULES, { product: RAB_SERVICE_PRODUCT, market: "GB", bps: 1250, version: "test/gb", source: "test" }];
    const gb = resolveCommission(RAB_SERVICE_PRODUCT, "GB", rules);
    const us = resolveCommission(RAB_SERVICE_PRODUCT, "US", rules);
    assert.equal(gb.ok && gb.bps, 1250);
    assert.equal(us.ok && us.bps, 1000);
  });

  it("no rule, or an invalid rule, is a refusal — never a default number", () => {
    assert.deepEqual(resolveCommission(RAB_SERVICE_PRODUCT, "US", []).ok, false);
    const bad: CommissionRule[] = [{ product: RAB_SERVICE_PRODUCT, market: "*", bps: 10.5, version: "x", source: "x" }];
    assert.equal(resolveCommission(RAB_SERVICE_PRODUCT, "US", bad).ok, false);
  });

  it("commission is floor(service × bps / 10000) in integers; seller gets the remainder", () => {
    assert.equal(commissionMinor(4000, 1000), 400);
    assert.equal(commissionMinor(4999, 1000), 499);
    assert.equal(commissionMinor(0, 1000), 0);
    assert.equal(commissionMinor(Number.MAX_SAFE_INTEGER, 1000), Math.floor(Number.MAX_SAFE_INTEGER / 10));
    assert.throws(() => commissionMinor(-1, 1000));
    assert.throws(() => commissionMinor(10, 10001));
  });

  it("formatBps renders for display only", () => {
    assert.equal(formatBps(1000), "10%");
    assert.equal(formatBps(1250), "12.5%");
    assert.equal(formatBps(1205), "12.05%");
  });
});

describe("quote", () => {
  const tax = createFakeTaxProvider({ env: LOCAL });

  it("an unconfigured tax market is tax_not_configured, never a zero tax", async () => {
    const r = await quoteBookingCharge({ serviceMinor: 4000, tipMinor: 0, currency: "USD", buyerMarket: "FR", sellerMarket: "FR" }, tax);
    assert.deepEqual(r.ok ? null : r.reason, "tax_not_configured");
    const none = await quoteBookingCharge({ serviceMinor: 4000, tipMinor: 0, currency: "USD", buyerMarket: "US", sellerMarket: "US" }, NONE_TAX_PROVIDER);
    assert.deepEqual(none.ok ? null : none.reason, "tax_not_configured");
  });

  it("components sum to the total; platform fee = commission + platform-remitted tax; payer fee 0; no deposit field", async () => {
    const r = await quoteBookingCharge({ serviceMinor: 4000, tipMinor: 500, currency: "USD", buyerMarket: "US", sellerMarket: "US" }, tax);
    assert.ok(r.ok);
    if (!r.ok) return;
    const c = r.quote.components;
    assert.equal(c.serviceMinor + c.payerFeeMinor + c.tipMinor + c.taxMinor, r.quote.amount.amountMinor);
    assert.equal(r.quote.platformFee.commissionMinor, 400, "the tip adds nothing to the commission");
    assert.equal(r.quote.platformFee.payerFeeMinor, 0);
    assert.equal(r.quote.platformFee.taxMinor, 400, "fake US tax is platform-remitted");
    assert.equal("deposit" in r.quote, false);
  });

  it("a seller-remitted tax (fake GB) is NOT part of the platform fee", async () => {
    const r = await quoteBookingCharge({ serviceMinor: 4000, tipMinor: 0, currency: "GBP", buyerMarket: "GB", sellerMarket: "GB" }, tax);
    assert.ok(r.ok);
    if (r.ok) { assert.equal(r.quote.components.taxMinor, 800); assert.equal(r.quote.platformFee.taxMinor, 0); }
  });

  it("refuses a zero or fractional price and malformed markets", async () => {
    for (const bad of [
      { serviceMinor: 0, tipMinor: 0, currency: "USD", buyerMarket: "US", sellerMarket: "US" },
      { serviceMinor: 10.5, tipMinor: 0, currency: "USD", buyerMarket: "US", sellerMarket: "US" },
      { serviceMinor: 100, tipMinor: 0, currency: "usd", buyerMarket: "US", sellerMarket: "US" },
      { serviceMinor: 100, tipMinor: 0, currency: "USD", buyerMarket: "USA", sellerMarket: "US" },
    ]) assert.equal((await quoteBookingCharge(bad, tax)).ok, false, JSON.stringify(bad));
  });
});

describe("majorDecimalToMinor: no float touches money", () => {
  it("parses numeric(10,2) text and numbers exactly", () => {
    assert.equal(majorDecimalToMinor("40.00"), 4000);
    assert.equal(majorDecimalToMinor("40.1"), 4010);
    assert.equal(majorDecimalToMinor(40), 4000);
    assert.equal(majorDecimalToMinor("0.29"), 29, "0.29 * 100 is 28.999999999999996 in floating point");
    assert.equal(majorDecimalToMinor("40.000"), 4000);
  });
  it("refuses anything that is not a non-negative amount with at most two decimals", () => {
    for (const bad of ["-1", "1.234", "abc", "", null, undefined, NaN, "1e3"]) assert.equal(majorDecimalToMinor(bad as unknown), null, String(bad));
  });
});

const payment = (o: Partial<BookingPaymentRecord> = {}): BookingPaymentRecord => ({
  id: "pay-1", bookingId: "b", attemptNo: 1, provider: "fake", idempotencyKey: "k", intentRef: "pi", recipientRef: "acct", recipientPartyId: "party-7a1",
  chargeModel: "direct", state: "succeeded", intentState: "succeeded",
  amount: { amountMinor: 5400, currency: "USD" }, components: { serviceMinor: 4000, payerFeeMinor: 0, tipMinor: 1000, taxMinor: 400 },
  platformFee: { commissionMinor: 400, payerFeeMinor: 0, taxMinor: 400 }, commissionBps: 1000, commissionRuleVersion: "v",
  taxProvider: "fake", taxCalculationRefs: [], buyerMarket: "US", sellerMarket: "US",
  amountCapturedMinor: 0, amountRefundedMinor: 0, platformFeeCollectedMinor: 0, platformFeeRefundedMinor: 0,
  settlement: null, lastSnapshot: null, failureReason: null, providerCancelOwed: false, payoutId: null, createdAt: "t", updatedAt: "t", ...o,
});
const zero = { capturedMinor: 0, refundedMinor: 0, feeCollectedMinor: 0, feeRefundedMinor: 0 };

describe("ledger postings", () => {
  it("a capture balances, splits tip from principal, and puts the fee on the platform's clearing", () => {
    const [p] = planPaymentPostings(payment(), zero, { ...zero, capturedMinor: 5400, feeCollectedMinor: 800 }, "t");
    assert.ok(p);
    assert.equal(postingBalance(p!), 0);
    const by = (acct: string, reason: string) => p!.entries.find((e) => e.account === acct && e.reason === reason)?.amountMinor;
    assert.equal(by("user_payable", "tip"), -1000, "the whole tip is the buddy's");
    assert.equal(by("user_payable", "principal"), -3600);
    assert.equal(by("platform_revenue", "platform_fee"), -400);
    assert.equal(by("tax_withheld", "tax"), -400);
    assert.equal(by("processor_clearing", "principal"), 5400, "the processor holds the whole charge");
  });

  it("the same counters plan the same key and entries (idempotent); a falling counter plans the exact reversal", () => {
    const next = { ...zero, capturedMinor: 5400, feeCollectedMinor: 800, refundedMinor: 1000, feeRefundedMinor: 100 };
    const a = planPaymentPostings(payment(), zero, next, "t1");
    const b = planPaymentPostings(payment(), zero, next, "t2");
    assert.deepEqual(a.map((x) => [x.key, x.entries]), b.map((x) => [x.key, x.entries]));
    const fell = planPaymentPostings(payment(), next, { ...next, refundedMinor: 0, feeRefundedMinor: 0 }, "t3");
    assert.equal(fell.length, 1);
    const refund = a.find((x) => x.kind === "refund")!;
    assert.deepEqual(fell[0]!.entries.map((e) => e.amountMinor).sort(), refund.entries.map((e) => -e.amountMinor).sort());
    for (const x of [...a, ...fell]) assert.equal(postingBalance(x), 0);
  });

  it("nothing changed -> nothing planned", () => {
    assert.deepEqual(planPaymentPostings(payment(), zero, zero, "t"), []);
    assert.equal(planProviderFeePosting(payment(), 30, 30, "t"), null);
  });

  it("payout paid / returned / chargeback / provider fee all balance, and keys name things, not people", () => {
    const po = { id: "po-1", recipientPartyId: "party-7a1", provider: "fake", payoutRef: "po_000001", currency: "USD", amountMinor: 3600 };
    for (const x of [planPayoutPaidPosting(po, "t"), planPayoutReturnedPosting(po, "t"), planChargebackPosting(payment(), "dp_1", 5400, "t"), planProviderFeePosting(payment(), 0, 160, "t")!]) {
      assert.equal(postingBalance(x), 0, x.key);
      assert.doesNotMatch(x.key, /party-7a1/, "no person (nor their party) in a ledger key");
    }
  });
});

describe("refund decisions (owner 2026-10-04, 'Refunds')", () => {
  const booking = { startsAt: "2026-08-20T15:00:00.000Z" };
  const paid = { amountCapturedMinor: 4400, amountRefundedMinor: 0 };
  const before = new Date("2026-08-19T00:00:00.000Z");
  const after = new Date("2026-08-20T15:00:00.000Z");

  it("full + fee refunded for: buddy cancels, service unavailable, safety upheld, cancelled before start", () => {
    for (const [trigger, role] of [["provider_cancelled", "buddy"], ["service_unavailable", "admin"], ["safety_issue_upheld", "admin"], ["cancelled_before_service", "traveler"]] as const) {
      const d = decideRefund({ trigger, role, booking, payment: paid, now: before });
      assert.deepEqual(d.ok && [d.amount, d.refundPlatformFee], ["full", true], trigger);
    }
  });

  it("at or after the start time, 'cancelled before service' is refused to support; an unknown start is support too", () => {
    const d = decideRefund({ trigger: "cancelled_before_service", role: "traveler", booking, payment: paid, now: after });
    assert.equal(!d.ok && d.error, "service_already_started");
    const u = decideRefund({ trigger: "cancelled_before_service", role: "traveler", booking: { startsAt: null }, payment: paid, now: before });
    assert.equal(!u.ok && u.error, "contact_support");
  });

  it("roles are enforced: a traveller cannot claim the buddy cancelled or a safety upheld", () => {
    assert.equal(decideRefund({ trigger: "provider_cancelled", role: "traveler", booking, payment: paid, now: before }).ok, false);
    assert.equal(decideRefund({ trigger: "safety_issue_upheld", role: "buddy", booking, payment: paid, now: before }).ok, false);
    assert.equal(decideRefund({ trigger: "support_decision", role: "traveler", booking, payment: paid, now: before, amountMinor: 10 }).ok, false);
  });

  it("support decides an amount within what remains refundable; the fee is refunded in proportion", () => {
    const d = decideRefund({ trigger: "support_decision", role: "admin", booking, payment: paid, now: after, amountMinor: 1000 });
    assert.deepEqual(d.ok && [d.amount, d.refundPlatformFee], [1000, true]);
    assert.equal(decideRefund({ trigger: "support_decision", role: "admin", booking, payment: paid, now: after, amountMinor: 5000 }).ok, false);
    assert.equal(decideRefund({ trigger: "support_decision", role: "admin", booking, payment: paid, now: after }).ok, false);
  });

  it("nothing left to refund is refused", () => {
    assert.equal(decideRefund({ trigger: "provider_cancelled", role: "admin", booking, payment: { amountCapturedMinor: 4400, amountRefundedMinor: 4400 }, now: before }).ok, false);
  });
});

describe("payout policy", () => {
  it("minimums come only from configuration; malformed or absent tokens configure nothing", () => {
    assert.deepEqual(payoutPolicyFromEnv({} as NodeJS.ProcessEnv).minimumByCurrency, {});
    assert.deepEqual(payoutPolicyFromEnv({ RAB_PAYOUT_MINIMUMS: "USD:2500, GBP:2000,eur:5,JPY:-1,XXX" } as unknown as NodeJS.ProcessEnv).minimumByCurrency, { USD: 2500, GBP: 2000 });
  });
  it("periods are calendar months in UTC", () => {
    assert.deepEqual(periodBounds("2026-08")?.endExclusive.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(periodBounds("2026-13"), null);
    assert.equal(periodBounds("2026-8"), null);
  });
  it("the buddy's net excludes the platform fee, refunds net of fee refunds, and a provider fee they paid", () => {
    assert.equal(netForRecipientMinor(payment({ amountCapturedMinor: 5400, platformFeeCollectedMinor: 800 })), 4600);
    assert.equal(netForRecipientMinor(payment({ amountCapturedMinor: 5400, platformFeeCollectedMinor: 800, amountRefundedMinor: 1000, platformFeeRefundedMinor: 100 })), 3700);
    assert.equal(netForRecipientMinor(payment({
      amountCapturedMinor: 5400, platformFeeCollectedMinor: 800,
      settlement: { settled: { amountMinor: 4440, currency: "USD" }, conversion: null, providerFee: { amount: { amountMinor: 160, currency: "USD" }, paidBy: "recipient" }, platformFeeSettled: null },
    })), 4440);
  });
});
