/**
 * PAY-T03 — which provider this process uses, and whether payments are ready.
 *
 *   PR1  the payment-key classification table (lib/paymentsMode.ts): prefix
 *        only, including empty, whitespace and mixed case — and it is the
 *        identity key's function, not a fork of it
 *   PR2  the registry resolves only `none` and `fake` until an adapter is
 *        registered; the fake is refused in production and hosted deployments
 *   PR3  a keyed adapter is refused BEFORE any request on a live, unrecognised
 *        or absent key — at resolution and again before every operation
 *   PR4  the platform's enabled markets
 *   PR5  the readiness report: provider, key mode, PAYMENTS_ALLOW_LIVE, tax
 *   PR6  the older PayoutProvider seam sits behind the contract and its
 *        behaviour for existing callers is unchanged
 *   PR7  market and tax policy is enforced BY THE REGISTRY: the platform's
 *        enabled markets, the provider's market support, and a tax computation
 *        issued by the registered tax provider — a hand-built one is refused
 *
 * Pure: every env is an object passed in. No network, no database.
 * Run: node --import tsx/esm --test src/test/paymentProviderRegistry.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PAYMENT_KEY_ENV,
  PAYMENT_PROVIDER_ENV,
  PAYMENT_WEBHOOK_SECRET_ENV,
  PaymentsLiveModeRefusedError,
  configuredPaymentProvider,
  evaluatePaymentKey,
  evaluateProviderKey,
  fakePaymentProviderPermitted,
  isKeyedPaymentProvider,
  mockIdentityPermitted,
  paymentKeyDecision,
  type ProviderKeyMode,
  type ProviderKeyRefusal,
} from "../lib/paymentsMode.js";
import { NONE_PAYOUT_PROVIDER, resolvePayoutProvider } from "../services/creators/PayoutProvider.js";
import { createFakePaymentProvider } from "../services/payments/FakePaymentProvider.js";
import {
  NONE_PAYMENT_PROVIDER,
  PAYMENT_PROVIDER_OPERATIONS,
  validateCreatePaymentIntent,
  type CreatePaymentIntentRequest,
  type PaymentProvider,
  type PaymentResult,
} from "../services/payments/PaymentProvider.js";
import { createFakeTaxProvider, taxProviderOrNone } from "../services/payments/TaxProvider.js";
import { payoutProviderBehind, resolvePayoutProviderBehindPayments, toPayoutRefusal, type PayoutSeamContext } from "../services/payments/payoutSeam.js";
import {
  PAYMENTS_ENABLED_MARKETS_ENV,
  enabledPaymentMarkets,
  enforcePaymentPolicy,
  getPaymentProvider,
  paymentMarketEnabled,
  paymentProviderLabel,
  registeredPaymentAdapters,
  resolvePaymentProvider,
  sharedFakePaymentProvider,
  type PaymentPolicy,
  type PaymentProviderAdapterRegistration,
} from "../services/payments/providerRegistry.js";
import { paymentsReadiness, paymentsReadinessSummary } from "../services/payments/readiness.js";
import { LOCAL_ENV, REFUSED_ENVS, buildCharge, callEveryOperation, conformingAdapter, sampleRecipient, tag, type ConformingAdapter } from "./helpers/paymentFixtures.js";

const env = (o: Record<string, string | undefined>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

// Dummy keys (documented prefixes, meaningless bodies). No real key exists in this file.
const TEST_KEY = "sk_test_dummyDUMMYdummy";
const LIVE_KEY = "sk_live_dummyDUMMYdummy";

describe("PR1 — payment key classification", () => {
  type Row = [name: string, key: string | undefined, allowLive: string | undefined, keyPresent: boolean, mode: ProviderKeyMode, allowed: boolean, refusal: ProviderKeyRefusal | null];
  const TABLE: Row[] = [
    ["unset", undefined, undefined, false, "unknown", false, "key_absent"],
    ["empty string", "", undefined, false, "unknown", false, "key_absent"],
    ["spaces only", "   ", undefined, false, "unknown", false, "key_absent"],
    ["tab and newline only", "\t\n", undefined, false, "unknown", false, "key_absent"],
    ["sk_test_", "sk_test_abc", undefined, true, "test", true, null],
    ["rk_test_ (restricted)", "rk_test_abc", undefined, true, "test", true, null],
    ["a test key is allowed whatever PAYMENTS_ALLOW_LIVE says", "sk_test_abc", "true", true, "test", true, null],
    ["sk_live_", "sk_live_abc", undefined, true, "live", false, "live_key_not_allowed"],
    ["rk_live_ (restricted)", "rk_live_abc", undefined, true, "live", false, "live_key_not_allowed"],
    ["sk_live_ with PAYMENTS_ALLOW_LIVE=true", "sk_live_abc", "true", true, "live", true, null],
    ["rk_live_ with PAYMENTS_ALLOW_LIVE=true", "rk_live_abc", "true", true, "live", true, null],
    ["sk_live_ with PAYMENTS_ALLOW_LIVE=TRUE", "sk_live_abc", "TRUE", true, "live", false, "live_key_not_allowed"],
    ["sk_live_ with PAYMENTS_ALLOW_LIVE=1", "sk_live_abc", "1", true, "live", false, "live_key_not_allowed"],
    ["sk_live_ with PAYMENTS_ALLOW_LIVE=' true'", "sk_live_abc", " true", true, "live", false, "live_key_not_allowed"],
    ["upper case SK_TEST_", "SK_TEST_abc", undefined, true, "unknown", false, "unknown_key_prefix"],
    ["mixed case Sk_Test_", "Sk_Test_abc", undefined, true, "unknown", false, "unknown_key_prefix"],
    ["mixed case sk_TEST_", "sk_TEST_abc", undefined, true, "unknown", false, "unknown_key_prefix"],
    ["mixed case Sk_Live_", "Sk_Live_abc", undefined, true, "unknown", false, "unknown_key_prefix"],
    ["upper case SK_LIVE_ is not rescued by PAYMENTS_ALLOW_LIVE", "SK_LIVE_abc", "true", true, "unknown", false, "unknown_key_prefix"],
    ["leading space before sk_test_", " sk_test_abc", undefined, true, "unknown", false, "unknown_key_prefix"],
    ["leading newline before sk_live_", "\nsk_live_abc", "true", true, "unknown", false, "unknown_key_prefix"],
    ["sk_test with no trailing underscore", "sk_test", undefined, true, "unknown", false, "unknown_key_prefix"],
    ["a publishable key pk_test_", "pk_test_abc", undefined, true, "unknown", false, "unknown_key_prefix"],
    ["a publishable key pk_live_ with live allowed", "pk_live_abc", "true", true, "unknown", false, "unknown_key_prefix"],
    ["a webhook secret whsec_", "whsec_abc", undefined, true, "unknown", false, "unknown_key_prefix"],
    ["a Persona sandbox key", "persona_sandbox_abc", undefined, true, "unknown", false, "unknown_key_prefix"],
    ["an arbitrary string", "hunter2", "true", true, "unknown", false, "unknown_key_prefix"],
  ];

  it("classifies STRIPE_SECRET_KEY by prefix and nothing else", () => {
    assert.ok(TABLE.length >= 25);
    for (const [name, key, allowLive, keyPresent, mode, allowed, refusal] of TABLE) {
      const e = env({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: key, PAYMENTS_ALLOW_LIVE: allowLive });
      const d = paymentKeyDecision(e);
      assert.deepEqual(
        d,
        { provider: "stripe", keyPresent, mode, liveAllowed: allowLive === "true", allowed, refusal },
        name,
      );
      // Not a fork: the payment decision IS the shared function's decision, row for row.
      assert.deepEqual(d, evaluateProviderKey("stripe", key, e), name);
      assert.deepEqual(evaluatePaymentKey("stripe", e), d, name);
      if (key) assert.ok(!JSON.stringify(d).includes(key.trim()) || key.trim() === "", `${name}: the decision carries the key`);
    }
  });

  it("names the variables, and only a keyed provider has a decision", () => {
    assert.deepEqual([PAYMENT_PROVIDER_ENV, PAYMENT_KEY_ENV.stripe, PAYMENT_WEBHOOK_SECRET_ENV.stripe], ["PAYMENT_PROVIDER", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
    assert.equal(isKeyedPaymentProvider("stripe"), true);
    for (const n of ["none", "fake", "persona", "paypal", ""]) assert.equal(isKeyedPaymentProvider(n), false, n);
    for (const name of [undefined, "", "none", "fake", "paypal"]) {
      assert.equal(paymentKeyDecision(env({ PAYMENT_PROVIDER: name, STRIPE_SECRET_KEY: LIVE_KEY })), null, String(name));
    }
    // The identity key lives in a DIFFERENT variable and does not answer for payments.
    assert.equal(paymentKeyDecision(env({ PAYMENT_PROVIDER: "stripe", STRIPE_IDENTITY_SECRET_KEY: TEST_KEY }))?.refusal, "key_absent");
  });

  it("the provider name is trimmed and lower-cased; absent or empty means none", () => {
    const cases: Array<[string | undefined, string]> = [[undefined, "none"], ["", "none"], ["   ", "none"], ["none", "none"], [" NONE ", "none"], ["Fake", "fake"], [" Stripe\n", "stripe"]];
    for (const [raw, name] of cases) assert.equal(configuredPaymentProvider(env({ PAYMENT_PROVIDER: raw })), name, JSON.stringify(raw));
  });

  it("the fake's permission is the mock identity provider's rule, env for env", () => {
    const envs: NodeJS.ProcessEnv[] = [
      {}, env({ NODE_ENV: "production" }), env({ NODE_ENV: "development" }), env({ NODE_ENV: "test" }), env({ NODE_ENV: "staging" }),
      env({ NODE_TEST_CONTEXT: "child-v8" }), env({ NODE_ENV: "development", REPLIT_DEPLOYMENT: "1" }), env({ NODE_TEST_CONTEXT: "child-v8", REPLIT_DEPLOYMENT: "1" }),
      env({ NODE_ENV: "production", NODE_TEST_CONTEXT: "child-v8" }), env({ REPLIT_DEPLOYMENT: "" , NODE_ENV: "test" }),
    ];
    for (const e of envs) assert.equal(fakePaymentProviderPermitted(e), mockIdentityPermitted(e), JSON.stringify(e));
    assert.equal(fakePaymentProviderPermitted(env({ NODE_ENV: "production" })), false);
    assert.equal(fakePaymentProviderPermitted(env({ NODE_ENV: "development", REPLIT_DEPLOYMENT: "1" })), false);
    assert.equal(fakePaymentProviderPermitted({}), false, "a bare start with no NODE_ENV is what the deployment runs");
    assert.equal(fakePaymentProviderPermitted(env({ NODE_ENV: "development" })), true);
  });

  it("REPLIT_DEPLOYMENT counts when it is PRESENT, even empty — for the mock identity provider and the fake alike", () => {
    // Replit sets it to "1" in a published app and leaves it unset otherwise; an empty value is a blanked marker, not a local run.
    for (const local of [{ NODE_ENV: "development" }, { NODE_ENV: "test" }, { NODE_TEST_CONTEXT: "child-v8" }]) {
      assert.equal(mockIdentityPermitted(env(local)), true, JSON.stringify(local));
      for (const marker of ["1", "0", "", " ", "false"]) {
        const e = env({ ...local, REPLIT_DEPLOYMENT: marker });
        assert.equal(mockIdentityPermitted(e), false, `identity: ${JSON.stringify(local)} with REPLIT_DEPLOYMENT=${JSON.stringify(marker)}`);
        assert.equal(fakePaymentProviderPermitted(e), false, `payments: ${JSON.stringify(local)} with REPLIT_DEPLOYMENT=${JSON.stringify(marker)}`);
      }
      // Unset — by absence or by an explicit undefined — is not a deployment.
      assert.equal(mockIdentityPermitted(env({ ...local, REPLIT_DEPLOYMENT: undefined })), true);
    }
  });
});

/** Register a conforming stand-in adapter under the name `stripe`, counting how often it is constructed. */
function standIn(certified = true): { registration: PaymentProviderAdapterRegistration; adapter: ConformingAdapter; creates: () => number } {
  const adapter = conformingAdapter("stripe");
  let creates = 0;
  return {
    adapter,
    creates: () => creates,
    registration: { name: "stripe", keyProvider: "stripe", certified, create: () => { creates += 1; return adapter.provider; } },
  };
}

/** A local run with a test key, the US enabled and the fake tax provider: everything the policy asks for. */
const READY = Object.freeze({ ...LOCAL_ENV, PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: TEST_KEY, TAX_PROVIDER: "fake", PAYMENTS_ENABLED_MARKETS: "US" });

/** The create-intent request with tax computed by the REGISTERED tax provider of `e` — the only kind the registry accepts. */
async function attestedCharge(e: NodeJS.ProcessEnv, spec: Partial<Parameters<typeof buildCharge>[0]> = {}): Promise<CreatePaymentIntentRequest> {
  return buildCharge({ key: "k-create", recipientRef: "acct_1", tax: taxProviderOrNone(e), ...spec });
}

describe("PR2 — the registry resolves only `none` and `fake`", () => {
  it("no adapter is registered", () => {
    assert.deepEqual(registeredPaymentAdapters(), []);
  });

  it("absent, empty and `none` resolve to the no-money provider, whose every operation is payments_disabled", async () => {
    for (const v of [undefined, "", " ", "none", "NONE"]) {
      const r = resolvePaymentProvider(env({ PAYMENT_PROVIDER: v }));
      assert.deepEqual([r.ok, r.kind, r.ok && r.provider === NONE_PAYMENT_PROVIDER], [true, "none", true], String(v));
    }
    for (const [op, r] of await callEveryOperation(getPaymentProvider({}))) assert.deepEqual(tag(r), ["unavailable", "payments_disabled"], op);
  });

  it("`fake` resolves in a local run only", async () => {
    const local = resolvePaymentProvider(env({ ...LOCAL_ENV, PAYMENT_PROVIDER: "fake" }));
    assert.deepEqual([local.ok, local.kind, local.ok && local.provider.id, local.ok && local.certified], [true, "fake", "fake", false]);
    for (const [why, refused] of REFUSED_ENVS) {
      const e = env({ ...refused, PAYMENT_PROVIDER: "fake", PAYMENTS_ENABLED_MARKETS: "US", TAX_PROVIDER: "fake" });
      const r = resolvePaymentProvider(e);
      assert.deepEqual([r.ok, !r.ok && r.reason, r.kind], [false, "fake_not_permitted", "fake"], why);
      for (const [op, answer] of await callEveryOperation(getPaymentProvider(e))) assert.deepEqual(tag(answer), ["unavailable", "fake_not_permitted"], `${why}: ${op}`);
    }
  });

  it("a fake handed out in a local run stops answering if the same env becomes a deployment — even with an EMPTY marker", async () => {
    for (const marker of ["1", ""]) {
      const e = env({ NODE_ENV: "development", PAYMENT_PROVIDER: "fake" });
      const provider = getPaymentProvider(e);
      assert.deepEqual(tag(await provider.validateRecipient("fake_acct_does_not_exist")), ["failed", "not_found"], "permitted: the fake itself answers");
      e["REPLIT_DEPLOYMENT"] = marker;
      assert.deepEqual(tag(await provider.validateRecipient("fake_acct_does_not_exist")), ["unavailable", "fake_not_permitted"], JSON.stringify(marker));
    }
  });

  it("every other name is refused — and a live or unrecognised key is the first thing said", () => {
    for (const name of ["stripe", "paypal", "adyen", "wise", "mock", "test"]) {
      const r = resolvePaymentProvider(env({ ...LOCAL_ENV, PAYMENT_PROVIDER: name, STRIPE_SECRET_KEY: TEST_KEY }));
      assert.deepEqual([r.ok, !r.ok && r.reason, r.kind], [false, "provider_not_registered", "unregistered"], name);
    }
    const live = resolvePaymentProvider(env({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: LIVE_KEY }));
    assert.deepEqual([live.ok, !live.ok && live.reason], [false, "live_key_not_allowed"]);
    const unknown = resolvePaymentProvider(env({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "pk_test_x" }));
    assert.deepEqual([unknown.ok, !unknown.ok && unknown.reason], [false, "unknown_key_prefix"]);
    const allowed = resolvePaymentProvider(env({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: LIVE_KEY, PAYMENTS_ALLOW_LIVE: "true" }));
    assert.deepEqual([allowed.ok, !allowed.ok && allowed.reason], [false, "provider_not_registered"], "allowing live does not conjure an adapter");
    assert.ok(!JSON.stringify(live).includes(LIVE_KEY), "a resolution must not carry the key");
  });

  it("a configured name is echoed only if it is a known one; anything else — a key pasted there — is `unrecognised value`", async () => {
    assert.deepEqual(["none", "fake", "stripe"].map((n) => paymentProviderLabel(n)), ["none", "fake", "stripe"]);
    for (const pasted of ["sk_live_SECRETVALUE123", "paypal", "whsec_SECRETVALUE", "stripe; drop", "x".repeat(300)]) {
      assert.equal(paymentProviderLabel(pasted.toLowerCase()), "unrecognised value", pasted.slice(0, 20));
      const e = env({ ...LOCAL_ENV, PAYMENT_PROVIDER: pasted });
      const r = resolvePaymentProvider(e);
      assert.deepEqual([r.ok, r.name], [false, "unrecognised value"], pasted.slice(0, 20));
      const answers = await callEveryOperation(getPaymentProvider(e));
      const everything = JSON.stringify([r, answers, paymentsReadiness(e), paymentsReadinessSummary(e), resolvePayoutProviderBehindPayments(e)]).toLowerCase();
      assert.ok(!everything.includes("secretvalue") && !everything.includes(pasted.toLowerCase()), `${pasted.slice(0, 20)}: the configured text was echoed`);
    }
  });
});

describe("PR3 — a keyed adapter is refused before any request", () => {
  it("a test key reaches the adapter, behind the guard and the policy", async () => {
    const s = standIn();
    const e = env({ ...READY });
    const r = resolvePaymentProvider(e, [s.registration]);
    assert.deepEqual([r.ok, r.kind, r.name, r.keyDecision?.mode], [true, "adapter", "stripe", "test"]);
    const answers = await callEveryOperation(getPaymentProvider(e, [s.registration]), { createPaymentIntent: await attestedCharge(e) });
    for (const [op, answer] of answers) assert.equal(answer.status, "ok", `${op}: ${JSON.stringify(answer).slice(0, 200)}`);
    for (const op of PAYMENT_PROVIDER_OPERATIONS) assert.ok(s.adapter.reached.includes(op), `${op} did not reach the adapter`);
  });

  it("a live, unrecognised or absent key makes ZERO adapter calls — and the adapter is not even constructed", async () => {
    const refusals: Array<[string, string | undefined, string]> = [
      ["live", LIVE_KEY, "live_key_not_allowed"],
      ["restricted live", "rk_live_dummy", "live_key_not_allowed"],
      ["publishable", "pk_test_dummy", "unknown_key_prefix"],
      ["upper-case test", "SK_TEST_dummy", "unknown_key_prefix"],
      ["absent", undefined, "key_absent"],
      ["whitespace", "   ", "key_absent"],
    ];
    for (const [name, key, reason] of refusals) {
      const s = standIn();
      const e = env({ ...READY, STRIPE_SECRET_KEY: key });
      const r = resolvePaymentProvider(e, [s.registration]);
      assert.deepEqual([r.ok, !r.ok && r.reason], [false, reason], name);
      for (const [op, answer] of await callEveryOperation(getPaymentProvider(e, [s.registration]))) assert.deepEqual(tag(answer), ["unavailable", reason], `${name}: ${op}`);
      assert.deepEqual([s.adapter.reached, s.creates()], [[], 0], `${name}: the adapter was reached`);
    }
  });

  it("PAYMENTS_ALLOW_LIVE exactly \"true\" is the only thing that lets a live key through, and it never rescues an unknown one", async () => {
    for (const [allow, ok] of [["true", true], ["TRUE", false], ["1", false], ["yes", false], ["", false]] as const) {
      const s = standIn();
      const e = env({ ...READY, STRIPE_SECRET_KEY: LIVE_KEY, PAYMENTS_ALLOW_LIVE: allow });
      assert.equal(resolvePaymentProvider(e, [s.registration]).ok, ok, allow);
      await getPaymentProvider(e, [s.registration]).validateRecipient("acct_1");
      assert.deepEqual(s.adapter.reached, ok ? ["validateRecipient"] : [], allow);
    }
    const s = standIn();
    const e = env({ ...READY, STRIPE_SECRET_KEY: "pk_live_x", PAYMENTS_ALLOW_LIVE: "true" });
    assert.deepEqual(tag(await getPaymentProvider(e, [s.registration]).validateRecipient("acct_1")), ["unavailable", "unknown_key_prefix"]);
    assert.deepEqual(s.adapter.reached, []);
  });

  it("the key is re-read before EVERY operation: a key rotated to live under a held provider is refused on the next call", async () => {
    const s = standIn();
    const e = env({ ...READY });
    const provider = getPaymentProvider(e, [s.registration]);
    assert.equal((await provider.validateRecipient("acct_1")).status, "ok");
    e["STRIPE_SECRET_KEY"] = LIVE_KEY;
    for (const [op, answer] of await callEveryOperation(provider, { createPaymentIntent: await attestedCharge(e) })) assert.deepEqual(tag(answer), ["unavailable", "live_key_not_allowed"], op);
    delete e["STRIPE_SECRET_KEY"];
    assert.deepEqual(tag(await provider.validateRecipient("acct_1")), ["unavailable", "key_absent"]);
    assert.deepEqual(s.adapter.reached, ["validateRecipient"], "only the call made under the test key reached the adapter");
  });

  it("whatever the adapter throws or returns leaves the registry as a tagged result", async () => {
    const s = standIn();
    const provider = getPaymentProvider(env({ ...READY }), [s.registration]);
    s.adapter.throwNext("a thrown string");
    assert.deepEqual(tag(await provider.validateRecipient("acct_1")), ["failed", "provider_error"]);
    s.adapter.throwNext(new PaymentsLiveModeRefusedError({ provider: "stripe", keyPresent: true, mode: "live", liveAllowed: false, allowed: false, refusal: "live_key_not_allowed" }));
    assert.deepEqual(tag(await provider.validateRecipient("acct_1")), ["unavailable", "live_key_not_allowed"]);
    s.adapter.answerNext(undefined);
    assert.deepEqual(tag(await provider.validateRecipient("acct_1")), ["failed", "provider_error"], "an adapter that returns undefined");
    s.adapter.answerNext({ status: "ok", provider: "stripe", value: { not: "a recipient" } });
    assert.deepEqual(tag(await provider.getPayoutStatus({ payoutRef: "po_1", kind: "payout", recipientRef: "acct_1" })), ["failed", "provider_error"], "an adapter that returns the wrong object");
  });

  it("an adapter whose create() throws, or returns nothing, resolves to unavailable / adapter_failed — and nothing throws", async () => {
    const broken: Array<[string, PaymentProviderAdapterRegistration["create"]]> = [
      ["throws an Error", () => { throw new Error("no sdk sk_live_SECRETVALUE"); }],
      ["throws a string", () => { throw "boom"; }],
      ["returns undefined", (() => undefined) as any],
      ["returns null", (() => null) as any],
      ["returns a number", (() => 7) as any],
    ];
    for (const [name, create] of broken) {
      const registration: PaymentProviderAdapterRegistration = { name: "stripe", keyProvider: "stripe", certified: true, create };
      const e = env({ ...READY });
      let r: ReturnType<typeof resolvePaymentProvider> | undefined;
      assert.doesNotThrow(() => { r = resolvePaymentProvider(e, [registration]); }, name);
      assert.deepEqual([r?.ok, r && !r.ok && r.reason, r?.kind], [false, "adapter_failed", "adapter"], name);
      for (const [op, answer] of await callEveryOperation(getPaymentProvider(e, [registration]))) assert.deepEqual(tag(answer), ["unavailable", "adapter_failed"], `${name}: ${op}`);
      const readiness = paymentsReadiness(e, [registration]);
      assert.deepEqual([readiness.operational, /adapter_failed/.test(readiness.reason)], [false, true], name);
      assert.ok(!JSON.stringify([r, readiness]).includes("SECRETVALUE"), name);
    }
  });

  it("an adapter whose capabilities() or marketSupport() throws has no capability and supports no market", async () => {
    const s = standIn();
    const throwing = { ...s.adapter.provider, capabilities: () => { throw new Error("boom"); }, marketSupport: () => { throw new Error("boom"); } } as unknown as PaymentProvider;
    const registration: PaymentProviderAdapterRegistration = { name: "stripe", keyProvider: "stripe", certified: true, create: () => throwing };
    const e = env({ ...READY });
    const provider = getPaymentProvider(e, [registration]);
    assert.deepEqual(provider.capabilities().chargeModels, []);
    assert.deepEqual([provider.marketSupport({ recipientCountry: "US" }).supported, provider.marketSupport({ recipientCountry: "US" }).reason], [false, "provider_error"]);
    assert.deepEqual(tag(await provider.createPaymentIntent(await attestedCharge(e))), ["unavailable", "unsupported_market"], "a provider that cannot say it supports a market does not");
    const readiness = paymentsReadiness(e, [registration]);
    assert.deepEqual([readiness.operational, readiness.marketsNotSupportedByProvider], [false, ["US"]]);
  });

  it("an UNCERTIFIED adapter answers provider_not_certified to everything; only an explicit certification run, on a test key, may use it", async () => {
    const s = standIn(false);
    const e = env({ ...READY });
    const r = resolvePaymentProvider(e, [s.registration]);
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, "provider_not_certified"]);
    for (const [op, answer] of await callEveryOperation(getPaymentProvider(e, [s.registration]))) assert.deepEqual(tag(answer), ["unavailable", "provider_not_certified"], op);
    assert.deepEqual([s.adapter.reached, s.creates()], [[], 0], "an uncertified adapter was reached by an ordinary caller");

    const run = getPaymentProvider(e, [s.registration], { certificationRun: true });
    assert.equal((await run.validateRecipient("acct_1")).status, "ok");
    assert.deepEqual(s.adapter.reached, ["validateRecipient"]);
    // A certification run never proceeds on a live key — not even with PAYMENTS_ALLOW_LIVE=true.
    const liveEnv = env({ ...READY, STRIPE_SECRET_KEY: LIVE_KEY, PAYMENTS_ALLOW_LIVE: "true" });
    const liveRun = resolvePaymentProvider(liveEnv, [s.registration], { certificationRun: true });
    assert.deepEqual([liveRun.ok, !liveRun.ok && liveRun.reason], [false, "provider_not_certified"]);
    e["STRIPE_SECRET_KEY"] = LIVE_KEY;
    e["PAYMENTS_ALLOW_LIVE"] = "true";
    assert.deepEqual(tag(await run.validateRecipient("acct_1")), ["unavailable", "provider_not_certified"], "the key was rotated to live mid-run");
    assert.deepEqual(s.adapter.reached, ["validateRecipient"]);
  });
});

describe("PR4 — the platform's enabled markets", () => {
  it("is empty by default, and parses a comma-separated list of ISO country codes", () => {
    assert.equal(PAYMENTS_ENABLED_MARKETS_ENV, "PAYMENTS_ENABLED_MARKETS");
    assert.deepEqual(enabledPaymentMarkets({}), { markets: [], invalidCount: 0 });
    assert.deepEqual(enabledPaymentMarkets(env({ PAYMENTS_ENABLED_MARKETS: " us, GB ,us,,jp " })), { markets: ["GB", "JP", "US"], invalidCount: 0 });
    const mixed = enabledPaymentMarkets(env({ PAYMENTS_ENABLED_MARKETS: "US,USA,*,all,G B,sk_live_SECRETVALUE" }));
    assert.deepEqual(mixed, { markets: ["US"], invalidCount: 5 });
    assert.ok(!JSON.stringify(mixed).includes("SECRETVALUE"), "invalid tokens are counted, never returned");
    assert.equal(paymentMarketEnabled("US", {}), false, "unset enables nothing");
    assert.equal(paymentMarketEnabled("US", env({ PAYMENTS_ENABLED_MARKETS: "US" })), true);
    assert.equal(paymentMarketEnabled("us", env({ PAYMENTS_ENABLED_MARKETS: "US" })), false, "the caller passes the upper-case code");
    assert.equal(paymentMarketEnabled("GB", env({ PAYMENTS_ENABLED_MARKETS: "US" })), false);
  });
});

describe("PR5 — the readiness report", () => {
  it("with nothing configured payments are not operational, and the report says which part is missing", () => {
    const r = paymentsReadiness({});
    assert.deepEqual(
      [r.operational, r.provider, r.providerKind, r.keyMode, r.keyPresent, r.keyRefused, r.liveAllowed, r.taxProvider, r.taxConfigured, r.enabledMarkets],
      [false, "none", "none", "none", false, false, false, "none", false, []],
    );
    assert.match(r.reason, /PAYMENT_PROVIDER is unset or `none`/);
    assert.equal(r.blockers.length, 2, JSON.stringify(r.blockers));
    assert.match(r.blockers[1]!, /PAYMENTS_ENABLED_MARKETS is empty/);
  });

  it("the fake with the fake tax provider and an enabled market is operational in a local run — and nowhere else", () => {
    const local = env({ ...LOCAL_ENV, PAYMENT_PROVIDER: "fake", TAX_PROVIDER: "fake", PAYMENTS_ENABLED_MARKETS: "US,GB,JP" });
    const r = paymentsReadiness(local);
    assert.deepEqual(r.blockers, []);
    assert.deepEqual(
      [r.operational, r.provider, r.providerKind, r.providerCertified, r.keyMode, r.taxProvider, r.taxConfigured, r.enabledMarkets, r.directChargeMarkets],
      [true, "fake", "fake", false, "none", "fake", true, ["GB", "JP", "US"], ["GB", "US"]],
    );
    for (const [why, refused] of REFUSED_ENVS) {
      const hosted = paymentsReadiness(env({ ...refused, PAYMENT_PROVIDER: "fake", TAX_PROVIDER: "fake", PAYMENTS_ENABLED_MARKETS: "US" }));
      assert.deepEqual([hosted.operational, hosted.taxConfigured], [false, false], why);
      assert.match(hosted.reason, /fake_not_permitted/, why);
    }
  });

  it("tax not configured, an unsupported market and an invalid market each block, and each is named", () => {
    const noTax = paymentsReadiness(env({ ...LOCAL_ENV, PAYMENT_PROVIDER: "fake", PAYMENTS_ENABLED_MARKETS: "US" }));
    assert.deepEqual([noTax.operational, noTax.taxProvider, noTax.taxConfigured, noTax.marketsWithoutTax], [false, "none", false, ["US"]]);
    assert.match(noTax.reason, /tax is not configured for: US/);

    const france = paymentsReadiness(env({ ...LOCAL_ENV, PAYMENT_PROVIDER: "fake", TAX_PROVIDER: "fake", PAYMENTS_ENABLED_MARKETS: "US,FR" }));
    assert.deepEqual([france.operational, france.marketsNotSupportedByProvider, france.marketsWithoutTax, france.taxConfigured], [false, ["FR"], ["FR"], false]);
    assert.match(france.reason, /does not support recipients in: FR/);

    const invalid = paymentsReadiness(env({ ...LOCAL_ENV, PAYMENT_PROVIDER: "fake", TAX_PROVIDER: "fake", PAYMENTS_ENABLED_MARKETS: "US,EVERYWHERE" }));
    assert.deepEqual([invalid.operational, invalid.invalidMarketCount, invalid.enabledMarkets], [false, 1, ["US"]]);

    const unknownTax = paymentsReadiness(env({ ...LOCAL_ENV, PAYMENT_PROVIDER: "fake", TAX_PROVIDER: "stripe_tax", PAYMENTS_ENABLED_MARKETS: "US" }));
    assert.deepEqual([unknownTax.operational, unknownTax.taxConfigured, unknownTax.taxProvider], [false, false, "unrecognised value"]);
    assert.match(unknownTax.reason, /tax_provider_not_registered/);
  });

  it("a refused key is reported first, as mode and booleans — never the key", () => {
    const live = paymentsReadiness(env({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_SECRETVALUE123", PAYMENTS_ENABLED_MARKETS: "US" }));
    assert.deepEqual([live.operational, live.provider, live.providerKind, live.keyMode, live.keyPresent, live.keyRefused, live.liveAllowed], [false, "stripe", "unregistered", "live", true, true, false]);
    assert.match(live.reason, /^not operational: live key not allowed/);
    assert.ok(!JSON.stringify(live).includes("SECRETVALUE"));

    const unknown = paymentsReadiness(env({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "pk_test_SECRETVALUE456" }));
    assert.deepEqual([unknown.keyMode, unknown.keyRefused], ["unknown", true]);
    assert.match(unknown.reason, /^not operational: unrecognised key/);
    assert.ok(!JSON.stringify(unknown).includes("SECRETVALUE"));

    const test = paymentsReadiness(env({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: TEST_KEY }));
    assert.deepEqual([test.operational, test.keyMode, test.keyRefused], [false, "test", false]);
    assert.match(test.reason, /provider_not_registered/, "a test key does not make an unwritten adapter operational");

    for (const [allow, expected] of [["true", true], ["TRUE", false], ["1", false], [undefined, false]] as const) {
      assert.equal(paymentsReadiness(env({ PAYMENTS_ALLOW_LIVE: allow })).liveAllowed, expected, String(allow));
    }
  });

  it("the report and the startup line echo NO configuration text: a secret pasted into any of the three variables is not in them", () => {
    const pasted = env({
      ...LOCAL_ENV,
      PAYMENT_PROVIDER: "sk_live_SECRETVALUE_provider",
      TAX_PROVIDER: "sk_live_SECRETVALUE_tax",
      PAYMENTS_ENABLED_MARKETS: "US,sk_live_SECRETVALUE_market,whsec_SECRETVALUE",
      STRIPE_SECRET_KEY: "sk_live_SECRETVALUE_key",
    });
    const report = paymentsReadiness(pasted);
    const line = paymentsReadinessSummary(pasted);
    assert.deepEqual([report.provider, report.taxProvider, report.invalidMarketCount, report.enabledMarkets, report.operational], ["unrecognised value", "unrecognised value", 2, ["US"], false]);
    assert.deepEqual([line.paymentProvider, line.taxProvider, line.enabledMarkets], ["unrecognised value", "unrecognised value", ["US"]]);
    for (const text of [JSON.stringify(report), JSON.stringify(line)]) {
      assert.ok(!/secretvalue/i.test(text), "configuration text reached the readiness report");
      assert.ok(!/sk_live_|whsec_/.test(text));
    }
  });

  it("an adapter that is written but not certified is not operational; certified, with a test key, a market and tax, it is", () => {
    const uncertified = paymentsReadiness(env({ ...READY }), [standIn(false).registration]);
    assert.deepEqual([uncertified.operational, uncertified.providerKind, uncertified.providerCertified, uncertified.keyMode], [false, "adapter", false, "test"]);
    assert.match(uncertified.reason, /provider_not_certified.*not certified/);
    const certified = paymentsReadiness(env({ ...READY }), [standIn(true).registration]);
    assert.deepEqual(certified.blockers, []);
    assert.deepEqual([certified.operational, certified.providerCertified, certified.keyMode, certified.directChargeMarkets], [true, true, "test", ["US"]]);
    assert.match(certified.reason, /operational in test mode for US/);
    const liveRefused = paymentsReadiness(env({ ...READY, STRIPE_SECRET_KEY: LIVE_KEY }), [standIn(true).registration]);
    assert.deepEqual([liveRefused.operational, liveRefused.keyRefused, liveRefused.blockers.length], [false, true, 1], "a certified adapter with a live key is still refused, once");
    const elsewhere = paymentsReadiness(env({ ...READY, PAYMENTS_ENABLED_MARKETS: "US,PH" }), [standIn(true).registration]);
    assert.deepEqual([elsewhere.operational, elsewhere.marketsNotSupportedByProvider], [false, ["PH"]], "no provider is worldwide");
  });

  it("the startup summary is names, booleans and enums", () => {
    const s = paymentsReadinessSummary(env({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_SECRETVALUE789", PAYMENTS_ALLOW_LIVE: "TRUE" }));
    assert.deepEqual(Object.keys(s).sort(), ["enabledMarkets", "keyMode", "keyRefused", "liveAllowed", "operational", "paymentProvider", "reason", "taxConfigured", "taxProvider"]);
    assert.deepEqual([s.paymentProvider, s.operational, s.keyMode, s.keyRefused, s.liveAllowed, s.taxProvider, s.taxConfigured], ["stripe", false, "live", true, false, "none", false]);
    assert.ok(!JSON.stringify(s).includes("SECRETVALUE"));
  });
});

describe("PR6 — the PayoutProvider seam sits behind the contract", () => {
  const CREATOR = "33333333-3333-4333-8333-333333333333";

  it("with no payment provider the seam returns the SAME frozen none object the old resolver returns", async () => {
    const old = resolvePayoutProvider(undefined);
    for (const e of [{}, env({ PAYMENT_PROVIDER: "none" }), env({ PAYMENT_PROVIDER: " NONE " })]) {
      const r = resolvePayoutProviderBehindPayments(e);
      assert.equal(r.ok && r.provider, NONE_PAYOUT_PROVIDER);
      assert.equal(r.ok && r.provider, old.ok && old.provider);
    }
    const p = NONE_PAYOUT_PROVIDER;
    const results = await Promise.all([
      p.createRecipient({ creatorId: CREATOR, settlementCurrency: "USD" }), p.validateRecipient("r"),
      p.requestPayout({ creatorId: CREATOR, amountMinor: 700, currency: "USD", idempotencyKey: "k" }), p.getPayoutStatus("x"),
      p.handleWebhook("{}", {}), p.reverseOrHold("x", "hold"),
    ]);
    for (const r of results) assert.deepEqual([r.ok, !r.ok && r.reason, r.provider], [false, "payouts_disabled", "none"]);
  });

  it("the old resolver is unchanged: it still refuses every name but none, `fake` and `stripe` included", () => {
    for (const c of ["stripe", "fake", "paypal"]) {
      const r = resolvePayoutProvider(c);
      assert.deepEqual([r.ok, !r.ok && r.reason], [false, "no_provider_chosen"], c);
    }
  });

  it("an unusable payment provider, or a real one with no context, is no_provider_chosen", () => {
    const hosted = resolvePayoutProviderBehindPayments(env({ NODE_ENV: "production", PAYMENT_PROVIDER: "fake" }));
    assert.deepEqual([hosted.ok, !hosted.ok && hosted.reason], [false, "no_provider_chosen"]);
    const unregistered = resolvePayoutProviderBehindPayments(env({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: TEST_KEY }));
    assert.deepEqual([unregistered.ok, !unregistered.ok && unregistered.reason], [false, "no_provider_chosen"]);
    const noContext = resolvePayoutProviderBehindPayments(env({ ...LOCAL_ENV, PAYMENT_PROVIDER: "fake" }));
    assert.deepEqual([noContext.ok, !noContext.ok && noContext.reason], [false, "no_provider_chosen"]);
  });

  it("behind a provider, the six operations forward to the contract and report its state", async () => {
    const fake = createFakePaymentProvider({ env: LOCAL_ENV });
    const refs = new Map<string, string>();
    const handles = new Map<string, { payoutRef: string; kind: "payout"; recipientRef: string }>();
    const context: PayoutSeamContext = {
      payoutKind: "payout",
      webhookEndpoint: "connect",
      recipientRefFor: async (creatorId) => refs.get(creatorId) ?? null,
      recipientDetailsFor: async (creatorId) => (creatorId === CREATOR ? { country: "US", entityType: "individual", returnUrl: "a://b", refreshUrl: "a://c" } : null),
      payoutHandleFor: async (payoutRef) => handles.get(payoutRef) ?? null,
    };
    const seam = payoutProviderBehind(fake, context);
    assert.equal(seam.id, "fake");

    const created = await seam.createRecipient({ creatorId: CREATOR, settlementCurrency: "USD" });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");
    refs.set(CREATOR, created.value.recipientRef);
    assert.deepEqual(await seam.validateRecipient(created.value.recipientRef), { ok: true, provider: "fake", value: { valid: false } }, "onboarding not finished");
    fake.control.setRecipientOnboarding(created.value.recipientRef, "verified");
    assert.deepEqual(await seam.validateRecipient(created.value.recipientRef), { ok: true, provider: "fake", value: { valid: true } });

    const broke = await seam.requestPayout({ creatorId: CREATOR, amountMinor: 700, currency: "USD", idempotencyKey: "po-0" });
    assert.deepEqual([broke.ok, !broke.ok && broke.reason], [false, "not_supported"], "declined: nothing on the balance");
    assert.match(broke.ok ? "" : broke.detail, /^declined:insufficient_balance/);

    fake.control.fundPlatformBalance({ amountMinor: 5000, currency: "USD" });
    await fake.requestPayout({ idempotencyKey: "tr", kind: "transfer", recipientRef: created.value.recipientRef, amount: { amountMinor: 5000, currency: "USD" }, reference: { kind: "x", id: "1" } });
    const paid = await seam.requestPayout({ creatorId: CREATOR, amountMinor: 700, currency: "USD", idempotencyKey: "po-1" });
    assert.equal(paid.ok, true);
    if (!paid.ok) throw new Error("unreachable");
    handles.set(paid.value.payoutRef, { payoutRef: paid.value.payoutRef, kind: "payout", recipientRef: created.value.recipientRef });
    assert.deepEqual(await seam.getPayoutStatus(paid.value.payoutRef), { ok: true, provider: "fake", value: { status: "pending" } });
    assert.deepEqual(await seam.reverseOrHold(paid.value.payoutRef, "hold"), { ok: true, provider: "fake", value: { status: "on_hold" } });
    assert.deepEqual(fake.control.balances().recipients[created.value.recipientRef], { USD: 4300 }, "the state, not the return value: the payout debited the balance");

    const [delivery] = fake.control.webhooks.deliver({ order: [0] });
    assert.equal(delivery!.endpoint, "connect", "a recipient's event arrives on the connect endpoint");
    assert.deepEqual(await seam.handleWebhook(delivery!.rawBody, delivery!.headers as Record<string, string>), { ok: true, provider: "fake", value: { accepted: true } });
    const forged = await seam.handleWebhook(delivery!.rawBody, { "fake-signature": "t=1,v1=00" });
    assert.deepEqual([forged.ok, !forged.ok && forged.reason], [false, "invalid_request"]);

    const stranger = await seam.requestPayout({ creatorId: "someone-else", amountMinor: 1, currency: "USD", idempotencyKey: "po-2" });
    assert.deepEqual([stranger.ok, !stranger.ok && stranger.reason], [false, "invalid_request"]);
    const unknown = await seam.getPayoutStatus("fake_po_999999");
    assert.deepEqual([unknown.ok, !unknown.ok && unknown.reason], [false, "invalid_request"]);
    const noDetails = await seam.createRecipient({ creatorId: "someone-else", settlementCurrency: "USD" });
    assert.deepEqual([noDetails.ok, !noDetails.ok && noDetails.reason], [false, "invalid_request"]);
  });

  it("the translation to the old three reasons keeps the contract's reason in the detail", () => {
    const cases: Array<[Exclude<PaymentResult<unknown>, { status: "ok" }>, string]> = [
      [{ status: "unavailable", provider: "p", reason: "payments_disabled", detail: "d", retriable: false }, "payouts_disabled"],
      [{ status: "unavailable", provider: "p", reason: "live_key_not_allowed", detail: "d", retriable: false }, "payouts_disabled"],
      [{ status: "unavailable", provider: "p", reason: "fake_not_permitted", detail: "d", retriable: false }, "payouts_disabled"],
      [{ status: "unavailable", provider: "p", reason: "market_not_enabled", detail: "d", retriable: false }, "payouts_disabled"],
      [{ status: "unavailable", provider: "p", reason: "unsupported_market", detail: "d", retriable: false }, "not_supported"],
      [{ status: "unavailable", provider: "p", reason: "capability_not_supported", detail: "d", retriable: false }, "not_supported"],
      [{ status: "failed", provider: "p", reason: "not_found", detail: "d", retriable: false }, "invalid_request"],
      [{ status: "declined", provider: "p", reason: "recipient_not_eligible", detail: "d", value: null }, "not_supported"],
    ];
    for (const [result, reason] of cases) {
      const r = toPayoutRefusal(result);
      assert.deepEqual([r.ok, r.reason, r.provider], [false, reason, "p"], `${result.status}:${result.reason}`);
      assert.ok(r.detail.startsWith(`${result.status}:${result.reason}`));
    }
  });
});

describe("PR7 — market and tax policy is enforced by the registry, on every operation that needs it", () => {
  /** A charge whose tax lines are hand-built: the right shape, consistent with the charge, issued by nobody. */
  const forgedCharge = (sellerMarket: string, chargeModel: "direct" | "platform" = "direct"): CreatePaymentIntentRequest => ({
    idempotencyKey: "k-forged",
    reference: { kind: "rent_buddy_booking", id: "b1" },
    payerProfileId: "payer-1",
    payerCountry: "US",
    amount: { amountMinor: 10_000, currency: "USD" },
    components: { serviceMinor: 10_000, payerFeeMinor: 0, tipMinor: 0, taxMinor: 0 },
    chargeModel,
    recipientRef: chargeModel === "platform" ? null : "acct_1",
    recipientCountry: chargeModel === "platform" ? null : sellerMarket,
    platformFee: { commissionMinor: chargeModel === "platform" ? 0 : 1000, payerFeeMinor: 0, taxMinor: 0 },
    capture: "automatic",
    tax: [{ provider: "fake", configured: true, sellerMarket, buyerMarket: "US", productKind: "service", taxableMinor: 10_000, taxMinor: 0, currency: "USD", remittedBy: "none", rateBps: 0, jurisdiction: null, calculationRef: null, computedAt: "2026-01-01T00:00:00.000Z" }],
  });

  it("a hand-built tax computation passes the SHAPE check and is refused by the registry — with TAX_PROVIDER=none and with a real one", async () => {
    assert.equal(validateCreatePaymentIntent("stripe", forgedCharge("US")), null, "the shape check alone cannot tell: this is why provenance is checked");
    for (const taxProvider of [undefined, "none", "fake"]) {
      const s = standIn();
      const e = env({ ...READY, TAX_PROVIDER: taxProvider });
      const r = await getPaymentProvider(e, [s.registration]).createPaymentIntent(forgedCharge("US"));
      assert.deepEqual(tag(r), ["unavailable", "tax_not_configured"], `TAX_PROVIDER=${String(taxProvider)}`);
      assert.ok(!s.adapter.reached.includes("createPaymentIntent"), `TAX_PROVIDER=${String(taxProvider)}: the forged charge reached the adapter`);
    }
    // The verifier's input: a platform charge claiming an unconfigured seller market "XX" with zero tax.
    const s = standIn();
    const xx = await getPaymentProvider(env({ ...READY, TAX_PROVIDER: "none" }), [s.registration]).createPaymentIntent(forgedCharge("XX", "platform"));
    assert.deepEqual(tag(xx), ["unavailable", "market_not_enabled"]);
    const enabledXx = await getPaymentProvider(env({ ...READY, TAX_PROVIDER: "none", PAYMENTS_ENABLED_MARKETS: "US,XX" }), [s.registration]).createPaymentIntent(forgedCharge("XX", "platform"));
    assert.deepEqual(tag(enabledXx), ["unavailable", "unsupported_market"], "enabled by the platform, not supported by the provider");
    assert.deepEqual(s.adapter.reached.filter((op) => op === "createPaymentIntent"), []);
  });

  it("only a computation ISSUED by the registered tax provider is accepted: not a copy, not another provider's", async () => {
    const s = standIn();
    const e = env({ ...READY });
    const provider = getPaymentProvider(e, [s.registration]);
    const good = await attestedCharge(e);
    assert.equal((await provider.createPaymentIntent(good)).status, "ok", "the control");
    const copied = { ...good, idempotencyKey: "k2", tax: good.tax.map((t) => ({ ...t })) };
    assert.deepEqual(tag(await provider.createPaymentIntent(copied)), ["unavailable", "tax_not_configured"], "a field-for-field copy");
    const other = await buildCharge({ key: "k3", recipientRef: "acct_1", tax: createFakeTaxProvider({ env: LOCAL_ENV }) });
    assert.deepEqual(tag(await provider.createPaymentIntent(other)), ["unavailable", "tax_not_configured"], "issued by a tax provider that is not the registered one");
    const noTaxProvider = getPaymentProvider(env({ ...READY, TAX_PROVIDER: "none" }), [s.registration]);
    assert.deepEqual(tag(await noTaxProvider.createPaymentIntent(good)), ["unavailable", "tax_not_configured"], "genuinely issued, but tax is not configured in THIS env");
    assert.equal(s.adapter.reached.filter((op) => op === "createPaymentIntent").length, 1);
  });

  it("configured-for-the-market and issued-by-the-provider are separate checks: failing either one refuses", async () => {
    const charge = forgedCharge("US");
    const policyWith = (configured: boolean, attests: boolean): PaymentPolicy => ({
      enabledMarkets: () => ["US"],
      taxProvider: () => ({
        id: "stub",
        marketStatus: (market) => ({ provider: "stub", market, configured, reason: "stub" }),
        computeTax: async () => ({ status: "unavailable", provider: "stub", reason: "tax_not_configured", detail: "stub", retriable: false }),
        attests: () => attests,
      }),
    });
    for (const [configured, attests, expected] of [[true, true, "ok"], [false, true, "unavailable"], [true, false, "unavailable"], [false, false, "unavailable"]] as const) {
      const adapter = conformingAdapter();
      const r = await enforcePaymentPolicy(adapter.provider, policyWith(configured, attests)).createPaymentIntent(charge);
      assert.equal(r.status, expected, `configured=${configured} attests=${attests}`);
      if (r.status !== "ok") assert.equal(r.reason, "tax_not_configured");
      assert.deepEqual(adapter.reached, expected === "ok" ? ["createPaymentIntent"] : [], `configured=${configured} attests=${attests}`);
    }
    // And a computation attested for ANOTHER market does not cover this one.
    const two = { ...charge, tax: [charge.tax[0]!, { ...charge.tax[0]!, sellerMarket: "GB", taxableMinor: 0 }] };
    const mixed = await enforcePaymentPolicy(conformingAdapter().provider, policyWith(true, true)).createPaymentIntent({ ...two, recipientCountry: null, recipientRef: null, chargeModel: "platform", platformFee: { commissionMinor: 0, payerFeeMinor: 0, taxMinor: 0 } });
    assert.deepEqual(tag(mixed), ["failed", "invalid_request"], "one charge, one seller market");
  });

  it("a market the platform has not enabled blocks money in and money out to a recipient — and never a refund, a cancel or a read", async () => {
    for (const markets of [undefined, "", "GB", "GB,JP"]) {
      const s = standIn();
      const e = env({ ...READY, PAYMENTS_ENABLED_MARKETS: markets });
      const answers = new Map(await callEveryOperation(getPaymentProvider(e, [s.registration]), { createPaymentIntent: await attestedCharge(e) }));
      const blocked = ["createPaymentIntent", "confirmPaymentIntent", "capturePaymentIntent", "createRecipient", "createRecipientOnboardingLink", "requestPayout"] as const;
      const open = ["cancelPaymentIntent", "refundPayment", "reverseOrHoldPayout", "getPaymentIntent", "validateRecipient", "getPayoutStatus", "verifyAndParseWebhook"] as const;
      assert.equal(blocked.length + open.length, PAYMENT_PROVIDER_OPERATIONS.length);
      for (const op of blocked) {
        assert.deepEqual(tag(answers.get(op)!), ["unavailable", "market_not_enabled"], `${String(markets)}: ${op}`);
        assert.ok(!s.adapter.reached.includes(op), `${String(markets)}: ${op} reached the adapter`);
      }
      for (const op of open) assert.equal(answers.get(op)!.status, "ok", `${String(markets)}: ${op} — disabling a market must not trap money or blind the platform`);
    }
  });

  it("the recipient's market is the PROVIDER's record of it, not the caller's word", async () => {
    const s = standIn();
    const e = env({ ...READY });
    const provider = getPaymentProvider(e, [s.registration]);
    const intent = { intentRef: "pi_1", chargeModel: "direct" as const, recipientRef: "acct_1" };
    assert.equal((await provider.confirmPaymentIntent({ idempotencyKey: "k", intent, paymentMethodRef: null, returnUrl: null })).status, "ok");
    assert.deepEqual(s.adapter.reached, ["validateRecipient", "confirmPaymentIntent"], "the registry asked the provider where the recipient is established");
    // The provider now says the recipient is in the Philippines, which is not enabled.
    s.adapter.reached.length = 0;
    s.adapter.answerNext({ status: "ok", provider: "stripe", value: sampleRecipient({ country: "PH" }) });
    assert.deepEqual(tag(await provider.requestPayout({ idempotencyKey: "k", kind: "payout", recipientRef: "acct_1", amount: { amountMinor: 100, currency: "USD" }, reference: { kind: "x", id: "1" } })), ["unavailable", "market_not_enabled"]);
    assert.deepEqual(s.adapter.reached, ["validateRecipient"]);
    // If the provider cannot say, nothing proceeds.
    s.adapter.reached.length = 0;
    s.adapter.answerNext({ status: "failed", provider: "stripe", reason: "not_found", detail: "d", retriable: false });
    assert.deepEqual(tag(await provider.capturePaymentIntent({ idempotencyKey: "k", intent, amountMinor: "full", partial: null })), ["failed", "not_found"]);
    assert.deepEqual(s.adapter.reached, ["validateRecipient"]);
    // A platform charge has no recipient to ask about.
    s.adapter.reached.length = 0;
    await provider.confirmPaymentIntent({ idempotencyKey: "k", intent: { intentRef: "pi_1", chargeModel: "platform", recipientRef: null }, paymentMethodRef: null, returnUrl: null });
    assert.deepEqual(s.adapter.reached, ["confirmPaymentIntent"]);
  });

  it("an enabled market the provider does not support, a currency it cannot charge there and a charge model it lacks are each refused", async () => {
    const s = standIn();
    const e = env({ ...READY, PAYMENTS_ENABLED_MARKETS: "US,PH" });
    const provider = getPaymentProvider(e, [s.registration]);
    const recipient = { idempotencyKey: "k", profileId: "p", entityType: "individual" as const, settlementCurrency: "USD", returnUrl: "a://b", refreshUrl: "a://c" };
    assert.deepEqual(tag(await provider.createRecipient({ ...recipient, country: "PH" })), ["unavailable", "unsupported_market"]);
    assert.equal((await provider.createRecipient({ ...recipient, country: "US" })).status, "ok");
    assert.deepEqual(tag(await provider.createRecipient({ ...recipient, country: "GB" })), ["unavailable", "market_not_enabled"]);
    const destination = await attestedCharge(e, { key: "k-dest", chargeModel: "destination" });
    assert.deepEqual(tag(await provider.createPaymentIntent(destination)), ["unavailable", "charge_model_not_supported"], "the stand-in offers direct charges only");
    assert.deepEqual(s.adapter.reached.filter((op) => op === "createPaymentIntent"), []);
  });

  it("through the registry the FAKE is held to the same policy", async () => {
    const off = env({ ...LOCAL_ENV, PAYMENT_PROVIDER: "fake" });
    const request = { idempotencyKey: "pr7-r1", profileId: "pr7-profile", country: "US", entityType: "individual" as const, settlementCurrency: "USD", returnUrl: "a://b", refreshUrl: "a://c" };
    assert.deepEqual(tag(await getPaymentProvider(off).createRecipient(request)), ["unavailable", "market_not_enabled"]);

    const on = env({ ...LOCAL_ENV, PAYMENT_PROVIDER: "fake", TAX_PROVIDER: "fake", PAYMENTS_ENABLED_MARKETS: "US" });
    const provider = getPaymentProvider(on);
    const created = await provider.createRecipient(request);
    assert.equal(created.status, "requires_action");
    if (created.status !== "requires_action") throw new Error("unreachable");
    const recipientRef = created.value.recipientRef;
    sharedFakePaymentProvider(on)!.control.setRecipientOnboarding(recipientRef, "verified");

    const forged = { ...forgedCharge("US"), idempotencyKey: "pr7-forged", recipientRef };
    assert.deepEqual(tag(await provider.createPaymentIntent(forged)), ["unavailable", "tax_not_configured"]);
    const good = await attestedCharge(on, { key: "pr7-c1", recipientRef });
    const intent = await provider.createPaymentIntent(good);
    assert.equal(intent.status, "ok", JSON.stringify(intent).slice(0, 200));
    assert.deepEqual(tag(await getPaymentProvider(off).createPaymentIntent({ ...good, idempotencyKey: "pr7-c2" })), ["unavailable", "market_not_enabled"]);
  });
});
