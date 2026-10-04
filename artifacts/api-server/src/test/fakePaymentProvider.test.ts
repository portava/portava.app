/**
 * PAY-T03 — the deterministic fake payment provider (services/payments/
 * FakePaymentProvider.ts): every tagged-result branch, every scripted failure,
 * and where it may run.
 *
 *   FP1  the direct-charge path: the charge is on the recipient's account, the
 *        platform fee is a separate amount, and the balances say where the
 *        money is (state, not return values)
 *   FP2  declined, requires_action, manual capture, cancel
 *   FP3  refunds: full and partial, with and without the platform fee
 *   FP4  recipients: onboarding and verification state, every answer
 *   FP5  markets and charge models: a market with no direct charges, an
 *        unsupported market, a provider with no direct charges
 *   FP6  original currency and amount survive a conversion; a missing rate is a
 *        refusal
 *   FP7  payouts and transfers: paid, rejected at request, failed after
 *        instruction, returned; hold, release, reverse
 *   FP8  idempotency: a key replays its answer and refuses a different request
 *   FP9  refused in production and on hosted deployments, on every operation
 *   FP10 deterministic and no I/O; all five result statuses are produced
 *
 * Run: node --import tsx/esm --test src/test/fakePaymentProvider.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";

import {
  FAKE_CAPABILITIES,
  FAKE_EPOCH_MS,
  createFakePaymentProvider,
  type FakePaymentProvider,
} from "../services/payments/FakePaymentProvider.js";
import {
  PAYMENT_PROVIDER_OPERATIONS,
  PAYMENT_RESULT_STATUSES,
  intentHandle,
  payoutHandle,
  selectChargeModel,
  type PaymentIntentSnapshot,
  type PaymentResult,
} from "../services/payments/PaymentProvider.js";
import { LOCAL_ENV, REFUSED_ENVS, buildCharge, okValue, tag, verifiedRecipient } from "./helpers/paymentFixtures.js";

const fresh = (): FakePaymentProvider => createFakePaymentProvider({ env: LOCAL_ENV });

/** A verified US recipient and a captured 12 500-minor direct charge on their account (10 000 service, 1 500 tip, 1 000 tax). */
async function capturedCharge(fake: FakePaymentProvider, key = "c1"): Promise<{ recipientRef: string; intent: PaymentIntentSnapshot }> {
  const recipientRef = await verifiedRecipient(fake, { key: `r-${key}` });
  const created = okValue(await fake.createPaymentIntent(await buildCharge({ key, recipientRef, tipMinor: 1500 })), "create");
  const intent = okValue(await fake.confirmPaymentIntent({ idempotencyKey: `${key}-confirm`, intent: intentHandle(created), paymentMethodRef: "pm_fake", returnUrl: null }), "confirm");
  return { recipientRef, intent };
}

describe("FP1 — a direct charge on the recipient's account with a separate platform fee", () => {
  it("create -> confirm: the recipient is credited the amount less the fee, the platform the fee, and the original amount is untouched", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    const request = await buildCharge({ key: "c1", recipientRef, tipMinor: 1500 });
    const created = okValue(await fake.createPaymentIntent(request), "create");
    assert.deepEqual(
      [created.state, created.chargeModel, created.recipientRef, created.amount, created.amountCapturedMinor, created.livemode, created.settlement],
      ["requires_confirmation", "direct", recipientRef, { amountMinor: 12_500, currency: "USD" }, 0, false, null],
    );
    assert.deepEqual(fake.control.balances(), { platform: {}, recipients: {}, paidOut: {}, providerFees: {} }, "creating an intent moves nothing");

    const confirmed = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "c1-confirm", intent: intentHandle(created), paymentMethodRef: "pm_fake", returnUrl: null }), "confirm");
    assert.deepEqual(
      [confirmed.state, confirmed.amountCapturedMinor, confirmed.amountCapturableMinor, confirmed.platformFeeCollectedMinor, confirmed.clientSecret],
      ["succeeded", 12_500, 0, 2000, null],
    );
    assert.deepEqual(confirmed.amount, { amountMinor: 12_500, currency: "USD" });
    assert.deepEqual(confirmed.components, { serviceMinor: 10_000, payerFeeMinor: 0, tipMinor: 1500, taxMinor: 1000 });
    assert.deepEqual(confirmed.platformFee, { commissionMinor: 1000, payerFeeMinor: 0, taxMinor: 1000 });
    assert.deepEqual(confirmed.settlement, {
      settled: { amountMinor: 10_500, currency: "USD" },
      conversion: null,
      providerFee: { amount: { amountMinor: 0, currency: "USD" }, paidBy: "recipient" },
      platformFeeSettled: { settled: { amountMinor: 2000, currency: "USD" }, conversion: null },
    });
    // The state, read back: the tip (1500) reached the recipient whole; the platform holds only commission + remitted tax.
    assert.deepEqual(fake.control.balances(), { platform: { USD: 2000 }, recipients: { [recipientRef]: { USD: 10_500 } }, paidOut: {}, providerFees: {} });
    const read = okValue(await fake.getPaymentIntent(intentHandle(confirmed)), "read back");
    assert.deepEqual(read, confirmed);
  });

  it("an intent is addressed by its recipient: the same id under another recipient or charge model is not found", async () => {
    const fake = fresh();
    const { intent } = await capturedCharge(fake);
    assert.deepEqual(tag(await fake.getPaymentIntent({ ...intentHandle(intent), recipientRef: "fake_acct_999999" })), ["failed", "not_found"]);
    assert.deepEqual(tag(await fake.getPaymentIntent({ ...intentHandle(intent), chargeModel: "destination" })), ["failed", "not_found"]);
    assert.deepEqual(tag(await fake.getPaymentIntent({ intentRef: "fake_pi_999999", chargeModel: "direct", recipientRef: intent.recipientRef })), ["failed", "not_found"]);
  });

  it("an invalid request is refused by the shared validator before anything is created", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    const over = await buildCharge({ key: "c1", recipientRef, commissionMinor: 10_001 });
    assert.deepEqual(tag(await fake.createPaymentIntent(over)), ["failed", "fee_exceeds_commissionable_amount"]);
    const untaxed = { ...(await buildCharge({ key: "c2", recipientRef })), tax: [] };
    assert.deepEqual(tag(await fake.createPaymentIntent(untaxed)), ["unavailable", "tax_not_configured"]);
    // Nothing exists: the next intent created is the first.
    const first = okValue(await fake.createPaymentIntent(await buildCharge({ key: "c3", recipientRef })), "create");
    assert.equal(first.intentRef, "fake_pi_000001");
  });

  it("a platform charge has no recipient and the whole amount is the platform's", async () => {
    const fake = fresh();
    const created = okValue(await fake.createPaymentIntent(await buildCharge({ key: "p1", recipientRef: null, chargeModel: "platform" })), "create");
    const done = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "p1-confirm", intent: intentHandle(created), paymentMethodRef: null, returnUrl: null }), "confirm");
    assert.deepEqual([done.state, done.recipientRef, done.platformFeeCollectedMinor], ["succeeded", null, 0]);
    assert.deepEqual(fake.control.balances(), { platform: { USD: 11_000 }, recipients: {}, paidOut: {}, providerFees: {} });
  });
});

describe("FP2 — declined, requires_action, manual capture, cancel", () => {
  it("a scripted decline is `declined` with the reason, moves nothing, and a new attempt can succeed", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    const created = okValue(await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef })), "create");
    fake.control.script.declineNextConfirm("insufficient_funds");
    const declined = await fake.confirmPaymentIntent({ idempotencyKey: "attempt-1", intent: intentHandle(created), paymentMethodRef: "pm_1", returnUrl: null });
    assert.deepEqual(tag(declined), ["declined", "insufficient_funds"]);
    assert.equal(declined.status === "declined" && declined.value?.state, "requires_payment_method");
    assert.deepEqual(fake.control.balances(), { platform: {}, recipients: {}, paidOut: {}, providerFees: {} }, "a declined payment moved money");
    const retried = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "attempt-2", intent: intentHandle(created), paymentMethodRef: "pm_2", returnUrl: null }), "second attempt");
    assert.equal(retried.state, "succeeded");
  });

  it("a scripted authentication is `requires_action`; the payer finishing it captures, failing it does not", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    for (const [key, outcome, finalState, moved] of [
      ["a", "authenticated", "succeeded", true],
      ["b", "failed", "requires_payment_method", false],
    ] as const) {
      const created = okValue(await fake.createPaymentIntent(await buildCharge({ key, recipientRef })), "create");
      const before = JSON.stringify(fake.control.balances());
      fake.control.script.requireActionOnNextConfirm();
      const r = await fake.confirmPaymentIntent({ idempotencyKey: `${key}-confirm`, intent: intentHandle(created), paymentMethodRef: "pm", returnUrl: null });
      assert.deepEqual(tag(r), ["requires_action", "payer_authentication_required"]);
      if (r.status !== "requires_action") throw new Error("unreachable");
      assert.equal(r.action.kind, "payer_authentication");
      assert.equal(r.action.kind === "payer_authentication" && r.action.clientSecret, r.value.clientSecret);
      assert.equal(r.value.state, "requires_action");
      assert.equal(JSON.stringify(fake.control.balances()), before, "an unauthenticated payment moved money");
      assert.deepEqual(tag(await fake.confirmPaymentIntent({ idempotencyKey: `${key}-again`, intent: intentHandle(created), paymentMethodRef: "pm", returnUrl: null })), ["failed", "illegal_state"]);
      fake.control.completePayerAction(created.intentRef, outcome);
      const after = okValue(await fake.getPaymentIntent(intentHandle(created)), "read back");
      assert.equal(after.state, finalState);
      assert.equal(JSON.stringify(fake.control.balances()) !== before, moved, `${outcome}: balances`);
    }
  });

  it("manual capture: authorise, then capture in full or in part with the fee restated", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    const hold = async (key: string) => {
      const created = okValue(await fake.createPaymentIntent(await buildCharge({ key, recipientRef, capture: "manual" })), "create");
      return okValue(await fake.confirmPaymentIntent({ idempotencyKey: `${key}-confirm`, intent: intentHandle(created), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    };
    const held = await hold("m1");
    assert.deepEqual([held.state, held.amountCapturableMinor, held.amountCapturedMinor], ["requires_capture", 11_000, 0]);
    assert.deepEqual(fake.control.balances().recipients, {}, "an authorisation is not a capture");

    const h = intentHandle(held);
    // Half the service and half its tax: 5 000 + 500. The original fee was 1 000 commission + 1 000 platform-remitted tax.
    const half = { components: { serviceMinor: 5000, payerFeeMinor: 0, tipMinor: 0, taxMinor: 500 }, platformFee: { commissionMinor: 500, payerFeeMinor: 0, taxMinor: 500 } };
    const refusals: Array<[string, Parameters<typeof fake.capturePaymentIntent>[0], string]> = [
      ["more than was authorised", { idempotencyKey: "x1", intent: h, amountMinor: 11_001, partial: half }, "amount_exceeds_capturable"],
      ["a stated amount with no breakdown", { idempotencyKey: "x2", intent: h, amountMinor: 5500, partial: null }, "invalid_request"],
      ["commission one minor unit over the scaled cap", { idempotencyKey: "x3", intent: h, amountMinor: 5500, partial: { ...half, platformFee: { ...half.platformFee, commissionMinor: 501 } } }, "fee_exceeds_commissionable_amount"],
      ["a float amount", { idempotencyKey: "x4", intent: h, amountMinor: 0.5, partial: half }, "invalid_amount"],
      ["components that do not sum to the captured amount", { idempotencyKey: "x6", intent: h, amountMinor: 5501, partial: half }, "invalid_amount"],
      ["a captured component larger than the original", { idempotencyKey: "x7", intent: h, amountMinor: 6001, partial: { ...half, components: { ...half.components, taxMinor: 1001 } } }, "invalid_amount"],
      ["platform tax over the scaled cap", { idempotencyKey: "x8", intent: h, amountMinor: 5500, partial: { ...half, platformFee: { ...half.platformFee, taxMinor: 501 } } }, "invalid_amount"],
      ["`full` with a breakdown", { idempotencyKey: "x9", intent: h, amountMinor: "full", partial: half }, "invalid_request"],
    ];
    for (const [name, req, reason] of refusals) assert.deepEqual(tag(await fake.capturePaymentIntent(req)), ["failed", reason], name);
    assert.deepEqual(fake.control.balances().recipients, {}, "a refused capture moved money");

    const part = okValue(await fake.capturePaymentIntent({ idempotencyKey: "m1-capture", intent: h, amountMinor: 5500, partial: half }), "partial capture");
    assert.deepEqual([part.state, part.amountCapturedMinor, part.amountCapturableMinor, part.platformFeeCollectedMinor], ["succeeded", 5500, 0, 1000]);
    assert.deepEqual(part.amount, { amountMinor: 11_000, currency: "USD" }, "the original amount is not rewritten by a partial capture");
    assert.deepEqual(part.components, { serviceMinor: 10_000, payerFeeMinor: 0, tipMinor: 0, taxMinor: 1000 }, "nor are the original components");
    assert.deepEqual(fake.control.balances(), { platform: { USD: 1000 }, recipients: { [recipientRef]: { USD: 4500 } }, paidOut: {}, providerFees: {} });
    assert.deepEqual(tag(await fake.capturePaymentIntent({ idempotencyKey: "x5", intent: h, amountMinor: "full", partial: null })), ["failed", "illegal_state"]);

    const full = okValue(await fake.capturePaymentIntent({ idempotencyKey: "m2-capture", intent: intentHandle(await hold("m2")), amountMinor: "full", partial: null }), "full capture");
    assert.deepEqual([full.amountCapturedMinor, full.platformFeeCollectedMinor], [11_000, 2000]);
  });

  it("cancel releases an uncaptured intent; a captured one cannot be cancelled", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    const created = okValue(await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef, capture: "manual" })), "create");
    const held = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "c1-confirm", intent: intentHandle(created), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    const cancelled = okValue(await fake.cancelPaymentIntent({ idempotencyKey: "c1-cancel", intent: intentHandle(held), reason: "requested_by_payer" }), "cancel");
    assert.deepEqual([cancelled.state, cancelled.amountCapturableMinor, cancelled.amountCapturedMinor], ["canceled", 0, 0]);
    assert.deepEqual(fake.control.balances(), { platform: {}, recipients: {}, paidOut: {}, providerFees: {} });
    assert.deepEqual(tag(await fake.cancelPaymentIntent({ idempotencyKey: "c1-cancel-2", intent: intentHandle(held), reason: "duplicate" })), ["failed", "illegal_state"]);
    const { intent } = await capturedCharge(fake, "c2");
    assert.deepEqual(tag(await fake.cancelPaymentIntent({ idempotencyKey: "c2-cancel", intent: intentHandle(intent), reason: "safety" })), ["failed", "illegal_state"]);
  });
});

describe("FP3 — refunds", () => {
  it("a full refund with the platform fee returns every balance to zero", async () => {
    const fake = fresh();
    const { recipientRef, intent } = await capturedCharge(fake);
    const refund = okValue(await fake.refundPayment({ idempotencyKey: "rf1", intent: intentHandle(intent), amountMinor: "full", reason: "provider_cancelled", refundPlatformFee: true, reverseTransfer: false }), "refund");
    assert.deepEqual(
      [refund.state, refund.amount, refund.platformFeeRefundedMinor, refund.fullyRefunded, refund.reason, refund.intentRef],
      ["succeeded", { amountMinor: 12_500, currency: "USD" }, 2000, true, "provider_cancelled", intent.intentRef],
    );
    assert.deepEqual(fake.control.balances(), { platform: { USD: 0 }, recipients: { [recipientRef]: { USD: 0 } }, paidOut: {}, providerFees: {} });
    const after = okValue(await fake.getPaymentIntent(intentHandle(intent)), "read back");
    assert.deepEqual([after.amountRefundedMinor, after.platformFeeRefundedMinor, after.amountCapturedMinor], [12_500, 2000, 12_500]);
    assert.deepEqual(tag(await fake.refundPayment({ idempotencyKey: "rf2", intent: intentHandle(intent), amountMinor: 1, reason: "duplicate", refundPlatformFee: true, reverseTransfer: false })), ["failed", "amount_exceeds_refundable"]);
  });

  it("partial refunds return the fee in proportion, and the last one takes the remainder", async () => {
    const fake = fresh();
    const { recipientRef, intent } = await capturedCharge(fake);
    const h = intentHandle(intent);
    const first = okValue(await fake.refundPayment({ idempotencyKey: "rf1", intent: h, amountMinor: 5000, reason: "support_decision", refundPlatformFee: true, reverseTransfer: false }), "first");
    // 2000 fee × 5000 / 12500 = 800
    assert.deepEqual([first.amount.amountMinor, first.platformFeeRefundedMinor, first.fullyRefunded], [5000, 800, false]);
    assert.deepEqual(fake.control.balances(), { platform: { USD: 1200 }, recipients: { [recipientRef]: { USD: 6300 } }, paidOut: {}, providerFees: {} });
    assert.deepEqual(tag(await fake.refundPayment({ idempotencyKey: "rf-over", intent: h, amountMinor: 7501, reason: "support_decision", refundPlatformFee: true, reverseTransfer: false })), ["failed", "amount_exceeds_refundable"]);
    const rest = okValue(await fake.refundPayment({ idempotencyKey: "rf2", intent: h, amountMinor: "full", reason: "safety_issue_upheld", refundPlatformFee: true, reverseTransfer: false }), "rest");
    assert.deepEqual([rest.amount.amountMinor, rest.platformFeeRefundedMinor, rest.fullyRefunded], [7500, 1200, true]);
    assert.deepEqual(fake.control.balances(), { platform: { USD: 0 }, recipients: { [recipientRef]: { USD: 0 } }, paidOut: {}, providerFees: {} });
  });

  it("without the platform fee the recipient bears the whole refund; the caller must say which", async () => {
    const fake = fresh();
    const { recipientRef, intent } = await capturedCharge(fake);
    const h = intentHandle(intent);
    assert.deepEqual(
      tag(await fake.refundPayment({ idempotencyKey: "rf0", intent: h, amountMinor: "full", reason: "provider_cancelled" } as any)),
      ["failed", "invalid_request"],
      "refundPlatformFee has no default",
    );
    const refund = okValue(await fake.refundPayment({ idempotencyKey: "rf1", intent: h, amountMinor: "full", reason: "cancelled_before_service", refundPlatformFee: false, reverseTransfer: false }), "refund");
    assert.equal(refund.platformFeeRefundedMinor, 0);
    assert.deepEqual(fake.control.balances(), { platform: { USD: 2000 }, recipients: { [recipientRef]: { USD: -2000 } }, paidOut: {}, providerFees: {} });
  });

  it("an uncaptured intent has nothing to refund", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    const created = okValue(await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef })), "create");
    assert.deepEqual(tag(await fake.refundPayment({ idempotencyKey: "rf1", intent: intentHandle(created), amountMinor: "full", reason: "duplicate", refundPlatformFee: true, reverseTransfer: false })), ["failed", "illegal_state"]);
  });
});

describe("FP4 — recipients: onboarding and verification state", () => {
  const request = (key: string, country = "US", settlementCurrency = "USD") => ({
    idempotencyKey: key, profileId: `profile-${key}`, country, entityType: "individual" as const, settlementCurrency,
    returnUrl: "travelbuddy://return", refreshUrl: "travelbuddy://refresh",
  });

  it("creating a recipient requires the recipient's action, with the onboarding link and requirement codes", async () => {
    const fake = fresh();
    const r = await fake.createRecipient(request("r1"));
    assert.deepEqual(tag(r), ["requires_action", "recipient_onboarding_required"]);
    if (r.status !== "requires_action") throw new Error("unreachable");
    assert.deepEqual(
      [r.value.recipientRef, r.value.onboarding, r.value.chargesEnabled, r.value.payoutsEnabled, r.value.country, r.value.settlementCurrency, r.value.livemode],
      ["fake_acct_000001", "not_started", false, false, "US", "USD", false],
    );
    assert.equal(r.action.kind, "recipient_onboarding");
    assert.deepEqual(r.action.kind === "recipient_onboarding" && [r.action.url, r.action.requirementsDue], ["https://fake-payments.invalid/onboard/fake_acct_000001", ["fake.identity_document", "fake.payout_account"]]);
    const linkRequest = { idempotencyKey: "link-1", recipientRef: r.value.recipientRef, returnUrl: "a://b", refreshUrl: "a://c" };
    const link = okValue(await fake.createRecipientOnboardingLink(linkRequest), "link");
    assert.equal(link.expiresAt, new Date(fake.control.nowMs() + 5 * 60_000).toISOString());
    assert.deepEqual(okValue(await fake.createRecipientOnboardingLink({ ...linkRequest }), "retry"), link, "a retried request gets the same link, not a second one");
    const another = okValue(await fake.createRecipientOnboardingLink({ ...linkRequest, idempotencyKey: "link-2" }), "a new request");
    assert.notEqual(another.url, link.url);
    assert.deepEqual(tag(await fake.createRecipientOnboardingLink({ ...linkRequest, idempotencyKey: "" })), ["failed", "invalid_request"]);
  });

  it("validateRecipient answers ok ONLY for a verified recipient; every other state is named", async () => {
    const fake = fresh();
    const created = await fake.createRecipient(request("r1"));
    if (created.status !== "requires_action") throw new Error("unreachable");
    const ref = created.value.recipientRef;
    const expected: Array<[Parameters<FakePaymentProvider["control"]["setRecipientOnboarding"]>[1], [string, string | null]]> = [
      ["in_progress", ["requires_action", "recipient_onboarding_required"]],
      ["pending_verification", ["requires_action", "recipient_verification_pending"]],
      ["verified", ["ok", null]],
      ["restricted", ["requires_action", "recipient_onboarding_required"]],
      ["rejected", ["declined", "recipient_rejected"]],
    ];
    assert.deepEqual(tag(await fake.validateRecipient(ref)), ["requires_action", "recipient_onboarding_required"], "not_started");
    for (const [state, answer] of expected) {
      fake.control.setRecipientOnboarding(ref, state);
      const r = await fake.validateRecipient(ref);
      assert.deepEqual(tag(r), answer, state);
      const snapshot = r.status === "ok" || r.status === "requires_action" || r.status === "declined" ? r.value : null;
      assert.equal(snapshot?.onboarding, state, `${state}: the snapshot travels with every answer`);
      assert.equal(snapshot?.chargesEnabled, state === "verified");
    }
    assert.deepEqual(tag(await fake.createRecipientOnboardingLink({ idempotencyKey: "link-r", recipientRef: ref, returnUrl: "a://b", refreshUrl: "a://c" })), ["declined", "recipient_rejected"]);
    assert.deepEqual(tag(await fake.validateRecipient("fake_acct_999999")), ["failed", "not_found"]);
    assert.deepEqual(tag(await fake.createRecipientOnboardingLink({ idempotencyKey: "link-n", recipientRef: "nope", returnUrl: "a://b", refreshUrl: "a://c" })), ["failed", "not_found"]);
  });

  it("a recipient who is not verified cannot be charged for", async () => {
    const fake = fresh();
    const created = await fake.createRecipient(request("r1"));
    if (created.status !== "requires_action") throw new Error("unreachable");
    const r = await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef: created.value.recipientRef }));
    assert.deepEqual(tag(r), ["declined", "recipient_not_eligible"]);
    assert.deepEqual(tag(await fake.createPaymentIntent(await buildCharge({ key: "c2", recipientRef: "fake_acct_999999" }))), ["failed", "not_found"]);
  });
});

describe("FP5 — markets and charge models", () => {
  it("market support is per country: direct charges, destination only, and not supported at all", () => {
    const fake = fresh();
    const us = fake.marketSupport({ recipientCountry: "US", presentmentCurrency: "EUR" });
    assert.deepEqual([us.supported, us.chargeModels, us.settlementCurrencies, us.presentmentCurrencySupported, us.reason], [true, ["direct", "destination"], ["USD"], true, "supported"]);
    const jp = fake.marketSupport({ recipientCountry: "JP" });
    assert.deepEqual([jp.supported, jp.chargeModels, jp.presentmentCurrencySupported], [true, ["destination"], null]);
    const fr = fake.marketSupport({ recipientCountry: "FR", presentmentCurrency: "EUR" });
    assert.deepEqual([fr.supported, fr.chargeModels, fr.reason, fr.presentmentCurrencySupported], [false, [], "country_not_supported", false]);
    const jpEur = fake.marketSupport({ recipientCountry: "JP", presentmentCurrency: "EUR" });
    assert.deepEqual([jpEur.supported, jpEur.reason], [false, "currency_not_supported"]);
    assert.equal(fake.marketSupport({ recipientCountry: "constructor" }).supported, false, "an inherited property is not a market");

    assert.deepEqual(selectChargeModel(fake.capabilities(), us), { ok: true, chargeModel: "direct" });
    const refused = selectChargeModel(fake.capabilities(), jp);
    assert.deepEqual([refused.ok, !refused.ok && refused.reason], [false, "charge_model_not_supported"], "no silent fallback to a model in which the platform is the seller");
    assert.deepEqual(selectChargeModel(fake.capabilities(), jp, "destination"), { ok: true, chargeModel: "destination" });
    const none = selectChargeModel(fake.capabilities(), fr, "destination");
    assert.deepEqual([none.ok, !none.ok && none.reason], [false, "unsupported_market"]);
  });

  it("a recipient cannot be created in an unsupported market or settlement currency", async () => {
    const fake = fresh();
    const base = { idempotencyKey: "r", profileId: "p", entityType: "individual" as const, returnUrl: "a://b", refreshUrl: "a://c" };
    assert.deepEqual(tag(await fake.createRecipient({ ...base, country: "FR", settlementCurrency: "EUR" })), ["unavailable", "unsupported_market"]);
    assert.deepEqual(tag(await fake.createRecipient({ ...base, idempotencyKey: "r2", country: "US", settlementCurrency: "EUR" })), ["unavailable", "unsupported_currency"]);
  });

  it("a direct charge for a recipient in a destination-only market is unavailable; a destination charge works", async () => {
    const fake = fresh();
    const jp = await verifiedRecipient(fake, { key: "jp", country: "JP", settlementCurrency: "JPY" });
    const direct = await buildCharge({ key: "d1", recipientRef: jp, sellerMarket: "JP", buyerMarket: "JP", currency: "JPY" });
    assert.deepEqual(tag(await fake.createPaymentIntent(direct)), ["unavailable", "charge_model_not_supported"]);
    const destination = await buildCharge({ key: "d2", recipientRef: jp, sellerMarket: "JP", buyerMarket: "JP", currency: "JPY", chargeModel: "destination" });
    const created = okValue(await fake.createPaymentIntent(destination), "destination create");
    const done = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "d2-confirm", intent: intentHandle(created), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    assert.deepEqual([done.chargeModel, done.state], ["destination", "succeeded"]);
    assert.deepEqual(fake.control.balances(), { platform: { JPY: 1000 }, recipients: { [jp]: { JPY: 9000 } }, paidOut: {}, providerFees: {} });
    const eur = await buildCharge({ key: "d3", recipientRef: jp, sellerMarket: "JP", buyerMarket: "JP", currency: "EUR", chargeModel: "destination", tax: undefined });
    assert.deepEqual(tag(await fake.createPaymentIntent(eur)), ["unavailable", "unsupported_currency"]);
  });

  it("a PROVIDER with no direct charges says so in its capability flags and refuses a direct charge", async () => {
    const fake = createFakePaymentProvider({ env: LOCAL_ENV, capabilities: { chargeModels: ["destination", "platform"], manualCapture: false } });
    assert.deepEqual(fake.capabilities().chargeModels, ["destination", "platform"]);
    assert.deepEqual(fake.marketSupport({ recipientCountry: "US" }).chargeModels, ["destination"]);
    const us = await verifiedRecipient(fake, { key: "us" });
    assert.deepEqual(tag(await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef: us }))), ["unavailable", "charge_model_not_supported"]);
    const manual = await buildCharge({ key: "c2", recipientRef: us, chargeModel: "destination", capture: "manual" });
    assert.deepEqual(tag(await fake.createPaymentIntent(manual)), ["unavailable", "capability_not_supported"]);
    assert.equal(FAKE_CAPABILITIES.chargeModels.includes("direct"), true, "the default fake offers direct charges");
  });
});

describe("FP6 — original currency and amount, and conversion details", () => {
  it("a charge in the payer's currency keeps its original amount and reports the rate applied, its source and its time", async () => {
    const fake = fresh();
    const us = await verifiedRecipient(fake, { key: "us" });
    // 10 000 EUR-minor service + 1 000 tax; fee 2 000; the recipient is settled in USD.
    const created = okValue(await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef: us, buyerMarket: "GB", currency: "EUR" })), "create");
    const done = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "c1-confirm", intent: intentHandle(created), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    assert.deepEqual(done.amount, { amountMinor: 11_000, currency: "EUR" }, "the original amount and currency are never rewritten");
    assert.deepEqual(done.settlement?.settled, { amountMinor: 9900, currency: "USD" }, "9000 EUR-minor at 1.10");
    assert.deepEqual(
      [done.settlement?.conversion?.fromCurrency, done.settlement?.conversion?.toCurrency, done.settlement?.conversion?.rate, done.settlement?.conversion?.rateSource],
      ["EUR", "USD", "1.10", "fake"],
    );
    assert.ok(Date.parse(done.settlement?.conversion?.rateAt ?? "") >= FAKE_EPOCH_MS);
    assert.deepEqual(fake.control.balances(), { platform: { EUR: 2000 }, recipients: { [us]: { USD: 9900 } }, paidOut: {}, providerFees: {} });
  });

  it("a zero-decimal settlement currency is converted across exponents in integers", async () => {
    const fake = fresh();
    const jp = await verifiedRecipient(fake, { key: "jp", country: "JP", settlementCurrency: "JPY" });
    const req = await buildCharge({ key: "c1", recipientRef: jp, sellerMarket: "JP", buyerMarket: "US", currency: "USD", chargeModel: "destination" });
    const done = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "c1-confirm", intent: intentHandle(okValue(await fake.createPaymentIntent(req), "create")), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    // 10 000 USD-minor less the 1 000 commission = 90.00 USD, at 150 = 13 500 JPY (no minor unit)
    assert.deepEqual(done.settlement?.settled, { amountMinor: 13_500, currency: "JPY" });
    assert.deepEqual(done.settlement?.conversion, { fromCurrency: "USD", toCurrency: "JPY", rate: "150", rateSource: "fake", rateAt: done.settlement?.conversion?.rateAt });
    assert.deepEqual(done.settlement?.platformFeeSettled, { settled: { amountMinor: 1000, currency: "USD" }, conversion: null }, "the platform's fee stays in the charge's currency");
    assert.deepEqual(done.amount, { amountMinor: 10_000, currency: "USD" });
  });

  it("a missing rate is a refusal, not a guess", async () => {
    const fake = fresh();
    const us = await verifiedRecipient(fake, { key: "us" });
    fake.control.setRate("EUR", "USD", null);
    const r = await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef: us, buyerMarket: "GB", currency: "EUR" }));
    assert.deepEqual(tag(r), ["unavailable", "unsupported_currency"]);
  });
});

describe("FP7 — payouts and transfers", () => {
  const payoutRequest = (key: string, recipientRef: string, amountMinor: number, kind: "payout" | "transfer" = "payout", currency = "USD") => ({
    idempotencyKey: key, kind, recipientRef, amount: { amountMinor, currency }, reference: { kind: "payout_run", id: key },
  });

  it("a payout debits the recipient's balance, travels pending -> in_transit -> paid, and its status reads back", async () => {
    const fake = fresh();
    const { recipientRef } = await capturedCharge(fake);
    const requested = okValue(await fake.requestPayout(payoutRequest("po1", recipientRef, 10_000)), "request");
    assert.deepEqual([requested.state, requested.kind, requested.amount, requested.settlement, requested.failureCode], ["pending", "payout", { amountMinor: 10_000, currency: "USD" }, null, null]);
    assert.deepEqual(fake.control.balances().recipients[recipientRef], { USD: 500 });
    assert.equal(fake.control.advancePayout(requested.payoutRef).state, "in_transit");
    assert.equal(fake.control.advancePayout(requested.payoutRef).state, "paid");
    const read = okValue(await fake.getPayoutStatus(payoutHandle(requested)), "status");
    assert.deepEqual([read.state, read.settlement?.settled, read.settlement?.conversion, read.amountReversedMinor], ["paid", { amountMinor: 10_000, currency: "USD" }, null, 0]);
    assert.deepEqual(fake.control.balances(), { platform: { USD: 2000 }, recipients: { [recipientRef]: { USD: 500 } }, paidOut: { USD: 10_000 }, providerFees: {} });
    assert.deepEqual(tag(await fake.getPayoutStatus({ ...payoutHandle(requested), recipientRef: "fake_acct_999999" })), ["failed", "not_found"]);
  });

  it("scripted: a payout rejected at request is `failed / payout_rejected` and debits nothing", async () => {
    const fake = fresh();
    const { recipientRef } = await capturedCharge(fake);
    fake.control.script.failNextPayout("at_request", "account_frozen");
    const r = await fake.requestPayout(payoutRequest("po1", recipientRef, 10_000));
    assert.deepEqual(tag(r), ["failed", "payout_rejected"]);
    assert.match(r.status === "failed" ? r.detail : "", /account_frozen/);
    assert.deepEqual(fake.control.balances().recipients[recipientRef], { USD: 10_500 }, "a rejected payout debited the balance");
    assert.equal(okValue(await fake.requestPayout(payoutRequest("po2", recipientRef, 10_000)), "the next one is not scripted").state, "pending");
  });

  it("scripted: a payout that fails after instruction returns the funds to the balance with the provider's code", async () => {
    const fake = fresh();
    const { recipientRef } = await capturedCharge(fake);
    fake.control.script.failNextPayout("after_instruction", "account_closed");
    const requested = okValue(await fake.requestPayout(payoutRequest("po1", recipientRef, 10_000)), "request");
    assert.equal(requested.state, "pending", "the request itself succeeds; the failure arrives later");
    assert.deepEqual(fake.control.balances().recipients[recipientRef], { USD: 500 });
    fake.control.advancePayout(requested.payoutRef);
    const failed = fake.control.advancePayout(requested.payoutRef);
    assert.deepEqual([failed.state, failed.failureCode, failed.settlement], ["failed", "account_closed", null]);
    assert.deepEqual(fake.control.balances(), { platform: { USD: 2000 }, recipients: { [recipientRef]: { USD: 10_500 } }, paidOut: {}, providerFees: {} });
    assert.equal(okValue(await fake.getPayoutStatus(payoutHandle(requested)), "status").state, "failed", "a failed payout is a successful READ of a failed state");
    assert.throws(() => fake.control.advancePayout(requested.payoutRef), /nowhere further/);
  });

  it("scripted: a payout that is paid and then returned gives the funds back", async () => {
    const fake = fresh();
    const { recipientRef } = await capturedCharge(fake);
    fake.control.script.returnNextPayout("bank_returned");
    const requested = okValue(await fake.requestPayout(payoutRequest("po1", recipientRef, 10_000)), "request");
    fake.control.advancePayout(requested.payoutRef);
    assert.equal(fake.control.advancePayout(requested.payoutRef).state, "paid");
    assert.deepEqual(fake.control.balances().paidOut, { USD: 10_000 });
    const returned = fake.control.advancePayout(requested.payoutRef);
    assert.deepEqual([returned.state, returned.failureCode], ["returned", "bank_returned"]);
    assert.deepEqual(fake.control.balances(), { platform: { USD: 2000 }, recipients: { [recipientRef]: { USD: 10_500 } }, paidOut: { USD: 0 }, providerFees: {} });
  });

  it("a payout is declined beyond the balance or for an unverified recipient, and refused in the wrong currency", async () => {
    const fake = fresh();
    const { recipientRef } = await capturedCharge(fake);
    assert.deepEqual(tag(await fake.requestPayout(payoutRequest("po1", recipientRef, 10_501))), ["declined", "insufficient_balance"]);
    assert.deepEqual(tag(await fake.requestPayout(payoutRequest("po2", recipientRef, 100, "payout", "EUR"))), ["failed", "currency_mismatch"]);
    assert.deepEqual(tag(await fake.requestPayout(payoutRequest("po3", "fake_acct_999999", 100))), ["failed", "not_found"]);
    assert.deepEqual(tag(await fake.requestPayout(payoutRequest("po4", recipientRef, 0))), ["failed", "invalid_amount"]);
    fake.control.setRecipientOnboarding(recipientRef, "restricted");
    assert.deepEqual(tag(await fake.requestPayout(payoutRequest("po5", recipientRef, 100))), ["declined", "recipient_not_eligible"]);
    assert.deepEqual(fake.control.balances().recipients[recipientRef], { USD: 10_500 });
  });

  it("a transfer moves platform funds to the recipient's balance, and only funds the platform has", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    assert.deepEqual(tag(await fake.requestPayout(payoutRequest("tr1", recipientRef, 5000, "transfer"))), ["declined", "insufficient_balance"]);
    fake.control.fundPlatformBalance({ amountMinor: 8000, currency: "USD" });
    const transfer = okValue(await fake.requestPayout(payoutRequest("tr2", recipientRef, 5000, "transfer")), "transfer");
    assert.deepEqual([transfer.state, transfer.kind, transfer.payoutRef], ["paid", "transfer", "fake_tr_000001"]);
    assert.deepEqual(fake.control.balances(), { platform: { USD: 3000 }, recipients: { [recipientRef]: { USD: 5000 } }, paidOut: {}, providerFees: {} });
    const reversed = okValue(await fake.reverseOrHoldPayout({ idempotencyKey: "tr2-reverse", payout: payoutHandle(transfer), action: "reverse", amountMinor: "full" }), "reverse");
    assert.equal(reversed.state, "reversed");
    assert.deepEqual(fake.control.balances(), { platform: { USD: 8000 }, recipients: { [recipientRef]: { USD: 0 } }, paidOut: {}, providerFees: {} });
    assert.deepEqual(tag(await fake.reverseOrHoldPayout({ idempotencyKey: "tr2-reverse-2", payout: payoutHandle(transfer), action: "reverse", amountMinor: "full" })), ["failed", "illegal_state"]);
  });

  it("hold stops a payout that has not left, release resumes it, reverse cancels it and returns the funds", async () => {
    const fake = fresh();
    const { recipientRef } = await capturedCharge(fake);
    const requested = okValue(await fake.requestPayout(payoutRequest("po1", recipientRef, 10_000)), "request");
    const h = payoutHandle(requested);
    assert.equal(okValue(await fake.reverseOrHoldPayout({ idempotencyKey: "h1", payout: h, action: "hold", amountMinor: "full" }), "hold").state, "on_hold");
    assert.throws(() => fake.control.advancePayout(requested.payoutRef), /on hold/);
    assert.equal(okValue(await fake.reverseOrHoldPayout({ idempotencyKey: "h2", payout: h, action: "release", amountMinor: "full" }), "release").state, "pending");
    assert.equal(okValue(await fake.reverseOrHoldPayout({ idempotencyKey: "h3", payout: h, action: "reverse", amountMinor: "full" }), "reverse").state, "canceled");
    assert.deepEqual(fake.control.balances().recipients[recipientRef], { USD: 10_500 });
    assert.deepEqual(tag(await fake.reverseOrHoldPayout({ idempotencyKey: "h4", payout: h, action: "hold", amountMinor: "full" })), ["failed", "illegal_state"]);

    const second = okValue(await fake.requestPayout(payoutRequest("po2", recipientRef, 1000)), "request");
    fake.control.advancePayout(second.payoutRef);
    fake.control.advancePayout(second.payoutRef);
    assert.deepEqual(tag(await fake.reverseOrHoldPayout({ idempotencyKey: "h5", payout: payoutHandle(second), action: "reverse", amountMinor: "full" })), ["failed", "illegal_state"], "a payout that reached the bank is not reversible");
  });
});

describe("FP8 — idempotency", () => {
  it("the same key and request replays the original answer and creates nothing new", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    const request = await buildCharge({ key: "c1", recipientRef });
    const first = await fake.createPaymentIntent(request);
    const replay = await fake.createPaymentIntent({ ...request });
    assert.deepEqual(replay, first);
    const other = okValue(await fake.createPaymentIntent(await buildCharge({ key: "c2", recipientRef })), "another key");
    assert.equal(other.intentRef, "fake_pi_000002", "the replay must not have created a second intent");

    const h = intentHandle(okValue(first, "first"));
    const confirm = { idempotencyKey: "c1-confirm", intent: h, paymentMethodRef: "pm", returnUrl: null };
    const done = await fake.confirmPaymentIntent(confirm);
    assert.deepEqual(await fake.confirmPaymentIntent(confirm), done, "a retried confirm does not capture twice");
    assert.deepEqual(fake.control.balances().recipients[recipientRef], { USD: 9000 });
    const refund = { idempotencyKey: "rf1", intent: h, amountMinor: 1000, reason: "support_decision" as const, refundPlatformFee: false, reverseTransfer: false };
    await fake.refundPayment(refund);
    await fake.refundPayment(refund);
    assert.deepEqual(fake.control.balances().recipients[recipientRef], { USD: 8000 }, "a retried refund refunded twice");
  });

  it("the same key with a different request is failed / idempotency_conflict", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    okValue(await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef })), "create");
    const different = await buildCharge({ key: "c1", recipientRef, serviceMinor: 20_000 });
    assert.deepEqual(tag(await fake.createPaymentIntent(different)), ["failed", "idempotency_conflict"]);
    assert.deepEqual(tag(await fake.confirmPaymentIntent({ idempotencyKey: "", intent: { intentRef: "x", chargeModel: "direct", recipientRef }, paymentMethodRef: null, returnUrl: null })), ["failed", "invalid_request"]);
  });

  it("scripted unavailability is retriable under the same key, and consumes nothing", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    const request = await buildCharge({ key: "c1", recipientRef });
    fake.control.script.failNextOperation("createPaymentIntent", "provider_unreachable");
    const down = await fake.createPaymentIntent(request);
    assert.deepEqual(tag(down), ["unavailable", "provider_unreachable"]);
    assert.equal(down.status === "unavailable" && down.retriable, true);
    assert.equal(okValue(await fake.createPaymentIntent(request), "retry").intentRef, "fake_pi_000001");
    fake.control.script.failNextOperation("validateRecipient", "rate_limited");
    assert.deepEqual(tag(await fake.validateRecipient(recipientRef)), ["unavailable", "rate_limited"]);
    assert.equal((await fake.validateRecipient(recipientRef)).status, "ok");
  });
});

describe("FP9 — the fake is refused in production and on hosted deployments", () => {
  for (const [why, env] of REFUSED_ENVS) {
    it(`${why}: every operation answers unavailable / fake_not_permitted and changes nothing`, async () => {
      // Build real state in a permitted env, then flip the SAME instance's env: the check is at call time.
      const state = { env: LOCAL_ENV };
      const fake = createFakePaymentProvider({ get env() { return state.env; } });
      const { recipientRef, intent } = await capturedCharge(fake);
      const payout = okValue(await fake.requestPayout({ idempotencyKey: "po1", kind: "payout", recipientRef, amount: { amountMinor: 100, currency: "USD" }, reference: { kind: "x", id: "1" } }), "payout");
      const [delivery] = fake.control.webhooks.deliver();
      const before = JSON.stringify(fake.control.balances());
      state.env = env;

      const charge = await buildCharge({ key: "c9", recipientRef });
      const answers: Record<(typeof PAYMENT_PROVIDER_OPERATIONS)[number], PaymentResult<unknown>> = {
        createPaymentIntent: await fake.createPaymentIntent(charge),
        confirmPaymentIntent: await fake.confirmPaymentIntent({ idempotencyKey: "k1", intent: intentHandle(intent), paymentMethodRef: null, returnUrl: null }),
        capturePaymentIntent: await fake.capturePaymentIntent({ idempotencyKey: "k2", intent: intentHandle(intent), amountMinor: "full", partial: null }),
        cancelPaymentIntent: await fake.cancelPaymentIntent({ idempotencyKey: "k3", intent: intentHandle(intent), reason: "abandoned" }),
        getPaymentIntent: await fake.getPaymentIntent(intentHandle(intent)),
        refundPayment: await fake.refundPayment({ idempotencyKey: "k4", intent: intentHandle(intent), amountMinor: "full", reason: "duplicate", refundPlatformFee: true, reverseTransfer: false }),
        createRecipient: await fake.createRecipient({ idempotencyKey: "k5", profileId: "p", country: "US", entityType: "individual", settlementCurrency: "USD", returnUrl: "a://b", refreshUrl: "a://c" }),
        createRecipientOnboardingLink: await fake.createRecipientOnboardingLink({ idempotencyKey: "k8", recipientRef, returnUrl: "a://b", refreshUrl: "a://c" }),
        validateRecipient: await fake.validateRecipient(recipientRef),
        requestPayout: await fake.requestPayout({ idempotencyKey: "k6", kind: "payout", recipientRef, amount: { amountMinor: 100, currency: "USD" }, reference: { kind: "x", id: "2" } }),
        getPayoutStatus: await fake.getPayoutStatus(payoutHandle(payout)),
        reverseOrHoldPayout: await fake.reverseOrHoldPayout({ idempotencyKey: "k7", payout: payoutHandle(payout), action: "hold", amountMinor: "full" }),
        verifyAndParseWebhook: await fake.verifyAndParseWebhook(delivery!),
      };
      assert.deepEqual(Object.keys(answers).sort(), [...PAYMENT_PROVIDER_OPERATIONS].sort());
      for (const op of PAYMENT_PROVIDER_OPERATIONS) assert.deepEqual(tag(answers[op]), ["unavailable", "fake_not_permitted"], op);
      assert.equal(JSON.stringify(fake.control.balances()), before, "a refused fake changed its balances");

      // And the refusal is the env, not the instance: back in a local run the same calls work.
      state.env = LOCAL_ENV;
      assert.equal((await fake.getPaymentIntent(intentHandle(intent))).status, "ok");
    });
  }

  it("the control: in a local run the same instance answers", async () => {
    const fake = createFakePaymentProvider({ env: { NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv });
    assert.equal((await fake.createRecipient({ idempotencyKey: "k", profileId: "p", country: "US", entityType: "individual", settlementCurrency: "USD", returnUrl: "a://b", refreshUrl: "a://c" })).status, "requires_action");
  });
});

describe("FP10 — deterministic, no I/O, and every result status is produced", () => {
  const reached: string[] = [];
  const saved: Array<[any, string, any]> = [];
  function trap(obj: any, key: string, label: string) {
    saved.push([obj, key, obj[key]]);
    obj[key] = (..._a: unknown[]) => { reached.push(label); throw new Error(`network primitive reached: ${label}`); };
  }
  before(() => {
    trap(globalThis, "fetch", "fetch");
    trap(http, "request", "http.request"); trap(http, "get", "http.get");
    trap(https, "request", "https.request"); trap(https, "get", "https.get");
    trap(net, "connect", "net.connect"); trap(net, "createConnection", "net.createConnection");
    trap(tls, "connect", "tls.connect"); trap(dns, "lookup", "dns.lookup");
  });
  after(() => { for (const [o, k, v] of saved.reverse()) o[k] = v; });

  /** One scenario touching every operation and every scripted branch; returns everything observable. */
  async function scenario(): Promise<{ results: PaymentResult<unknown>[]; balances: unknown; deliveries: unknown; clock: number }> {
    const fake = fresh();
    const results: PaymentResult<unknown>[] = [];
    const keep = <T>(r: PaymentResult<T>): PaymentResult<T> => { results.push(r); return r; };
    const created = keep(await fake.createRecipient({ idempotencyKey: "r1", profileId: "p1", country: "US", entityType: "individual", settlementCurrency: "USD", returnUrl: "a://b", refreshUrl: "a://c" }));
    if (created.status !== "requires_action") throw new Error("unreachable");
    const recipientRef = created.value.recipientRef;
    keep(await fake.createRecipientOnboardingLink({ idempotencyKey: "link", recipientRef, returnUrl: "a://b", refreshUrl: "a://c" }));
    fake.control.setRecipientOnboarding(recipientRef, "verified");
    keep(await fake.validateRecipient(recipientRef));
    const intent = okValue(keep(await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef, tipMinor: 1500, capture: "manual" }))), "create");
    const h = intentHandle(intent);
    fake.control.script.declineNextConfirm();
    keep(await fake.confirmPaymentIntent({ idempotencyKey: "a1", intent: h, paymentMethodRef: "pm", returnUrl: null }));
    fake.control.script.requireActionOnNextConfirm();
    keep(await fake.confirmPaymentIntent({ idempotencyKey: "a2", intent: h, paymentMethodRef: "pm", returnUrl: null }));
    fake.control.completePayerAction(intent.intentRef, "authenticated");
    keep(await fake.capturePaymentIntent({ idempotencyKey: "cap", intent: h, amountMinor: "full", partial: null }));
    keep(await fake.getPaymentIntent(h));
    keep(await fake.refundPayment({ idempotencyKey: "rf", intent: h, amountMinor: 2500, reason: "support_decision", refundPlatformFee: true, reverseTransfer: false }));
    keep(await fake.cancelPaymentIntent({ idempotencyKey: "cancel", intent: h, reason: "duplicate" }));
    fake.control.script.failNextPayout("after_instruction");
    const payout = okValue(keep(await fake.requestPayout({ idempotencyKey: "po", kind: "payout", recipientRef, amount: { amountMinor: 4000, currency: "USD" }, reference: { kind: "run", id: "1" } })), "payout");
    keep(await fake.reverseOrHoldPayout({ idempotencyKey: "hold", payout: payoutHandle(payout), action: "hold", amountMinor: "full" }));
    keep(await fake.reverseOrHoldPayout({ idempotencyKey: "release", payout: payoutHandle(payout), action: "release", amountMinor: "full" }));
    fake.control.advancePayout(payout.payoutRef);
    fake.control.advancePayout(payout.payoutRef);
    keep(await fake.getPayoutStatus(payoutHandle(payout)));
    fake.control.script.failNextOperation("validateRecipient", "provider_unreachable");
    keep(await fake.validateRecipient(recipientRef));
    const deliveries = fake.control.webhooks.deliver();
    for (const d of deliveries) keep(await fake.verifyAndParseWebhook(d));
    return { results, balances: fake.control.balances(), deliveries, clock: fake.control.nowMs() };
  }

  it("two fresh fakes given the same calls give byte-identical answers, deliveries and clocks", async () => {
    const a = await scenario();
    const b = await scenario();
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.ok(a.clock > FAKE_EPOCH_MS && a.clock < FAKE_EPOCH_MS + 3_600_000, "the clock is the fake's own, not the wall's");
  });

  it("the scenario reaches no network primitive and produces all five result statuses", async () => {
    reached.length = 0;
    const { results } = await scenario();
    assert.deepEqual(reached, [], "the fake touched the network");
    assert.deepEqual([...new Set(results.map((r) => r.status))].sort(), [...PAYMENT_RESULT_STATUSES].sort());
    for (const r of results) assert.equal(r.provider, "fake");
  });

  it("money is conserved: what was captured is on a balance, refunded, or paid out", async () => {
    const fake = fresh();
    const { recipientRef, intent } = await capturedCharge(fake);
    await fake.refundPayment({ idempotencyKey: "rf", intent: intentHandle(intent), amountMinor: 2500, reason: "support_decision", refundPlatformFee: true, reverseTransfer: false });
    const payout = okValue(await fake.requestPayout({ idempotencyKey: "po", kind: "payout", recipientRef, amount: { amountMinor: 3000, currency: "USD" }, reference: { kind: "run", id: "1" } }), "payout");
    fake.control.advancePayout(payout.payoutRef);
    fake.control.advancePayout(payout.payoutRef);
    const pending = okValue(await fake.requestPayout({ idempotencyKey: "po2", kind: "payout", recipientRef, amount: { amountMinor: 1000, currency: "USD" }, reference: { kind: "run", id: "2" } }), "payout 2");
    const b = fake.control.balances();
    const onBalances = (b.platform["USD"] ?? 0) + (b.recipients[recipientRef]?.["USD"] ?? 0);
    assert.equal(onBalances + (b.paidOut["USD"] ?? 0) + pending.amount.amountMinor, 12_500 - 2500, JSON.stringify(b));
  });
});

describe("FP11 — a partial capture cannot manufacture a fee", () => {
  it("a tip-only intent captured in part carries no fee at all — 4 999 of 5 000 with a 4 999 fee is refused", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    // service 0, tip 5 000, commission 0 (the create-time rule allows nothing else), manual capture
    const created = okValue(await fake.createPaymentIntent(await buildCharge({ key: "t1", recipientRef, serviceMinor: 0, tipMinor: 5000, commissionMinor: 0, capture: "manual" })), "create");
    assert.deepEqual([created.amount.amountMinor, created.components.tipMinor, created.platformFee], [5000, 5000, { commissionMinor: 0, payerFeeMinor: 0, taxMinor: 0 }]);
    const held = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "t1-confirm", intent: intentHandle(created), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    const h = intentHandle(held);
    const tip = { serviceMinor: 0, payerFeeMinor: 0, tipMinor: 4999, taxMinor: 0 };
    const attempts: Array<[string, Parameters<typeof fake.capturePaymentIntent>[0]["partial"], string]> = [
      ["the whole captured tip as commission", { components: tip, platformFee: { commissionMinor: 4999, payerFeeMinor: 0, taxMinor: 0 } }, "fee_exceeds_commissionable_amount"],
      ["one minor unit of commission", { components: tip, platformFee: { commissionMinor: 1, payerFeeMinor: 0, taxMinor: 0 } }, "fee_exceeds_commissionable_amount"],
      ["the tip as a payer fee", { components: tip, platformFee: { commissionMinor: 0, payerFeeMinor: 4999, taxMinor: 0 } }, "invalid_amount"],
      ["the tip as platform tax", { components: tip, platformFee: { commissionMinor: 0, payerFeeMinor: 0, taxMinor: 1 } }, "invalid_amount"],
      ["the tip relabelled as service, with commission on it", { components: { serviceMinor: 4999, payerFeeMinor: 0, tipMinor: 0, taxMinor: 0 }, platformFee: { commissionMinor: 499, payerFeeMinor: 0, taxMinor: 0 } }, "invalid_amount"],
      ["the tip relabelled as a payer fee", { components: { serviceMinor: 0, payerFeeMinor: 4999, tipMinor: 0, taxMinor: 0 }, platformFee: { commissionMinor: 0, payerFeeMinor: 4999, taxMinor: 0 } }, "invalid_amount"],
    ];
    for (const [i, [name, partial, reason]] of attempts.entries()) {
      assert.deepEqual(tag(await fake.capturePaymentIntent({ idempotencyKey: `t1-x${i}`, intent: h, amountMinor: 4999, partial })), ["failed", reason], name);
    }
    assert.deepEqual(fake.control.balances().recipients, {}, "a refused capture moved money");

    const captured = okValue(
      await fake.capturePaymentIntent({ idempotencyKey: "t1-capture", intent: h, amountMinor: 4999, partial: { components: tip, platformFee: { commissionMinor: 0, payerFeeMinor: 0, taxMinor: 0 } } }),
      "the only capture the rule allows: no fee",
    );
    assert.deepEqual([captured.amountCapturedMinor, captured.platformFeeCollectedMinor], [4999, 0]);
    const b = fake.control.balances();
    assert.deepEqual([b.recipients[recipientRef], b.platform["USD"] ?? 0], [{ USD: 4999 }, 0], "the captured tip reached the recipient whole");
  });

  it("commission on a partial capture is the original commission scaled to the captured SERVICE, to the minor unit", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    const hold = async (key: string) => {
      const created = okValue(await fake.createPaymentIntent(await buildCharge({ key, recipientRef, tipMinor: 1500, capture: "manual" })), "create");
      return intentHandle(okValue(await fake.confirmPaymentIntent({ idempotencyKey: `${key}-confirm`, intent: intentHandle(created), paymentMethodRef: "pm", returnUrl: null }), "confirm"));
    };
    // Original: service 10 000 (commission 1 000), tip 1 500, tax 1 000 (platform-remitted). Captured: a third of the
    // service, the whole tip, a third of the tax. floor(1 000 × 3 333 / 10 000) = 333.
    const components = { serviceMinor: 3333, payerFeeMinor: 0, tipMinor: 1500, taxMinor: 333 };
    const over = await fake.capturePaymentIntent({ idempotencyKey: "b1", intent: await hold("b1"), amountMinor: 5166, partial: { components, platformFee: { commissionMinor: 334, payerFeeMinor: 0, taxMinor: 333 } } });
    assert.deepEqual(tag(over), ["failed", "fee_exceeds_commissionable_amount"], "334 is one over the cap: the captured tip adds nothing to it");
    const at = okValue(await fake.capturePaymentIntent({ idempotencyKey: "b2", intent: await hold("b2"), amountMinor: 5166, partial: { components, platformFee: { commissionMinor: 333, payerFeeMinor: 0, taxMinor: 333 } } }), "at the cap");
    assert.equal(at.platformFeeCollectedMinor, 666);
    assert.deepEqual(fake.control.balances().recipients[recipientRef], { USD: 4500 }, "5 166 less 666: the tip is inside what the recipient keeps");
  });
});

describe("FP12 — what a settlement reports: the provider's own fee and the platform fee's conversion", () => {
  it("direct charge: the recipient pays the processing fee; the platform's fee lands converted on the platform's balance", async () => {
    const fake = createFakePaymentProvider({ env: LOCAL_ENV, processingFeeBps: 300, platformSettlementCurrency: "USD" });
    const us = await verifiedRecipient(fake, { key: "us" });
    // 11 000 EUR-minor (10 000 service + 1 000 tax); platform fee 2 000; processing 3% of 11 000 = 330.
    const created = okValue(await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef: us, buyerMarket: "GB", currency: "EUR" })), "create");
    const done = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "c1-confirm", intent: intentHandle(created), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    const s = done.settlement;
    assert.deepEqual(done.amount, { amountMinor: 11_000, currency: "EUR" });
    assert.deepEqual(s?.settled, { amountMinor: 9537, currency: "USD" }, "(11 000 − 2 000 − 330) EUR-minor at 1.10");
    assert.deepEqual(s?.providerFee, { amount: { amountMinor: 363, currency: "USD" }, paidBy: "recipient" });
    assert.deepEqual(s?.platformFeeSettled?.settled, { amountMinor: 2200, currency: "USD" });
    assert.deepEqual([s?.platformFeeSettled?.conversion?.fromCurrency, s?.platformFeeSettled?.conversion?.toCurrency, s?.platformFeeSettled?.conversion?.rate], ["EUR", "USD", "1.10"]);
    assert.deepEqual(fake.control.balances(), { platform: { USD: 2200 }, recipients: { [us]: { USD: 9537 } }, paidOut: {}, providerFees: { USD: 363 } });
  });

  it("destination and platform charges: the PLATFORM pays the processing fee", async () => {
    const fake = createFakePaymentProvider({ env: LOCAL_ENV, processingFeeBps: 300, platformSettlementCurrency: "USD" });
    const jp = await verifiedRecipient(fake, { key: "jp", country: "JP", settlementCurrency: "JPY" });
    const req = await buildCharge({ key: "d1", recipientRef: jp, sellerMarket: "JP", buyerMarket: "US", currency: "USD", chargeModel: "destination" });
    const done = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "d1-confirm", intent: intentHandle(okValue(await fake.createPaymentIntent(req), "create")), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    assert.deepEqual(done.settlement?.settled, { amountMinor: 13_500, currency: "JPY" }, "the recipient is not charged the processing fee");
    assert.deepEqual(done.settlement?.providerFee, { amount: { amountMinor: 300, currency: "USD" }, paidBy: "platform" });
    assert.deepEqual(done.settlement?.platformFeeSettled, { settled: { amountMinor: 1000, currency: "USD" }, conversion: null });
    assert.deepEqual(fake.control.balances(), { platform: { USD: 700 }, recipients: { [jp]: { JPY: 13_500 } }, paidOut: {}, providerFees: { USD: 300 } });

    const own = okValue(await fake.createPaymentIntent(await buildCharge({ key: "p1", recipientRef: null, chargeModel: "platform" })), "platform create");
    const paid = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "p1-confirm", intent: intentHandle(own), paymentMethodRef: null, returnUrl: null }), "platform confirm");
    assert.deepEqual(paid.settlement, {
      settled: { amountMinor: 10_670, currency: "USD" },
      conversion: null,
      providerFee: { amount: { amountMinor: 330, currency: "USD" }, paidBy: "platform" },
      platformFeeSettled: null,
    });
  });

  it("with no rate to the platform's currency the charge is refused before anything exists", async () => {
    const fake = createFakePaymentProvider({ env: LOCAL_ENV, platformSettlementCurrency: "GBP" });
    const us = await verifiedRecipient(fake, { key: "us" });
    fake.control.setRate("USD", "GBP", null);
    assert.deepEqual(tag(await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef: us }))), ["unavailable", "unsupported_currency"]);
  });

  it("confirm: a return URL means an off-site step and a redirect; none means the client finishes in-app", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    for (const [key, returnUrl, redirects] of [["a", "travelbuddy://pay/return", true], ["b", null, false]] as const) {
      const created = okValue(await fake.createPaymentIntent(await buildCharge({ key, recipientRef })), "create");
      fake.control.script.requireActionOnNextConfirm();
      const r = await fake.confirmPaymentIntent({ idempotencyKey: `${key}-confirm`, intent: intentHandle(created), paymentMethodRef: "pm", returnUrl });
      assert.equal(r.status, "requires_action");
      assert.equal(r.status === "requires_action" && r.action.kind === "payer_authentication" && r.action.redirectUrl !== null, redirects, key);
    }
    const created = okValue(await fake.createPaymentIntent(await buildCharge({ key: "c", recipientRef })), "create");
    assert.deepEqual(tag(await fake.confirmPaymentIntent({ idempotencyKey: "c-confirm", intent: intentHandle(created), paymentMethodRef: "pm", returnUrl: "" })), ["failed", "invalid_request"]);
  });
});

describe("FP13 — a refund on a destination charge: who bears it is stated, both ways", () => {
  const charged = async (fake: FakePaymentProvider) => {
    const jp = await verifiedRecipient(fake, { key: "jp", country: "JP", settlementCurrency: "JPY" });
    const req = await buildCharge({ key: "d1", recipientRef: jp, sellerMarket: "JP", buyerMarket: "JP", currency: "JPY", chargeModel: "destination" });
    const intent = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "d1-confirm", intent: intentHandle(okValue(await fake.createPaymentIntent(req), "create")), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    assert.deepEqual(fake.control.balances(), { platform: { JPY: 1000 }, recipients: { [jp]: { JPY: 9000 } }, paidOut: {}, providerFees: {} });
    return { jp, intent };
  };

  it("reverseTransfer + refundPlatformFee: the transfer comes back and the fee is returned — every balance to zero", async () => {
    const fake = fresh();
    const { jp, intent } = await charged(fake);
    const refund = okValue(await fake.refundPayment({ idempotencyKey: "rf", intent: intentHandle(intent), amountMinor: "full", reason: "provider_cancelled", refundPlatformFee: true, reverseTransfer: true }), "refund");
    assert.deepEqual([refund.amount.amountMinor, refund.platformFeeRefundedMinor, refund.fullyRefunded], [10_000, 1000, true]);
    assert.deepEqual(fake.control.balances(), { platform: { JPY: 0 }, recipients: { [jp]: { JPY: 0 } }, paidOut: {}, providerFees: {} });
  });

  it("neither: the recipient keeps their funds and the PLATFORM bears the refund", async () => {
    const fake = fresh();
    const { jp, intent } = await charged(fake);
    okValue(await fake.refundPayment({ idempotencyKey: "rf", intent: intentHandle(intent), amountMinor: "full", reason: "support_decision", refundPlatformFee: false, reverseTransfer: false }), "refund");
    assert.deepEqual(fake.control.balances(), { platform: { JPY: -9000 }, recipients: { [jp]: { JPY: 9000 } }, paidOut: {}, providerFees: {} });
  });

  it("reverseTransfer must be stated, and is refused on a charge with no transfer to reverse", async () => {
    const fake = fresh();
    const { intent } = await charged(fake);
    const h = intentHandle(intent);
    assert.deepEqual(tag(await fake.refundPayment({ idempotencyKey: "r0", intent: h, amountMinor: "full", reason: "duplicate", refundPlatformFee: true } as any)), ["failed", "invalid_request"], "reverseTransfer has no default");
    const { intent: direct } = await capturedCharge(fake, "c2");
    assert.deepEqual(
      tag(await fake.refundPayment({ idempotencyKey: "r1", intent: intentHandle(direct), amountMinor: "full", reason: "duplicate", refundPlatformFee: true, reverseTransfer: true })),
      ["failed", "invalid_request"],
      "a direct charge has no transfer",
    );
    assert.deepEqual(tag(await fake.refundPayment({ idempotencyKey: "r2", intent: h, amountMinor: "full", reason: "because" as any, refundPlatformFee: true, reverseTransfer: true })), ["failed", "invalid_request"]);
  });
});

describe("FP14 — partial transfer reversal, and a payout the provider started", () => {
  it("a transfer comes back in parts; only a transfer may, and never more than is left", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    fake.control.fundPlatformBalance({ amountMinor: 8000, currency: "USD" });
    const transfer = okValue(await fake.requestPayout({ idempotencyKey: "tr", kind: "transfer", recipientRef, amount: { amountMinor: 5000, currency: "USD" }, reference: { kind: "earnings", id: "1" } }), "transfer");
    const h = payoutHandle(transfer);
    const part = okValue(await fake.reverseOrHoldPayout({ idempotencyKey: "rv1", payout: h, action: "reverse", amountMinor: 2000 }), "partial reversal");
    assert.deepEqual([part.state, part.amountReversedMinor, part.amount.amountMinor], ["paid", 2000, 5000]);
    assert.deepEqual(fake.control.balances(), { platform: { USD: 5000 }, recipients: { [recipientRef]: { USD: 3000 } }, paidOut: {}, providerFees: {} });
    assert.deepEqual(tag(await fake.reverseOrHoldPayout({ idempotencyKey: "rv2", payout: h, action: "reverse", amountMinor: 3001 })), ["failed", "amount_exceeds_reversible"]);
    const rest = okValue(await fake.reverseOrHoldPayout({ idempotencyKey: "rv3", payout: h, action: "reverse", amountMinor: "full" }), "the rest");
    assert.deepEqual([rest.state, rest.amountReversedMinor], ["reversed", 5000]);
    assert.deepEqual(fake.control.balances(), { platform: { USD: 8000 }, recipients: { [recipientRef]: { USD: 0 } }, paidOut: {}, providerFees: {} });
    assert.deepEqual(tag(await fake.reverseOrHoldPayout({ idempotencyKey: "rv4", payout: h, action: "hold", amountMinor: 100 })), ["failed", "invalid_request"], "only a reversal may be partial");
    assert.deepEqual(tag(await fake.reverseOrHoldPayout({ idempotencyKey: "rv5", payout: h, action: "reverse", amountMinor: 0 })), ["failed", "invalid_amount"]);
  });

  it("a payout is cancelled whole: a partial amount is refused", async () => {
    const fake = fresh();
    const { recipientRef } = await capturedCharge(fake);
    const payout = okValue(await fake.requestPayout({ idempotencyKey: "po", kind: "payout", recipientRef, amount: { amountMinor: 1000, currency: "USD" }, reference: { kind: "run", id: "1" } }), "payout");
    assert.deepEqual(tag(await fake.reverseOrHoldPayout({ idempotencyKey: "c1", payout: payoutHandle(payout), action: "reverse", amountMinor: 500 })), ["failed", "invalid_request"]);
  });

  it("a payout the PROVIDER initiated has no platform reference, and reads, verifies and folds like any other", async () => {
    const fake = fresh();
    const { recipientRef } = await capturedCharge(fake);
    fake.control.webhooks.deliver();
    const auto = fake.control.providerInitiatedPayout(recipientRef, 4000);
    assert.deepEqual([auto.reference, auto.kind, auto.state, auto.amount], [null, "payout", "pending", { amountMinor: 4000, currency: "USD" }]);
    assert.deepEqual(fake.control.balances().recipients[recipientRef], { USD: 6500 });
    assert.equal(okValue(await fake.getPayoutStatus(payoutHandle(auto)), "status").reference, null);
    const [delivery] = fake.control.webhooks.deliver();
    const event = okValue(await fake.verifyAndParseWebhook(delivery!), "verify");
    assert.deepEqual(event.body.kind === "payout" && [event.body.payout.reference, event.body.payout.payoutRef], [null, auto.payoutRef]);
    assert.throws(() => fake.control.providerInitiatedPayout(recipientRef, 6501), /does not cover/);
  });
});

describe("FP15 — currency granularity", () => {
  it("a three-decimal currency is charged in multiples of 10 minor units, and converts across exponents", async () => {
    const fake = fresh();
    const us = await verifiedRecipient(fake, { key: "us" });
    // 10.000 KWD service + 1.000 tax; the fee is 2.000; 9.000 KWD at 3.25 = 29.25 USD
    const created = okValue(await fake.createPaymentIntent(await buildCharge({ key: "k1", recipientRef: us, buyerMarket: "GB", currency: "KWD" })), "create");
    const done = okValue(await fake.confirmPaymentIntent({ idempotencyKey: "k1-confirm", intent: intentHandle(created), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    assert.deepEqual([done.amount, done.settlement?.settled], [{ amountMinor: 11_000, currency: "KWD" }, { amountMinor: 2925, currency: "USD" }]);
    // 10.005 KWD cannot be charged: only two of its three decimals exist on the rails.
    const odd = await buildCharge({ key: "k2", recipientRef: us, buyerMarket: "GB", currency: "KWD", serviceMinor: 10_005, commissionMinor: 1000 });
    assert.deepEqual(tag(await fake.createPaymentIntent(odd)), ["failed", "invalid_amount"]);
    assert.deepEqual(tag(await fake.requestPayout({ idempotencyKey: "po", kind: "transfer", recipientRef: us, amount: { amountMinor: 1005, currency: "KWD" }, reference: { kind: "x", id: "1" } })), ["failed", "invalid_amount"]);
    const h = intentHandle(done);
    assert.deepEqual(tag(await fake.refundPayment({ idempotencyKey: "rf1", intent: h, amountMinor: 1005, reason: "support_decision", refundPlatformFee: false, reverseTransfer: false })), ["failed", "invalid_amount"], "1.005 KWD cannot be refunded");
    assert.equal(okValue(await fake.refundPayment({ idempotencyKey: "rf2", intent: h, amountMinor: 1000, reason: "support_decision", refundPlatformFee: false, reverseTransfer: false }), "1.000 KWD").amount.amountMinor, 1000);
  });
});
