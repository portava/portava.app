/**
 * The Stripe Connect TEST-MODE adapter (services/payments/StripeConnectProvider.ts)
 * over a STUBBED transport (test/helpers/stripeSimulator.ts). Nothing here
 * reaches Stripe or any socket: the adapter has never spoken to Stripe.
 *
 *   SC0  the same contract suite the fake passes (K1-K11)
 *   SC1  the requests: method, path, form fields, Idempotency-Key, and
 *        Stripe-Account on every direct-charge, refund and payout call (and
 *        NOT on accounts, account links or application fees); no payer profile
 *        id is ever sent; refund_application_fee is stated both ways
 *   SC2  a LIVE key is refused before any request, even with
 *        PAYMENTS_ALLOW_LIVE="true"; an unknown prefix likewise
 *   SC3  inert without a key; without a webhook secret nothing verifies
 *   SC4  the Connect account configuration is required, with NO default:
 *        onboarding refuses while it is unset or unknown, and each choice sends
 *        its own controller fields
 *   SC5  markets: US/JP/TH documented, PH and VN not; destination charges and
 *        transfers are refused; an unmodelled event is ignored
 *   SC6  no network primitive is reached; the DEFAULT transport targets
 *        https://api.stripe.com through fetch (trapped here)
 *   SC7  the registry: `stripe` is registered UNCERTIFIED — every operation is
 *        provider_not_certified unless a certification run with a test key
 *
 * Run: node --import tsx/esm --test src/test/stripeConnectProvider.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";

import {
  STRIPE_CONNECT_ACCOUNT_CONFIGURATIONS,
  STRIPE_CONNECT_ACCOUNT_CONFIGURATION_ENV,
  createStripeConnectProvider,
  type StripeTransport,
} from "../services/payments/StripeConnectProvider.js";
import { intentHandle, payoutHandle, type PaymentProvider } from "../services/payments/PaymentProvider.js";
import { resolvePaymentProvider } from "../services/payments/providerRegistry.js";
import { createStripeSimulator, type StripeSimulator } from "./helpers/stripeSimulator.js";
import { buildCharge, okValue } from "./helpers/paymentFixtures.js";
import { runPaymentProviderContract, type ContractHarness } from "./helpers/paymentProviderContractSuite.js";

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const TEST_ENV = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  STRIPE_SECRET_KEY: "sk_test_contract_only",
  STRIPE_WEBHOOK_SECRET: "whsec_platform_stub",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_stub",
  [STRIPE_CONNECT_ACCOUNT_CONFIGURATION_ENV]: "express_platform_liable",
  ...over,
}) as unknown as NodeJS.ProcessEnv;

function world(env: NodeJS.ProcessEnv = TEST_ENV()) {
  let clock = T0;
  const sim = createStripeSimulator({ env, nowMs: () => clock });
  const provider = createStripeConnectProvider({ env, transport: sim.transport, nowMs: () => clock });
  return { sim, provider, tick: (ms = 1000) => { clock += ms; } };
}

async function onboard(provider: PaymentProvider, sim: StripeSimulator, key: string, country = "US", currency = "USD"): Promise<string> {
  const r = await provider.createRecipient({ idempotencyKey: key, profileId: `party-${key}`, country, entityType: "individual", settlementCurrency: currency, returnUrl: "app://ok", refreshUrl: "app://again" });
  assert.equal(r.status, "requires_action", JSON.stringify(r));
  if (r.status !== "requires_action") throw new Error("unreachable");
  return r.value.recipientRef;
}

// ── SC0 ──────────────────────────────────────────────────────────────────────
runPaymentProviderContract("stripe (stubbed transport)", (): ContractHarness => {
  const { sim, provider } = world();
  return {
    provider,
    market: { country: "US", currency: "USD" },
    newRecipient: (key, country = "US") => onboard(provider, sim, key, country),
    verify: (ref) => sim.control.verifyAccount(ref),
    pending: (ref) => sim.control.pendingAccount(ref),
    reject: (ref) => sim.control.rejectAccount(ref),
    declineNextConfirm: () => sim.control.declineNextConfirm("insufficient_funds"),
    requireActionNextConfirm: () => sim.control.requireActionNextConfirm(),
    failNext: () => sim.control.failNext(503),
    deliveries: (o) => sim.control.deliveries(o),
    sign: (raw, endpoint) => sim.control.sign(raw, endpoint),
  };
});

// ── SC1 ──────────────────────────────────────────────────────────────────────
describe("SC1 — what is sent to Stripe", () => {
  it("a direct charge: POST /v1/payment_intents AS THE CONNECTED ACCOUNT, the caller's key, the fee and the components; no payer id", async () => {
    const { sim, provider } = world();
    const rec = await onboard(provider, sim, "r1");
    sim.control.verifyAccount(rec);
    const req = await buildCharge({ key: "bk-1:1", recipientRef: rec, tipMinor: 1500 });
    okValue(await provider.createPaymentIntent(req), "create");
    const r = sim.requests.at(-1)!;
    assert.equal(r.method, "POST");
    assert.equal(r.path, "/v1/payment_intents");
    assert.equal(r.headers["Stripe-Account"], rec);
    assert.equal(r.headers["Idempotency-Key"], "bk-1:1", "the caller's key, never a minted one");
    assert.equal(r.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.match(r.headers["Authorization"] ?? "", /^Bearer sk_test_/);
    assert.equal(r.formMap["amount"], String(req.amount.amountMinor));
    assert.equal(r.formMap["currency"], "usd");
    assert.equal(r.formMap["capture_method"], "automatic");
    assert.equal(r.formMap["application_fee_amount"], String(req.platformFee.commissionMinor + req.platformFee.payerFeeMinor + req.platformFee.taxMinor));
    assert.equal(r.formMap["metadata[portava_service_minor]"], String(req.components.serviceMinor));
    assert.equal(r.formMap["metadata[portava_tip_minor]"], "1500");
    assert.equal(r.formMap["metadata[portava_commission_minor]"], String(req.platformFee.commissionMinor));
    assert.equal(r.formMap["metadata[portava_ref_id]"], req.reference.id);
    assert.ok(!JSON.stringify(sim.requests).includes(req.payerProfileId), "the payer's profile id is never sent");
    assert.deepEqual(sim.violations, []);
  });

  it("confirm, capture, cancel, read: each on the connected account; the application fee is read on the PLATFORM", async () => {
    const { sim, provider } = world();
    const rec = await onboard(provider, sim, "r2");
    sim.control.verifyAccount(rec);
    const pi = okValue(await provider.createPaymentIntent(await buildCharge({ key: "c2", recipientRef: rec, capture: "manual" })), "create");
    okValue(await provider.confirmPaymentIntent({ idempotencyKey: "c2-confirm", intent: intentHandle(pi), paymentMethodRef: "pm_card_visa", returnUrl: "app://back" }), "confirm");
    const confirm = sim.requests.find((x) => x.path.endsWith("/confirm"))!;
    assert.equal(confirm.path, `/v1/payment_intents/${pi.intentRef}/confirm`);
    assert.equal(confirm.formMap["payment_method"], "pm_card_visa");
    assert.equal(confirm.formMap["return_url"], "app://back");
    assert.equal(confirm.headers["Idempotency-Key"], "c2-confirm");
    okValue(await provider.capturePaymentIntent({ idempotencyKey: "c2-capture", intent: intentHandle(pi), amountMinor: "full", partial: null }), "capture");
    const capture = sim.requests.find((x) => x.path.endsWith("/capture"))!;
    assert.equal(capture.formMap["amount_to_capture"], String(pi.amount.amountMinor));
    assert.equal(capture.formMap["application_fee_amount"], String(pi.platformFee.commissionMinor + pi.platformFee.payerFeeMinor + pi.platformFee.taxMinor));
    const reads = sim.requests.filter((x) => x.method === "GET" && x.path.startsWith("/v1/payment_intents/"));
    assert.ok(reads.length > 0 && reads.every((x) => x.headers["Stripe-Account"] === rec && x.query.some(([k, v]) => k === "expand[]" && v === "latest_charge")));
    const fee = sim.requests.filter((x) => x.path.startsWith("/v1/application_fees/"));
    assert.ok(fee.length > 0 && fee.every((x) => x.headers["Stripe-Account"] === undefined), "application fees live on the platform account");
    const open = okValue(await provider.createPaymentIntent(await buildCharge({ key: "c2b", recipientRef: rec })), "create b");
    okValue(await provider.cancelPaymentIntent({ idempotencyKey: "c2b-cancel", intent: intentHandle(open), reason: "abandoned" }), "cancel");
    const cancel = sim.requests.at(-1)!;
    assert.equal(cancel.path, `/v1/payment_intents/${open.intentRef}/cancel`);
    assert.equal(cancel.formMap["cancellation_reason"], "abandoned");
    okValue(await provider.cancelPaymentIntent({ idempotencyKey: "c2c-cancel", intent: intentHandle(okValue(await provider.createPaymentIntent(await buildCharge({ key: "c2c", recipientRef: rec })), "c")), reason: "safety" }), "cancel c");
    assert.equal(sim.requests.at(-1)!.formMap["cancellation_reason"], undefined, "a reason with no honest Stripe match is not sent");
    assert.deepEqual(sim.violations, []);
  });

  it("a refund STATES refund_application_fee, true or false, as the caller chose", async () => {
    const { sim, provider } = world();
    const rec = await onboard(provider, sim, "r3");
    sim.control.verifyAccount(rec);
    const pi = okValue(await provider.createPaymentIntent(await buildCharge({ key: "c3", recipientRef: rec })), "create");
    okValue(await provider.confirmPaymentIntent({ idempotencyKey: "c3-confirm", intent: intentHandle(pi), paymentMethodRef: "pm_card_visa", returnUrl: null }), "confirm");
    const kept = okValue(await provider.refundPayment({ idempotencyKey: "c3-r1", intent: intentHandle(pi), amountMinor: 1000, reason: "support_decision", refundPlatformFee: false, reverseTransfer: false }), "refund kept fee");
    assert.equal(sim.requests.filter((x) => x.path === "/v1/refunds").at(-1)!.formMap["refund_application_fee"], "false");
    assert.equal(kept.platformFeeRefundedMinor, 0);
    okValue(await provider.refundPayment({ idempotencyKey: "c3-r2", intent: intentHandle(pi), amountMinor: "full", reason: "duplicate", refundPlatformFee: true, reverseTransfer: false }), "refund with fee");
    const r = sim.requests.filter((x) => x.path === "/v1/refunds").at(-1)!;
    assert.equal(r.formMap["refund_application_fee"], "true");
    assert.equal(r.formMap["reason"], "duplicate");
    assert.equal(r.formMap["metadata[portava_refund_reason]"], "duplicate");
    assert.equal(r.formMap["amount"], undefined, "a full refund sends no amount");
    assert.equal(r.headers["Stripe-Account"], rec);
    assert.deepEqual(sim.violations, []);
  });

  it("a payout: POST /v1/payouts as the connected account, with the caller's key and the platform's reference", async () => {
    const { sim, provider } = world();
    const rec = await onboard(provider, sim, "r4");
    sim.control.verifyAccount(rec);
    const pi = okValue(await provider.createPaymentIntent(await buildCharge({ key: "c4", recipientRef: rec })), "create");
    okValue(await provider.confirmPaymentIntent({ idempotencyKey: "c4-confirm", intent: intentHandle(pi), paymentMethodRef: "pm_card_visa", returnUrl: null }), "confirm");
    const po = okValue(await provider.requestPayout({ idempotencyKey: "rab-payout:p1", kind: "payout", recipientRef: rec, amount: { amountMinor: 700, currency: "USD" }, reference: { kind: "rab_monthly_payout", id: "p1" } }), "payout");
    const r = sim.requests.at(-1)!;
    assert.equal(r.path, "/v1/payouts");
    assert.equal(r.headers["Stripe-Account"], rec);
    assert.equal(r.headers["Idempotency-Key"], "rab-payout:p1");
    assert.deepEqual([r.formMap["amount"], r.formMap["currency"], r.formMap["metadata[portava_ref_id]"]], ["700", "usd", "p1"]);
    okValue(await provider.reverseOrHoldPayout({ idempotencyKey: "rab-payout:p1:cancel", payout: payoutHandle(po), action: "reverse", amountMinor: "full" }), "cancel");
    assert.equal(sim.requests.at(-1)!.path, `/v1/payouts/${po.payoutRef}/cancel`);
    assert.deepEqual(sim.violations, []);
  });
});

// ── SC2 / SC3 ────────────────────────────────────────────────────────────────
describe("SC2/SC3 — test keys only, and nothing without a key", () => {
  const sentNothing = () => {
    let calls = 0;
    const transport: StripeTransport = async () => { calls += 1; return { status: 500, body: null }; };
    return { transport, calls: () => calls };
  };

  for (const [label, over] of [
    ["a live key", { STRIPE_SECRET_KEY: "sk_live_x" }],
    ["a live key with PAYMENTS_ALLOW_LIVE=\"true\"", { STRIPE_SECRET_KEY: "sk_live_x", PAYMENTS_ALLOW_LIVE: "true" }],
    ["a live restricted key", { STRIPE_SECRET_KEY: "rk_live_x", PAYMENTS_ALLOW_LIVE: "true" }],
  ] as const) {
    it(`${label} is refused before any request (live_key_not_allowed)`, async () => {
      const t = sentNothing();
      const p = createStripeConnectProvider({ env: TEST_ENV(over), transport: t.transport });
      const r = await p.validateRecipient("acct_x");
      assert.equal(r.status, "unavailable");
      if (r.status === "unavailable") assert.equal(r.reason, "live_key_not_allowed");
      assert.equal(t.calls(), 0);
    });
  }

  it("an unrecognised key prefix is refused before any request", async () => {
    const t = sentNothing();
    const r = await createStripeConnectProvider({ env: TEST_ENV({ STRIPE_SECRET_KEY: "pk_test_publishable" }), transport: t.transport }).validateRecipient("acct_x");
    assert.equal(r.status, "unavailable");
    if (r.status === "unavailable") assert.equal(r.reason, "unknown_key_prefix");
    assert.equal(t.calls(), 0);
  });

  it("without a key every operation answers key_absent and sends nothing", async () => {
    const t = sentNothing();
    const env = TEST_ENV();
    delete (env as Record<string, unknown>)["STRIPE_SECRET_KEY"];
    const p = createStripeConnectProvider({ env, transport: t.transport });
    const results = [
      await p.createPaymentIntent(await buildCharge({ key: "x", recipientRef: "acct_x" })),
      await p.getPaymentIntent({ intentRef: "pi_x", chargeModel: "direct", recipientRef: "acct_x" }),
      await p.createRecipient({ idempotencyKey: "x", profileId: "p", country: "US", entityType: "individual", settlementCurrency: "USD", returnUrl: "a://b", refreshUrl: "a://c" }),
      await p.validateRecipient("acct_x"),
      await p.requestPayout({ idempotencyKey: "x", kind: "payout", recipientRef: "acct_x", amount: { amountMinor: 1, currency: "USD" }, reference: { kind: "k", id: "i" } }),
    ];
    for (const r of results) {
      assert.equal(r.status, "unavailable", JSON.stringify(r));
      if (r.status === "unavailable") assert.equal(r.reason, "key_absent");
    }
    assert.equal(t.calls(), 0);
  });

  it("without the endpoint's webhook secret nothing verifies (webhook_secret_not_configured)", async () => {
    const env = TEST_ENV();
    delete (env as Record<string, unknown>)["STRIPE_CONNECT_WEBHOOK_SECRET"];
    const { sim, provider } = world(env);
    const d = sim.control.sign(JSON.stringify({ id: "evt_1", type: "account.updated", created: 1, livemode: false, account: "acct_1", data: { object: {} } }), "connect");
    const r = await provider.verifyAndParseWebhook(d);
    assert.equal(r.status, "unavailable");
    if (r.status === "unavailable") assert.equal(r.reason, "webhook_secret_not_configured");
  });
});

// ── SC4 ──────────────────────────────────────────────────────────────────────
describe("SC4 — the Connect account configuration is required and has no default", () => {
  for (const value of ["", "standard", "express", "EXPRESS_PLATFORM_LIABLE"]) {
    it(`unset or unknown (${JSON.stringify(value)}): onboarding refuses, naming the setting, and sends nothing`, async () => {
      const env = TEST_ENV({ [STRIPE_CONNECT_ACCOUNT_CONFIGURATION_ENV]: value });
      const { sim, provider } = world(env);
      const r = await provider.createRecipient({ idempotencyKey: "k", profileId: "p", country: "US", entityType: "individual", settlementCurrency: "USD", returnUrl: "a://b", refreshUrl: "a://c" });
      assert.equal(r.status, "unavailable", JSON.stringify(r));
      if (r.status === "unavailable") {
        assert.equal(r.reason, "capability_not_supported");
        assert.match(r.detail, new RegExp(STRIPE_CONNECT_ACCOUNT_CONFIGURATION_ENV));
        assert.match(r.detail, /no default/);
      }
      const l = await provider.createRecipientOnboardingLink({ idempotencyKey: "k2", recipientRef: "acct_1", returnUrl: "a://b", refreshUrl: "a://c" });
      assert.equal(l.status, "unavailable");
      assert.equal(sim.requests.length, 0);
    });
  }

  for (const [name, c] of Object.entries(STRIPE_CONNECT_ACCOUNT_CONFIGURATIONS)) {
    it(`${name}: POST /v1/accounts sends exactly its controller fields, on the platform, with no name or email`, async () => {
      const { sim, provider } = world(TEST_ENV({ [STRIPE_CONNECT_ACCOUNT_CONFIGURATION_ENV]: name }));
      await onboard(provider, sim, `cfg-${name}`);
      const r = sim.requests.find((x) => x.path === "/v1/accounts")!;
      assert.equal(r.headers["Stripe-Account"], undefined);
      assert.equal(r.formMap["controller[fees][payer]"], c.feesPayer);
      assert.equal(r.formMap["controller[losses][payments]"], c.lossesPayments);
      assert.equal(r.formMap["controller[stripe_dashboard][type]"], c.dashboard);
      assert.equal(r.formMap["capabilities[card_payments][requested]"], "true");
      assert.equal(r.formMap["metadata[portava_ref]"], `party-cfg-${name}`);
      assert.ok(!Object.keys(r.formMap).some((k) => /email|name|phone|dob|address/.test(k)), Object.keys(r.formMap).join(","));
      assert.deepEqual(sim.violations, []);
    });
  }
});

// ── SC5 ──────────────────────────────────────────────────────────────────────
describe("SC5 — markets, models and events this adapter does not serve", () => {
  it("US, JP and TH are documented (stripe.com/global, 2026-10-05); PH and VN are not — Manila and Da Nang cannot be served by direct charges", () => {
    const { provider } = world();
    for (const [c, cur] of [["US", "USD"], ["JP", "JPY"], ["TH", "THB"]] as const) {
      assert.equal(provider.marketSupport({ recipientCountry: c, presentmentCurrency: cur }).supported, true, c);
      assert.equal(provider.marketSupport({ recipientCountry: c, presentmentCurrency: "EUR" }).supported, false, `${c}: no conversion is modelled`);
    }
    for (const c of ["PH", "VN", "BR"]) assert.equal(provider.marketSupport({ recipientCountry: c }).supported, false, c);
  });

  it("a destination charge and a transfer are refused; a payout hold is not a Stripe operation", async () => {
    const { provider } = world();
    const d = await provider.createPaymentIntent(await buildCharge({ key: "d", recipientRef: "acct_1", chargeModel: "destination" }));
    assert.equal(d.status, "unavailable");
    if (d.status === "unavailable") assert.equal(d.reason, "charge_model_not_supported");
    const t = await provider.requestPayout({ idempotencyKey: "t", kind: "transfer", recipientRef: "acct_1", amount: { amountMinor: 1, currency: "USD" }, reference: { kind: "k", id: "i" } });
    assert.equal(t.status, "unavailable");
    assert.equal(provider.capabilities().transfers, false);
    assert.equal(provider.capabilities().payoutHold, false);
    assert.deepEqual(provider.capabilities().chargeModels, ["direct"]);
  });

  it("a verified event this contract does not model is acknowledged as ignored", async () => {
    const { sim, provider } = world();
    const d = sim.control.sign(JSON.stringify({ id: "evt_x", object: "event", type: "customer.created", created: 1_700_000_000, livemode: false, data: { object: { id: "cus_1" } } }), "platform");
    const e = okValue(await provider.verifyAndParseWebhook(d), "ignored");
    assert.equal(e.body.kind, "ignored");
  });

  it("a dispute on the connected account is reported", async () => {
    const { sim, provider } = world();
    const rec = await onboard(provider, sim, "rd");
    sim.control.verifyAccount(rec);
    const pi = okValue(await provider.createPaymentIntent(await buildCharge({ key: "cd", recipientRef: rec })), "create");
    okValue(await provider.confirmPaymentIntent({ idempotencyKey: "cd-c", intent: intentHandle(pi), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    sim.control.deliveries();
    sim.control.openDispute(pi.intentRef);
    const [d] = sim.control.deliveries();
    const e = okValue(await provider.verifyAndParseWebhook(d!), "dispute");
    assert.equal(e.body.kind, "dispute");
    if (e.body.kind === "dispute") {
      assert.equal(e.body.dispute.intentRef, pi.intentRef);
      assert.equal(e.body.dispute.state, "needs_response");
      assert.equal(e.body.dispute.recipientRef, rec);
    }
  });
});

// ── SC6 ──────────────────────────────────────────────────────────────────────
describe("SC6 — no socket is opened; the default transport is fetch to api.stripe.com", () => {
  const reached: string[] = [];
  const fetchCalls: Array<{ url: string; method: string; hasAuth: boolean }> = [];
  const saved: Array<[any, string, any]> = [];
  function trap(obj: any, key: string, label: string) {
    saved.push([obj, key, obj[key]]);
    obj[key] = (..._a: unknown[]) => { reached.push(label); throw new Error(`network primitive reached: ${label}`); };
  }
  before(() => {
    saved.push([globalThis, "fetch", globalThis.fetch]);
    (globalThis as any).fetch = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      fetchCalls.push({ url: String(url), method: init.method, hasAuth: /^Bearer sk_test_/.test(init.headers["Authorization"] ?? "") });
      throw new Error("trapped fetch");
    };
    trap(http, "request", "http.request"); trap(https, "request", "https.request");
    trap(net, "connect", "net.connect"); trap(tls, "connect", "tls.connect"); trap(dns, "lookup", "dns.lookup");
  });
  after(() => { for (const [o, k, v] of saved.reverse()) o[k] = v; });

  it("a whole flow over the stub reaches no network primitive", async () => {
    const { sim, provider } = world();
    const rec = await onboard(provider, sim, "n1");
    sim.control.verifyAccount(rec);
    const pi = okValue(await provider.createPaymentIntent(await buildCharge({ key: "n1", recipientRef: rec })), "create");
    okValue(await provider.confirmPaymentIntent({ idempotencyKey: "n1-c", intent: intentHandle(pi), paymentMethodRef: "pm", returnUrl: null }), "confirm");
    for (const d of sim.control.deliveries()) okValue(await provider.verifyAndParseWebhook(d), "event");
    assert.deepEqual(reached, []);
    assert.deepEqual(fetchCalls, []);
  });

  it("with no transport injected, the adapter calls fetch on https://api.stripe.com with the test key, and an unreachable Stripe is a retriable unavailable", async () => {
    const p = createStripeConnectProvider({ env: TEST_ENV() });
    const r = await p.validateRecipient("acct_123");
    assert.equal(r.status, "unavailable");
    if (r.status === "unavailable") { assert.equal(r.reason, "provider_unreachable"); assert.equal(r.retriable, true); }
    assert.deepEqual(fetchCalls, [{ url: "https://api.stripe.com/v1/accounts/acct_123", method: "GET", hasAuth: true }]);
  });
});

// ── SC7 ──────────────────────────────────────────────────────────────────────
describe("SC7 — registered, UNCERTIFIED: no route can reach it", () => {
  const env = (over: Record<string, string> = {}) => ({ ...TEST_ENV(), PAYMENT_PROVIDER: "stripe", ...over }) as unknown as NodeJS.ProcessEnv;

  it("PAYMENT_PROVIDER=stripe with a test key resolves to provider_not_certified", () => {
    const r = resolvePaymentProvider(env());
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.kind, "adapter"); assert.equal(r.reason, "provider_not_certified"); }
  });

  it("a certification run with a TEST key gets the guarded adapter; with a live key it is refused", () => {
    const run = resolvePaymentProvider(env(), undefined, { certificationRun: true });
    assert.equal(run.ok, true);
    if (run.ok) { assert.equal(run.kind, "adapter"); assert.equal(run.certified, false); assert.equal(run.provider.id, "stripe"); }
    const live = resolvePaymentProvider(env({ STRIPE_SECRET_KEY: "sk_live_x", PAYMENTS_ALLOW_LIVE: "true" }), undefined, { certificationRun: true });
    assert.equal(live.ok, false);
  });
});
