/**
 * TaxProvider — the replaceable boundary between checkout and whatever computes
 * tax. Its only real implementation computes none and says so.
 *
 * ── THE OWNER'S RULING (2026-10-04, "Tax") ───────────────────────────────────
 * "Calculate, collect, report, and remit taxes where the platform is legally
 * required to do so; providers handle their own income taxes. Add a
 * tax-provider interface and configure each launch country before enabling
 * checkout. Stripe Tax supports many jurisdictions, but it is not a substitute
 * for determining where the platform must register or file."
 *
 * ── WHAT THE CONTRACT SAYS ───────────────────────────────────────────────────
 *   1. A tax provider answers two questions and nothing else: "is this market
 *      configured?" (`marketStatus`, no I/O) and "what is the tax on this
 *      amount?" (`computeTax`, for a seller market, a buyer market, a product
 *      kind and a pre-tax amount in integer minor units).
 *   2. CHECKOUT MUST REFUSE WHERE TAX IS NOT CONFIGURED. This is not left to the
 *      caller's memory: `PaymentProvider.createPaymentIntent` takes the
 *      `TaxComputation`s as a required part of its request, and
 *      `validateCreatePaymentIntent` (PaymentProvider.ts) answers
 *      `unavailable / tax_not_configured` when they are missing, were produced
 *      for a different market or currency, or do not add up to the tax the
 *      payer is being charged. A `TaxComputation` can only be obtained from
 *      `computeTax` answering `ok`, and `none` never answers `ok`.
 *   3. "Configured" is a statement about ONE market. A provider that works in
 *      one country says nothing about the next; `marketStatus` is asked per
 *      seller market, and an unconfigured market is `configured: false` with a
 *      reason, never a zero-tax answer. Zero tax is an answer a configured
 *      market gives (`taxMinor: 0`); it is not what absence looks like.
 *   4. Who remits is part of the answer (`remittedBy`). Where the platform must
 *      collect and remit, the tax is taken through the platform fee; where the
 *      seller remits, it stays with the seller. The contract carries the fact;
 *      it does not decide it — that is a per-country legal determination.
 *
 * ── WHAT IS NOT HERE ─────────────────────────────────────────────────────────
 * No real provider. `resolveTaxProvider` knows `none` and — in a local run only
 * — `fake`. Which provider to use, and what "configured" must mean for each
 * launch country (registration, rates, who remits), are owner questions listed
 * in the PAY-C handoff. Tax DOCUMENTS and withholding are a different task
 * (PAY-T18) and are not modelled here.
 *
 * This file imports only `lib/paymentsMode.ts` (for the local-run rule the fake
 * shares with the mock identity provider). It performs no I/O.
 */

import { fakePaymentProviderPermitted } from "../../lib/paymentsMode.js";

export const NONE_TAX_PROVIDER_ID = "none" as const;
export const FAKE_TAX_PROVIDER_ID = "fake" as const;

/** The env var naming the tax provider. Absent or empty means `none`. */
export const TAX_PROVIDER_ENV = "TAX_PROVIDER" as const;

/** What is being sold. Tips and the platform's own fee are taxed differently from a service in most places. */
export type TaxProductKind = "service" | "tip" | "platform_fee" | "ticket" | "subscription";

export const TAX_PRODUCT_KINDS: readonly TaxProductKind[] = ["service", "tip", "platform_fee", "ticket", "subscription"];

/** Who hands the collected tax to the authority. `none` = no tax is due on this line. */
export type TaxRemitter = "platform" | "seller" | "none";

export interface TaxQuery {
  /** ISO 3166-1 alpha-2 of the market the SELLER (the service provider) operates in. */
  sellerMarket: string;
  /** ISO 3166-1 alpha-2 of the buyer's market. */
  buyerMarket: string;
  productKind: TaxProductKind;
  /** PRE-TAX amount, integer minor units. */
  amountMinor: number;
  /** ISO 4217, upper case. */
  currency: string;
}

/**
 * A tax answer for one line. Only `computeTax` answering `ok` produces one, and
 * `configured` is the literal `true` so a hand-built object that omits the
 * question cannot type-check as an answer.
 */
export interface TaxComputation {
  readonly provider: string;
  readonly configured: true;
  readonly sellerMarket: string;
  readonly buyerMarket: string;
  readonly productKind: TaxProductKind;
  /** The pre-tax amount the tax was computed on, integer minor units. */
  readonly taxableMinor: number;
  /** The tax, integer minor units, in `currency`. May be 0 in a configured market. */
  readonly taxMinor: number;
  readonly currency: string;
  readonly remittedBy: TaxRemitter;
  /** The rate applied, in basis points, when the provider reports one. */
  readonly rateBps: number | null;
  /** The provider's name for the taxing jurisdiction, when it reports one. */
  readonly jurisdiction: string | null;
  /** The provider's reference for this calculation, for the audit trail. */
  readonly calculationRef: string | null;
  /** ISO 8601, the provider's clock. */
  readonly computedAt: string;
}

export type TaxUnavailableReason =
  | "tax_not_configured"
  | "tax_provider_not_registered"
  | "tax_provider_unreachable"
  | "fake_not_permitted";

export type TaxFailureReason = "invalid_request" | "provider_error";

/** Every answer a tax computation can give. Never a thrown string. */
export type TaxResult =
  | { readonly status: "ok"; readonly provider: string; readonly value: TaxComputation }
  | { readonly status: "failed"; readonly provider: string; readonly reason: TaxFailureReason; readonly detail: string; readonly retriable: boolean }
  | { readonly status: "unavailable"; readonly provider: string; readonly reason: TaxUnavailableReason; readonly detail: string; readonly retriable: boolean };

export interface TaxMarketStatus {
  readonly provider: string;
  readonly market: string;
  readonly configured: boolean;
  /** Safe for server logs. Never a credential. */
  readonly reason: string;
}

export interface TaxProvider {
  readonly id: string;
  /** Is tax configured for sellers in this market? No I/O. */
  marketStatus(sellerMarket: string): TaxMarketStatus;
  /** Compute tax for one line. Answers `unavailable / tax_not_configured` for an unconfigured market. */
  computeTax(query: TaxQuery): Promise<TaxResult>;
}

const COUNTRY = /^[A-Z]{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

/** Shape check shared by every tax provider. Returns the failure, or null when the query is well formed. */
export function invalidTaxQuery(provider: string, q: TaxQuery): TaxResult | null {
  const bad = (detail: string): TaxResult => ({ status: "failed", provider, reason: "invalid_request", detail, retriable: false });
  if (typeof q !== "object" || q === null) return bad("tax query is not an object");
  if (typeof q.sellerMarket !== "string" || !COUNTRY.test(q.sellerMarket)) return bad("sellerMarket must be an ISO 3166-1 alpha-2 code in upper case");
  if (typeof q.buyerMarket !== "string" || !COUNTRY.test(q.buyerMarket)) return bad("buyerMarket must be an ISO 3166-1 alpha-2 code in upper case");
  if (!TAX_PRODUCT_KINDS.includes(q.productKind)) return bad("productKind is not one this contract knows");
  if (typeof q.currency !== "string" || !CURRENCY.test(q.currency)) return bad("currency must be an ISO 4217 code in upper case");
  if (!Number.isSafeInteger(q.amountMinor) || q.amountMinor < 0) return bad("amountMinor must be a non-negative integer of minor units");
  return null;
}

const NOT_CONFIGURED_DETAIL =
  "No tax provider is configured (TAX_PROVIDER is unset or `none`). The owner ruled that each launch country " +
  "is configured before checkout is enabled, so checkout refuses here.";

/**
 * The no-tax provider. It does not answer "zero": it answers "not configured",
 * for every market, and so no payment intent can be created behind it.
 */
export const NONE_TAX_PROVIDER: TaxProvider = Object.freeze({
  id: NONE_TAX_PROVIDER_ID,
  marketStatus: (sellerMarket: string): TaxMarketStatus => ({
    provider: NONE_TAX_PROVIDER_ID,
    market: sellerMarket,
    configured: false,
    reason: NOT_CONFIGURED_DETAIL,
  }),
  computeTax: (query: TaxQuery): Promise<TaxResult> => {
    const invalid = invalidTaxQuery(NONE_TAX_PROVIDER_ID, query);
    if (invalid) return Promise.resolve(invalid);
    return Promise.resolve({
      status: "unavailable",
      provider: NONE_TAX_PROVIDER_ID,
      reason: "tax_not_configured",
      detail: NOT_CONFIGURED_DETAIL,
      retriable: false,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// The fake — local runs only, for tests and local development
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeTaxMarket {
  /** Basis points applied to the pre-tax amount. */
  rateBps: number;
  remittedBy: TaxRemitter;
}

/**
 * FAKE DATA. These rates describe no real jurisdiction; they exist so a local
 * run exercises a non-zero platform-remitted tax (US), a seller-remitted tax
 * (GB) and a configured zero (JP). A market absent from the table is NOT
 * configured.
 */
export const FAKE_TAX_DEFAULT_MARKETS: Readonly<Record<string, FakeTaxMarket>> = Object.freeze({
  US: Object.freeze({ rateBps: 1000, remittedBy: "platform" as const }),
  GB: Object.freeze({ rateBps: 2000, remittedBy: "seller" as const }),
  JP: Object.freeze({ rateBps: 0, remittedBy: "none" as const }),
});

export interface FakeTaxProviderOptions {
  markets?: Readonly<Record<string, FakeTaxMarket>>;
  /** Read at CALL time; the fake refuses unless this env is a local run. */
  env?: NodeJS.ProcessEnv;
  /** Injectable clock (ms since epoch). Defaults to a fixed instant, so answers are deterministic. */
  now?: () => number;
}

const FAKE_TAX_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Round-half-up of amount × bps / 10000, in integers (BigInt, so a large amount cannot lose precision). */
export function taxMinorAtRate(amountMinor: number, rateBps: number): number {
  const scaled = BigInt(amountMinor) * BigInt(rateBps) + 5000n;
  return Number(scaled / 10000n);
}

/**
 * A deterministic tax provider with no I/O. Refused — every `computeTax`
 * answers `unavailable / fake_not_permitted` and every market reads as not
 * configured — in production, on a hosted deployment, and in any process with
 * no local-run signal (`fakePaymentProviderPermitted`, which is the mock
 * identity provider's rule).
 */
export function createFakeTaxProvider(options: FakeTaxProviderOptions = {}): TaxProvider {
  const markets = options.markets ?? FAKE_TAX_DEFAULT_MARKETS;
  const now = options.now ?? (() => FAKE_TAX_EPOCH_MS);
  const env = (): NodeJS.ProcessEnv => options.env ?? process.env;
  let calculations = 0;

  return Object.freeze({
    id: FAKE_TAX_PROVIDER_ID,
    marketStatus(sellerMarket: string): TaxMarketStatus {
      if (!fakePaymentProviderPermitted(env())) {
        return { provider: FAKE_TAX_PROVIDER_ID, market: sellerMarket, configured: false, reason: "the fake tax provider is refused outside a local run" };
      }
      const m = Object.prototype.hasOwnProperty.call(markets, sellerMarket) ? markets[sellerMarket] : undefined;
      return m
        ? { provider: FAKE_TAX_PROVIDER_ID, market: sellerMarket, configured: true, reason: "fake tax table (local run)" }
        : { provider: FAKE_TAX_PROVIDER_ID, market: sellerMarket, configured: false, reason: `the fake tax table has no entry for ${sellerMarket}` };
    },
    computeTax(query: TaxQuery): Promise<TaxResult> {
      if (!fakePaymentProviderPermitted(env())) {
        return Promise.resolve({
          status: "unavailable",
          provider: FAKE_TAX_PROVIDER_ID,
          reason: "fake_not_permitted",
          detail: "the fake tax provider is refused in production, on a hosted deployment, and without a local-run signal",
          retriable: false,
        });
      }
      const invalid = invalidTaxQuery(FAKE_TAX_PROVIDER_ID, query);
      if (invalid) return Promise.resolve(invalid);
      const m = Object.prototype.hasOwnProperty.call(markets, query.sellerMarket) ? markets[query.sellerMarket] : undefined;
      if (!m) {
        return Promise.resolve({
          status: "unavailable",
          provider: FAKE_TAX_PROVIDER_ID,
          reason: "tax_not_configured",
          detail: `tax is not configured for sellers in ${query.sellerMarket}`,
          retriable: false,
        });
      }
      // A tip is a gift to the seller in this fake: never taxed, whatever the market's rate.
      const rateBps = query.productKind === "tip" ? 0 : m.rateBps;
      const taxMinor = taxMinorAtRate(query.amountMinor, rateBps);
      calculations += 1;
      return Promise.resolve({
        status: "ok",
        provider: FAKE_TAX_PROVIDER_ID,
        value: Object.freeze({
          provider: FAKE_TAX_PROVIDER_ID,
          configured: true as const,
          sellerMarket: query.sellerMarket,
          buyerMarket: query.buyerMarket,
          productKind: query.productKind,
          taxableMinor: query.amountMinor,
          taxMinor,
          currency: query.currency,
          remittedBy: taxMinor === 0 ? ("none" as const) : m.remittedBy,
          rateBps,
          jurisdiction: `FAKE-${query.sellerMarket}`,
          calculationRef: `fake_taxcalc_${String(calculations).padStart(6, "0")}`,
          computedAt: new Date(now()).toISOString(),
        }),
      });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Configured tax provider name, trimmed and lowercased. Default `none`. */
export function configuredTaxProvider(env: NodeJS.ProcessEnv = process.env): string {
  const name = (env[TAX_PROVIDER_ENV] ?? "").trim().toLowerCase();
  return name === "" ? NONE_TAX_PROVIDER_ID : name;
}

export type TaxProviderResolution =
  | { readonly ok: true; readonly name: string; readonly provider: TaxProvider }
  | { readonly ok: false; readonly name: string; readonly reason: TaxUnavailableReason; readonly detail: string };

let sharedFakeTaxProvider: TaxProvider | null = null;

/**
 * The tax provider in use. `none` (the default) and — in a local run only —
 * `fake` resolve; ANY other name is refused, because no real tax provider has
 * been chosen or written. A real one is added here, beside a per-market
 * configuration the owner has approved; it is not added by setting an env var.
 */
export function resolveTaxProvider(env: NodeJS.ProcessEnv = process.env): TaxProviderResolution {
  const name = configuredTaxProvider(env);
  if (name === NONE_TAX_PROVIDER_ID) return { ok: true, name, provider: NONE_TAX_PROVIDER };
  if (name === FAKE_TAX_PROVIDER_ID) {
    if (!fakePaymentProviderPermitted(env)) {
      return {
        ok: false,
        name,
        reason: "fake_not_permitted",
        detail: "TAX_PROVIDER=fake is refused in production, on a hosted deployment, and without a local-run signal (NODE_ENV=development|test, or node --test)",
      };
    }
    sharedFakeTaxProvider ??= createFakeTaxProvider();
    return { ok: true, name, provider: sharedFakeTaxProvider };
  }
  return {
    ok: false,
    name,
    reason: "tax_provider_not_registered",
    detail: `tax provider ${JSON.stringify(name)} is not registered; choosing one, and configuring each launch country, is an owner decision`,
  };
}

/** The resolved provider, or `none` when the configured one is refused. A refused provider configures no market. */
export function taxProviderOrNone(env: NodeJS.ProcessEnv = process.env): TaxProvider {
  const r = resolveTaxProvider(env);
  return r.ok ? r.provider : NONE_TAX_PROVIDER;
}
