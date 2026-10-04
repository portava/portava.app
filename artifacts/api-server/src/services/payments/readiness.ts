/**
 * Payments readiness — "can a payment actually be taken right now?", answered
 * without a network call, a database read or a throw.
 *
 * The owner's ruling (2026-10-04, "Launch flags"): "keep payments in test mode
 * until payment, identity, and tax readiness are established." Identity has its
 * probe (`services/identityVerification/readiness.ts`); this is the payment and
 * tax half, built the same way and for the same reason: a route that needs to
 * ask "is this working?" cannot use a factory that refuses, and an operator
 * reading "payments are off" needs to be told which of several different
 * things is the cause.
 *
 * Payments are OPERATIONAL only when every one of these holds:
 *   1. a provider other than `none` is configured and resolves
 *      (`providerRegistry.ts` — `none`, `fake` in a local run, or a registered
 *      adapter)
 *   2. its key is allowed: test mode, or live with PAYMENTS_ALLOW_LIVE exactly
 *      "true" (`lib/paymentsMode.ts`); an unrecognised key is never allowed
 *   3. a real adapter is CERTIFIED by a sandbox transcript — "implemented" is
 *      not "certified", exactly as for identity
 *   4. the platform has enabled at least one market (PAYMENTS_ENABLED_MARKETS)
 *      and named no invalid one
 *   5. the provider supports every enabled market
 *   6. tax is configured for every enabled market (TaxProvider.ts)
 *
 * Every blocker is reported, most urgent first; `reason` is the first. Nothing
 * here returns or logs a key: the report is names, booleans and enums.
 *
 * NOR DOES IT ECHO CONFIGURATION. `provider` and `taxProvider` are the
 * configured names only when they are names this server knows (`none`, `fake`,
 * a registered adapter, a provider with a known key family); anything else is
 * reported as "unrecognised value". Invalid PAYMENTS_ENABLED_MARKETS tokens are
 * COUNTED, never quoted. A secret pasted into one of those variables by mistake
 * therefore cannot reach the startup log line.
 *
 * NO ROUTE. Identity readiness has no admin route today (it is consumed by
 * `lib/rentBuddyKycGate.ts` and the verification routes, and logged at
 * startup), so there is no admin auth to reuse and none is invented here. The
 * report is logged once at startup by `lib/paymentsStartupLog.ts`; checkout
 * (PAY-T09) consults `paymentsReadiness().operational` the way the booking gate
 * consults `identityProviderStatus()`.
 */

import {
  describeRefusal,
  liveAllowed,
  type ProviderKeyMode,
} from "../../lib/paymentsMode.js";
import { resolveTaxProvider } from "./TaxProvider.js";
import {
  enabledPaymentMarkets,
  resolvePaymentProvider,
  type PaymentProviderAdapterRegistration,
  type PaymentProviderKind,
} from "./providerRegistry.js";

export interface PaymentsReadiness {
  /** True only when a payment can actually be created today. */
  readonly operational: boolean;
  /** Configured provider name, lower case. */
  readonly provider: string;
  readonly providerKind: PaymentProviderKind;
  /** A real adapter is certified by a sandbox transcript. Always false for `none`, `fake` and unregistered names. */
  readonly providerCertified: boolean;
  /** The configured provider's key mode; `none` when it holds no key or none is set. */
  readonly keyMode: ProviderKeyMode | "none";
  readonly keyPresent: boolean;
  /** A key is present and refused (live without permission, or unrecognised). */
  readonly keyRefused: boolean;
  /** PAYMENTS_ALLOW_LIVE is exactly "true". */
  readonly liveAllowed: boolean;
  readonly taxProvider: string;
  /** At least one market is enabled and tax is configured for every enabled market. */
  readonly taxConfigured: boolean;
  readonly enabledMarkets: readonly string[];
  /** How many PAYMENTS_ENABLED_MARKETS tokens are not country codes. A count: the tokens are never echoed. */
  readonly invalidMarketCount: number;
  readonly marketsNotSupportedByProvider: readonly string[];
  readonly marketsWithoutTax: readonly string[];
  /** Enabled markets in which the provider offers the direct-charge model. */
  readonly directChargeMarkets: readonly string[];
  /** Every blocker, most urgent first. Empty when operational. Safe for server logs. */
  readonly blockers: readonly string[];
  /** The first blocker, or a one-line statement that payments are operational. */
  readonly reason: string;
}

/** Probe payments. Never throws; performs no I/O. `adapters` is injectable for tests only. */
export function paymentsReadiness(
  env: NodeJS.ProcessEnv = process.env,
  adapters?: readonly PaymentProviderAdapterRegistration[],
): PaymentsReadiness {
  const resolution = resolvePaymentProvider(env, adapters);
  const key = resolution.keyDecision;
  const allowLive = liveAllowed(env);
  const keyPresent = key?.keyPresent ?? false;
  const keyRefused = keyPresent && key !== null && !key.allowed;
  const blockers: string[] = [];

  // 1–2. key first: a live or unrecognised key stops every provider call.
  if (key && keyRefused) {
    const what = key.refusal === "live_key_not_allowed" ? "live key not allowed" : "unrecognised key";
    blockers.push(`not operational: ${what} — ${describeRefusal(key.refusal ?? "unknown_key_prefix")}; every provider call is refused before it is sent.`);
  }

  if (resolution.ok && resolution.kind === "none") {
    blockers.push("PAYMENT_PROVIDER is unset or `none`: payments are disabled and nothing is charged, refunded or paid out.");
  } else if (!resolution.ok) {
    if (!(keyRefused && (resolution.reason === "live_key_not_allowed" || resolution.reason === "unknown_key_prefix"))) {
      blockers.push(`PAYMENT_PROVIDER (${resolution.name}) cannot be used (${resolution.reason}): ${resolution.detail}`);
    }
  }

  // 4–6. markets and tax
  const { markets: enabledMarkets, invalidCount: invalidMarketCount } = enabledPaymentMarkets(env);
  if (invalidMarketCount > 0) {
    blockers.push(`PAYMENTS_ENABLED_MARKETS names ${invalidMarketCount} value(s) that are not ISO 3166-1 alpha-2 codes.`);
  }
  if (enabledMarkets.length === 0) {
    blockers.push("PAYMENTS_ENABLED_MARKETS is empty: the platform has enabled payments in no market.");
  }

  const marketsNotSupportedByProvider: string[] = [];
  const directChargeMarkets: string[] = [];
  if (resolution.ok && resolution.kind !== "none") {
    const capabilities = resolution.provider.capabilities();
    for (const market of enabledMarkets) {
      const support = resolution.provider.marketSupport({ recipientCountry: market });
      if (!support.supported) marketsNotSupportedByProvider.push(market);
      else if (support.chargeModels.includes("direct") && capabilities.chargeModels.includes("direct")) directChargeMarkets.push(market);
    }
    if (marketsNotSupportedByProvider.length > 0) {
      blockers.push(`${resolution.name} does not support recipients in: ${marketsNotSupportedByProvider.join(", ")}. No provider is worldwide; remove the market or use a provider that covers it.`);
    }
  }

  const tax = resolveTaxProvider(env);
  const taxName = tax.name; // already a label: a known name or "unrecognised value", never raw configuration
  const marketsWithoutTax = tax.ok ? enabledMarkets.filter((m) => !tax.provider.marketStatus(m).configured) : [...enabledMarkets];
  if (!tax.ok) {
    blockers.push(`TAX_PROVIDER (${taxName}) cannot be used (${tax.reason}): ${tax.detail}`);
  } else if (marketsWithoutTax.length > 0) {
    blockers.push(`tax is not configured for: ${marketsWithoutTax.join(", ")} (TAX_PROVIDER=${taxName}). Checkout refuses where tax is not configured.`);
  }
  const taxConfigured = tax.ok && enabledMarkets.length > 0 && marketsWithoutTax.length === 0;

  const operational = blockers.length === 0;
  const mode = key && key.keyPresent ? key.mode : "none";
  return {
    operational,
    provider: resolution.name,
    providerKind: resolution.kind,
    providerCertified: resolution.ok && resolution.kind === "adapter" && resolution.certified,
    keyMode: mode,
    keyPresent,
    keyRefused,
    liveAllowed: allowLive,
    taxProvider: taxName,
    taxConfigured,
    enabledMarkets,
    invalidMarketCount,
    marketsNotSupportedByProvider,
    marketsWithoutTax,
    directChargeMarkets,
    blockers,
    reason: operational
      ? `${resolution.name} operational in ${mode === "live" ? "LIVE" : mode === "test" ? "test" : "local fake"} mode for ${enabledMarkets.join(", ")}`
      : (blockers[0] as string),
  };
}

/** What the startup line logs: names, booleans and enums — never a key. */
export function paymentsReadinessSummary(env: NodeJS.ProcessEnv = process.env): {
  paymentProvider: string;
  operational: boolean;
  keyMode: ProviderKeyMode | "none";
  keyRefused: boolean;
  liveAllowed: boolean;
  taxProvider: string;
  taxConfigured: boolean;
  enabledMarkets: readonly string[];
  reason: string;
} {
  const r = paymentsReadiness(env);
  return {
    paymentProvider: r.provider,
    operational: r.operational,
    keyMode: r.keyMode,
    keyRefused: r.keyRefused,
    liveAllowed: r.liveAllowed,
    taxProvider: r.taxProvider,
    taxConfigured: r.taxConfigured,
    enabledMarkets: r.enabledMarkets,
    reason: r.reason,
  };
}
