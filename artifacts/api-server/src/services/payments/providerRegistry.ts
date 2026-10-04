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
 * ── WHAT THE REGISTRY ENFORCES, SO AN ADAPTER CANNOT FORGET ──────────────────
 *   • KEY MODE, BEFORE ANY REQUEST. A keyed adapter is handed out only if its
 *     key classifies as `test` (or `live` with PAYMENTS_ALLOW_LIVE exactly
 *     "true"), and it is handed out wrapped in `guardPaymentProvider`, which
 *     re-reads and re-classifies the key before EVERY operation — a key rotated
 *     to a live one under a running process is refused on the next call. The
 *     decision is `lib/paymentsMode.ts evaluateProviderKey`; nothing here
 *     restates a prefix.
 *   • NOTHING THROWS. Whatever an adapter throws leaves the guard as a tagged
 *     `failed / provider_error` (or the sandbox guard's own refusal).
 *   • THE FAKE STAYS LOCAL. Refused in production, on a hosted deployment and
 *     without a local-run signal — the mock identity provider's rule.
 *
 * ── MARKETS ──────────────────────────────────────────────────────────────────
 * The owner ruled: "Enable real payments only in supported markets after the
 * relevant account, tax, and legal setup is complete." Two things must both be
 * true for a country, and they are different facts:
 *   1. the PROVIDER supports it        (`PaymentProvider.marketSupport`)
 *   2. the PLATFORM has enabled it     (`PAYMENTS_ENABLED_MARKETS`, a comma-
 *      separated list of ISO 3166-1 alpha-2 codes; empty by default, so no
 *      market is enabled until someone names it)
 * and tax must be configured for it (TaxProvider.ts). `readiness.ts` reports
 * all three; `paymentMarketEnabled` is the platform half.
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
 *  3. Call `validateCreatePaymentIntent` / `validateCreateRecipient` /
 *     `validateRequestPayout` first and return their refusal unchanged. The fee
 *     and tax rules live there; do not re-derive them.
 *  4. Send the caller's `idempotencyKey` as the provider's idempotency key on
 *     every create / confirm / capture / cancel / refund / payout. Never mint one.
 *  5. `chargeModel: "direct"` creates the charge ON THE RECIPIENT'S ACCOUNT with
 *     `platformFeeTotalMinor(req.platformFee)` as the application fee. Every
 *     later call for that object carries the recipient too (`IntentHandle`).
 *     Report in `capabilities()` and `marketSupport()` exactly what the provider
 *     documents for each country — never "supported" by default.
 *  6. Amounts are integer minor units in and out. Own the zero-decimal-currency
 *     table. Put the ORIGINAL amount and currency on every snapshot and the
 *     provider's settled amount, applied rate, its source and timestamp in
 *     `settlement`; never compute a rate from `fx_rates`.
 *  7. `verifyAndParseWebhook`: verify with `verifyPaymentWebhookSignature` over
 *     the RAW body first; then parse; then `webhookLivemodeRefused(livemode)` ->
 *     `unavailable / livemode_not_allowed`; then normalise to
 *     `PaymentWebhookEvent`. Map anything unmodelled to `{ kind: "ignored" }`.
 *     `updatedAt` must never go backwards for one object (paymentEventFold.ts);
 *     where the provider's clock cannot order two changes, re-read the object.
 *  8. Map the provider's outcomes onto the five statuses with a reason from the
 *     closed unions. A payer's bank saying no is `declined`, not `failed`. A
 *     5xx or a timeout is `unavailable / provider_unreachable`, retriable.
 *  9. Never log or return a key, a signature, a raw body, a document number or
 *     a date of birth. `requirementsDue` carries the provider's CODES only.
 * 10. Register with `certified: false`. Flip it only when a sandbox transcript
 *     exists: recipient onboarded -> intent created on the recipient's account
 *     with a platform fee -> confirmed -> captured -> partially and fully
 *     refunded -> transfer and payout -> each signed webhook received, verified
 *     and folded. Until then `paymentsReadiness().operational` is false, which
 *     is what keeps checkout closed (the pattern identity's readiness uses).
 * 11. Add the adapter's module name to `PROVIDER_MODULES` in
 *     test/paymentProviderArchitecture.test.ts so the ledger pin covers it.
 */

import {
  PAYMENT_KEY_ENV,
  configuredPaymentProvider,
  evaluateProviderKey,
  fakePaymentProviderPermitted,
  paymentKeyDecision,
  type KeyedPaymentProvider,
  type ProviderKeyDecision,
} from "../../lib/paymentsMode.js";
import { FAKE_PAYMENT_PROVIDER_ID, createFakePaymentProvider, type FakePaymentProvider } from "./FakePaymentProvider.js";
import {
  NONE_PAYMENT_PROVIDER,
  NONE_PAYMENT_PROVIDER_ID,
  guardPaymentProvider,
  paymentUnavailable,
  refusingPaymentProvider,
  type PaymentProvider,
  type PaymentUnavailable,
  type UnavailableReason,
} from "./PaymentProvider.js";

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
   * adapter still resolves — the transcript has to be produced with it — but
   * readiness reports payments not operational.
   */
  readonly certified: boolean;
  /** Build the adapter. No I/O, no key read: both happen per call. */
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

export type PaymentProviderKind = "none" | "fake" | "adapter" | "unregistered";

export type PaymentProviderResolution =
  | {
      readonly ok: true;
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
  "PAYMENT_PROVIDER=fake is refused in production, on a hosted deployment (REPLIT_DEPLOYMENT set), and without a " +
  "local-run signal (NODE_ENV=development|test, or node --test).";

/**
 * Resolve the configured provider. Never throws and never performs I/O.
 * `adapters` is injectable so the key guard can be proven against a stand-in
 * adapter; production passes nothing and gets `REGISTERED_ADAPTERS`.
 */
export function resolvePaymentProvider(
  env: NodeJS.ProcessEnv = process.env,
  adapters: readonly PaymentProviderAdapterRegistration[] = REGISTERED_ADAPTERS,
): PaymentProviderResolution {
  const name = configuredPaymentProvider(env);

  if (name === NONE_PAYMENT_PROVIDER_ID) {
    return { ok: true, name, kind: "none", provider: NONE_PAYMENT_PROVIDER, certified: false, keyDecision: null };
  }

  if (name === FAKE_PAYMENT_PROVIDER_ID) {
    const fake = sharedFakePaymentProvider(env);
    if (!fake) return { ok: false, name, kind: "fake", reason: "fake_not_permitted", detail: FAKE_REFUSED_DETAIL, keyDecision: null };
    const provider = guardPaymentProvider(fake, () =>
      fakePaymentProviderPermitted(env) ? null : paymentUnavailable(FAKE_PAYMENT_PROVIDER_ID, "fake_not_permitted", FAKE_REFUSED_DETAIL),
    );
    return { ok: true, name, kind: "fake", provider, certified: false, keyDecision: null };
  }

  const adapter = adapters.find((a) => a.name === name);
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
      detail: `payment provider ${JSON.stringify(name)} has no registered adapter; only \`none\` and (in a local run) \`fake\` resolve`,
      keyDecision,
    };
  }

  const decide = (): ProviderKeyDecision => evaluateProviderKey(adapter.keyProvider, env[PAYMENT_KEY_ENV[adapter.keyProvider]], env);
  const keyDecision = decide();
  const refused = keyRefusal(name, keyDecision);
  if (refused) {
    return { ok: false, name, kind: "adapter", reason: refused.reason, detail: refused.detail, keyDecision };
  }
  const provider = guardPaymentProvider(adapter.create(env), () => keyRefusal(name, decide()));
  return { ok: true, name, kind: "adapter", provider, certified: adapter.certified, keyDecision };
}

/**
 * The provider every caller uses. Always answers: when the configured provider
 * cannot be used, the caller gets one whose every operation is the refusal, so
 * no route has a throwing factory to guard.
 */
export function getPaymentProvider(
  env: NodeJS.ProcessEnv = process.env,
  adapters: readonly PaymentProviderAdapterRegistration[] = REGISTERED_ADAPTERS,
): PaymentProvider {
  const r = resolvePaymentProvider(env, adapters);
  return r.ok ? r.provider : refusingPaymentProvider(r.name, r.reason, r.detail);
}

// ─────────────────────────────────────────────────────────────────────────────
// The platform's enabled markets
// ─────────────────────────────────────────────────────────────────────────────

/** Comma-separated ISO 3166-1 alpha-2 codes of the markets the platform has enabled payments in. Empty by default. */
export const PAYMENTS_ENABLED_MARKETS_ENV = "PAYMENTS_ENABLED_MARKETS" as const;

export interface EnabledPaymentMarkets {
  /** Valid codes, upper case, de-duplicated, sorted. */
  readonly markets: readonly string[];
  /** Tokens that are not two letters. Reported, never guessed at. */
  readonly invalid: readonly string[];
}

export function enabledPaymentMarkets(env: NodeJS.ProcessEnv = process.env): EnabledPaymentMarkets {
  const tokens = (env[PAYMENTS_ENABLED_MARKETS_ENV] ?? "").split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const markets = new Set<string>();
  const invalid = new Set<string>();
  for (const t of tokens) {
    const code = t.toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) markets.add(code);
    else invalid.add(t);
  }
  return { markets: [...markets].sort(), invalid: [...invalid].sort() };
}

/** Has the platform enabled payments for recipients in this country? Exact, upper-case match; unset means no. */
export function paymentMarketEnabled(country: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledPaymentMarkets(env).markets.includes(country);
}
