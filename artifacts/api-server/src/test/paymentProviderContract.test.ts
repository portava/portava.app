/**
 * PAY-T03 — the provider-agnostic payment contract (services/payments/
 * PaymentProvider.ts) and the tax-provider interface (TaxProvider.ts).
 *
 *   PC1  the no-money provider: all thirteen operations answer
 *        `unavailable / payments_disabled`, reach no network primitive, and
 *        report no capability and no market
 *   PC2  create-intent validation: amounts are integer minor units with an ISO
 *        currency, and the four components sum to the amount exactly
 *   PC3  the platform fee is a SEPARATE amount: commission is bounded by the
 *        pre-tax service component — a tip can carry none — and a platform
 *        charge carries no fee at all
 *   PC4  checkout refuses where tax is not configured: no tax computation, or
 *        one for another market or currency, or one that does not add up
 *   PC5  charge-model selection: direct where the provider AND the market offer
 *        it; otherwise REFUSED unless the caller opts into a fallback
 *   PC6  nothing is thrown and nothing malformed passes: the guard turns a
 *        throwing adapter, `undefined`, an invented reason or the wrong object
 *        into a tagged result — `capabilities()` and `marketSupport()` included
 *        — and validates the request before the adapter is reached
 *   PC7  the `none` tax provider reports every market as not configured and
 *        never answers ok; the fake computes in integers and is refused outside
 *        a local run; only `none` and `fake` resolve
 *   PC8  a partial capture's fee is held to the ORIGINAL fee scaled to the
 *        captured share of the pre-tax service component; a captured tip
 *        carries none; the guard enforces it before any adapter
 *   PC9  currency granularity (ISO exponents, three-decimal step) is checked by
 *        the shared validators
 *   PC10 the request shapes a marketplace adapter needs
 *   PC11 a tax computation is attested by the provider that issued it
 *   PC12 a refund of a stated amount is checked against the intent (bound,
 *        state, granularity), by the guard, before the adapter
 *
 * Pure: no env is read except the objects passed in, and no I/O.
 * Run: node --import tsx/esm --test src/test/paymentProviderContract.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";

import { PAYMENT_CONNECT_WEBHOOK_SECRET_ENV, PAYMENT_WEBHOOK_SECRET_ENV, PaymentsLiveModeRefusedError } from "../lib/paymentsMode.js";
import {
  CURRENCY_MINOR_UNIT_EXCEPTIONS,
  NONE_PAYMENT_PROVIDER,
  NO_PAYMENT_CAPABILITIES,
  PAYMENT_PROVIDER_OPERATIONS,
  guardPaymentProvider,
  isChargeableAmount,
  isMinorUnits,
  isMoney,
  isPayoutSnapshot,
  minorUnitExponent,
  minorUnitStep,
  paymentResultFromThrown,
  platformFeeTotalMinor,
  refusingPaymentProvider,
  resolveCapture,
  safeToken,
  scaledShareMinor,
  selectChargeModel,
  validateCancelPaymentIntent,
  validateCapturePaymentIntent,
  validateConfirmPaymentIntent,
  validateCreatePaymentIntent,
  validateCreateRecipient,
  validateRecipientOnboardingLink,
  validateRefundAgainstIntent,
  validateRefundPayment,
  validateRequestPayout,
  validateReverseOrHoldPayout,
  validateWebhookDelivery,
  type CreatePaymentIntentRequest,
  type MarketSupport,
  type PaymentProvider,
  type PaymentProviderCapabilities,
} from "../services/payments/PaymentProvider.js";
import {
  NONE_TAX_PROVIDER,
  createFakeTaxProvider,
  resolveTaxProvider,
  taxMinorAtRate,
  taxProviderOrNone,
} from "../services/payments/TaxProvider.js";
import { LOCAL_ENV, REFUSED_ENVS, buildCharge, callEveryOperation, conformingAdapter, sampleIntent, samplePayout, sampleRecipient, sampleRequests, tag } from "./helpers/paymentFixtures.js";

// ── A network trap: every primitive records and throws ─────────────────────
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

describe("PC1 — the no-money provider", () => {
  it("all thirteen operations answer unavailable / payments_disabled and reach no network primitive", async () => {
    reached.length = 0;
    const results = await callEveryOperation(NONE_PAYMENT_PROVIDER);
    assert.equal(results.length, 13);
    assert.deepEqual(results.map(([op]) => op), [...PAYMENT_PROVIDER_OPERATIONS]);
    for (const [op, r] of results) assert.deepEqual([r.provider, ...tag(r)], ["none", "unavailable", "payments_disabled"], op);
    assert.deepEqual(reached, [], "the no-money provider touched the network");
    assert.ok(Object.isFrozen(NONE_PAYMENT_PROVIDER), "the provider cannot be monkey-patched into moving money");
  });

  it("reports no capability and supports no market", () => {
    assert.equal(NONE_PAYMENT_PROVIDER.capabilities(), NO_PAYMENT_CAPABILITIES);
    assert.deepEqual(NO_PAYMENT_CAPABILITIES.chargeModels, []);
    for (const [k, v] of Object.entries(NO_PAYMENT_CAPABILITIES)) if (k !== "chargeModels") assert.equal(v, false, k);
    const m = NONE_PAYMENT_PROVIDER.marketSupport({ recipientCountry: "US", presentmentCurrency: "USD" });
    assert.deepEqual([m.supported, m.reason, m.chargeModels, m.presentmentCurrencySupported], [false, "no_provider", [], false]);
    assert.equal(NONE_PAYMENT_PROVIDER.marketSupport({ recipientCountry: "US" }).presentmentCurrencySupported, null);
  });

  it("a refusing provider carries the reason it was built with on every operation", async () => {
    const p = refusingPaymentProvider("stripe", "live_key_not_allowed", "x");
    for (const [op, r] of await callEveryOperation(p)) assert.deepEqual([r.provider, ...tag(r)], ["stripe", "unavailable", "live_key_not_allowed"], op);
  });
});

describe("PC2 — amounts are integer minor units with an ISO currency", () => {
  it("isMinorUnits / isMoney accept only non-negative safe integers and upper-case three-letter codes", () => {
    for (const ok of [0, 1, 12_500, Number.MAX_SAFE_INTEGER]) assert.equal(isMinorUnits(ok), true, String(ok));
    for (const bad of [-1, 0.5, 12.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100", null, undefined]) assert.equal(isMinorUnits(bad), false, String(bad));
    assert.equal(isMoney({ amountMinor: 100, currency: "USD" }), true);
    for (const bad of [{ amountMinor: 100, currency: "usd" }, { amountMinor: 100, currency: "US" }, { amountMinor: 1.5, currency: "USD" }, { amountMinor: 100 }, null]) {
      assert.equal(isMoney(bad), false, JSON.stringify(bad));
    }
  });

  it("a well-formed request passes; the control every refusal below is measured against", async () => {
    const req = await buildCharge({ key: "k", recipientRef: "acct", tipMinor: 1500 });
    assert.equal(validateCreatePaymentIntent("p", req), null);
    // 10000 service + 1500 tip + 1000 tax (10% of the service, platform-remitted; the tip is untaxed)
    assert.deepEqual(req.amount, { amountMinor: 12_500, currency: "USD" });
    assert.deepEqual(req.platformFee, { commissionMinor: 1000, payerFeeMinor: 0, taxMinor: 1000 });
    assert.equal(platformFeeTotalMinor(req.platformFee), 2000);
  });

  it("refuses a float, a negative, a zero total, a lower-case currency, and components that do not sum", async () => {
    const good = await buildCharge({ key: "k", recipientRef: "acct" });
    const cases: Array<[string, Partial<CreatePaymentIntentRequest>, string]> = [
      ["float amount", { amount: { amountMinor: 110.5, currency: "USD" } }, "invalid_amount"],
      ["negative amount", { amount: { amountMinor: -1, currency: "USD" } }, "invalid_amount"],
      ["zero amount", { amount: { amountMinor: 0, currency: "USD" } }, "invalid_amount"],
      ["lower-case currency", { amount: { amountMinor: 11_000, currency: "usd" } }, "invalid_currency"],
      ["components one minor unit short", { components: { ...good.components, serviceMinor: good.components.serviceMinor - 1 } }, "invalid_amount"],
      ["a float component", { components: { ...good.components, tipMinor: 0.5 } }, "invalid_amount"],
      ["empty idempotency key", { idempotencyKey: "  " }, "invalid_request"],
      ["a 256-character idempotency key", { idempotencyKey: "k".repeat(256) }, "invalid_request"],
      ["lower-case payer country", { payerCountry: "us" }, "invalid_request"],
      ["an unknown charge model", { chargeModel: "split" as any }, "invalid_request"],
      ["a direct charge with no recipient", { recipientRef: null }, "invalid_request"],
      ["a direct charge with no recipient country", { recipientCountry: null }, "invalid_request"],
    ];
    for (const [name, patch, reason] of cases) {
      const r = validateCreatePaymentIntent("p", { ...good, ...patch });
      assert.deepEqual(r && [r.status, r.reason], ["failed", reason], name);
    }
  });

  it("payout and recipient requests are shape-checked the same way", () => {
    const payout = { idempotencyKey: "k", kind: "payout" as const, recipientRef: "acct", amount: { amountMinor: 100, currency: "USD" }, reference: { kind: "payout", id: "1" } };
    assert.equal(validateRequestPayout("p", payout), null);
    assert.equal(validateRequestPayout("p", { ...payout, amount: { amountMinor: 0, currency: "USD" } })?.reason, "invalid_amount");
    assert.equal(validateRequestPayout("p", { ...payout, amount: { amountMinor: 1.5, currency: "USD" } })?.reason, "invalid_amount");
    assert.equal(validateRequestPayout("p", { ...payout, amount: { amountMinor: 100, currency: "dollars" } })?.reason, "invalid_currency");
    assert.equal(validateRequestPayout("p", { ...payout, kind: "wire" as any })?.reason, "invalid_request");
    const recipient = { idempotencyKey: "k", profileId: "p1", country: "US", entityType: "individual" as const, settlementCurrency: "USD", returnUrl: "a://b", refreshUrl: "a://c" };
    assert.equal(validateCreateRecipient("p", recipient), null);
    assert.equal(validateCreateRecipient("p", { ...recipient, country: "USA" })?.reason, "invalid_request");
    assert.equal(validateCreateRecipient("p", { ...recipient, settlementCurrency: "usd" })?.reason, "invalid_currency");
    assert.equal(validateCreateRecipient("p", { ...recipient, returnUrl: "" })?.reason, "invalid_request");
  });
});

describe("PC3 — the platform fee is a separate amount, and a tip carries none", () => {
  it("commission may equal the whole service component and not one minor unit more", async () => {
    const atCap = await buildCharge({ key: "k", recipientRef: "acct", tipMinor: 5000, commissionMinor: 10_000 });
    assert.equal(validateCreatePaymentIntent("p", atCap), null);
    const over = await buildCharge({ key: "k", recipientRef: "acct", tipMinor: 5000, commissionMinor: 10_001 });
    const r = validateCreatePaymentIntent("p", over);
    assert.deepEqual(r && [r.status, r.reason], ["failed", "fee_exceeds_commissionable_amount"]);
  });

  it("a tip-only charge can carry no commission at all, whatever the rate", async () => {
    const tipOnly = await buildCharge({ key: "k", recipientRef: "acct", serviceMinor: 0, tipMinor: 2000, commissionMinor: 0 });
    assert.equal(validateCreatePaymentIntent("p", tipOnly), null);
    assert.equal(platformFeeTotalMinor(tipOnly.platformFee), 0, "a tip reaches the recipient whole");
    const taxed = await buildCharge({ key: "k", recipientRef: "acct", serviceMinor: 0, tipMinor: 2000, commissionMinor: 1 });
    assert.equal(validateCreatePaymentIntent("p", taxed)?.reason, "fee_exceeds_commissionable_amount");
  });

  it("a payer fee is the platform's in full, and platform-remitted tax is exactly what the tax lines say", async () => {
    const withFee = await buildCharge({ key: "k", recipientRef: "acct", payerFeeMinor: 300 });
    assert.equal(validateCreatePaymentIntent("p", withFee), null);
    // 10% on the 10000 service and on the 300 payer fee, both platform-remitted in the fake's US table
    assert.deepEqual(withFee.platformFee, { commissionMinor: 1000, payerFeeMinor: 300, taxMinor: 1030 });
    assert.equal(validateCreatePaymentIntent("p", { ...withFee, platformFee: { ...withFee.platformFee, payerFeeMinor: 299 } })?.reason, "invalid_amount");
    assert.equal(validateCreatePaymentIntent("p", { ...withFee, platformFee: { ...withFee.platformFee, taxMinor: 1029 } })?.reason, "invalid_amount");
    assert.equal(validateCreatePaymentIntent("p", { ...withFee, platformFee: { ...withFee.platformFee, taxMinor: 2000 } })?.reason, "invalid_amount");
  });

  it("where the SELLER remits the tax it is not part of the platform's fee", async () => {
    const gb = await buildCharge({ key: "k", recipientRef: "acct", sellerMarket: "GB", buyerMarket: "GB", currency: "GBP" });
    assert.equal(validateCreatePaymentIntent("p", gb), null);
    assert.equal(gb.components.taxMinor, 2000);
    assert.equal(gb.platformFee.taxMinor, 0);
  });

  it("a platform charge names no recipient and carries no separate fee", async () => {
    const platform = await buildCharge({ key: "k", recipientRef: null, chargeModel: "platform" });
    assert.equal(validateCreatePaymentIntent("p", platform), null);
    assert.equal(validateCreatePaymentIntent("p", { ...platform, platformFee: { commissionMinor: 1, payerFeeMinor: 0, taxMinor: 0 } })?.reason, "invalid_request");
    assert.equal(validateCreatePaymentIntent("p", { ...platform, recipientRef: "acct" })?.reason, "invalid_request");
  });
});

describe("PC4 — checkout refuses where tax is not configured", () => {
  it("no tax computation is unavailable / tax_not_configured, not a zero-tax charge", async () => {
    const good = await buildCharge({ key: "k", recipientRef: "acct" });
    const r = validateCreatePaymentIntent("p", { ...good, tax: [] });
    assert.deepEqual(r && [r.status, r.reason], ["unavailable", "tax_not_configured"]);
    const hand = validateCreatePaymentIntent("p", { ...good, tax: [{ ...good.tax[0]!, configured: false as any }] });
    assert.deepEqual(hand && [hand.status, hand.reason], ["unavailable", "tax_not_configured"]);
  });

  it("the `none` tax provider yields no computation, so no intent can be built behind it", async () => {
    const r = await NONE_TAX_PROVIDER.computeTax({ sellerMarket: "US", buyerMarket: "US", productKind: "service", amountMinor: 10_000, currency: "USD" });
    assert.deepEqual([r.status, r.status !== "ok" && r.reason], ["unavailable", "tax_not_configured"]);
  });

  it("a computation for another market, another currency, or one that does not add up is refused", async () => {
    const good = await buildCharge({ key: "k", recipientRef: "acct", tipMinor: 1500 });
    const line = good.tax[0]!;
    const rest = good.tax.slice(1);
    const cases: Array<[string, CreatePaymentIntentRequest, string]> = [
      ["another seller market", { ...good, tax: [{ ...line, sellerMarket: "GB" }, ...rest] }, "invalid_request"],
      ["another buyer market", { ...good, tax: [{ ...line, buyerMarket: "GB" }, ...rest] }, "invalid_request"],
      ["another currency", { ...good, tax: [{ ...line, currency: "EUR" }, ...rest] }, "currency_mismatch"],
      ["tax that does not sum to the tax component", { ...good, tax: [{ ...line, taxMinor: line.taxMinor - 1 }, ...rest] }, "invalid_amount"],
      ["a pre-tax component with no tax line (the tip)", { ...good, tax: [line] }, "invalid_amount"],
      ["a float in a tax line", { ...good, tax: [{ ...line, taxMinor: 999.5 }, ...rest] }, "invalid_amount"],
    ];
    for (const [name, req, reason] of cases) {
      const r = validateCreatePaymentIntent("p", req);
      assert.deepEqual(r && [r.status, r.reason], ["failed", reason], name);
    }
  });
});

describe("PC5 — charge-model selection", () => {
  const caps = (chargeModels: PaymentProviderCapabilities["chargeModels"]): PaymentProviderCapabilities => ({ ...NO_PAYMENT_CAPABILITIES, chargeModels });
  const market = (supported: boolean, chargeModels: MarketSupport["chargeModels"]): MarketSupport => ({
    provider: "p", recipientCountry: "XX", supported, chargeModels, settlementCurrencies: ["USD"], presentmentCurrencySupported: null,
    reason: supported ? "supported" : "country_not_supported",
  });

  it("direct where the provider and the market both offer it", () => {
    assert.deepEqual(selectChargeModel(caps(["direct", "destination"]), market(true, ["direct", "destination"])), { ok: true, chargeModel: "direct" });
  });

  it("a provider OR a market without direct charges is refused by default, and uses destination only when the caller opts in", () => {
    for (const [c, m] of [
      [caps(["destination"]), market(true, ["direct", "destination"])],
      [caps(["direct", "destination"]), market(true, ["destination"])],
    ] as const) {
      const refused = selectChargeModel(c, m);
      assert.deepEqual([refused.ok, !refused.ok && refused.reason], [false, "charge_model_not_supported"]);
      assert.deepEqual(selectChargeModel(c, m, "destination"), { ok: true, chargeModel: "destination" });
    }
    const neither = selectChargeModel(caps(["platform"]), market(true, []), "destination");
    assert.deepEqual([neither.ok, !neither.ok && neither.reason], [false, "charge_model_not_supported"]);
  });

  it("an unsupported market is unsupported whatever the fallback", () => {
    for (const fallback of ["refuse", "destination"] as const) {
      const r = selectChargeModel(caps(["direct", "destination"]), market(false, []), fallback);
      assert.deepEqual([r.ok, !r.ok && r.reason], [false, "unsupported_market"]);
    }
  });
});

describe("PC6 — nothing is thrown, and nothing malformed passes", () => {
  it("a thrown string, a thrown Error and a rejected promise all become failed / provider_error, without the message", async () => {
    for (const thrown of ["boom sk_live_SECRET", new Error("request to https://api.example/v1 with sk_live_SECRET failed"), { code: "ECONNRESET" }]) {
      const adapter = conformingAdapter();
      const guarded = guardPaymentProvider(adapter.provider, () => null);
      adapter.throwNext(thrown);
      const r = await guarded.validateRecipient("acct_1");
      assert.deepEqual([r.status, r.status !== "ok" && r.reason], ["failed", "provider_error"]);
      assert.ok(!JSON.stringify(r).includes("SECRET"), "the thrown message must not travel in the result");
      if (r.status === "failed") assert.equal(r.retriable, true);
    }
  });

  it("only a short safe token of a thrown `code` or name is echoed; anything else — a key pasted into it — is dropped", () => {
    assert.match(paymentResultFromThrown("p", Object.assign(new Error("x"), { code: "ETIMEDOUT" })).detail, /\(Error code=ETIMEDOUT\)/);
    assert.match(paymentResultFromThrown("p", { code: "resource_missing" }).detail, /code=resource_missing/);
    for (const code of ["sk_live_SECRETVALUE and more", "x".repeat(41), "a b", "line\nbreak", "", 42, { toString: () => "SECRETVALUE" }]) {
      const r = paymentResultFromThrown("p", Object.assign(new Error("x"), { code }));
      assert.ok(!r.detail.includes("code="), `a code of ${JSON.stringify(String(code)).slice(0, 30)} must not be echoed`);
      assert.ok(!r.detail.includes("SECRETVALUE"));
    }
    const named = new Error("x");
    named.name = "sk_live_SECRETVALUE is my name";
    assert.equal(paymentResultFromThrown("p", named).detail, "the provider adapter threw (Error)");
    assert.equal(safeToken("stripe"), "stripe");
    assert.equal(safeToken("sk_live_" + "x".repeat(60)), "unrecognised");
    assert.equal(safeToken(undefined), "unrecognised");
  });

  it("a sandbox-guard refusal thrown by an adapter keeps its meaning", async () => {
    const live = new PaymentsLiveModeRefusedError({ provider: "stripe", keyPresent: true, mode: "live", liveAllowed: false, allowed: false, refusal: "live_key_not_allowed" });
    const unknown = new PaymentsLiveModeRefusedError({ provider: "stripe", keyPresent: true, mode: "unknown", liveAllowed: false, allowed: false, refusal: "unknown_key_prefix" });
    const event = new PaymentsLiveModeRefusedError({ provider: "stripe", refusal: "live_event_not_allowed", liveAllowed: false });
    assert.deepEqual(tag(paymentResultFromThrown("stripe", live)), ["unavailable", "live_key_not_allowed"]);
    assert.deepEqual(tag(paymentResultFromThrown("stripe", unknown)), ["unavailable", "unknown_key_prefix"]);
    assert.deepEqual(tag(paymentResultFromThrown("stripe", event)), ["unavailable", "livemode_not_allowed"]);
    const adapter = conformingAdapter();
    adapter.throwNext(live);
    assert.deepEqual(tag(await guardPaymentProvider(adapter.provider, () => null).validateRecipient("acct_1")), ["unavailable", "live_key_not_allowed"]);
  });

  it("an adapter that returns undefined, a bare value, an unknown status, an invented reason or the wrong object is failed / provider_error", async () => {
    const wrong: Array<[string, unknown]> = [
      ["undefined", undefined],
      ["null", null],
      ["a string", "ok"],
      ["an empty object", {}],
      ["an unknown status", { status: "success", provider: "stripe", value: sampleRecipient() }],
      ["ok with no value", { status: "ok", provider: "stripe" }],
      ["ok with another operation's value", { status: "ok", provider: "stripe", value: sampleIntent() }],
      ["ok with a value missing its state", { status: "ok", provider: "stripe", value: { recipientRef: "acct_1" } }],
      ["a reason outside the closed union", { status: "failed", provider: "stripe", reason: "something_else", detail: "d", retriable: false }],
      ["a failure with no retriable flag", { status: "failed", provider: "stripe", reason: "not_found", detail: "d" }],
      ["requires_action with no action", { status: "requires_action", provider: "stripe", reason: "recipient_onboarding_required", detail: "d", value: sampleRecipient() }],
    ];
    for (const [name, answer] of wrong) {
      const adapter = conformingAdapter();
      adapter.answerNext(answer);
      const r = await guardPaymentProvider(adapter.provider, () => null).validateRecipient("acct_1");
      assert.deepEqual(tag(r), ["failed", "provider_error"], name);
      assert.deepEqual(adapter.reached, ["validateRecipient"], name);
    }
    // The control: a well-formed answer of each non-ok status passes through unchanged.
    for (const answer of [
      { status: "failed", provider: "stripe", reason: "not_found", detail: "d", retriable: false },
      { status: "unavailable", provider: "stripe", reason: "rate_limited", detail: "d", retriable: true },
      { status: "declined", provider: "stripe", reason: "recipient_rejected", detail: "d", value: sampleRecipient({ onboarding: "rejected" }) },
      { status: "requires_action", provider: "stripe", reason: "recipient_onboarding_required", detail: "d", action: { kind: "recipient_onboarding", url: null, requirementsDue: [] }, value: sampleRecipient({ onboarding: "in_progress" }) },
    ]) {
      const adapter = conformingAdapter();
      adapter.answerNext(answer);
      assert.deepEqual(await guardPaymentProvider(adapter.provider, () => null).validateRecipient("acct_1"), answer);
    }
  });

  it("capabilities() and marketSupport() are guarded too: a throw or nonsense means no capability and no market", () => {
    const base = conformingAdapter().provider;
    const cases: Array<[string, Partial<PaymentProvider>]> = [
      ["throws", { capabilities: () => { throw new Error("boom"); }, marketSupport: () => { throw "boom"; } }],
      ["returns undefined", { capabilities: (() => undefined) as any, marketSupport: (() => undefined) as any }],
      ["returns nonsense", { capabilities: (() => ({ chargeModels: ["teleport"], manualCapture: "yes" })) as any, marketSupport: (() => ({ supported: "yes" })) as any }],
      ["is not a function", { capabilities: 5 as any, marketSupport: null as any }],
    ];
    for (const [name, overrides] of cases) {
      const guarded = guardPaymentProvider({ ...base, ...overrides }, () => null);
      assert.equal(guarded.capabilities(), NO_PAYMENT_CAPABILITIES, name);
      const m = guarded.marketSupport({ recipientCountry: "US", presentmentCurrency: "USD" });
      assert.deepEqual([m.supported, m.reason, m.chargeModels, m.recipientCountry, m.presentmentCurrencySupported], [false, "provider_error", [], "US", false], name);
    }
    const ok = guardPaymentProvider(base, () => null);
    assert.deepEqual(ok.capabilities().chargeModels, ["direct"], "the control: a well-formed answer passes through");
    assert.equal(ok.marketSupport({ recipientCountry: "US" }).supported, true);
  });

  it("an adapter that is not an object, or lacks a method, cannot throw either", async () => {
    for (const notAProvider of [undefined, null, 5, "stripe"]) {
      const guarded = guardPaymentProvider(notAProvider as any, () => null);
      assert.equal(guarded.id, "unknown");
      assert.equal(guarded.capabilities(), NO_PAYMENT_CAPABILITIES);
      for (const [op, r] of await callEveryOperation(guarded)) assert.deepEqual(tag(r), ["failed", "provider_error"], `${String(notAProvider)}: ${op}`);
    }
    const partial = { ...conformingAdapter().provider, refundPayment: undefined } as any;
    const req = (await sampleRequests()).refundPayment as any;
    assert.deepEqual(tag(await guardPaymentProvider(partial, () => null).refundPayment(req)), ["failed", "provider_error"]);
  });

  it("the precheck runs first on every operation, then the request is validated, and only then is the adapter reached", async () => {
    const adapter = conformingAdapter();
    let refuse = true;
    const guarded = guardPaymentProvider(adapter.provider, () => (refuse ? { status: "unavailable", provider: "stripe", reason: "live_key_not_allowed", detail: "x", retriable: false } : null));
    for (const [op, r] of await callEveryOperation(guarded)) assert.deepEqual(tag(r), ["unavailable", "live_key_not_allowed"], op);
    assert.deepEqual(adapter.reached, [], "a refused precheck must not reach the adapter");

    refuse = false;
    const invalid: Record<string, unknown> = {
      createPaymentIntent: { ...((await sampleRequests()).createPaymentIntent as object), tax: [] },
      confirmPaymentIntent: { idempotencyKey: "k", intent: { intentRef: "pi_1" }, paymentMethodRef: null, returnUrl: null },
      capturePaymentIntent: { idempotencyKey: "k", intent: null, amountMinor: "full", partial: null },
      cancelPaymentIntent: { idempotencyKey: "", intent: { intentRef: "pi_1", chargeModel: "direct", recipientRef: "acct_1" }, reason: "abandoned" },
      getPaymentIntent: {},
      refundPayment: { idempotencyKey: "k", intent: { intentRef: "pi_1", chargeModel: "direct", recipientRef: "acct_1" }, amountMinor: "full", reason: "duplicate", refundPlatformFee: true },
      createRecipient: { idempotencyKey: "k", profileId: "p", country: "usa", entityType: "individual", settlementCurrency: "USD", returnUrl: "a://b", refreshUrl: "a://c" },
      createRecipientOnboardingLink: { recipientRef: "acct_1", returnUrl: "a://b", refreshUrl: "a://c" },
      validateRecipient: "",
      requestPayout: { idempotencyKey: "k", kind: "payout", recipientRef: "acct_1", amount: { amountMinor: 1.5, currency: "USD" }, reference: { kind: "x", id: "1" } },
      getPayoutStatus: { payoutRef: "po_1" },
      reverseOrHoldPayout: { idempotencyKey: "k", payout: { payoutRef: "po_1", kind: "payout", recipientRef: "acct_1" }, action: "hold", amountMinor: 5 },
      verifyAndParseWebhook: { rawBody: "{}", headers: {} },
    };
    for (const [op, r] of await callEveryOperation(guarded, invalid)) assert.notEqual(r.status, "ok", `${op}: an invalid request reached the adapter`);
    assert.deepEqual(adapter.reached, [], "a request the shared validators refuse must not reach the adapter");

    for (const [op, r] of await callEveryOperation(guarded)) assert.equal(r.status, "ok", `${op}: ${JSON.stringify(r).slice(0, 160)}`);
    // Thirteen operations, plus the read of the intent the guard makes before a capture.
    assert.deepEqual([...adapter.reached].sort(), [...PAYMENT_PROVIDER_OPERATIONS, "getPaymentIntent"].sort());
    const throwingPrecheck = guardPaymentProvider(adapter.provider, () => { throw new Error("precheck bug"); });
    adapter.reached.length = 0;
    assert.deepEqual(tag(await throwingPrecheck.validateRecipient("acct_1")), ["failed", "provider_error"]);
    assert.deepEqual(adapter.reached, [], "a precheck that throws fails closed");
  });
});

describe("PC8 — a partial capture's fee is held to the original, scaled to what is captured", () => {
  // service 10 000 (commission 1 000), payer fee 300, tip 1 500, tax 1 030 platform-remitted
  const basis = sampleIntent({
    amount: { amountMinor: 12_830, currency: "USD" },
    components: { serviceMinor: 10_000, payerFeeMinor: 300, tipMinor: 1500, taxMinor: 1030 },
    platformFee: { commissionMinor: 1000, payerFeeMinor: 300, taxMinor: 1030 },
    amountCapturableMinor: 12_830,
  });
  const intent = { intentRef: "pi_1", chargeModel: "direct" as const, recipientRef: "acct_1" };
  const capture = (components: [number, number, number, number], fee: [number, number, number], amountMinor?: number | "full") => {
    const [serviceMinor, payerFeeMinor, tipMinor, taxMinor] = components;
    const [commissionMinor, feePayer, feeTax] = fee;
    return validateCapturePaymentIntent("p", basis, {
      idempotencyKey: "k",
      intent,
      amountMinor: amountMinor ?? serviceMinor + payerFeeMinor + tipMinor + taxMinor,
      partial: { components: { serviceMinor, payerFeeMinor, tipMinor, taxMinor }, platformFee: { commissionMinor, payerFeeMinor: feePayer, taxMinor: feeTax } },
    });
  };

  it("scaledShareMinor floors, in integers, and is zero when there is nothing to take a share of", () => {
    assert.equal(scaledShareMinor(1000, 3333, 10_000), 333);
    assert.equal(scaledShareMinor(1000, 10_000, 10_000), 1000);
    assert.equal(scaledShareMinor(1000, 0, 10_000), 0);
    assert.equal(scaledShareMinor(0, 5000, 10_000), 0);
    assert.equal(scaledShareMinor(4999, 4999, 0), 0, "no service component: no commission, whatever is asked");
    assert.equal(scaledShareMinor(1, 9999, 10_000), 0, "the floor favours the recipient");
    assert.equal(scaledShareMinor(9_007_199_254_740_991, 9_007_199_254_740_990, 9_007_199_254_740_991), 9_007_199_254_740_990, "no precision is lost on large amounts");
  });

  it("the commission cap follows the captured SERVICE and nothing else", () => {
    // [service, payer fee, tip, tax] captured -> the largest commission allowed
    const caps: Array<[[number, number, number, number], number]> = [
      [[10_000, 300, 1500, 1030], 1000], // everything
      [[5000, 0, 0, 0], 500], // half the service
      [[5000, 300, 1500, 1030], 500], // half the service plus ALL the rest: still 500
      [[3333, 0, 1500, 0], 333], // floor(333.3); the captured tip adds nothing
      [[1, 0, 0, 0], 0], // floor(0.1)
      [[9, 0, 0, 0], 0], // floor(0.9)
      [[10, 0, 0, 0], 1],
      [[0, 300, 1500, 1030], 0], // no service captured: no commission
      [[0, 0, 1500, 0], 0], // tip only
    ];
    for (const [components, cap] of caps) {
      const [, payerFee] = components;
      assert.equal(capture(components, [cap, payerFee, 0]), null, `${JSON.stringify(components)}: commission ${cap} is allowed`);
      const over = capture(components, [cap + 1, payerFee, 0]);
      assert.deepEqual(over && [over.status, over.reason], ["failed", "fee_exceeds_commissionable_amount"], `${JSON.stringify(components)}: commission ${cap + 1} is refused`);
    }
  });

  it("the payer fee is exactly the captured payer-fee component, and platform tax is capped by the captured tax", () => {
    assert.equal(capture([5000, 300, 0, 515], [500, 300, 515]), null);
    assert.equal(capture([5000, 300, 0, 515], [500, 299, 515])?.reason, "invalid_amount", "a payer fee is the platform's in full");
    assert.equal(capture([5000, 0, 0, 515], [500, 300, 515])?.reason, "invalid_amount", "no payer fee was captured");
    assert.equal(capture([5000, 0, 0, 515], [500, 0, 516])?.reason, "invalid_amount", "floor(1030 × 515 / 1030) = 515");
    assert.equal(capture([5000, 0, 0, 0], [500, 0, 1])?.reason, "invalid_amount", "no tax captured: no platform tax");
  });

  it("the amount, the breakdown and the state are checked before any fee is considered", () => {
    assert.equal(capture([5000, 0, 0, 0], [0, 0, 0], 12_831)?.reason, "amount_exceeds_capturable");
    assert.equal(capture([5000, 0, 0, 0], [0, 0, 0], 5001)?.reason, "invalid_amount", "the components must sum to the captured amount");
    assert.equal(capture([10_001, 0, 0, 0], [0, 0, 0])?.reason, "invalid_amount", "a captured component cannot exceed the original");
    assert.equal(capture([0, 0, 1501, 0], [0, 0, 0])?.reason, "invalid_amount");
    assert.equal(capture([5000, 0, 0, 0], [0, 0, 0], 0.5)?.reason, "invalid_amount");
    assert.equal(capture([0, 0, 0, 0], [0, 0, 0])?.reason, "invalid_amount", "a capture of nothing");
    assert.equal(validateCapturePaymentIntent("p", basis, { idempotencyKey: "k", intent, amountMinor: 5000, partial: null })?.reason, "invalid_request");
    assert.equal(validateCapturePaymentIntent("p", basis, { idempotencyKey: "k", intent, amountMinor: "full", partial: null }), null);
    assert.equal(validateCapturePaymentIntent("p", basis, { idempotencyKey: "k", intent, amountMinor: "full", partial: { components: basis.components, platformFee: basis.platformFee } })?.reason, "invalid_request");
    for (const state of ["requires_confirmation", "succeeded", "canceled", "requires_action"] as const) {
      assert.equal(validateCapturePaymentIntent("p", { ...basis, state }, { idempotencyKey: "k", intent, amountMinor: "full", partial: null })?.reason, "illegal_state", state);
    }
    assert.equal(validateCapturePaymentIntent("p", undefined as any, { idempotencyKey: "k", intent, amountMinor: "full", partial: null })?.reason, "provider_error");
    assert.equal(validateCapturePaymentIntent("p", basis, null as any)?.reason, "invalid_request");
  });

  it("a platform charge captured in part carries no fee", () => {
    const platform = sampleIntent({ chargeModel: "platform", recipientRef: null, platformFee: { commissionMinor: 0, payerFeeMinor: 0, taxMinor: 0 } });
    const h = { intentRef: "pi_1", chargeModel: "platform" as const, recipientRef: null };
    const part = { serviceMinor: 5000, payerFeeMinor: 0, tipMinor: 0, taxMinor: 0 };
    assert.equal(validateCapturePaymentIntent("p", platform, { idempotencyKey: "k", intent: h, amountMinor: 5000, partial: { components: part, platformFee: { commissionMinor: 0, payerFeeMinor: 0, taxMinor: 0 } } }), null);
    assert.equal(validateCapturePaymentIntent("p", platform, { idempotencyKey: "k", intent: h, amountMinor: 5000, partial: { components: part, platformFee: { commissionMinor: 1, payerFeeMinor: 0, taxMinor: 0 } } })?.reason, "invalid_request");
  });

  it("resolveCapture: `full` takes the original amount, components and fee; a partial takes what it stated", () => {
    assert.deepEqual(resolveCapture(basis, { idempotencyKey: "k", intent, amountMinor: "full", partial: null }), { amountMinor: 12_830, components: basis.components, platformFee: basis.platformFee });
    const partial = { components: { serviceMinor: 5000, payerFeeMinor: 0, tipMinor: 0, taxMinor: 0 }, platformFee: { commissionMinor: 500, payerFeeMinor: 0, taxMinor: 0 } };
    assert.deepEqual(resolveCapture(basis, { idempotencyKey: "k", intent, amountMinor: 5000, partial }), { amountMinor: 5000, ...partial });
  });

  it("THE GUARD ENFORCES IT: an adapter that would accept anything is never asked to capture a fee the rule refuses", async () => {
    const adapter = conformingAdapter();
    const guarded = guardPaymentProvider(adapter.provider, () => null);
    // The adapter's intent (sampleIntent): service 10 000 / tax 1 000, commission 1 000, tax 1 000, 11 000 capturable.
    const bad = await guarded.capturePaymentIntent({ idempotencyKey: "k", intent, amountMinor: 5000, partial: { components: { serviceMinor: 5000, payerFeeMinor: 0, tipMinor: 0, taxMinor: 0 }, platformFee: { commissionMinor: 5000, payerFeeMinor: 0, taxMinor: 0 } } });
    assert.deepEqual(tag(bad), ["failed", "fee_exceeds_commissionable_amount"]);
    assert.deepEqual(adapter.reached, ["getPaymentIntent"], "the guard read the intent and stopped; capture was never called");
    adapter.reached.length = 0;
    const good = await guarded.capturePaymentIntent({ idempotencyKey: "k", intent, amountMinor: 5000, partial: { components: { serviceMinor: 5000, payerFeeMinor: 0, tipMinor: 0, taxMinor: 0 }, platformFee: { commissionMinor: 500, payerFeeMinor: 0, taxMinor: 0 } } });
    assert.equal(good.status, "ok");
    assert.deepEqual(adapter.reached, ["getPaymentIntent", "capturePaymentIntent"]);
    // If the intent cannot be read, nothing is captured.
    adapter.reached.length = 0;
    adapter.answerNext({ status: "failed", provider: "stripe", reason: "not_found", detail: "d", retriable: false });
    assert.deepEqual(tag(await guarded.capturePaymentIntent({ idempotencyKey: "k", intent, amountMinor: "full", partial: null })), ["failed", "not_found"]);
    assert.deepEqual(adapter.reached, ["getPaymentIntent"]);
  });
});

describe("PC9 — currency granularity is the contract's, not each adapter's", () => {
  it("minor-unit exponents follow ISO 4217, and an unlisted code is two-decimal", () => {
    for (const c of ["JPY", "KRW", "VND", "CLP", "XOF", "ISK", "UGX"]) assert.equal(minorUnitExponent(c), 0, c);
    for (const c of ["KWD", "BHD", "JOD", "OMR", "TND", "IQD", "LYD"]) assert.equal(minorUnitExponent(c), 3, c);
    for (const c of ["USD", "EUR", "GBP", "PHP", "AUD", "ZZZ"]) assert.equal(minorUnitExponent(c), 2, c);
    assert.equal(minorUnitExponent("CLF"), 4);
    assert.equal(minorUnitExponent("toString"), 2, "an inherited property is not a currency");
    assert.ok(Object.isFrozen(CURRENCY_MINOR_UNIT_EXCEPTIONS));
  });

  it("three- and four-decimal currencies step by 10 and 100 minor units; the rest by one", () => {
    assert.deepEqual(["JPY", "USD", "KWD", "CLF"].map(minorUnitStep), [1, 1, 10, 100]);
    assert.equal(isChargeableAmount(5120, "KWD"), true);
    assert.equal(isChargeableAmount(5125, "KWD"), false, "5.125 KWD has a third decimal no card rail carries");
    assert.equal(isChargeableAmount(1, "JPY"), true);
    assert.equal(isChargeableAmount(1, "USD"), true);
    assert.equal(isChargeableAmount(1.5, "USD"), false);
    assert.equal(isChargeableAmount(-10, "KWD"), false);
  });

  it("every validator applies it: charge, capture, payout", async () => {
    const good = await buildCharge({ key: "k", recipientRef: "acct", buyerMarket: "GB", currency: "KWD" });
    assert.equal(validateCreatePaymentIntent("p", good), null, "10.000 + 1.000 KWD");
    const offStep = { ...good, amount: { amountMinor: 11_005, currency: "KWD" }, components: { ...good.components, tipMinor: 5 }, tax: [...good.tax, { ...good.tax[0]!, productKind: "tip" as const, taxableMinor: 5, taxMinor: 0 }] };
    assert.equal(validateCreatePaymentIntent("p", offStep)?.reason, "invalid_amount");
    assert.match(validateCreatePaymentIntent("p", offStep)?.detail ?? "", /multiple of 10 minor units in KWD/);
    assert.equal(validateCreatePaymentIntent("p", { ...good, platformFee: { ...good.platformFee, commissionMinor: 995 } })?.reason, "invalid_amount", "a fee part off the step");
    const yen = await buildCharge({ key: "k", recipientRef: "acct", sellerMarket: "JP", buyerMarket: "JP", currency: "JPY", serviceMinor: 1001, commissionMinor: 7 });
    assert.equal(validateCreatePaymentIntent("p", yen), null, "a zero-decimal currency steps by one");
    const payout = { idempotencyKey: "k", kind: "payout" as const, recipientRef: "acct", reference: { kind: "x", id: "1" } };
    assert.equal(validateRequestPayout("p", { ...payout, amount: { amountMinor: 1000, currency: "BHD" } }), null);
    assert.equal(validateRequestPayout("p", { ...payout, amount: { amountMinor: 1001, currency: "BHD" } })?.reason, "invalid_amount");
    const kwd = sampleIntent({ amount: { amountMinor: 11_000, currency: "KWD" } });
    const h = { intentRef: "pi_1", chargeModel: "direct" as const, recipientRef: "acct_1" };
    const part = (serviceMinor: number) => ({ idempotencyKey: "k", intent: h, amountMinor: serviceMinor, partial: { components: { serviceMinor, payerFeeMinor: 0, tipMinor: 0, taxMinor: 0 }, platformFee: { commissionMinor: 0, payerFeeMinor: 0, taxMinor: 0 } } });
    assert.equal(validateCapturePaymentIntent("p", kwd, part(5000)), null);
    assert.equal(validateCapturePaymentIntent("p", kwd, part(5005))?.reason, "invalid_amount");
  });
});

describe("PC10 — request shapes the adapter needs are in the contract", () => {
  it("confirm carries a return URL; a refund states both choices; a reversal may be partial only for a transfer", () => {
    const intent = { intentRef: "pi_1", chargeModel: "destination" as const, recipientRef: "acct_1" };
    assert.equal(validateConfirmPaymentIntent("p", { idempotencyKey: "k", intent, paymentMethodRef: null, returnUrl: "travelbuddy://pay/return" }), null);
    assert.equal(validateConfirmPaymentIntent("p", { idempotencyKey: "k", intent, paymentMethodRef: null, returnUrl: "  " })?.reason, "invalid_request");
    assert.equal(validateConfirmPaymentIntent("p", { idempotencyKey: "k", intent, paymentMethodRef: null } as any)?.reason, "invalid_request", "returnUrl must be stated, as a string or null");
    const refund = { idempotencyKey: "k", intent, amountMinor: "full" as const, reason: "provider_cancelled" as const, refundPlatformFee: true, reverseTransfer: true };
    assert.equal(validateRefundPayment("p", refund), null);
    assert.equal(validateRefundPayment("p", { ...refund, reverseTransfer: undefined } as any)?.reason, "invalid_request");
    assert.equal(validateRefundPayment("p", { ...refund, refundPlatformFee: undefined } as any)?.reason, "invalid_request");
    assert.equal(validateRefundPayment("p", { ...refund, intent: { ...intent, chargeModel: "direct" } })?.reason, "invalid_request");
    assert.equal(validateRefundPayment("p", { ...refund, amountMinor: 0 })?.reason, "invalid_amount");
    const transfer = { payoutRef: "tr_1", kind: "transfer" as const, recipientRef: "acct_1" };
    assert.equal(validateReverseOrHoldPayout("p", { idempotencyKey: "k", payout: transfer, action: "reverse", amountMinor: 250 }), null);
    assert.equal(validateReverseOrHoldPayout("p", { idempotencyKey: "k", payout: { ...transfer, kind: "payout" }, action: "reverse", amountMinor: 250 })?.reason, "invalid_request");
    assert.equal(validateReverseOrHoldPayout("p", { idempotencyKey: "k", payout: transfer, action: "hold", amountMinor: 250 })?.reason, "invalid_request");
    assert.equal(validateReverseOrHoldPayout("p", { idempotencyKey: "k", payout: transfer, action: "reverse" } as any)?.reason, "invalid_amount");
    assert.equal(validateRecipientOnboardingLink("p", { idempotencyKey: "k", recipientRef: "acct_1", returnUrl: "a://b", refreshUrl: "a://c" }), null);
    assert.equal(validateRecipientOnboardingLink("p", { recipientRef: "acct_1", returnUrl: "a://b", refreshUrl: "a://c" } as any)?.reason, "invalid_request");
    assert.equal(validateWebhookDelivery("p", { rawBody: "{}", headers: {}, endpoint: "connect" }), null);
    assert.equal(validateWebhookDelivery("p", { rawBody: "{}", headers: {} } as any)?.reason, "webhook_malformed", "the route must say which endpoint");
    assert.equal(validateCancelPaymentIntent("p", { idempotencyKey: "k", intent, reason: "whim" as any })?.reason, "invalid_request");
  });

  it("the Connect endpoint has its own secret variable, and a provider-initiated payout has no reference", () => {
    assert.deepEqual([PAYMENT_WEBHOOK_SECRET_ENV.stripe, PAYMENT_CONNECT_WEBHOOK_SECRET_ENV.stripe], ["STRIPE_WEBHOOK_SECRET", "STRIPE_CONNECT_WEBHOOK_SECRET"]);
    assert.equal(isPayoutSnapshot(samplePayout({ reference: null })), true);
    assert.equal(isPayoutSnapshot({ ...samplePayout(), amountReversedMinor: undefined }), false);
  });
});

describe("PC7 — the tax-provider interface", () => {
  it("`none` reports every market as not configured and never answers ok", async () => {
    for (const market of ["US", "GB", "JP", "PH", "ZZ"]) {
      const s = NONE_TAX_PROVIDER.marketStatus(market);
      assert.deepEqual([s.provider, s.market, s.configured], ["none", market, false]);
    }
    assert.ok(Object.isFrozen(NONE_TAX_PROVIDER));
    const bad = await NONE_TAX_PROVIDER.computeTax({ sellerMarket: "us", buyerMarket: "US", productKind: "service", amountMinor: 1, currency: "USD" });
    assert.deepEqual([bad.status, bad.status !== "ok" && bad.reason], ["failed", "invalid_request"]);
  });

  it("the fake computes in integers, round half up, and says who remits", async () => {
    assert.equal(taxMinorAtRate(10_000, 1000), 1000);
    assert.equal(taxMinorAtRate(5, 1000), 1, "0.5 rounds up");
    assert.equal(taxMinorAtRate(4, 1000), 0, "0.4 rounds down");
    assert.equal(taxMinorAtRate(9_007_199_254_740_000, 1), 900_719_925_474, "a large amount does not lose precision");
    const fake = createFakeTaxProvider({ env: LOCAL_ENV });
    const us = await fake.computeTax({ sellerMarket: "US", buyerMarket: "GB", productKind: "service", amountMinor: 12_345, currency: "USD" });
    assert.equal(us.status, "ok");
    if (us.status === "ok") {
      assert.deepEqual(
        [us.value.configured, us.value.taxableMinor, us.value.taxMinor, us.value.remittedBy, us.value.rateBps, us.value.sellerMarket, us.value.buyerMarket, us.value.currency],
        [true, 12_345, 1235, "platform", 1000, "US", "GB", "USD"],
      );
    }
    const tip = await fake.computeTax({ sellerMarket: "US", buyerMarket: "US", productKind: "tip", amountMinor: 2000, currency: "USD" });
    assert.deepEqual(tip.status === "ok" && [tip.value.taxMinor, tip.value.remittedBy], [0, "none"]);
    const jp = await fake.computeTax({ sellerMarket: "JP", buyerMarket: "JP", productKind: "service", amountMinor: 5000, currency: "JPY" });
    assert.deepEqual(jp.status === "ok" && [jp.value.taxMinor, jp.value.configured], [0, true], "a configured market may owe zero");
    const fr = await fake.computeTax({ sellerMarket: "FR", buyerMarket: "FR", productKind: "service", amountMinor: 5000, currency: "EUR" });
    assert.deepEqual([fr.status, fr.status !== "ok" && fr.reason], ["unavailable", "tax_not_configured"], "an absent market is not a zero-tax market");
    assert.equal(fake.marketStatus("FR").configured, false);
    assert.equal(fake.marketStatus("US").configured, true);
    assert.equal(fake.marketStatus("toString").configured, false, "an inherited property is not a market");
  });

  it("the fake tax provider is refused in production and on hosted deployments", async () => {
    for (const [why, env] of REFUSED_ENVS) {
      const fake = createFakeTaxProvider({ env });
      const r = await fake.computeTax({ sellerMarket: "US", buyerMarket: "US", productKind: "service", amountMinor: 100, currency: "USD" });
      assert.deepEqual([r.status, r.status !== "ok" && r.reason], ["unavailable", "fake_not_permitted"], why);
      assert.equal(fake.marketStatus("US").configured, false, why);
      const resolved = resolveTaxProvider({ ...env, TAX_PROVIDER: "fake" });
      assert.deepEqual([resolved.ok, !resolved.ok && resolved.reason], [false, "fake_not_permitted"], why);
      assert.equal(taxProviderOrNone({ ...env, TAX_PROVIDER: "fake" }), NONE_TAX_PROVIDER, why);
    }
  });

  it("only `none` and (locally) `fake` resolve; any other name is refused, not guessed", () => {
    for (const v of [undefined, "", "  ", "none", " NONE "]) {
      const r = resolveTaxProvider({ ...LOCAL_ENV, TAX_PROVIDER: v });
      assert.equal(r.ok && r.provider, NONE_TAX_PROVIDER, String(v));
    }
    const fake = resolveTaxProvider({ ...LOCAL_ENV, TAX_PROVIDER: "Fake" });
    assert.deepEqual([fake.ok, fake.name], [true, "fake"]);
    for (const v of ["stripe", "stripe_tax", "avalara", "taxjar"]) {
      const r = resolveTaxProvider({ ...LOCAL_ENV, TAX_PROVIDER: v });
      assert.deepEqual([r.ok, !r.ok && r.reason], [false, "tax_provider_not_registered"], v);
    }
  });
});

describe("PC11 — a tax computation is attested by the provider that issued it, and by nothing else", () => {
  const query = { sellerMarket: "US", buyerMarket: "US", productKind: "service" as const, amountMinor: 10_000, currency: "USD" };

  it("the issuing provider attests the very object it returned — not a copy, an edit, a look-alike or another provider's", async () => {
    const a = createFakeTaxProvider({ env: LOCAL_ENV });
    const b = createFakeTaxProvider({ env: LOCAL_ENV });
    const issued = await a.computeTax(query);
    assert.equal(issued.status, "ok");
    if (issued.status !== "ok") return;
    const x = issued.value;
    assert.equal(a.attests(x), true);
    assert.ok(Object.isFrozen(x), "an issued computation cannot be edited in place");
    assert.throws(() => { (x as any).taxMinor = 0; }, TypeError);
    assert.equal(x.taxMinor, 1000);
    const forgeries: Array<[string, unknown]> = [
      ["a spread copy", { ...x }],
      ["a copy with the tax zeroed", { ...x, taxMinor: 0 }],
      ["a JSON round trip", JSON.parse(JSON.stringify(x))],
      ["a hand-built look-alike for an unconfigured market", { provider: "fake", configured: true, sellerMarket: "XX", buyerMarket: "US", productKind: "service", taxableMinor: 10_000, taxMinor: 0, currency: "USD", remittedBy: "none", rateBps: 0, jurisdiction: null, calculationRef: null, computedAt: "2026-01-01T00:00:00.000Z" }],
      ["null", null],
      ["undefined", undefined],
      ["a string", "fake_taxcalc_000001"],
    ];
    for (const [name, forgery] of forgeries) assert.equal(a.attests(forgery), false, name);
    assert.equal(b.attests(x), false, "another instance of the same provider did not issue it");
    assert.equal(NONE_TAX_PROVIDER.attests(x), false, "`none` issues nothing, so it attests nothing");
  });

  it("a provider that is refused in this process attests nothing", async () => {
    const state = { env: LOCAL_ENV };
    const fake = createFakeTaxProvider({ get env() { return state.env; } });
    const issued = await fake.computeTax(query);
    assert.equal(issued.status === "ok" && fake.attests(issued.value), true);
    state.env = { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
    assert.equal(issued.status === "ok" && fake.attests(issued.value), false);
  });
});

describe("PC12 — a refund of a stated amount is checked against the intent it refunds", () => {
  const intent = { intentRef: "pi_1", chargeModel: "direct" as const, recipientRef: "acct_1" };
  const refund = (amountMinor: number | "full") => ({ idempotencyKey: "k", intent, amountMinor, reason: "support_decision" as const, refundPlatformFee: true, reverseTransfer: false });
  const captured = sampleIntent({ state: "succeeded", amountCapturableMinor: 0, amountCapturedMinor: 11_000, amountRefundedMinor: 1000 });

  it("the bound is what was captured and not yet refunded; the state must be captured", () => {
    assert.equal(validateRefundAgainstIntent("p", captured, refund(10_000)), null);
    assert.equal(validateRefundAgainstIntent("p", captured, refund("full")), null);
    assert.equal(validateRefundAgainstIntent("p", captured, refund(10_001))?.reason, "amount_exceeds_refundable");
    assert.equal(validateRefundAgainstIntent("p", { ...captured, amountRefundedMinor: 11_000 }, refund("full"))?.reason, "amount_exceeds_refundable");
    for (const state of ["requires_capture", "requires_confirmation", "canceled"] as const) {
      assert.equal(validateRefundAgainstIntent("p", { ...captured, state }, refund(1))?.reason, "illegal_state", state);
    }
    assert.equal(validateRefundAgainstIntent("p", undefined as any, refund(1))?.reason, "provider_error");
  });

  it("a three-decimal currency refunds in its chargeable step — except the exact remainder, which may always go back whole", () => {
    const kwd = sampleIntent({ state: "succeeded", amount: { amountMinor: 11_005, currency: "KWD" }, amountCapturedMinor: 11_005, amountRefundedMinor: 0 });
    assert.equal(validateRefundAgainstIntent("p", kwd, refund(5000)), null);
    assert.equal(validateRefundAgainstIntent("p", kwd, refund(5005))?.reason, "invalid_amount");
    assert.equal(validateRefundAgainstIntent("p", kwd, refund(11_005)), null, "the whole remainder");
    assert.equal(validateRefundAgainstIntent("p", sampleIntent({ state: "succeeded", amount: { amountMinor: 500, currency: "JPY" }, amountCapturedMinor: 500 }), refund(1)), null);
  });

  it("THE GUARD ENFORCES IT: it reads the intent for a stated amount, and never for `full`", async () => {
    const adapter = conformingAdapter();
    const guarded = guardPaymentProvider(adapter.provider, () => null);
    // The adapter's intent is uncaptured (requires_capture): a partial refund is refused before the adapter's refund runs.
    assert.deepEqual(tag(await guarded.refundPayment(refund(100))), ["failed", "illegal_state"]);
    assert.deepEqual(adapter.reached, ["getPaymentIntent"]);
    adapter.reached.length = 0;
    adapter.answerNext({ status: "ok", provider: "stripe", value: captured });
    assert.equal((await guarded.refundPayment(refund(100))).status, "ok");
    assert.deepEqual(adapter.reached, ["getPaymentIntent", "refundPayment"]);
    adapter.reached.length = 0;
    adapter.answerNext({ status: "ok", provider: "stripe", value: captured });
    assert.deepEqual(tag(await guarded.refundPayment(refund(10_001))), ["failed", "amount_exceeds_refundable"]);
    assert.deepEqual(adapter.reached, ["getPaymentIntent"]);
    adapter.reached.length = 0;
    assert.equal((await guarded.refundPayment(refund("full"))).status, "ok");
    assert.deepEqual(adapter.reached, ["refundPayment"], "a full refund is not held up by a read");
  });
});
