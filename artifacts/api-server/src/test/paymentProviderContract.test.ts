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
 *   PC6  nothing is thrown: the guard turns a throwing adapter into a tagged
 *        result, and a sandbox-guard refusal keeps its meaning
 *   PC7  the `none` tax provider reports every market as not configured and
 *        never answers ok; the fake computes in integers and is refused outside
 *        a local run; only `none` and `fake` resolve
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

import { PaymentsLiveModeRefusedError } from "../lib/paymentsMode.js";
import {
  NONE_PAYMENT_PROVIDER,
  NO_PAYMENT_CAPABILITIES,
  PAYMENT_PROVIDER_OPERATIONS,
  guardPaymentProvider,
  isMinorUnits,
  isMoney,
  paymentOk,
  paymentResultFromThrown,
  platformFeeTotalMinor,
  refusingPaymentProvider,
  selectChargeModel,
  validateCreatePaymentIntent,
  validateCreateRecipient,
  validateRequestPayout,
  type CreatePaymentIntentRequest,
  type MarketSupport,
  type PaymentProvider,
  type PaymentProviderCapabilities,
  type PaymentResult,
} from "../services/payments/PaymentProvider.js";
import {
  NONE_TAX_PROVIDER,
  createFakeTaxProvider,
  resolveTaxProvider,
  taxMinorAtRate,
  taxProviderOrNone,
} from "../services/payments/TaxProvider.js";
import { LOCAL_ENV, REFUSED_ENVS, buildCharge, tag } from "./helpers/paymentFixtures.js";

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

/** Call every one of the thirteen operations with a plausible argument. */
async function callEveryOperation(p: PaymentProvider): Promise<Array<[string, PaymentResult<unknown>]>> {
  const intent = { intentRef: "x", chargeModel: "direct" as const, recipientRef: "acct" };
  const payout = { payoutRef: "x", kind: "payout" as const, recipientRef: "acct" };
  const charge = await buildCharge({ key: "k-every", recipientRef: "acct" });
  const calls: Record<(typeof PAYMENT_PROVIDER_OPERATIONS)[number], () => Promise<PaymentResult<unknown>>> = {
    createPaymentIntent: () => p.createPaymentIntent(charge),
    confirmPaymentIntent: () => p.confirmPaymentIntent({ idempotencyKey: "k1", intent, paymentMethodRef: null }),
    capturePaymentIntent: () => p.capturePaymentIntent({ idempotencyKey: "k2", intent, amountMinor: "full", platformFeeMinor: null }),
    cancelPaymentIntent: () => p.cancelPaymentIntent({ idempotencyKey: "k3", intent, reason: "abandoned" }),
    getPaymentIntent: () => p.getPaymentIntent(intent),
    refundPayment: () => p.refundPayment({ idempotencyKey: "k4", intent, amountMinor: "full", reason: "provider_cancelled", refundPlatformFee: true }),
    createRecipient: () => p.createRecipient({ idempotencyKey: "k5", profileId: "p", country: "US", entityType: "individual", settlementCurrency: "USD", returnUrl: "a://b", refreshUrl: "a://c" }),
    createRecipientOnboardingLink: () => p.createRecipientOnboardingLink({ recipientRef: "acct", returnUrl: "a://b", refreshUrl: "a://c" }),
    validateRecipient: () => p.validateRecipient("acct"),
    requestPayout: () => p.requestPayout({ idempotencyKey: "k6", kind: "payout", recipientRef: "acct", amount: { amountMinor: 100, currency: "USD" }, reference: { kind: "payout", id: "1" } }),
    getPayoutStatus: () => p.getPayoutStatus(payout),
    reverseOrHoldPayout: () => p.reverseOrHoldPayout({ idempotencyKey: "k7", payout, action: "hold" }),
    verifyAndParseWebhook: () => p.verifyAndParseWebhook({ rawBody: "{}", headers: {} }),
  };
  const out: Array<[string, PaymentResult<unknown>]> = [];
  for (const op of PAYMENT_PROVIDER_OPERATIONS) out.push([op, await calls[op]()]);
  return out;
}

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

describe("PC6 — nothing is thrown", () => {
  const throwing = (thrown: unknown): PaymentProvider => ({
    ...refusingPaymentProvider("adapter", "payments_disabled", "x"),
    validateRecipient: async () => { throw thrown; },
    getPaymentIntent: async () => paymentOk("adapter", {} as any),
  });

  it("a thrown string, a thrown Error and a rejected promise all become failed / provider_error, without the message", async () => {
    for (const thrown of ["boom sk_live_SECRET", new Error("request to https://api.example/v1 with sk_live_SECRET failed"), { code: "ECONNRESET" }]) {
      const guarded = guardPaymentProvider(throwing(thrown), () => null);
      const r = await guarded.validateRecipient("acct");
      assert.deepEqual([r.status, r.status !== "ok" && r.reason], ["failed", "provider_error"]);
      assert.ok(!JSON.stringify(r).includes("SECRET"), "the thrown message must not travel in the result");
      if (r.status === "failed") assert.equal(r.retriable, true);
    }
    const coded = paymentResultFromThrown("adapter", Object.assign(new Error("x"), { code: "ETIMEDOUT" }));
    assert.match(coded.detail, /code=ETIMEDOUT/);
  });

  it("a sandbox-guard refusal thrown by an adapter keeps its meaning", async () => {
    const live = new PaymentsLiveModeRefusedError({ provider: "stripe", keyPresent: true, mode: "live", liveAllowed: false, allowed: false, refusal: "live_key_not_allowed" });
    const unknown = new PaymentsLiveModeRefusedError({ provider: "stripe", keyPresent: true, mode: "unknown", liveAllowed: false, allowed: false, refusal: "unknown_key_prefix" });
    const event = new PaymentsLiveModeRefusedError({ provider: "stripe", refusal: "live_event_not_allowed", liveAllowed: false });
    assert.deepEqual(tag(paymentResultFromThrown("stripe", live)), ["unavailable", "live_key_not_allowed"]);
    assert.deepEqual(tag(paymentResultFromThrown("stripe", unknown)), ["unavailable", "unknown_key_prefix"]);
    assert.deepEqual(tag(paymentResultFromThrown("stripe", event)), ["unavailable", "livemode_not_allowed"]);
    assert.deepEqual(tag(await guardPaymentProvider(throwing(live), () => null).validateRecipient("acct")), ["unavailable", "live_key_not_allowed"]);
  });

  it("the precheck runs before the adapter on every operation, and a refusal means the adapter is never called", async () => {
    let adapterCalls = 0;
    const counting: PaymentProvider = { ...refusingPaymentProvider("adapter", "payments_disabled", "x") };
    for (const op of PAYMENT_PROVIDER_OPERATIONS) (counting as any)[op] = async () => { adapterCalls += 1; return paymentOk("adapter", {}); };
    let refuse = true;
    const guarded = guardPaymentProvider(counting, () => (refuse ? { status: "unavailable", provider: "adapter", reason: "live_key_not_allowed", detail: "x", retriable: false } : null));
    for (const [op, r] of await callEveryOperation(guarded)) assert.deepEqual(tag(r), ["unavailable", "live_key_not_allowed"], op);
    assert.equal(adapterCalls, 0, "a refused precheck must not reach the adapter");
    refuse = false;
    for (const [op, r] of await callEveryOperation(guarded)) assert.equal(r.status, "ok", op);
    assert.equal(adapterCalls, 13);
    const throwingPrecheck = guardPaymentProvider(counting, () => { throw new Error("precheck bug"); });
    assert.deepEqual(tag(await throwingPrecheck.validateRecipient("acct")), ["failed", "provider_error"]);
    assert.equal(adapterCalls, 13, "a precheck that throws fails closed");
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
