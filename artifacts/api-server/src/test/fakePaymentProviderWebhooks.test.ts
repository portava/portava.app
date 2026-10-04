/**
 * PAY-T03 — webhooks through the contract: verify-and-parse on the fake
 * provider, and the order-independent fold (services/payments/paymentEventFold.ts).
 *
 *   FW1  raw body + signature -> a typed event with the provider's event id and
 *        its livemode flag; the signature is checked over the RAW bytes first
 *   FW2  a livemode:true event is REFUSED unless PAYMENTS_ALLOW_LIVE is exactly
 *        "true" — after the signature is verified, never instead of it
 *   FW3  delivered twice: the same event id, and the fold counts it once
 *   FW4  delivered late and out of order: an older snapshot arriving after a
 *        newer one is stale and changes nothing
 *   FW5  the property: every permutation of the deliveries, with duplicates,
 *        folds to the same state as the in-order sequence
 *
 * `09_Payment_Architecture.md` §7: "the PSP's event id is the idempotency key
 * and the handler must be order-independent as well as duplicate-safe."
 *
 * Run: node --import tsx/esm --test src/test/fakePaymentProviderWebhooks.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { assertWebhookLivemodeAllowed, webhookLivemodeRefused } from "../lib/paymentsMode.js";
import {
  FAKE_SIGNATURE_HEADER,
  FAKE_WEBHOOK_SECRET,
  createFakePaymentProvider,
  type FakePaymentProvider,
} from "../services/payments/FakePaymentProvider.js";
import { intentHandle, type PaymentWebhookEvent, type WebhookDelivery } from "../services/payments/PaymentProvider.js";
import {
  applyPaymentEvent,
  canonicalJson,
  describePaymentEventState,
  emptyPaymentEventState,
  foldPaymentEvents,
  type PaymentEventOutcome,
} from "../services/payments/paymentEventFold.js";
import { verifyPaymentWebhookSignature } from "../services/payments/paymentWebhookSignature.js";
import { LOCAL_ENV, buildCharge, okValue, permutations, tag, verifiedRecipient } from "./helpers/paymentFixtures.js";

const fresh = (env: NodeJS.ProcessEnv = LOCAL_ENV): FakePaymentProvider => createFakePaymentProvider({ env });

/**
 * One payment's life, producing seven events in emission order:
 *   0 recipient.created          1 recipient.updated (verified)
 *   2 payment_intent.created     3 payment_intent.requires_action
 *   4 payment_intent.succeeded   5 refund.succeeded
 *   6 payment_intent.refunded
 */
async function lifecycle(fake: FakePaymentProvider): Promise<{ recipientRef: string; intentRef: string }> {
  const recipientRef = await verifiedRecipient(fake, { key: "r1" });
  const created = okValue(await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef, tipMinor: 1500 })), "create");
  fake.control.script.requireActionOnNextConfirm();
  await fake.confirmPaymentIntent({ idempotencyKey: "c1-confirm", intent: intentHandle(created), paymentMethodRef: "pm" });
  fake.control.completePayerAction(created.intentRef, "authenticated");
  okValue(await fake.refundPayment({ idempotencyKey: "rf1", intent: intentHandle(created), amountMinor: 2500, reason: "support_decision", refundPlatformFee: true }), "refund");
  return { recipientRef, intentRef: created.intentRef };
}

async function parseAll(fake: FakePaymentProvider, deliveries: readonly WebhookDelivery[]): Promise<PaymentWebhookEvent[]> {
  const events: PaymentWebhookEvent[] = [];
  for (const d of deliveries) events.push(okValue(await fake.verifyAndParseWebhook(d), "verify"));
  return events;
}

describe("FW1 — raw body + signature -> a typed event", () => {
  it("each delivery verifies and parses to an event with the provider's id, type, livemode flag, time and account", async () => {
    const fake = fresh();
    const { recipientRef, intentRef } = await lifecycle(fake);
    assert.deepEqual(
      fake.control.webhooks.pending().map((p) => p.providerEventType),
      ["recipient.created", "recipient.updated", "payment_intent.created", "payment_intent.requires_action", "payment_intent.succeeded", "refund.succeeded", "payment_intent.refunded"],
    );
    const events = await parseAll(fake, fake.control.webhooks.deliver());
    assert.equal(fake.control.webhooks.pending().length, 0, "delivered events leave the outbox");
    assert.deepEqual(events.map((e) => e.providerEventId), [1, 2, 3, 4, 5, 6, 7].map((n) => `fake_evt_00000${n}`));
    for (const e of events) {
      assert.deepEqual([e.provider, e.livemode, e.accountRef], ["fake", false, recipientRef], e.providerEventType);
      assert.ok(Number.isFinite(Date.parse(e.occurredAt)), e.providerEventType);
    }
    assert.deepEqual(events.map((e) => e.body.kind), ["recipient", "recipient", "payment_intent", "payment_intent", "payment_intent", "refund", "payment_intent"]);
    const succeeded = events[4]!;
    assert.equal(succeeded.body.kind === "payment_intent" && succeeded.body.intent.state, "succeeded");
    assert.equal(succeeded.body.kind === "payment_intent" && succeeded.body.intent.intentRef, intentRef);
    const refund = events[5]!;
    assert.deepEqual(refund.body.kind === "refund" && [refund.body.refund.amount, refund.body.refund.platformFeeRefundedMinor], [{ amountMinor: 2500, currency: "USD" }, 400]);
    const last = events[6]!;
    assert.deepEqual(last.body.kind === "payment_intent" && [last.body.intent.amountRefundedMinor, last.body.intent.amount], [2500, { amountMinor: 12_500, currency: "USD" }]);
  });

  it("a tampered body, a missing or malformed header, a wrong secret and a stale timestamp are all failed / signature_invalid", async () => {
    const fake = fresh();
    await lifecycle(fake);
    const [good] = fake.control.webhooks.deliver({ order: [4] });
    assert.equal((await fake.verifyAndParseWebhook(good!)).status, "ok", "the control: the untouched delivery verifies");

    const tampered: WebhookDelivery = { ...good!, rawBody: good!.rawBody.replace('"livemode":false', '"livemode": false') };
    assert.notEqual(tampered.rawBody, good!.rawBody);
    assert.equal(canonicalJson(JSON.parse(tampered.rawBody)), canonicalJson(JSON.parse(good!.rawBody)), "same JSON, different bytes");
    const t = Math.floor(fake.control.nowMs() / 1000);
    const forged = crypto.createHmac("sha256", "whsec_not_the_secret").update(`${t}.${good!.rawBody}`, "utf8").digest("hex");
    const cases: Array<[string, WebhookDelivery]> = [
      ["a re-serialised body (one byte of whitespace)", tampered],
      ["no signature header", { rawBody: good!.rawBody, headers: {} }],
      ["a malformed signature header", { rawBody: good!.rawBody, headers: { [FAKE_SIGNATURE_HEADER]: "v1=" } }],
      ["a signature made with another secret", { rawBody: good!.rawBody, headers: { [FAKE_SIGNATURE_HEADER]: `t=${t},v1=${forged}` } }],
    ];
    for (const [name, delivery] of cases) assert.deepEqual(tag(await fake.verifyAndParseWebhook(delivery)), ["failed", "signature_invalid"], name);

    fake.control.advanceClock(301_000);
    const stale = await fake.verifyAndParseWebhook(good!);
    assert.deepEqual(tag(stale), ["failed", "signature_invalid"], "a delivery older than the replay window");
    assert.match(stale.status === "failed" ? stale.detail : "", /signature_timestamp_out_of_tolerance/);
    assert.ok(!JSON.stringify(stale).includes(FAKE_WEBHOOK_SECRET));
  });

  it("an unconfigured secret is unavailable — never a pass", () => {
    const delivery = { rawBody: "{}", headers: { "x-signature": "t=1,v1=00" } };
    for (const secret of [undefined, "", "   "]) {
      const r = verifyPaymentWebhookSignature({ provider: "p", delivery, headerName: "x-signature", secret });
      assert.deepEqual(r && [r.status, r.reason], ["unavailable", "webhook_secret_not_configured"], JSON.stringify(secret));
    }
  });

  it("a verified body that is not an event is failed / webhook_malformed; an unmodelled event is `ignored`", async () => {
    const fake = fresh();
    for (const raw of ["not json", "[]", "null", JSON.stringify({ id: "e", type: "x" }), JSON.stringify({ id: "e", type: "x", livemode: "false", created: "2026-01-01T00:00:00.000Z", account: null, data: { kind: "ignored" } })]) {
      assert.deepEqual(tag(await fake.verifyAndParseWebhook(fake.control.webhooks.signRawBody(raw))), ["failed", "webhook_malformed"], raw);
    }
    assert.deepEqual(tag(await fake.verifyAndParseWebhook({ rawBody: 5 as any, headers: {} })), ["failed", "webhook_malformed"]);
    const unmodelled = JSON.stringify({ id: "fake_evt_custom", type: "balance.available", livemode: false, created: "2026-01-01T00:00:00.000Z", account: null, data: { kind: "ignored" } });
    const event = okValue(await fake.verifyAndParseWebhook(fake.control.webhooks.signRawBody(unmodelled)), "ignored");
    assert.deepEqual([event.body.kind, event.providerEventId, event.providerEventType], ["ignored", "fake_evt_custom", "balance.available"]);
    assert.equal(applyPaymentEvent(emptyPaymentEventState(), event).outcome, "ignored");
  });
});

describe("FW2 — a livemode event is refused in the testing environment", () => {
  it("livemode:true is unavailable / livemode_not_allowed; only PAYMENTS_ALLOW_LIVE === \"true\" lets it through", async () => {
    const refusing: Array<[string, NodeJS.ProcessEnv]> = [
      ["unset", { ...LOCAL_ENV }],
      ["\"1\"", { ...LOCAL_ENV, PAYMENTS_ALLOW_LIVE: "1" }],
      ["\"TRUE\"", { ...LOCAL_ENV, PAYMENTS_ALLOW_LIVE: "TRUE" }],
      ["\"true \"", { ...LOCAL_ENV, PAYMENTS_ALLOW_LIVE: "true " }],
    ];
    for (const [name, env] of refusing) {
      const fake = fresh(env);
      await lifecycle(fake);
      const [live] = fake.control.webhooks.deliver({ order: [4], livemode: true });
      assert.match(live!.rawBody, /"livemode":true/);
      assert.deepEqual(tag(await fake.verifyAndParseWebhook(live!)), ["unavailable", "livemode_not_allowed"], `PAYMENTS_ALLOW_LIVE ${name}`);
      const [test] = fake.control.webhooks.deliver({ order: [0] });
      assert.equal((await fake.verifyAndParseWebhook(test!)).status, "ok", `PAYMENTS_ALLOW_LIVE ${name}: a test-mode event still passes`);
    }
    const allowed = fresh({ ...LOCAL_ENV, PAYMENTS_ALLOW_LIVE: "true" });
    await lifecycle(allowed);
    const [live] = allowed.control.webhooks.deliver({ order: [4], livemode: true });
    assert.equal(okValue(await allowed.verifyAndParseWebhook(live!), "allowed live").livemode, true);
  });

  it("the signature is still verified first: an unsigned livemode body is signature_invalid, not livemode_not_allowed", async () => {
    const fake = fresh();
    await lifecycle(fake);
    const [live] = fake.control.webhooks.deliver({ order: [4], livemode: true });
    const unsigned = { rawBody: live!.rawBody, headers: { [FAKE_SIGNATURE_HEADER]: "t=1,v1=00" } };
    assert.deepEqual(tag(await fake.verifyAndParseWebhook(unsigned)), ["failed", "signature_invalid"]);
  });

  it("webhookLivemodeRefused is assertWebhookLivemodeAllowed as a boolean — the same rule, not a second one", () => {
    const envs: NodeJS.ProcessEnv[] = [{}, { PAYMENTS_ALLOW_LIVE: "true" }, { PAYMENTS_ALLOW_LIVE: "TRUE" }, { PAYMENTS_ALLOW_LIVE: "1" }, { PAYMENTS_ALLOW_LIVE: "" }];
    for (const env of envs) {
      for (const livemode of [true, false, undefined, null, "true", 1, 0]) {
        let threw = false;
        try { assertWebhookLivemodeAllowed("stripe", livemode, env); } catch { threw = true; }
        assert.equal(webhookLivemodeRefused(livemode, env), threw, `${JSON.stringify(livemode)} under ${JSON.stringify(env)}`);
      }
    }
    assert.equal(webhookLivemodeRefused(true, {}), true);
    assert.equal(webhookLivemodeRefused(true, { PAYMENTS_ALLOW_LIVE: "true" }), false);
  });
});

describe("FW3 — delivered twice", () => {
  it("a duplicate delivery carries the same provider event id, and the fold applies it once", async () => {
    const fake = fresh();
    await lifecycle(fake);
    const deliveries = fake.control.webhooks.deliver({ duplicates: 1 });
    assert.equal(deliveries.length, 14);
    const events = await parseAll(fake, deliveries);
    assert.equal(new Set(events.map((e) => e.providerEventId)).size, 7);
    let state = emptyPaymentEventState();
    const outcomes: PaymentEventOutcome[] = [];
    for (const e of events) {
      const r = applyPaymentEvent(state, e);
      state = r.state;
      outcomes.push(r.outcome);
    }
    assert.deepEqual(outcomes, Array.from({ length: 7 }, () => ["applied", "duplicate"]).flat());
    assert.equal(state.seenEventIds.size, 7);
  });

  it("a provider retry of an already-delivered event is re-signed and is still the same event", async () => {
    const fake = fresh();
    await lifecycle(fake);
    const first = await parseAll(fake, fake.control.webhooks.deliver());
    fake.control.advanceClock(600_000);
    const retried = okValue(await fake.verifyAndParseWebhook(fake.control.webhooks.redeliver("fake_evt_000005")), "retry");
    assert.deepEqual(retried, first[4]);
    const state = foldPaymentEvents(first);
    assert.equal(applyPaymentEvent(state, retried).outcome, "duplicate");
    assert.equal(applyPaymentEvent(state, retried).state, state, "a duplicate returns the very same state");
  });
});

describe("FW4 — delivered late and out of order", () => {
  it("the newest snapshot wins whichever arrives first; a late older one is stale and changes nothing", async () => {
    const fake = fresh();
    const { intentRef } = await lifecycle(fake);
    // Out of order: the refund-updated intent (6) and succeeded (4) arrive BEFORE created (2) and
    // requires_action (3), which are held back and delivered late on a second call.
    const early = await parseAll(fake, fake.control.webhooks.deliver({ order: [6, 4, 5, 1, 0] }));
    assert.deepEqual(fake.control.webhooks.pending().map((p) => p.providerEventType), ["payment_intent.created", "payment_intent.requires_action"], "the two not chosen are still pending");
    fake.control.advanceClock(120_000);
    const late = await parseAll(fake, fake.control.webhooks.deliver());

    let state = emptyPaymentEventState();
    const outcomes: Array<[string, PaymentEventOutcome]> = [];
    for (const e of [...early, ...late]) {
      const r = applyPaymentEvent(state, e);
      state = r.state;
      outcomes.push([e.providerEventType, r.outcome]);
    }
    assert.deepEqual(outcomes, [
      ["payment_intent.refunded", "applied"],
      ["payment_intent.succeeded", "stale"],
      ["refund.succeeded", "applied"],
      ["recipient.updated", "applied"],
      ["recipient.created", "stale"],
      ["payment_intent.created", "stale"],
      ["payment_intent.requires_action", "stale"],
    ]);
    const held = state.intents.get(intentRef);
    assert.deepEqual([held?.state, held?.amountCapturedMinor, held?.amountRefundedMinor], ["succeeded", 12_500, 2500], "a late `created` must not rewind a captured, refunded payment");
    assert.equal([...state.recipients.values()][0]?.onboarding, "verified", "a late `created` must not un-verify a recipient");

    // The provider's own view is the same answer the fold reached.
    const truth = okValue(await fake.getPaymentIntent({ intentRef, chargeModel: "direct", recipientRef: held!.recipientRef }), "read back");
    assert.deepEqual(held, JSON.parse(JSON.stringify(truth)));
  });

  it("payout and dispute events fold the same way: failed-after-instruction and a lost dispute survive any order", async () => {
    const fake = fresh();
    const { recipientRef, intentRef } = await lifecycle(fake);
    fake.control.webhooks.deliver(); // the lifecycle's seven are not under test here
    fake.control.script.failNextPayout("after_instruction", "account_closed");
    const payout = okValue(await fake.requestPayout({ idempotencyKey: "po1", kind: "payout", recipientRef, amount: { amountMinor: 3000, currency: "USD" }, reference: { kind: "run", id: "1" } }), "payout");
    fake.control.advancePayout(payout.payoutRef);
    fake.control.advancePayout(payout.payoutRef);
    const dispute = fake.control.openDispute(intentRef, "product_not_received");
    assert.deepEqual([dispute.state, dispute.amount, dispute.intentRef, dispute.reasonCode], ["needs_response", { amountMinor: 10_000, currency: "USD" }, intentRef, "product_not_received"]);
    assert.equal(fake.control.resolveDispute(dispute.disputeRef, "lost").state, "lost");
    assert.throws(() => fake.control.resolveDispute(dispute.disputeRef, "won"), /already lost/);

    const events = await parseAll(fake, fake.control.webhooks.deliver());
    assert.deepEqual(events.map((e) => e.providerEventType), ["payout.created", "payout.in_transit", "payout.failed", "dispute.created", "dispute.closed"]);
    assert.deepEqual(events.map((e) => e.body.kind), ["payout", "payout", "payout", "dispute", "dispute"]);
    for (const order of permutations(events)) {
      const state = foldPaymentEvents([...order, ...order]);
      const p = state.payouts.get(payout.payoutRef);
      assert.deepEqual([p?.state, p?.failureCode, p?.amount], ["failed", "account_closed", { amountMinor: 3000, currency: "USD" }]);
      assert.equal(state.disputes.get(dispute.disputeRef)?.state, "lost");
    }
    const unpaid = okValue(await fake.createPaymentIntent(await buildCharge({ key: "c2", recipientRef })), "create");
    assert.throws(() => fake.control.openDispute(unpaid.intentRef), /only a captured payment can be disputed/);
  });

  it("a decline after an authentication is a step BACK in state and still wins by time, not by rank", async () => {
    const fake = fresh();
    const recipientRef = await verifiedRecipient(fake, { key: "r1" });
    const created = okValue(await fake.createPaymentIntent(await buildCharge({ key: "c1", recipientRef })), "create");
    fake.control.script.requireActionOnNextConfirm();
    await fake.confirmPaymentIntent({ idempotencyKey: "k1", intent: intentHandle(created), paymentMethodRef: "pm" });
    fake.control.completePayerAction(created.intentRef, "failed");
    const events = await parseAll(fake, fake.control.webhooks.deliver());
    for (const order of permutations(events)) {
      assert.equal(foldPaymentEvents(order).intents.get(created.intentRef)?.state, "requires_payment_method");
    }
  });
});

describe("FW5 — any order, any multiplicity, the same state", () => {
  it("every permutation of the seven events, each also delivered twice, folds to the in-order state", async () => {
    const fake = fresh();
    await lifecycle(fake);
    const events = await parseAll(fake, fake.control.webhooks.deliver());
    assert.equal(events.length, 7);
    const expected = JSON.stringify(describePaymentEventState(foldPaymentEvents(events)));
    let checked = 0;
    for (const order of permutations(events)) {
      // every event twice: once in this order, once more in reverse
      const withDuplicates = [...order, ...[...order].reverse()];
      assert.equal(JSON.stringify(describePaymentEventState(foldPaymentEvents(withDuplicates))), expected);
      checked += 1;
    }
    assert.equal(checked, 5040);
    const state = JSON.parse(expected);
    assert.deepEqual([state.seenEventIds.length, state.intents.length, state.refunds.length, state.recipients.length], [7, 1, 1, 1]);
  });

  it("the check can fail: a fold that took the LAST delivery instead of the latest snapshot disagrees across orders", async () => {
    const fake = fresh();
    const { intentRef } = await lifecycle(fake);
    const events = await parseAll(fake, fake.control.webhooks.deliver());
    const lastWins = (order: readonly PaymentWebhookEvent[]) => {
      let state: string | undefined;
      for (const e of order) if (e.body.kind === "payment_intent" && e.body.intent.intentRef === intentRef) state = e.body.intent.state;
      return state;
    };
    const naive = new Set(permutations(events).map(lastWins));
    assert.ok(naive.size > 1, "a naive last-delivery-wins handler is order-dependent on this very sequence");
    const folded = new Set(permutations(events).map((o) => foldPaymentEvents(o).intents.get(intentRef)?.state));
    assert.deepEqual([...folded], ["succeeded"]);
  });

  it("equal instants are broken by a fixed order, so two snapshots with one timestamp cannot disagree", () => {
    const at = "2026-01-01T00:00:10.000Z";
    const base = { provider: "p", providerEventType: "t", livemode: false, occurredAt: at, accountRef: null };
    const snapshot = (state: string) => ({ intentRef: "pi_1", state, updatedAt: at }) as any;
    const a: PaymentWebhookEvent = { ...base, providerEventId: "e1", body: { kind: "payment_intent", intent: snapshot("requires_capture") } };
    const b: PaymentWebhookEvent = { ...base, providerEventId: "e2", body: { kind: "payment_intent", intent: snapshot("succeeded") } };
    assert.equal(foldPaymentEvents([a, b]).intents.get("pi_1")?.state, "succeeded");
    assert.equal(foldPaymentEvents([b, a]).intents.get("pi_1")?.state, "succeeded");
  });
});
