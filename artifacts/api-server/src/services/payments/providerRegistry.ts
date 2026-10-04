/**
 * Payment provider registry — which PaymentProvider this process uses.
 *
 *   PAYMENT_PROVIDER unset / empty / `none`  -> the no-money provider (default)
 *   PAYMENT_PROVIDER=fake                    -> the deterministic fake, in a
 *                                               LOCAL run only
 *   any other name                           -> refused, until an adapter is
 *                                               registered in REGISTERED_ADAPTERS
 *
 * No real adapter is registered. The owner chose Stripe Connect in test mode as
 * the first integration (2026-10-04); writing that adapter is PAY-T04. Setting
 * `PAYMENT_PROVIDER=stripe` today answers `provider_not_registered` — or, if the
 * key in STRIPE_SECRET_KEY is live or unrecognised, the key refusal, which is
 * reported first because it is the more urgent fault.
 *
 * WHAT THIS MEANS FOR TESTERS. The hosted testing app is a Replit deployment,
 * where the fake is refused. Until a test-mode adapter AND a tax provider are
 * registered, no payment can be made there; nothing in this module is
 * exercisable by a tester. It is exercisable in a local run and by the suites.
 *
 * ── WHAT THE REGISTRY ENFORCES, SO NEITHER AN ADAPTER NOR A CALLER CAN FORGET ─
 * A route obtains a provider only from `getPaymentProvider`, and what it gets
 * is the adapter behind two wrappers:
 *
 *   1. `guardPaymentProvider` (PaymentProvider.ts)
 *      • KEY MODE, BEFORE ANY REQUEST. The key is re-read and re-classified
 *        before EVERY operation — a key rotated to a live one under a running
 *        process is refused on the next call. The decision is
 *        `lib/paymentsMode.ts evaluateProviderKey`; nothing here restates a prefix.
 *      • THE REQUEST IS VALIDATED by the shared validators, and a capture is
 *        validated against the intent it captures, before the adapter runs.
 *      • NOTHING THROWS AND NOTHING MALFORMED PASSES. A throw, `undefined`, or
 *        an answer that is not that operation's result becomes
 *        `failed / provider_error` — `capabilities()` and `marketSupport()`
 *        included, and `adapter.create()` too (`unavailable / adapter_failed`).
 *
 *   2. `enforcePaymentPolicy` (below) — the owner's "enable real payments only
 *      in supported markets after the relevant account, tax, and legal setup is
 *      complete" and "checkout must refuse where tax is not configured",
 *      checked on every operation that brings money IN or sends it OUT to a
 *      recipient (create / confirm / capture an intent, create a recipient or
 *      an onboarding link, request a payout):
 *      • the PLATFORM has enabled the recipient's market
 *        (`PAYMENTS_ENABLED_MARKETS`, empty by default) — `market_not_enabled`
 *      • the PROVIDER supports it, in that currency and charge model —
 *        `unsupported_market` / `unsupported_currency` / `charge_model_not_supported`
 *      • on `createPaymentIntent`: tax is configured for the market by the
 *        REGISTERED tax provider, and every `TaxComputation` on the charge was
 *        ISSUED by it (`TaxProvider.attests`) for that market —
 *        `tax_not_configured`. A hand-built computation, a copy, or one from a
 *        different provider is refused; with TAX_PROVIDER=none nothing passes.
 *      Operations that give money BACK or only read — cancel, refund,
 *      hold / release / reverse, the reads, webhook verification — are never
 *      blocked by market policy: disabling a market must not trap a refund.
 *
 *   • CERTIFICATION. An adapter registered `certified: false` resolves to
 *     `unavailable / provider_not_certified` on every operation. The one
 *     exception is an explicit `{ certificationRun: true }`, which a sandbox
 *     transcript script passes and no route does, and which additionally
 *     requires a TEST key whatever PAYMENTS_ALLOW_LIVE says.
 *   • THE FAKE STAYS LOCAL. Refused in production, on a hosted deployment and
 *     without a local-run signal — the mock identity provider's rule.
 *   • NOTHING CONFIGURED IS ECHOED. A provider name that is not `none`, `fake`
 *     or a registered/known name is reported as "unrecognised value": a key
 *     pasted into PAYMENT_PROVIDER by mistake never reaches a result or a log.
 *
 * ── ADAPTER-AUTHOR CHECKLIST (PAY-T04 and every adapter after it) ────────────
 *  1. Implement `PaymentProvider` (PaymentProvider.ts) in its own file under
 *     services/payments/, and add ONE entry to REGISTERED_ADAPTERS below. Do not
 *     export the raw adapter for callers: they get it from `getPaymentProvider`.
 *  2. Read the secret key at CALL time (not module load) and pass it through
 *     `assertProviderKeyAllowed` before every fetch, exactly as
 *     services/identityVerification/stripeIdentity.ts `secretKey()` does. The
 *     registry's guard is the second lock, not a replacement for the first.
 *     A provider whose keys carry no documented test/live prefix cannot be
 *     registered as it stands: teach `lib/paymentsMode.ts` to tell its sandbox
 *     key from its live key first (as was done for Persona), then register.
 *  3. The guard has already run the shared validators (`validateCreatePaymentIntent`,
 *     `validateCapturePaymentIntent`, `validateRefundPayment`, …) when your
 *     method is called. Do not re-derive the fee, tax or granularity rules.
 *     For a capture, take the amount and fee from `resolveCapture`.
 *  4. Send the caller's `idempotencyKey` as the provider's idempotency key on
 *     every create / confirm / capture / cancel / refund / payout / reversal /
 *     onboarding link. Never mint one.
 *  5. `chargeModel: "direct"` creates the charge ON THE RECIPIENT'S ACCOUNT with
 *     `platformFeeTotalMinor(req.platformFee)` as the application fee. Every
 *     later call for that object carries the recipient too (`IntentHandle`).
 *     Persist `components` and `platformFee` with the object (provider
 *     metadata): every snapshot must return them, and a partial capture is
 *     validated against them. Report in `capabilities()` and `marketSupport()`
 *     exactly what the provider documents for each country — never "supported"
 *     by default. On a refund honour BOTH choices the caller states:
 *     `refundPlatformFee` and, for destination charges, `reverseTransfer`.
 *  6. Amounts are ISO 4217 minor units in and out (`minorUnitExponent`); where
 *     the provider's wire format departs from ISO for a currency, convert at
 *     your boundary. Put the ORIGINAL amount and currency on every snapshot.
 *     Fill `settlement` from the provider's balance records: what reached the
 *     receiving balance, the rate applied with its source and time, the
 *     provider's own processing fee and who paid it (`providerFee`), and what
 *     the platform's fee became on the platform's balance
 *     (`platformFeeSettled`). Never compute a rate from `fx_rates`.
 *  7. `verifyAndParseWebhook`: pick the secret by `delivery.endpoint` (the
 *     platform endpoint and the connect endpoint have different secrets —
 *     `PAYMENT_WEBHOOK_SECRET_ENV`, `PAYMENT_CONNECT_WEBHOOK_SECRET_ENV`);
 *     verify with `verifyPaymentWebhookSignature` over the RAW body first; then
 *     parse; then `webhookLivemodeRefused(livemode)` -> `unavailable /
 *     livemode_not_allowed`; then normalise to `PaymentWebhookEvent`. Map
 *     anything unmodelled to `{ kind: "ignored" }`. `updatedAt` must never go
 *     backwards for one object, and it may repeat (paymentEventFold.ts): where
 *     two changes share an instant and no counter separates them, re-read the
 *     object and report its current state.
 *  8. Map the provider's outcomes onto the five statuses with a reason from the
 *     closed unions (the guard rejects any other). A payer's bank saying no is
 *     `declined`, not `failed`. A 5xx or a timeout is `unavailable /
 *     provider_unreachable`, retriable. A provider-initiated payout has
 *     `reference: null`.
 *  9. Never log or return a key, a signature, a raw body, a document number or
 *     a date of birth. `requirementsDue` carries the provider's CODES only.
 * 10. Register with `certified: false`. Flip it only when a sandbox transcript
 *     exists (produced with `{ certificationRun: true }` and a test key):
 *     recipient onboarded -> intent created on the recipient's account with a
 *     platform fee -> confirmed -> captured -> partially and fully refunded ->
 *     transfer, partial reversal and payout -> each signed webhook received on
 *     its endpoint, verified and folded.
 * 11. Add the adapter's module name to `PROVIDER_MODULES` in
 *     test/paymentProviderArchitecture.test.ts so the ledger pin covers it.
 */

import {
  PAYMENT_KEY_ENV,
  configuredPaymentProvider,
  evaluateProviderKey,
  fakePaymentProviderPermitted,
  isKeyedPaymentProvider,
  paymentKeyDecision,
  type KeyedPaymentProvider,
  type ProviderKeyDecision,
} from "../../lib/paymentsMode.js";
import { FAKE_PAYMENT_PROVIDER_ID, createFakePaymentProvider, type FakePaymentProvider } from "./FakePaymentProvider.js";
import {
  NONE_PAYMENT_PROVIDER,
  NONE_PAYMENT_PROVIDER_ID,
  guardPaymentProvider,
  paymentFailed,
  paymentResultFromThrown,
  paymentUnavailable,
  refusingPaymentProvider,
  validateCreatePaymentIntent,
  validateCreateRecipient,
  type CapturePaymentIntentRequest,
  type ChargeModel,
  type ConfirmPaymentIntentRequest,
  type CreatePaymentIntentRequest,
  type CreateRecipientRequest,
  type PaymentIntentSnapshot,
  type PaymentProvider,
  type PaymentRefusal,
  type PaymentResult,
  type PaymentUnavailable,
  type PayoutSnapshot,
  type RecipientOnboardingLink,
  type RecipientOnboardingLinkRequest,
  type RecipientSnapshot,
  type RequestPayoutRequest,
  type UnavailableReason,
} from "./PaymentProvider.js";
import { UNRECOGNISED_VALUE, taxProviderOrNone, type TaxProvider } from "./TaxProvider.js";

/**
 * How a real adapter joins the registry. THIS is the registration point: one
 * entry in `REGISTERED_ADAPTERS`, reviewed like any other change. There is no
 * runtime `register()` call for a module to make on import.
 */
export interface PaymentProviderAdapterRegistration {
  /** What PAYMENT_PROVIDER is set to. Lower case; never `none` or `fake`. */
  readonly name: string;
  /** The key family the adapter's secret belongs to; `lib/paymentsMode.ts` classifies it and names its env var. */
  readonly keyProvider: KeyedPaymentProvider;
  /**
   * False until a sandbox transcript exists (checklist item 10). An uncertified
   * adapter answers `provider_not_certified` to everything, except in an
   * explicit certification run with a test key.
   */
  readonly certified: boolean;
  /** Build the adapter. No I/O, no key read: both happen per call. May not throw — but if it does, the registry answers `adapter_failed`. */
  create(env: NodeJS.ProcessEnv): PaymentProvider;
}

/**
 * ── ADD YOUR ADAPTER HERE, AFTER THE CHECKLIST ABOVE ─────────────────────────
 * Empty on purpose: no real payment provider is implemented yet.
 */
const REGISTERED_ADAPTERS: readonly PaymentProviderAdapterRegistration[] = Object.freeze([]);

/** The registered adapters' names. Empty until PAY-T04. */
export function registeredPaymentAdapters(): readonly string[] {
  return REGISTERED_ADAPTERS.map((a) => a.name);
}

export interface ResolveOptions {
  /**
   * Allow an UNCERTIFIED adapter to be used, to produce the sandbox transcript
   * that certifies it. Requires a test key. Passed by a certification script
   * only; no route passes it.
   */
  readonly certificationRun?: boolean;
}

export type PaymentProviderKind = "none" | "fake" | "adapter" | "unregistered";

export type PaymentProviderResolution =
  | {
      readonly ok: true;
      /** The configured name as it may be logged (see `paymentProviderLabel`). */
      readonly name: string;
      readonly kind: "none" | "fake" | "adapter";
      readonly provider: PaymentProvider;
      readonly certified: boolean;
      readonly keyDecision: ProviderKeyDecision | null;
    }
  | {
      readonly ok: false;
      readonly name: string;
      readonly kind: PaymentProviderKind;
      readonly reason: UnavailableReason;
      readonly detail: string;
      readonly keyDecision: ProviderKeyDecision | null;
    };

/**
 * The configured provider name as it may be LOGGED OR RETURNED: itself when it
 * is `none`, `fake`, a registered adapter's name or a provider this server
 * knows a key family for; otherwise a fixed marker. Raw configuration text is
 * never echoed.
 */
export function paymentProviderLabel(name: string, adapters: readonly PaymentProviderAdapterRegistration[] = REGISTERED_ADAPTERS): string {
  if (name === NONE_PAYMENT_PROVIDER_ID || name === FAKE_PAYMENT_PROVIDER_ID || isKeyedPaymentProvider(name)) return name;
  return adapters.some((a) => a.name === name) ? name : UNRECOGNISED_VALUE;
}

const KEY_REFUSAL_DETAIL: Record<"key_absent" | "live_key_not_allowed" | "unknown_key_prefix", string> = {
  key_absent: "no secret key is configured for the payment provider",
  live_key_not_allowed: "the payment provider's key is a LIVE key and PAYMENTS_ALLOW_LIVE is not \"true\"; refused before any request",
  unknown_key_prefix: "the payment provider's key has an unrecognised prefix; only documented test/live secret-key prefixes are accepted",
};

function keyRefusal(provider: string, decision: ProviderKeyDecision): PaymentUnavailable | null {
  if (decision.allowed || decision.refusal === null) return null;
  return paymentUnavailable(provider, decision.refusal, KEY_REFUSAL_DETAIL[decision.refusal]);
}

let sharedFake: FakePaymentProvider | null = null;

/**
 * The one fake instance a local server process shares, so state survives
 * between requests. Null when the fake is not permitted in `env`. Tests that
 * want isolated state call `createFakePaymentProvider` themselves.
 */
export function sharedFakePaymentProvider(env: NodeJS.ProcessEnv = process.env): FakePaymentProvider | null {
  if (!fakePaymentProviderPermitted(env)) return null;
  sharedFake ??= createFakePaymentProvider();
  return sharedFake;
}

const FAKE_REFUSED_DETAIL =
  "PAYMENT_PROVIDER=fake is refused in production, on a hosted deployment (REPLIT_DEPLOYMENT defined), and without a " +
  "local-run signal (NODE_ENV=development|test, or node --test).";

const NOT_CERTIFIED_DETAIL =
  "the adapter is implemented but not certified against the provider. A sandbox transcript (onboard -> charge on the " +
  "recipient's account -> capture -> refund -> payout, with signed webhooks) must be recorded before its registration is marked certified.";

// ─────────────────────────────────────────────────────────────────────────────
// The platform's enabled markets
// ─────────────────────────────────────────────────────────────────────────────

/** Comma-separated ISO 3166-1 alpha-2 codes of the markets the platform has enabled payments in. Empty by default. */
export const PAYMENTS_ENABLED_MARKETS_ENV = "PAYMENTS_ENABLED_MARKETS" as const;

export interface EnabledPaymentMarkets {
  /** Valid codes, upper case, de-duplicated, sorted. */
  readonly markets: readonly string[];
  /** How many tokens are not two letters. Counted, never echoed: a token is raw configuration text. */
  readonly invalidCount: number;
}

export function enabledPaymentMarkets(env: NodeJS.ProcessEnv = process.env): EnabledPaymentMarkets {
  const tokens = (env[PAYMENTS_ENABLED_MARKETS_ENV] ?? "").split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const markets = new Set<string>();
  let invalidCount = 0;
  for (const t of tokens) {
    const code = t.toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) markets.add(code);
    else invalidCount += 1;
  }
  return { markets: [...markets].sort(), invalidCount };
}

/** Has the platform enabled payments for recipients in this country? Exact, upper-case match; unset means no. */
export function paymentMarketEnabled(country: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledPaymentMarkets(env).markets.includes(country);
}

// ─────────────────────────────────────────────────────────────────────────────
// Market and tax policy, enforced on every operation that needs it
// ─────────────────────────────────────────────────────────────────────────────

/** What the policy wrapper consults. Both are read at CALL time. */
export interface PaymentPolicy {
  /** The markets the platform has enabled. */
  enabledMarkets(): readonly string[];
  /** The REGISTERED tax provider — the only one whose computations a charge may carry. */
  taxProvider(): TaxProvider;
}

export function paymentPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentPolicy {
  return {
    enabledMarkets: () => enabledPaymentMarkets(env).markets,
    taxProvider: () => taxProviderOrNone(env),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Wrap a (guarded) provider so that the owner's market and tax rulings are
 * checked by the registry, not left to each route. See the header for exactly
 * which operations are gated and which never are.
 */
export function enforcePaymentPolicy(provider: PaymentProvider, policy: PaymentPolicy): PaymentProvider {
  const id = provider.id;

  /** May money move for a recipient established in `country`? Null when it may. */
  const marketGate = (country: string, presentmentCurrency: string | null, chargeModel: ChargeModel | null): PaymentUnavailable | null => {
    if (!policy.enabledMarkets().includes(country)) {
      return paymentUnavailable(id, "market_not_enabled", `the platform has not enabled payments for ${country} (PAYMENTS_ENABLED_MARKETS)`);
    }
    const support = provider.marketSupport({ recipientCountry: country, presentmentCurrency });
    if (!support.supported) {
      return support.reason === "currency_not_supported"
        ? paymentUnavailable(id, "unsupported_currency", `${id} cannot charge that currency for a recipient in ${country}`)
        : paymentUnavailable(id, "unsupported_market", `${id} does not support recipients in ${country}; no provider is worldwide`);
    }
    if (chargeModel !== null && chargeModel !== "platform" && !(support.chargeModels.includes(chargeModel) && provider.capabilities().chargeModels.includes(chargeModel))) {
      return paymentUnavailable(id, "charge_model_not_supported", `${id} cannot create ${chargeModel} charges for recipients in ${country}`);
    }
    return null;
  };

  /** The gate for an operation on an existing recipient: ask the provider where they are established. */
  const recipientGate = async (recipientRef: unknown): Promise<PaymentRefusal | null> => {
    if (typeof recipientRef !== "string" || recipientRef.length === 0) return null; // no recipient (a platform charge), or a shape the guard refuses
    const r = await provider.validateRecipient(recipientRef);
    if (r.status === "failed" || r.status === "unavailable") return r;
    const snapshot = r.value;
    if (!snapshot) return paymentFailed(id, "provider_error", "the recipient's market could not be read", true);
    return marketGate(snapshot.country, null, null);
  };

  const gated = <A, T>(gate: (arg: A) => Promise<PaymentRefusal | null> | PaymentRefusal | null, op: (arg: A) => Promise<PaymentResult<T>>) =>
    async (arg: A): Promise<PaymentResult<T>> => {
      try {
        const refusal = await gate(arg);
        if (refusal) return refusal;
        return await op(arg);
      } catch (err) {
        return paymentResultFromThrown(id, err);
      }
    };

  const createIntentGate = (req: CreatePaymentIntentRequest): PaymentRefusal | null => {
    const invalid = validateCreatePaymentIntent(id, req);
    if (invalid) return invalid;
    // The seller's market: the recipient's for a direct or destination charge, the tax lines' for a platform charge.
    const sellerMarkets = new Set(req.tax.map((t) => t.sellerMarket));
    if (sellerMarkets.size !== 1) return paymentFailed(id, "invalid_request", "the tax computations on one charge must be for one seller market");
    const market = req.recipientCountry ?? ([...sellerMarkets][0] as string);
    const blocked = marketGate(market, req.amount.currency, req.chargeModel);
    if (blocked) return blocked;
    const tax = policy.taxProvider();
    if (!tax.marketStatus(market).configured) {
      return paymentUnavailable(id, "tax_not_configured", `tax is not configured for sellers in ${market}; checkout refuses where tax is not configured`);
    }
    if (!req.tax.every((t) => t.sellerMarket === market && tax.attests(t))) {
      return paymentUnavailable(
        id,
        "tax_not_configured",
        "a tax computation on this charge was not issued by the registered tax provider for this market; compute tax with it in this request",
      );
    }
    return null;
  };

  const createRecipientGate = (req: CreateRecipientRequest): PaymentRefusal | null => validateCreateRecipient(id, req) ?? marketGate(req.country, null, null);
  const intentRecipient = (req: { intent?: unknown }): unknown => (isObject(req) && isObject(req.intent) ? req.intent["recipientRef"] : null);
  const requestRecipient = (req: { recipientRef?: unknown }): unknown => (isObject(req) ? req["recipientRef"] : null);

  const wrapped: PaymentProvider = {
    id,
    capabilities: () => provider.capabilities(),
    marketSupport: (query) => provider.marketSupport(query),
    // money in
    createPaymentIntent: gated<CreatePaymentIntentRequest, PaymentIntentSnapshot>(createIntentGate, (r) => provider.createPaymentIntent(r)),
    confirmPaymentIntent: gated<ConfirmPaymentIntentRequest, PaymentIntentSnapshot>((r) => recipientGate(intentRecipient(r)), (r) => provider.confirmPaymentIntent(r)),
    capturePaymentIntent: gated<CapturePaymentIntentRequest, PaymentIntentSnapshot>((r) => recipientGate(intentRecipient(r)), (r) => provider.capturePaymentIntent(r)),
    // recipients, and money out to them
    createRecipient: gated<CreateRecipientRequest, RecipientSnapshot>(createRecipientGate, (r) => provider.createRecipient(r)),
    createRecipientOnboardingLink: gated<RecipientOnboardingLinkRequest, RecipientOnboardingLink>((r) => recipientGate(requestRecipient(r)), (r) => provider.createRecipientOnboardingLink(r)),
    requestPayout: gated<RequestPayoutRequest, PayoutSnapshot>((r) => recipientGate(requestRecipient(r)), (r) => provider.requestPayout(r)),
    // money back, and reads: never blocked by market policy
    cancelPaymentIntent: (r) => provider.cancelPaymentIntent(r),
    refundPayment: (r) => provider.refundPayment(r),
    reverseOrHoldPayout: (r) => provider.reverseOrHoldPayout(r),
    getPaymentIntent: (h) => provider.getPaymentIntent(h),
    validateRecipient: (ref) => provider.validateRecipient(ref),
    getPayoutStatus: (h) => provider.getPayoutStatus(h),
    verifyAndParseWebhook: (d) => provider.verifyAndParseWebhook(d),
  };
  return Object.freeze(wrapped);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the configured provider. Never throws and never performs I/O.
 * `adapters` is injectable so the guards can be proven against a stand-in
 * adapter; production passes nothing and gets `REGISTERED_ADAPTERS`.
 */
export function resolvePaymentProvider(
  env: NodeJS.ProcessEnv = process.env,
  adapters: readonly PaymentProviderAdapterRegistration[] = REGISTERED_ADAPTERS,
  options: ResolveOptions = {},
): PaymentProviderResolution {
  const configured = configuredPaymentProvider(env);
  const name = paymentProviderLabel(configured, adapters);
  const policy = paymentPolicyFromEnv(env);

  if (configured === NONE_PAYMENT_PROVIDER_ID) {
    return { ok: true, name, kind: "none", provider: NONE_PAYMENT_PROVIDER, certified: false, keyDecision: null };
  }

  if (configured === FAKE_PAYMENT_PROVIDER_ID) {
    const fake = sharedFakePaymentProvider(env);
    if (!fake) return { ok: false, name, kind: "fake", reason: "fake_not_permitted", detail: FAKE_REFUSED_DETAIL, keyDecision: null };
    const guarded = guardPaymentProvider(fake, () =>
      fakePaymentProviderPermitted(env) ? null : paymentUnavailable(FAKE_PAYMENT_PROVIDER_ID, "fake_not_permitted", FAKE_REFUSED_DETAIL),
    );
    return { ok: true, name, kind: "fake", provider: enforcePaymentPolicy(guarded, policy), certified: false, keyDecision: null };
  }

  const adapter = adapters.find((a) => a.name === configured);
  if (!adapter) {
    // Not registered. If the name is one whose key we can classify, a live or
    // unrecognised key is still the first thing to say.
    const keyDecision = paymentKeyDecision(env);
    if (keyDecision && (keyDecision.refusal === "live_key_not_allowed" || keyDecision.refusal === "unknown_key_prefix")) {
      return { ok: false, name, kind: "unregistered", reason: keyDecision.refusal, detail: KEY_REFUSAL_DETAIL[keyDecision.refusal], keyDecision };
    }
    return {
      ok: false,
      name,
      kind: "unregistered",
      reason: "provider_not_registered",
      detail: "PAYMENT_PROVIDER names a provider with no registered adapter; only `none` and (in a local run) `fake` resolve",
      keyDecision,
    };
  }

  const decide = (): ProviderKeyDecision => evaluateProviderKey(adapter.keyProvider, env[PAYMENT_KEY_ENV[adapter.keyProvider]], env);
  const keyDecision = decide();
  const refused = keyRefusal(name, keyDecision);
  if (refused) {
    return { ok: false, name, kind: "adapter", reason: refused.reason, detail: refused.detail, keyDecision };
  }
  if (!adapter.certified) {
    if (options.certificationRun !== true) {
      return { ok: false, name, kind: "adapter", reason: "provider_not_certified", detail: NOT_CERTIFIED_DETAIL, keyDecision };
    }
    if (keyDecision.mode !== "test") {
      return { ok: false, name, kind: "adapter", reason: "provider_not_certified", detail: "a certification run uses a TEST key; this key is not one", keyDecision };
    }
  }

  let inner: PaymentProvider;
  try {
    inner = adapter.create(env);
  } catch {
    return { ok: false, name, kind: "adapter", reason: "adapter_failed", detail: "the provider adapter could not be constructed (it threw)", keyDecision };
  }
  if (!isObject(inner)) {
    return { ok: false, name, kind: "adapter", reason: "adapter_failed", detail: "the provider adapter could not be constructed (it returned nothing)", keyDecision };
  }
  const uncertifiedRun = !adapter.certified;
  const guarded = guardPaymentProvider(inner, () => {
    const now = decide();
    const stillRefused = keyRefusal(name, now);
    if (stillRefused) return stillRefused;
    // A certification run never proceeds on a live key, whatever PAYMENTS_ALLOW_LIVE says.
    return uncertifiedRun && now.mode !== "test" ? paymentUnavailable(name, "provider_not_certified", "a certification run uses a TEST key; this key is not one") : null;
  });
  return { ok: true, name, kind: "adapter", provider: enforcePaymentPolicy(guarded, policy), certified: adapter.certified, keyDecision };
}

/**
 * The provider every caller uses. Always answers: when the configured provider
 * cannot be used, the caller gets one whose every operation is the refusal, so
 * no route has a throwing factory to guard.
 */
export function getPaymentProvider(
  env: NodeJS.ProcessEnv = process.env,
  adapters: readonly PaymentProviderAdapterRegistration[] = REGISTERED_ADAPTERS,
  options: ResolveOptions = {},
): PaymentProvider {
  const r = resolvePaymentProvider(env, adapters, options);
  return r.ok ? r.provider : refusingPaymentProvider(r.name === UNRECOGNISED_VALUE ? "unrecognised" : r.name, r.reason, r.detail);
}
