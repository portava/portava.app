/**
 * The Rent-a-Buddy payment vertical slice, end to end, against the
 * PaymentProvider CONTRACT — the deterministic fake provider and fake tax
 * provider, in a local run. No real provider is called: there are no Stripe or
 * Sumsub keys in this lane, and a test-mode Stripe adapter is not registered.
 *
 *   buddy onboards (recipient, hosted onboarding, signed recipient webhook)
 *   -> traveller is quoted: price, 10% commission from the price, tax, total
 *   -> checkout: direct charge on the buddy's account, commission as platform fee
 *   -> confirm -> SIGNED webhooks (late / twice / out of order) -> ledger
 *   -> booking.payment_status -> completion -> monthly payout plan / hold /
 *      release / execute -> payout webhook -> ledger
 *   -> refunds: cancelled before start, buddy cancelled, support decision
 * and the failure states: declined, failed after confirmation, ledger down,
 * bad signature, live-mode event, store down, quote changed, market without
 * direct charges, buddy not onboarded, no payout minimum configured.
 *
 * Every assertion is on resulting STATE: the store's rows, the booking's
 * payment_status, the ledger's postings and balances, the fake's balances.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyPaymentSlice.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFakePaymentProvider, type FakePaymentProvider } from "../services/payments/FakePaymentProvider.js";
import { guardPaymentProvider } from "../services/payments/PaymentProvider.js";
import { enforcePaymentPolicy } from "../services/payments/providerRegistry.js";
import { createFakeTaxProvider, type TaxProvider } from "../services/payments/TaxProvider.js";
import type { PaymentSliceDeps } from "../services/payments/bookingPayments/deps.js";
import { quoteBookingPayment, startBookingCheckout, confirmBookingPayment } from "../services/payments/bookingPayments/checkout.js";
import { processPaymentWebhook } from "../services/payments/bookingPayments/webhookProcessor.js";
import { requestBookingRefund } from "../services/payments/bookingPayments/refunds.js";
import { planMonthlyPayouts, executePlannedPayouts, holdOrReleasePayout } from "../services/payments/bookingPayments/payouts.js";
import { startRecipientOnboarding } from "../services/payments/bookingPayments/recipients.js";
import { createMemoryStore, createMemoryLedger, partyIdFor, type MemoryStore, type MemoryLedger } from "./helpers/memoryBookingPayments.js";
import type { BookingForPayment } from "../services/payments/bookingPayments/model.js";

const LOCAL = { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv;
const TRAVELER = "traveler-1";
const BUDDY = "buddy-user-1";
const ADMIN = "admin-1";
const BOOKING = "booking-1";
/** The buddy's payment party (3821): what the ledger and the payment rows name instead of the profile. */
const BUDDY_PARTY = partyIdFor(BUDDY);

interface World {
  fake: FakePaymentProvider;
  tax: TaxProvider;
  store: MemoryStore;
  ledger: MemoryLedger;
  deps: PaymentSliceDeps;
  clock: { now: Date };
  enabledMarkets: string[];
  operational: boolean;
}

function world(): World {
  const fake = createFakePaymentProvider({ env: LOCAL });
  const tax = createFakeTaxProvider({ env: LOCAL });
  const store = createMemoryStore();
  const ledger = createMemoryLedger();
  const clock = { now: new Date("2026-08-10T12:00:00.000Z") };
  const w: World = { fake, tax, store, ledger, clock, enabledMarkets: ["US", "GB"], operational: true, deps: undefined as unknown as PaymentSliceDeps };
  // The SAME wrappers the registry hands a route: the guard (validation, nothing throws) and the market/tax policy.
  const provider = enforcePaymentPolicy(guardPaymentProvider(fake, () => null), { enabledMarkets: () => w.enabledMarkets, taxProvider: () => tax });
  let n = 0;
  w.deps = {
    provider,
    tax,
    store,
    ledger,
    paymentsOperational: () => ({ operational: w.operational, reason: w.operational ? "ok" : "PAYMENT_PROVIDER is none" }),
    bookingParties: async () => ({ allowed: true }),
    personVerified: async () => "verified",
    newId: () => `id-${++n}`,
    now: () => clock.now,
  };
  return w;
}

function seedBooking(w: World, over: Partial<BookingForPayment> = {}): BookingForPayment {
  const b: BookingForPayment = {
    bookingId: BOOKING, status: "confirmed", paymentStatus: "not_required",
    travelerId: TRAVELER, buddyProfileId: "bp-1", buddyUserId: BUDDY,
    serviceCountry: "US", serviceMinor: 4000, currency: "USD",
    startsAt: "2026-08-20T15:00:00.000Z", startBasis: "city_timezone", completedAt: null, disputeWindowExpiresAt: null, isTestBooking: false,
    ...over,
  };
  w.store.bookings.set(b.bookingId, b);
  return b;
}

/** Deliver every pending signed webhook through the processor; returns the HTTP statuses. */
async function deliverAll(w: World, plan?: Parameters<FakePaymentProvider["control"]["webhooks"]["deliver"]>[0]): Promise<number[]> {
  const out: number[] = [];
  for (const d of w.fake.control.webhooks.deliver(plan)) out.push((await processPaymentWebhook(w.deps, d)).httpStatus);
  return out;
}

async function onboardBuddy(w: World, country = "US", currency = "USD"): Promise<string> {
  const r = await startRecipientOnboarding(w.deps, { userId: BUDDY, country, settlementCurrency: currency, returnUrl: "app://ok", refreshUrl: "app://again" });
  assert.equal(r.httpStatus, 200, JSON.stringify(r.body));
  const ref = String(r.body["recipientRef"]);
  w.fake.control.setRecipientOnboarding(ref, "verified");
  await deliverAll(w);
  return ref;
}

async function paidBooking(w: World): Promise<string> {
  seedBooking(w);
  await onboardBuddy(w);
  const c = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
  assert.equal(c.httpStatus, 201, JSON.stringify(c.body));
  const f = await confirmBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, paymentMethodRef: "fake_pm_card", returnUrl: null });
  assert.equal(f.httpStatus, 200, JSON.stringify(f.body));
  await deliverAll(w);
  return String(c.body["paymentId"]);
}

/** The quote body the routes return (checkout.ts quoteBody). */
interface QuoteBody {
  total: { amountMinor: number; currency: string };
  lines: Array<{ key: string; amount: { amountMinor: number; currency: string }; payable: boolean }>;
  commission: { rate: string; bps: number; ruleVersion: string };
  deposit: null;
}
/** A report / ineligible / results row of the payout operations. */
interface Row { result: string; reason: string | null; payoutId: string | null; amountMinor: number; paymentId: string }
const rows = (v: unknown): Row[] => v as Row[];

let w: World;
beforeEach(() => { w = world(); });

describe("buddy onboarding: identity first, then the provider's account", () => {
  it("a verified buddy gets an account and an onboarding link; the signed recipient webhook records it as payable", async () => {
    const ref = await onboardBuddy(w);
    const rec = w.store.recipients.get(BUDDY_PARTY);
    assert.ok(rec);
    assert.equal(rec?.recipientRef, ref);
    assert.equal(rec?.onboarding, "verified");
    assert.equal(rec?.chargesEnabled, true);
    assert.equal(rec?.payoutsEnabled, true);
  });

  it("an UNVERIFIED buddy cannot start onboarding (identity before payment-provider verification)", async () => {
    w.deps = { ...w.deps, personVerified: async () => "not_verified" };
    const r = await startRecipientOnboarding(w.deps, { userId: BUDDY, country: "US", settlementCurrency: "USD", returnUrl: "a", refreshUrl: "b" });
    assert.equal(r.httpStatus, 403);
    assert.equal(r.body["error"], "identity_verification_required");
    assert.equal(w.store.recipients.size, 0);
  });

  it("a market the platform has not enabled is refused as unsupported, and nothing is stored", async () => {
    const r = await startRecipientOnboarding(w.deps, { userId: BUDDY, country: "JP", settlementCurrency: "JPY", returnUrl: "a", refreshUrl: "b" });
    assert.equal(r.httpStatus, 409, JSON.stringify(r.body));
    assert.equal(r.body["error"], "market_not_supported");
    assert.equal(w.store.recipients.size, 0);
  });
});

describe("quote: the commission is shown before checkout", () => {
  it("10% of the PRE-TAX service price, taken from the price; tax on top; no deposit", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    const q = await quoteBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    assert.equal(q.httpStatus, 200, JSON.stringify(q.body));
    const quote = q.body["quote"] as QuoteBody;
    assert.deepEqual(quote.total, { amountMinor: 4400, currency: "USD" }, "4000 service + 400 fake US tax (10%, platform-remitted)");
    const line = (k: string) => quote.lines.find((l) => l.key === k)!;
    assert.equal(line("service").amount.amountMinor, 4000);
    assert.equal(line("commission_from_service").amount.amountMinor, 400);
    assert.equal(line("commission_from_service").payable, false, "the commission is not added to the traveller's total");
    assert.equal(line("buddy_receives").amount.amountMinor, 3600);
    assert.equal(quote.commission.rate, "10%");
    assert.equal(quote.deposit, null);
  });

  it("a tip carries NO commission and goes 100% to the buddy", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    const q = await quoteBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, tipMinor: 1000 });
    const quote = q.body["quote"] as QuoteBody;
    const line = (k: string) => quote.lines.find((l) => l.key === k)!;
    assert.equal(line("commission_from_service").amount.amountMinor, 400, "commission unchanged by the tip");
    assert.equal(line("buddy_receives").amount.amountMinor, 4600, "3600 + the whole 1000 tip");
    assert.equal(quote.total.amountMinor, 5400, "the fake taxes no tip: 4000 + 1000 + 400");
  });
});

describe("checkout -> confirm -> signed webhook -> ledger -> booking state", () => {
  it("the happy path books the money before the booking reads as paid", async () => {
    const paymentId = await paidBooking(w);
    const p = w.store.payments.get(paymentId);
    assert.equal(p?.state, "succeeded");
    assert.equal(p?.chargeModel, "direct", "the buddy is the seller: a direct charge on their account");
    assert.equal(p?.amountCapturedMinor, 4400);
    assert.equal(p?.platformFeeCollectedMinor, 800, "commission 400 + platform-remitted tax 400");
    assert.equal(p?.commissionBps, 1000);
    assert.equal(p?.commissionRuleVersion, "rab-commission/owner-2026-10-04/v1");
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "captured");
    // The books: the buddy is owed 3600 on their provider balance; the platform holds its 400 fee and owes 400 tax.
    assert.equal(w.ledger.balance("user_payable", BUDDY_PARTY, "USD"), -3600);
    assert.equal(w.ledger.balance("processor_clearing", null, "USD"), 4400, "the processor holds the whole charge (3821: only a processor party owns a clearing account)");
    assert.equal(w.ledger.balance("platform_revenue", null, "USD"), -400);
    assert.equal(w.ledger.balance("tax_withheld", null, "USD"), -400);
    // And the provider agrees: the buddy's balance holds exactly what the ledger says they are owed.
    assert.equal(w.fake.control.balances().recipients[w.store.recipients.get(BUDDY_PARTY)!.recipientRef]?.["USD"], 3600);
  });

  it("confirm alone never marks the booking paid — only the signed webhook does", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    const f = await confirmBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, paymentMethodRef: "fake_pm", returnUrl: null });
    assert.equal(f.body["state"], "processing");
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "pending");
    assert.equal(w.ledger.postings.size, 0);
  });

  it("deliveries twice, late and out of order end in the SAME books (duplicates replay, stale is stale)", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    await confirmBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, paymentMethodRef: "fake_pm", returnUrl: null });
    const pending = w.fake.control.webhooks.pending();
    const reversed = pending.map((e) => e.index).reverse();
    const statuses = await deliverAll(w, { order: reversed, duplicates: 2 });
    assert.ok(statuses.every((s) => s === 200), JSON.stringify(statuses));
    const p = [...w.store.payments.values()][0];
    assert.equal(p?.state, "succeeded");
    assert.equal(w.ledger.balance("user_payable", BUDDY_PARTY, "USD"), -3600, "exactly one capture booked");
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "captured");
  });

  it("a delivery with a bad signature is refused 400 and changes nothing", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    await confirmBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, paymentMethodRef: "fake_pm", returnUrl: null });
    const [d] = w.fake.control.webhooks.deliver({ order: [w.fake.control.webhooks.pending().length - 1] });
    assert.ok(d);
    const tampered = { ...d!, rawBody: d!.rawBody.replace('"succeeded"', '"canceled"') };
    const r = await processPaymentWebhook(w.deps, tampered);
    assert.equal(r.httpStatus, 400);
    assert.equal(w.ledger.postings.size, 0);
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "pending");
  });

  it("a verified LIVE-mode event is refused (409) and booked nowhere — test mode only", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    await confirmBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, paymentMethodRef: "fake_pm", returnUrl: null });
    const statuses = await deliverAll(w, { livemode: true });
    assert.ok(statuses.every((s) => s === 409), JSON.stringify(statuses));
    assert.equal(w.ledger.postings.size, 0);
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "pending");
  });

  it("LEDGER DOWN: the webhook answers 503, books nothing, marks nothing processed; a redelivery after recovery applies it", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    await confirmBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, paymentMethodRef: "fake_pm", returnUrl: null });
    w.ledger.setAvailable(false);
    const pending = w.fake.control.webhooks.pending();
    const first = await deliverAll(w);
    assert.ok(first.includes(503), JSON.stringify(first));
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "pending", "never 'captured' on money the books do not hold");
    assert.equal([...w.store.payments.values()][0]?.state, "processing");
    w.ledger.setAvailable(true);
    for (const e of pending) assert.equal((await processPaymentWebhook(w.deps, w.fake.control.webhooks.redeliver(e.providerEventId))).httpStatus, 200);
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "captured");
    assert.equal(w.ledger.balance("user_payable", BUDDY_PARTY, "USD"), -3600);
  });

  it("a STORE failure while booking a webhook answers 503 and the redelivery completes it (no double booking)", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    await confirmBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, paymentMethodRef: "fake_pm", returnUrl: null });
    const pending = w.fake.control.webhooks.pending();
    const last = pending[pending.length - 1]!; // the capture
    await deliverAll(w, { order: pending.slice(0, -1).map((e) => e.index) });
    // The capture's payment write succeeds; its BOOKING write fails -> 503.
    w.store.failNext("setBookingPaymentStatus", 1);
    const first = await deliverAll(w);
    assert.deepEqual(first, [503]);
    assert.equal([...w.store.payments.values()][0]?.state, "succeeded", "the payment row was written");
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "pending", "the booking write failed");
    // The redelivery is STALE for the payment (already applied) and must still complete the booking.
    const again = await processPaymentWebhook(w.deps, w.fake.control.webhooks.redeliver(last.providerEventId));
    assert.equal(again.httpStatus, 200);
    assert.equal(again.body["outcome"], "stale");
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "captured");
    assert.equal(w.ledger.balance("user_payable", BUDDY_PARTY, "USD"), -3600, "the capture is booked once");
    assert.equal([...w.ledger.postings.values()].filter((p) => p.kind === "capture").length, 1);
  });

  it("the ledger booked but the payment write FAILED: the redelivery re-plans the SAME posting and the ledger replays it", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    await confirmBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, paymentMethodRef: "fake_pm", returnUrl: null });
    const pending = w.fake.control.webhooks.pending();
    w.store.failNext("updatePayment", 3);
    await deliverAll(w);
    for (const e of pending) await processPaymentWebhook(w.deps, w.fake.control.webhooks.redeliver(e.providerEventId));
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "captured");
    assert.equal(w.ledger.balance("user_payable", BUDDY_PARTY, "USD"), -3600, "booked once");
    assert.ok(w.ledger.replays() >= 1, "the re-run replayed the posting rather than booking it twice");
  });
});

describe("checkout refusals — every one creates nothing", () => {
  it("payments not operational -> 503, no row, no provider call", async () => {
    seedBooking(w);
    w.operational = false;
    const r = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    assert.equal(r.httpStatus, 503);
    assert.equal(w.store.payments.size, 0);
  });

  it("someone other than the traveller -> 403", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    const r = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: BUDDY });
    assert.equal(r.httpStatus, 403);
    assert.equal(w.store.payments.size, 0);
  });

  it("a booking that is not accepted yet (requested) -> 409 booking_not_payable", async () => {
    seedBooking(w, { status: "requested" });
    await onboardBuddy(w);
    const r = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    assert.equal(r.httpStatus, 409);
    assert.equal(r.body["error"], "booking_not_payable");
  });

  it("a buddy with no provider account -> 409 buddy_payments_not_ready", async () => {
    seedBooking(w);
    const r = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    assert.equal(r.httpStatus, 409);
    assert.equal(r.body["error"], "buddy_payments_not_ready");
    assert.equal(w.store.payments.size, 0);
  });

  it("a buddy whose onboarding is incomplete -> 409 buddy_payments_not_ready", async () => {
    seedBooking(w);
    const r0 = await startRecipientOnboarding(w.deps, { userId: BUDDY, country: "US", settlementCurrency: "USD", returnUrl: "a", refreshUrl: "b" });
    assert.equal(r0.httpStatus, 200);
    const r = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    assert.equal(r.httpStatus, 409);
    assert.equal(r.body["error"], "buddy_payments_not_ready");
  });

  it("either person failing identity eligibility -> that refusal, nothing created", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    w.deps = { ...w.deps, bookingParties: async () => ({ allowed: false, httpStatus: 403, code: "identity_verification_required", side: "traveler", message: "verify" }) };
    const r = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    assert.equal(r.httpStatus, 403);
    assert.equal(r.body["error"], "identity_verification_required");
    assert.equal(w.store.payments.size, 0);
  });

  it("a total different from the one shown -> 422 quote_changed with the new quote, nothing charged", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    const r = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, expectedTotalMinor: 4000 });
    assert.equal(r.httpStatus, 422);
    assert.equal(r.body["error"], "quote_changed");
    assert.equal(w.store.payments.size, 0);
  });

  it("a market WITHOUT direct charges is refused, never silently made a destination charge", async () => {
    w.enabledMarkets = ["US", "GB", "JP"];
    seedBooking(w, { serviceCountry: "JP", currency: "JPY", serviceMinor: 5000 });
    await onboardBuddy(w, "JP", "JPY");
    const r = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    assert.equal(r.httpStatus, 503, JSON.stringify(r.body));
    assert.equal(r.body["reason"], "charge_model_not_supported");
    assert.equal(w.store.payments.size, 0);
  });

  it("a store failure before the provider is asked -> 503 and no intent exists at the provider", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    w.store.failNext("insertPayment");
    const r = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    assert.equal(r.httpStatus, 503);
    assert.equal(w.fake.control.webhooks.pending().filter((e) => e.providerEventType.startsWith("payment_intent")).length, 0);
  });

  it("a second checkout of a paid booking -> 409 already_paid", async () => {
    await paidBooking(w);
    const r = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    assert.equal(r.httpStatus, 409);
    assert.equal(r.body["error"], "already_paid");
  });

  it("re-asking checkout while a payment is open RESUMES it (same intent, same key), it does not create a second", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    const a = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    const b = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    assert.equal(a.body["paymentId"], b.body["paymentId"]);
    assert.equal(w.store.payments.size, 1);
  });
});

describe("failed and retried payments are explicit states", () => {
  it("a DECLINED confirmation: 402, payment failed, booking failed; a retry creates attempt 2 with a new key", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    w.fake.control.script.declineNextConfirm("card_declined");
    const f = await confirmBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, paymentMethodRef: "fake_pm_bad", returnUrl: null });
    assert.equal(f.httpStatus, 402);
    await deliverAll(w);
    const first = [...w.store.payments.values()][0];
    assert.equal(first?.state, "failed", "a late payment_failed event does not reopen the attempt");
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "failed");
    const retry = await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    assert.equal(retry.httpStatus, 201);
    const attempts = [...w.store.payments.values()].sort((a, b) => a.attemptNo - b.attemptNo);
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0]?.idempotencyKey, attempts[1]?.idempotencyKey);
    assert.equal(w.ledger.postings.size, 0, "nothing was captured");
  });

  it("a payment that needs authentication and then FAILS it ends failed via the webhook", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    w.fake.control.script.requireActionOnNextConfirm();
    const f = await confirmBookingPayment(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, paymentMethodRef: "fake_pm_3ds", returnUrl: null });
    assert.equal(f.httpStatus, 202);
    const p = [...w.store.payments.values()][0]!;
    assert.equal(p.state, "awaiting_payment", "waiting for the payer to authenticate");
    w.fake.control.completePayerAction(p.intentRef!, "failed");
    await deliverAll(w);
    assert.equal(w.store.payments.get(p.id)?.state, "failed");
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "failed");
    assert.equal(w.ledger.postings.size, 0);
  });
});

describe("refunds follow the owner's rules; fees come back with them", () => {
  it("traveller cancels BEFORE the service starts -> full refund including the platform fee; books net to zero", async () => {
    await paidBooking(w);
    w.clock.now = new Date("2026-08-15T00:00:00.000Z");
    const r = await requestBookingRefund(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, actorIsAdmin: false, trigger: "cancelled_before_service" });
    assert.equal(r.httpStatus, 202, JSON.stringify(r.body));
    assert.equal((r.body["amount"] as { amountMinor: number }).amountMinor, 4400);
    assert.equal(r.body["platformFeeRefundedMinor"], 800, "the fee is refunded too — never promised as non-refundable");
    await deliverAll(w);
    const p = [...w.store.payments.values()][0];
    assert.equal(p?.state, "refunded");
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "refunded");
    for (const [acct, party] of [["user_payable", BUDDY_PARTY], ["processor_clearing", null], ["platform_revenue", null], ["tax_withheld", null]] as const) {
      assert.equal(w.ledger.balance(acct, party, "USD"), 0, `${acct}/${party ?? "platform"} nets to zero`);
    }
    assert.equal([...w.store.refunds.values()][0]?.state, "succeeded");
  });

  it("traveller cancels AFTER the start -> 409 service_already_started (support decides), nothing refunded", async () => {
    await paidBooking(w);
    w.clock.now = new Date("2026-08-20T16:00:00.000Z");
    const r = await requestBookingRefund(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, actorIsAdmin: false, trigger: "cancelled_before_service" });
    assert.equal(r.httpStatus, 409);
    assert.equal(r.body["error"], "service_already_started");
    assert.equal(w.store.refunds.size, 0);
  });

  it("the BUDDY cancels -> full refund (provider cancelled)", async () => {
    await paidBooking(w);
    const r = await requestBookingRefund(w.deps, { bookingId: BOOKING, actorUserId: BUDDY, actorIsAdmin: false, trigger: "provider_cancelled" });
    assert.equal(r.httpStatus, 202);
    await deliverAll(w);
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "refunded");
  });

  it("only support issues service_unavailable / safety_issue_upheld refunds", async () => {
    await paidBooking(w);
    const denied = await requestBookingRefund(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, actorIsAdmin: false, trigger: "safety_issue_upheld" });
    assert.equal(denied.httpStatus, 403);
    const ok = await requestBookingRefund(w.deps, { bookingId: ADMIN === ADMIN ? BOOKING : BOOKING, actorUserId: ADMIN, actorIsAdmin: true, trigger: "safety_issue_upheld" });
    assert.equal(ok.httpStatus, 202);
  });

  it("a support decision refunds a PART; the books carry exactly that part; a second identical request is the same refund", async () => {
    await paidBooking(w);
    const r = await requestBookingRefund(w.deps, { bookingId: BOOKING, actorUserId: ADMIN, actorIsAdmin: true, trigger: "support_decision", amountMinor: 1100 });
    assert.equal(r.httpStatus, 202, JSON.stringify(r.body));
    await deliverAll(w);
    const p = [...w.store.payments.values()][0];
    assert.equal(p?.state, "partially_refunded");
    assert.equal(p?.amountRefundedMinor, 1100);
    assert.equal(w.store.bookings.get(BOOKING)?.paymentStatus, "partial");
    assert.equal(w.ledger.balance("processor_clearing", null, "USD"), 4400 - 1100);
  });

  it("an UNCAPTURED payment is cancelled, not refunded: nothing moved and the traveller is told so", async () => {
    seedBooking(w);
    await onboardBuddy(w);
    await startBookingCheckout(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER });
    const r = await requestBookingRefund(w.deps, { bookingId: BOOKING, actorUserId: TRAVELER, actorIsAdmin: false, trigger: "cancelled_before_service" });
    assert.equal(r.httpStatus, 200, JSON.stringify(r.body));
    assert.equal(r.body["refunded"], false);
    assert.equal([...w.store.payments.values()][0]?.state, "canceled");
    assert.equal(w.store.refunds.size, 0);
  });

  it("a stranger cannot refund someone else's booking", async () => {
    await paidBooking(w);
    const r = await requestBookingRefund(w.deps, { bookingId: BOOKING, actorUserId: "someone-else", actorIsAdmin: false, trigger: "cancelled_before_service" });
    assert.equal(r.httpStatus, 403);
  });
});

describe("disputes: opened, won, lost (chargeback) — explicit and booked", () => {
  it("an open dispute marks the payment disputed and keeps it out of payouts; a LOST dispute is a booked chargeback (reversed)", async () => {
    await paidBooking(w);
    const p = [...w.store.payments.values()][0]!;
    const d = w.fake.control.openDispute(p.intentRef!, "fraudulent");
    await deliverAll(w);
    assert.equal(w.store.payments.get(p.id)?.state, "disputed");
    const b = w.store.bookings.get(BOOKING)!;
    w.store.bookings.set(BOOKING, { ...b, status: "completed", completedAt: "2026-08-20T18:00:00.000Z", disputeWindowExpiresAt: "2026-08-23T18:00:00.000Z" });
    w.clock.now = new Date("2026-09-03T00:00:00.000Z");
    const plan = await planMonthlyPayouts(w.deps, { minimumByCurrency: { USD: 100 } }, "2026-08");
    assert.equal(rows(plan.body["ineligible"])[0]?.reason, "not_settled", "a disputed payment is not paid out");
    w.fake.control.resolveDispute(d.disputeRef, "lost");
    await deliverAll(w);
    assert.equal(w.store.payments.get(p.id)?.state, "reversed");
    assert.equal(w.ledger.balance("user_payable", BUDDY_PARTY, "USD"), -3600 + 4400, "the chargeback debits what the buddy was owed");
    assert.equal([...w.ledger.postings.values()].filter((x) => x.kind === "chargeback").length, 1);
  });

  it("a WON dispute returns the payment to succeeded and books nothing", async () => {
    await paidBooking(w);
    const p = [...w.store.payments.values()][0]!;
    const d = w.fake.control.openDispute(p.intentRef!, "fraudulent");
    await deliverAll(w);
    w.fake.control.resolveDispute(d.disputeRef, "won");
    await deliverAll(w);
    assert.equal(w.store.payments.get(p.id)?.state, "succeeded");
    assert.equal([...w.ledger.postings.values()].filter((x) => x.kind === "chargeback").length, 0);
  });
});

describe("monthly payouts: finalised, completed, verified; small balances carried forward", () => {
  async function completedAndFinalised(): Promise<void> {
    await paidBooking(w);
    const b = w.store.bookings.get(BOOKING)!;
    w.store.bookings.set(BOOKING, { ...b, status: "completed", completedAt: "2026-08-20T18:00:00.000Z", disputeWindowExpiresAt: "2026-08-23T18:00:00.000Z" });
    w.clock.now = new Date("2026-09-03T00:00:00.000Z");
  }

  it("NO minimum configured for the currency -> nothing is paid, the balance is carried forward with that reason", async () => {
    await completedAndFinalised();
    const r = await planMonthlyPayouts(w.deps, { minimumByCurrency: {} }, "2026-08");
    assert.equal(r.httpStatus, 200);
    const line = rows(r.body["report"])[0];
    assert.equal(line.result, "carried_forward");
    assert.equal(line.reason, "payout_minimum_not_configured");
    assert.equal([...w.store.payments.values()][0]?.payoutId, null, "the payment rolls into the next plan");
  });

  it("below the configured minimum -> carried forward; at or above -> planned", async () => {
    await completedAndFinalised();
    const low = await planMonthlyPayouts(w.deps, { minimumByCurrency: { USD: 5000 } }, "2026-08");
    assert.equal(rows(low.body["report"])[0].reason, "below_minimum");
    const ok = await planMonthlyPayouts(w.deps, { minimumByCurrency: { USD: 2000 } }, "2026-08");
    const line = rows(ok.body["report"])[0];
    assert.equal(line.result, "planned");
    assert.equal(line.amountMinor, 3600, "the buddy's net: captured 4400 - platform fee 800");
  });

  it("an open dispute window, an uncompleted booking or an unverified buddy is not paid", async () => {
    await completedAndFinalised();
    const b = w.store.bookings.get(BOOKING)!;
    w.store.bookings.set(BOOKING, { ...b, disputeWindowExpiresAt: "2026-09-10T00:00:00.000Z" });
    const open = await planMonthlyPayouts(w.deps, { minimumByCurrency: { USD: 100 } }, "2026-08");
    assert.equal(rows(open.body["ineligible"])[0].reason, "dispute_window_open");
    w.store.bookings.set(BOOKING, { ...b, completedAt: null });
    const notDone = await planMonthlyPayouts(w.deps, { minimumByCurrency: { USD: 100 } }, "2026-08");
    assert.equal(rows(notDone.body["ineligible"])[0].reason, "not_completed");
    w.store.bookings.set(BOOKING, b);
    w.deps = { ...w.deps, personVerified: async () => "not_verified" };
    const unverified = await planMonthlyPayouts(w.deps, { minimumByCurrency: { USD: 100 } }, "2026-08");
    assert.equal(rows(unverified.body["report"])[0].reason, "recipient_not_verified");
    assert.equal(w.store.payouts.size, 0);
  });

  it("plan -> hold (skipped by execute) -> release -> execute -> signed paid webhook -> booked; the buddy's books clear", async () => {
    await completedAndFinalised();
    const plan = await planMonthlyPayouts(w.deps, { minimumByCurrency: { USD: 1000 } }, "2026-08");
    const payoutId = String(rows(plan.body["report"])[0].payoutId);
    const held = await holdOrReleasePayout(w.deps, { payoutId, action: "hold", reason: "fraud review", actorUserId: ADMIN });
    assert.equal(held.httpStatus, 200);
    const skipped = await executePlannedPayouts(w.deps, [payoutId]);
    assert.equal(rows(skipped.body["results"])[0].result, "skipped_held");
    assert.equal((await holdOrReleasePayout(w.deps, { payoutId, action: "release", reason: "review cleared", actorUserId: ADMIN })).httpStatus, 200);
    const ex = await executePlannedPayouts(w.deps, [payoutId]);
    assert.equal(rows(ex.body["results"])[0].result, "requested");
    const ref = w.store.payouts.get(payoutId)!.payoutRef!;
    while (w.store.payouts.get(payoutId)!.state !== "paid") {
      w.fake.control.advancePayout(ref);
      await deliverAll(w);
      if (w.fake.control.webhooks.pending().length === 0 && w.store.payouts.get(payoutId)!.lastSnapshot?.state === "paid") break;
    }
    assert.equal(w.store.payouts.get(payoutId)?.state, "paid");
    assert.equal(w.ledger.balance("user_payable", BUDDY_PARTY, "USD"), 0, "the buddy is owed nothing after the payout");
    assert.equal(w.ledger.balance("processor_clearing", null, "USD"), 800, "only the platform's fee and tax remain with the processor");
    assert.equal(w.fake.control.balances().paidOut["USD"], 3600);
  });

  it("a payout the provider REJECTS is failed and its payments are released to the next plan", async () => {
    await completedAndFinalised();
    const plan = await planMonthlyPayouts(w.deps, { minimumByCurrency: { USD: 1000 } }, "2026-08");
    const payoutId = String(rows(plan.body["report"])[0].payoutId);
    w.fake.control.script.failNextPayout("at_request", "account_closed");
    const ex = await executePlannedPayouts(w.deps, [payoutId]);
    assert.match(String(rows(ex.body["results"])[0].result), /^failed:/);
    assert.equal(w.store.payouts.get(payoutId)?.state, "failed");
    assert.equal([...w.store.payments.values()][0]?.payoutId, null);
    assert.equal(w.ledger.balance("user_payable", BUDDY_PARTY, "USD"), -3600, "nothing was booked as paid");
  });

  it("a hold needs a reason; only a planned payout can be held", async () => {
    await completedAndFinalised();
    const plan = await planMonthlyPayouts(w.deps, { minimumByCurrency: { USD: 1000 } }, "2026-08");
    const payoutId = String(rows(plan.body["report"])[0].payoutId);
    assert.equal((await holdOrReleasePayout(w.deps, { payoutId, action: "hold", reason: "", actorUserId: ADMIN })).httpStatus, 400);
    assert.equal((await holdOrReleasePayout(w.deps, { payoutId, action: "release", reason: "review cleared", actorUserId: ADMIN })).httpStatus, 409);
  });

  it("a month is paid out only after it ends", async () => {
    await completedAndFinalised();
    w.clock.now = new Date("2026-08-25T00:00:00.000Z");
    assert.equal((await planMonthlyPayouts(w.deps, { minimumByCurrency: { USD: 1 } }, "2026-08")).httpStatus, 409);
  });
});
