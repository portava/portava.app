/**
 * ONE contract suite for every PaymentProvider adapter: the behaviour a caller
 * (services/payments/bookingPayments/) relies on, stated without reference to
 * any provider's internals. The fake runs it (test/fakePaymentProviderContract.test.ts)
 * and so does the Stripe Connect adapter over its stubbed transport
 * (test/stripeConnectProvider.test.ts): the same cases, the same assertions.
 *
 *   K1  markets: a documented market is offered with direct charges; an
 *       undocumented one is not
 *   K2  a direct charge: the original amount, components and platform fee
 *       survive; the charge is on the recipient; nothing is captured yet
 *   K3  confirm: ok and captured; declined WITH the snapshot; requires_action
 *       with a client secret
 *   K4  manual capture: authorised, then captured in full
 *   K5  cancel an open intent; cancelling a captured one is illegal_state
 *   K6  refunds: a partial refund returns part of the platform fee when asked;
 *       a full refund returns the rest; the counters agree
 *   K7  idempotency: the same key and request replays; the same key with a
 *       different request is idempotency_conflict
 *   K8  recipients: outstanding -> requires_action with requirement CODES;
 *       pending verification; verified -> ok; rejected -> declined; a link
 *   K9  payouts: requested against the recipient's balance, read back,
 *       cancelled while pending; hold is honoured or refused as the
 *       capabilities say
 *   K10 webhooks: every delivery verifies and parses; the captured intent is
 *       reported; a tampered body, the other endpoint's secret, a live event
 *       and a verified-but-unreadable body are each refused by name
 *   K11 an outage is a retriable `unavailable`, never a throw
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DECLINE_REASONS,
  intentHandle,
  payoutHandle,
  type PaymentIntentSnapshot,
  type PaymentProvider,
  type PaymentProviderOperation,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "../../services/payments/PaymentProvider.js";
import { buildCharge, okValue } from "./paymentFixtures.js";

export interface ContractHarness {
  readonly provider: PaymentProvider;
  /** A recipient in `country`, whose onboarding is outstanding. */
  newRecipient(key: string, country?: string): Promise<string>;
  verify(recipientRef: string): void;
  pending(recipientRef: string): void;
  reject(recipientRef: string): void;
  declineNextConfirm(): void;
  requireActionNextConfirm(): void;
  /** The next call of `operation` meets an outage. */
  failNext(operation: PaymentProviderOperation): void;
  /** Signed deliveries of every event not yet handed out. */
  deliveries(opts?: { livemode?: boolean }): WebhookDelivery[];
  sign(rawBody: string, endpoint: WebhookEndpoint): WebhookDelivery;
  /** A market this provider documents, with its currency. */
  readonly market: { country: string; currency: string };
}

export function runPaymentProviderContract(label: string, make: () => ContractHarness): void {
  const verified = async (h: ContractHarness, key: string) => {
    const ref = await h.newRecipient(key, h.market.country);
    h.verify(ref);
    return ref;
  };
  const charge = async (h: ContractHarness, key: string, recipientRef: string, over: { capture?: "automatic" | "manual"; tipMinor?: number } = {}) =>
    okValue(await h.provider.createPaymentIntent(await buildCharge({ key, recipientRef, sellerMarket: h.market.country, buyerMarket: h.market.country, currency: h.market.currency, ...over })), `create ${key}`);
  const captured = async (h: ContractHarness, key: string) => {
    const rec = await verified(h, `r-${key}`);
    const created = await charge(h, key, rec, { tipMinor: 1500 });
    const conf = okValue(await h.provider.confirmPaymentIntent({ idempotencyKey: `${key}-confirm`, intent: intentHandle(created), paymentMethodRef: "pm_card_visa", returnUrl: null }), "confirm");
    return { rec, created, conf };
  };

  describe(`${label} — the PaymentProvider contract (K1-K11)`, () => {
    it("K1 a documented market is offered with direct charges; an undocumented one is not", () => {
      const h = make();
      const m = h.provider.marketSupport({ recipientCountry: h.market.country, presentmentCurrency: h.market.currency });
      assert.equal(m.supported, true, JSON.stringify(m));
      assert.ok(m.chargeModels.includes("direct"));
      assert.equal(h.provider.marketSupport({ recipientCountry: "AQ" }).supported, false);
    });

    it("K2 a direct charge keeps the original amount, components and fee, on the recipient, nothing captured", async () => {
      const h = make();
      const rec = await verified(h, "r-k2");
      const req = await buildCharge({ key: "k2", recipientRef: rec, sellerMarket: h.market.country, buyerMarket: h.market.country, currency: h.market.currency, tipMinor: 1500 });
      const snap = okValue(await h.provider.createPaymentIntent(req), "create");
      assert.equal(snap.chargeModel, "direct");
      assert.equal(snap.recipientRef, rec);
      assert.deepEqual(snap.amount, req.amount);
      assert.deepEqual(snap.components, req.components);
      assert.deepEqual(snap.platformFee, req.platformFee);
      assert.deepEqual(snap.reference, req.reference);
      assert.ok(snap.state === "requires_payment_method" || snap.state === "requires_confirmation", snap.state);
      assert.equal(snap.amountCapturedMinor, 0);
      assert.equal(snap.livemode, false);
    });

    it("K3 confirm: ok and captured; a decline carries the snapshot; an authentication step carries a client secret", async () => {
      const h = make();
      const { created, conf } = await captured(h, "k3");
      assert.equal(conf.intentRef, created.intentRef);
      assert.equal(conf.state, "succeeded");
      assert.equal(conf.amountCapturedMinor, created.amount.amountMinor);
      assert.equal(conf.platformFeeCollectedMinor, created.platformFee.commissionMinor + created.platformFee.payerFeeMinor + created.platformFee.taxMinor);

      const rec = await verified(h, "r-k3b");
      const second = await charge(h, "k3b", rec);
      h.declineNextConfirm();
      const d = await h.provider.confirmPaymentIntent({ idempotencyKey: "k3b-confirm", intent: intentHandle(second), paymentMethodRef: "pm_card_declined", returnUrl: null });
      assert.equal(d.status, "declined", JSON.stringify(d));
      if (d.status === "declined") {
        assert.ok((DECLINE_REASONS as readonly string[]).includes(d.reason));
        assert.equal(d.value?.state, "requires_payment_method");
      }

      const third = await charge(h, "k3c", rec);
      h.requireActionNextConfirm();
      const a = await h.provider.confirmPaymentIntent({ idempotencyKey: "k3c-confirm", intent: intentHandle(third), paymentMethodRef: "pm_card_3ds", returnUrl: null });
      assert.equal(a.status, "requires_action", JSON.stringify(a));
      if (a.status === "requires_action") {
        assert.equal(a.action.kind, "payer_authentication");
        if (a.action.kind === "payer_authentication") assert.ok(a.action.clientSecret.length > 0);
      }
    });

    it("K4 manual capture: authorised, then captured in full with the fee", async () => {
      const h = make();
      const rec = await verified(h, "r-k4");
      const created = await charge(h, "k4", rec, { capture: "manual" });
      const auth = okValue(await h.provider.confirmPaymentIntent({ idempotencyKey: "k4-confirm", intent: intentHandle(created), paymentMethodRef: "pm_card_visa", returnUrl: null }), "confirm");
      assert.equal(auth.state, "requires_capture");
      assert.equal(auth.amountCapturableMinor, created.amount.amountMinor);
      const cap = okValue(await h.provider.capturePaymentIntent({ idempotencyKey: "k4-capture", intent: intentHandle(created), amountMinor: "full", partial: null }), "capture");
      assert.equal(cap.state, "succeeded");
      assert.equal(cap.amountCapturedMinor, created.amount.amountMinor);
      assert.ok(cap.platformFeeCollectedMinor > 0);
    });

    it("K5 an open intent is cancelled; a captured one cannot be (illegal_state)", async () => {
      const h = make();
      const rec = await verified(h, "r-k5");
      const open = await charge(h, "k5", rec);
      const c = okValue(await h.provider.cancelPaymentIntent({ idempotencyKey: "k5-cancel", intent: intentHandle(open), reason: "abandoned" }), "cancel");
      assert.equal(c.state, "canceled");
      const { created } = await captured(h, "k5b");
      const late = await h.provider.cancelPaymentIntent({ idempotencyKey: "k5b-cancel", intent: intentHandle(created), reason: "abandoned" });
      assert.equal(late.status, "failed", JSON.stringify(late));
      if (late.status === "failed") assert.equal(late.reason, "illegal_state");
    });

    it("K6 a partial refund returns part of the platform fee when asked; a full refund returns the rest", async () => {
      const h = make();
      const { created, conf } = await captured(h, "k6");
      const part = okValue(await h.provider.refundPayment({ idempotencyKey: "k6-r1", intent: intentHandle(created), amountMinor: 2000, reason: "support_decision", refundPlatformFee: true, reverseTransfer: false }), "partial refund");
      assert.equal(part.amount.amountMinor, 2000);
      assert.equal(part.fullyRefunded, false);
      assert.ok(part.platformFeeRefundedMinor > 0 && part.platformFeeRefundedMinor < conf.platformFeeCollectedMinor, JSON.stringify(part));
      const rest = okValue(await h.provider.refundPayment({ idempotencyKey: "k6-r2", intent: intentHandle(created), amountMinor: "full", reason: "cancelled_before_service", refundPlatformFee: true, reverseTransfer: false }), "full refund");
      assert.equal(rest.fullyRefunded, true);
      const after = okValue(await h.provider.getPaymentIntent(intentHandle(created)), "read");
      assert.equal(after.amountRefundedMinor, after.amountCapturedMinor);
      assert.equal(after.platformFeeRefundedMinor, after.platformFeeCollectedMinor);
      assert.equal(part.platformFeeRefundedMinor + rest.platformFeeRefundedMinor, after.platformFeeRefundedMinor);
    });

    it("K7 the same key and request replays; the same key with a different request is idempotency_conflict", async () => {
      const h = make();
      const rec = await verified(h, "r-k7");
      const req = await buildCharge({ key: "k7", recipientRef: rec, sellerMarket: h.market.country, buyerMarket: h.market.country, currency: h.market.currency });
      const a = okValue(await h.provider.createPaymentIntent(req), "first");
      const b = okValue(await h.provider.createPaymentIntent(req), "replay");
      assert.equal(b.intentRef, a.intentRef);
      const other = await buildCharge({ key: "k7", recipientRef: rec, sellerMarket: h.market.country, buyerMarket: h.market.country, currency: h.market.currency, serviceMinor: 20_000 });
      const c = await h.provider.createPaymentIntent(other);
      assert.equal(c.status, "failed", JSON.stringify(c));
      if (c.status === "failed") assert.equal(c.reason, "idempotency_conflict");
    });

    it("K8 recipients: outstanding, pending verification, verified, rejected; and an onboarding link", async () => {
      const h = make();
      const ref = await h.newRecipient("r-k8", h.market.country);
      const out = await h.provider.validateRecipient(ref);
      assert.equal(out.status, "requires_action", JSON.stringify(out));
      if (out.status === "requires_action") {
        assert.equal(out.reason, "recipient_onboarding_required");
        assert.ok(out.value.requirementsDue.length > 0);
        assert.ok(out.value.requirementsDue.every((c) => /^[a-z0-9_.]+$/.test(c)), "requirement CODES only");
      }
      const link = okValue(await h.provider.createRecipientOnboardingLink({ idempotencyKey: "r-k8-link", recipientRef: ref, returnUrl: "app://ok", refreshUrl: "app://again" }), "link");
      assert.ok(link.url.startsWith("https://"));
      assert.ok(Number.isFinite(Date.parse(link.expiresAt)));
      h.pending(ref);
      const pend = await h.provider.validateRecipient(ref);
      assert.equal(pend.status, "requires_action");
      if (pend.status === "requires_action") assert.equal(pend.reason, "recipient_verification_pending");
      h.verify(ref);
      const ok = okValue(await h.provider.validateRecipient(ref), "verified");
      assert.equal(ok.onboarding, "verified");
      assert.equal(ok.chargesEnabled && ok.payoutsEnabled, true);
      const other = await h.newRecipient("r-k8b", h.market.country);
      h.reject(other);
      const rej = await h.provider.validateRecipient(other);
      assert.equal(rej.status, "declined", JSON.stringify(rej));
      if (rej.status === "declined") assert.equal(rej.reason, "recipient_rejected");
    });

    it("K9 payouts: requested against the balance, read back, cancelled while pending; hold as the capabilities say", async () => {
      const h = make();
      const { rec } = await captured(h, "k9");
      const ask = (key: string, amountMinor: number) =>
        h.provider.requestPayout({ idempotencyKey: key, kind: "payout", recipientRef: rec, amount: { amountMinor, currency: h.market.currency }, reference: { kind: "rab_monthly_payout", id: key } });
      const too = await ask("k9-too-much", 10_000_000);
      assert.equal(too.status, "declined", JSON.stringify(too));
      if (too.status === "declined") assert.equal(too.reason, "insufficient_balance");
      const po = okValue(await ask("k9-po", 1000), "payout");
      assert.ok(po.state === "pending" || po.state === "in_transit", po.state);
      assert.deepEqual(po.reference, { kind: "rab_monthly_payout", id: "k9-po" });
      const read = okValue(await h.provider.getPayoutStatus(payoutHandle(po)), "read");
      assert.equal(read.payoutRef, po.payoutRef);
      const hold = await h.provider.reverseOrHoldPayout({ idempotencyKey: "k9-hold", payout: payoutHandle(po), action: "hold", amountMinor: "full" });
      if (h.provider.capabilities().payoutHold) assert.equal(hold.status, "ok", JSON.stringify(hold));
      else {
        assert.equal(hold.status, "unavailable", JSON.stringify(hold));
        if (hold.status === "unavailable") assert.equal(hold.reason, "capability_not_supported");
        const po2 = okValue(await ask("k9-po2", 500), "second payout");
        const cancel = okValue(await h.provider.reverseOrHoldPayout({ idempotencyKey: "k9-cancel", payout: payoutHandle(po2), action: "reverse", amountMinor: "full" }), "cancel");
        assert.equal(cancel.state, "canceled");
      }
    });

    it("K10 webhooks: every delivery verifies and parses; the captured intent is reported; forgeries, the wrong endpoint, live events and unreadable bodies are refused by name", async () => {
      const h = make();
      const { created } = await captured(h, "k10");
      const deliveries = h.deliveries();
      assert.ok(deliveries.length > 0);
      let reported: PaymentIntentSnapshot | null = null;
      for (const d of deliveries) {
        const e = okValue(await h.provider.verifyAndParseWebhook(d), `delivery on ${d.endpoint}`);
        assert.equal(e.endpoint, d.endpoint);
        assert.equal(e.livemode, false);
        if (e.body.kind === "payment_intent" && e.body.intent.intentRef === created.intentRef && e.body.intent.state === "succeeded") reported = e.body.intent;
      }
      assert.ok(reported, "the captured intent was reported by a webhook");
      assert.equal(reported!.amountCapturedMinor, created.amount.amountMinor);

      const one = deliveries.find((d) => d.endpoint === "connect") ?? deliveries[0]!;
      const tampered = { ...one, rawBody: one.rawBody.replace(/"livemode":false/, '"livemode":false ') };
      const t = await h.provider.verifyAndParseWebhook(tampered);
      assert.equal(t.status, "failed");
      if (t.status === "failed") assert.equal(t.reason, "signature_invalid");
      const wrongEndpoint = { ...one, endpoint: (one.endpoint === "connect" ? "platform" : "connect") as WebhookEndpoint };
      const w = await h.provider.verifyAndParseWebhook(wrongEndpoint);
      assert.equal(w.status, "failed", "a delivery verified with the other endpoint's secret is refused");

      const rec2 = await verified(h, "r-k10b");
      await charge(h, "k10b", rec2);
      const live = h.deliveries({ livemode: true });
      assert.ok(live.length > 0);
      const l = await h.provider.verifyAndParseWebhook(live[live.length - 1]!);
      assert.equal(l.status, "unavailable", JSON.stringify(l));
      if (l.status === "unavailable") assert.equal(l.reason, "livemode_not_allowed");

      const junk = await h.provider.verifyAndParseWebhook(h.sign("not json", "platform"));
      assert.equal(junk.status, "failed");
      if (junk.status === "failed") assert.equal(junk.reason, "webhook_malformed");
    });

    it("K11 an outage is a retriable unavailable, never a throw", async () => {
      const h = make();
      const rec = await verified(h, "r-k11");
      h.failNext("createPaymentIntent");
      const r = await h.provider.createPaymentIntent(await buildCharge({ key: "k11", recipientRef: rec, sellerMarket: h.market.country, buyerMarket: h.market.country, currency: h.market.currency }));
      assert.equal(r.status, "unavailable", JSON.stringify(r));
      if (r.status === "unavailable") {
        assert.equal(r.reason, "provider_unreachable");
        assert.equal(r.retriable, true);
      }
    });
  });
}
