/**
 * Builders shared by the payment-provider suites (paymentProviderContract,
 * fakePaymentProvider, fakePaymentProviderWebhooks, paymentProviderRegistry).
 *
 * Nothing here talks to anything: the tax lines come from the fake tax
 * provider, the recipients from the fake payment provider, and every env is an
 * object the test passes in. The numbers are arbitrary and say nothing about
 * what Portava charges.
 */

import assert from "node:assert/strict";

import { FAKE_CAPABILITIES, type FakePaymentProvider } from "../../services/payments/FakePaymentProvider.js";
import {
  PAYMENT_PROVIDER_OPERATIONS,
  paymentOk,
  type CaptureMethod,
  type ChargeModel,
  type CreatePaymentIntentRequest,
  type MarketQuery,
  type MarketSupport,
  type PaymentIntentSnapshot,
  type PaymentProvider,
  type PaymentProviderOperation,
  type PaymentResult,
  type PaymentWebhookEvent,
  type PayoutSnapshot,
  type PlatformFee,
  type RecipientSnapshot,
  type RefundSnapshot,
} from "../../services/payments/PaymentProvider.js";
import { createFakeTaxProvider, type TaxComputation, type TaxProductKind, type TaxProvider } from "../../services/payments/TaxProvider.js";

/** An env with positive evidence of a local run — what the fake needs. */
export const LOCAL_ENV = Object.freeze({ NODE_ENV: "test" }) as unknown as NodeJS.ProcessEnv;

/** Envs in which the fake must be refused, with why. */
export const REFUSED_ENVS: ReadonlyArray<readonly [string, NodeJS.ProcessEnv]> = [
  ["NODE_ENV=production", { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv],
  ["REPLIT_DEPLOYMENT set under NODE_ENV=development", { NODE_ENV: "development", REPLIT_DEPLOYMENT: "1" } as unknown as NodeJS.ProcessEnv],
  ["REPLIT_DEPLOYMENT set under node --test", { NODE_TEST_CONTEXT: "child-v8", REPLIT_DEPLOYMENT: "1" } as unknown as NodeJS.ProcessEnv],
  ["REPLIT_DEPLOYMENT defined but EMPTY under NODE_ENV=development", { NODE_ENV: "development", REPLIT_DEPLOYMENT: "" } as unknown as NodeJS.ProcessEnv],
  ["a bare start with no NODE_ENV", {} as NodeJS.ProcessEnv],
];

export interface ChargeSpec {
  key: string;
  recipientRef: string | null;
  sellerMarket?: string;
  buyerMarket?: string;
  currency?: string;
  serviceMinor?: number;
  tipMinor?: number;
  payerFeeMinor?: number;
  /** The platform's commission, as an amount. Default: 10% of the service component. */
  commissionMinor?: number;
  chargeModel?: ChargeModel;
  capture?: CaptureMethod;
  tax?: TaxProvider;
  referenceId?: string;
}

export const fakeTax = (): TaxProvider => createFakeTaxProvider({ env: LOCAL_ENV });

async function taxLine(tax: TaxProvider, sellerMarket: string, buyerMarket: string, productKind: TaxProductKind, amountMinor: number, currency: string): Promise<TaxComputation> {
  const r = await tax.computeTax({ sellerMarket, buyerMarket, productKind, amountMinor, currency });
  assert.equal(r.status, "ok", `tax line ${productKind}: ${JSON.stringify(r)}`);
  if (r.status !== "ok") throw new Error("unreachable");
  return r.value;
}

/**
 * A well-formed create-intent request: components that sum to the amount, a tax
 * computation for every pre-tax component, and a platform fee made of the
 * commission, the payer fee and the tax the platform remits.
 */
export async function buildCharge(spec: ChargeSpec): Promise<CreatePaymentIntentRequest> {
  const sellerMarket = spec.sellerMarket ?? "US";
  const buyerMarket = spec.buyerMarket ?? "US";
  const currency = spec.currency ?? "USD";
  const serviceMinor = spec.serviceMinor ?? 10_000;
  const tipMinor = spec.tipMinor ?? 0;
  const payerFeeMinor = spec.payerFeeMinor ?? 0;
  const chargeModel = spec.chargeModel ?? "direct";
  const tax = spec.tax ?? fakeTax();

  const lines: TaxComputation[] = [await taxLine(tax, sellerMarket, buyerMarket, "service", serviceMinor, currency)];
  if (payerFeeMinor > 0) lines.push(await taxLine(tax, sellerMarket, buyerMarket, "platform_fee", payerFeeMinor, currency));
  if (tipMinor > 0) lines.push(await taxLine(tax, sellerMarket, buyerMarket, "tip", tipMinor, currency));
  const taxMinor = lines.reduce((s, l) => s + l.taxMinor, 0);
  const platformTaxMinor = lines.filter((l) => l.remittedBy === "platform").reduce((s, l) => s + l.taxMinor, 0);

  const platformFee: PlatformFee =
    chargeModel === "platform"
      ? { commissionMinor: 0, payerFeeMinor: 0, taxMinor: 0 }
      : { commissionMinor: spec.commissionMinor ?? Math.floor(serviceMinor / 10), payerFeeMinor, taxMinor: platformTaxMinor };

  return {
    idempotencyKey: spec.key,
    reference: { kind: "rent_buddy_booking", id: spec.referenceId ?? `booking-${spec.key}` },
    payerProfileId: "payer-profile-1",
    payerCountry: buyerMarket,
    amount: { amountMinor: serviceMinor + payerFeeMinor + tipMinor + taxMinor, currency },
    components: { serviceMinor, payerFeeMinor, tipMinor, taxMinor },
    chargeModel,
    recipientRef: chargeModel === "platform" ? null : spec.recipientRef,
    recipientCountry: chargeModel === "platform" ? null : sellerMarket,
    platformFee,
    capture: spec.capture ?? "automatic",
    tax: lines,
  };
}

/** Create a recipient and take them through onboarding to `verified`. Returns the provider's account ref. */
export async function verifiedRecipient(
  fake: FakePaymentProvider,
  opts: { key: string; country?: string; settlementCurrency?: string; profileId?: string } = { key: "rcpt-1" },
): Promise<string> {
  const created = await fake.createRecipient({
    idempotencyKey: opts.key,
    profileId: opts.profileId ?? `profile-${opts.key}`,
    country: opts.country ?? "US",
    entityType: "individual",
    settlementCurrency: opts.settlementCurrency ?? "USD",
    returnUrl: "travelbuddy://payouts/onboarding/return",
    refreshUrl: "travelbuddy://payouts/onboarding/refresh",
  });
  assert.equal(created.status, "requires_action", JSON.stringify(created));
  if (created.status !== "requires_action") throw new Error("unreachable");
  fake.control.setRecipientOnboarding(created.value.recipientRef, "verified");
  return created.value.recipientRef;
}

/** Narrow a result to `ok` (failing the test with the whole answer otherwise) and return its value. */
export function okValue<T>(r: PaymentResult<T>, what = "result"): T {
  assert.equal(r.status, "ok", `${what}: ${JSON.stringify(r)}`);
  if (r.status !== "ok") throw new Error("unreachable");
  return r.value;
}

/** `[status, reason]` of any answer; `ok` has no reason. */
export function tag(r: PaymentResult<unknown>): [string, string | null] {
  return [r.status, r.status === "ok" ? null : r.reason];
}

/** Every ordering of a small array. */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

// ── A stand-in adapter that answers with well-formed values ──────────────────

const AT = "2026-01-01T00:00:10.000Z";

export function sampleIntent(overrides: Partial<PaymentIntentSnapshot> = {}): PaymentIntentSnapshot {
  return {
    intentRef: "pi_1",
    chargeModel: "direct",
    recipientRef: "acct_1",
    reference: { kind: "rent_buddy_booking", id: "b1" },
    state: "requires_capture",
    amount: { amountMinor: 11_000, currency: "USD" },
    components: { serviceMinor: 10_000, payerFeeMinor: 0, tipMinor: 0, taxMinor: 1000 },
    platformFee: { commissionMinor: 1000, payerFeeMinor: 0, taxMinor: 1000 },
    capture: "manual",
    amountCapturableMinor: 11_000,
    amountCapturedMinor: 0,
    amountRefundedMinor: 0,
    platformFeeCollectedMinor: 0,
    platformFeeRefundedMinor: 0,
    settlement: null,
    clientSecret: null,
    livemode: false,
    updatedAt: AT,
    ...overrides,
  };
}

export const sampleRecipient = (overrides: Partial<RecipientSnapshot> = {}): RecipientSnapshot => ({
  recipientRef: "acct_1", profileId: "p1", country: "US", settlementCurrency: "USD", onboarding: "verified", chargesEnabled: true, payoutsEnabled: true,
  requirementsDue: [], requirementsDeadline: null, disabledReason: null, livemode: false, updatedAt: AT, ...overrides,
});

export const samplePayout = (overrides: Partial<PayoutSnapshot> = {}): PayoutSnapshot => ({
  payoutRef: "po_1", kind: "payout", recipientRef: "acct_1", reference: { kind: "run", id: "1" }, state: "pending", amount: { amountMinor: 100, currency: "USD" },
  amountReversedMinor: 0, settlement: null, failureCode: null, expectedArrivalAt: null, livemode: false, updatedAt: AT, ...overrides,
});

const sampleRefund: RefundSnapshot = {
  refundRef: "re_1", intentRef: "pi_1", recipientRef: "acct_1", state: "succeeded", amount: { amountMinor: 100, currency: "USD" }, platformFeeRefundedMinor: 0,
  fullyRefunded: false, reason: "duplicate", livemode: false, updatedAt: AT,
};

/** A well-formed request for each of the thirteen operations, addressed at `sampleIntent` / `sampleRecipient`. */
export async function sampleRequests(): Promise<Record<PaymentProviderOperation, unknown>> {
  const intent = { intentRef: "pi_1", chargeModel: "direct" as const, recipientRef: "acct_1" };
  const payout = { payoutRef: "po_1", kind: "payout" as const, recipientRef: "acct_1" };
  return {
    createPaymentIntent: await buildCharge({ key: "k-create", recipientRef: "acct_1" }),
    confirmPaymentIntent: { idempotencyKey: "k1", intent, paymentMethodRef: null, returnUrl: null },
    capturePaymentIntent: { idempotencyKey: "k2", intent, amountMinor: "full", partial: null },
    cancelPaymentIntent: { idempotencyKey: "k3", intent, reason: "abandoned" },
    getPaymentIntent: intent,
    refundPayment: { idempotencyKey: "k4", intent, amountMinor: "full", reason: "provider_cancelled", refundPlatformFee: true, reverseTransfer: false },
    createRecipient: { idempotencyKey: "k5", profileId: "p", country: "US", entityType: "individual", settlementCurrency: "USD", returnUrl: "a://b", refreshUrl: "a://c" },
    createRecipientOnboardingLink: { idempotencyKey: "k8", recipientRef: "acct_1", returnUrl: "a://b", refreshUrl: "a://c" },
    validateRecipient: "acct_1",
    requestPayout: { idempotencyKey: "k6", kind: "payout", recipientRef: "acct_1", amount: { amountMinor: 100, currency: "USD" }, reference: { kind: "payout", id: "1" } },
    getPayoutStatus: payout,
    reverseOrHoldPayout: { idempotencyKey: "k7", payout, action: "hold", amountMinor: "full" },
    verifyAndParseWebhook: { rawBody: "{}", headers: {}, endpoint: "platform" },
  };
}

/** Call all thirteen operations with well-formed requests. `requests` overrides the samples. */
export async function callEveryOperation(p: PaymentProvider, requests?: Partial<Record<PaymentProviderOperation, unknown>>): Promise<Array<[PaymentProviderOperation, PaymentResult<unknown>]>> {
  const all = { ...(await sampleRequests()), ...(requests ?? {}) };
  const out: Array<[PaymentProviderOperation, PaymentResult<unknown>]> = [];
  for (const op of PAYMENT_PROVIDER_OPERATIONS) out.push([op, await (p as unknown as Record<string, (a: unknown) => Promise<PaymentResult<unknown>>>)[op]!(all[op])]);
  return out;
}

export interface ConformingAdapter {
  readonly provider: PaymentProvider;
  /** The OPERATIONS that reached the adapter, in order. `capabilities()` and `marketSupport()` make no request and are not recorded. */
  readonly reached: string[];
  /** The next operation call throws this. */
  throwNext(e: unknown): void;
  /** The next operation call resolves to this instead of a well-formed result. */
  answerNext(v: unknown): void;
}

/**
 * An adapter that keeps the contract: every operation answers `ok` with a
 * well-formed value, it supports recipients in the US by direct charge, and it
 * records every call that reaches it.
 */
export function conformingAdapter(id = "stripe"): ConformingAdapter {
  const reached: string[] = [];
  let toThrow: { e: unknown } | null = null;
  let toAnswer: { v: unknown } | null = null;
  const event: PaymentWebhookEvent = { provider: id, providerEventId: "evt_1", endpoint: "platform", providerEventType: "x", livemode: false, occurredAt: AT, accountRef: null, body: { kind: "ignored" } };
  const values: Record<PaymentProviderOperation, unknown> = {
    createPaymentIntent: sampleIntent({ state: "requires_confirmation", amountCapturableMinor: 0 }),
    confirmPaymentIntent: sampleIntent(),
    capturePaymentIntent: sampleIntent({ state: "succeeded", amountCapturableMinor: 0, amountCapturedMinor: 11_000 }),
    cancelPaymentIntent: sampleIntent({ state: "canceled", amountCapturableMinor: 0 }),
    getPaymentIntent: sampleIntent(),
    refundPayment: sampleRefund,
    createRecipient: sampleRecipient(),
    createRecipientOnboardingLink: { recipientRef: "acct_1", url: "https://provider.invalid/onboard", expiresAt: AT },
    validateRecipient: sampleRecipient(),
    requestPayout: samplePayout(),
    getPayoutStatus: samplePayout(),
    reverseOrHoldPayout: samplePayout({ state: "on_hold" }),
    verifyAndParseWebhook: event,
  };
  const provider = {
    id,
    capabilities: () => ({ ...FAKE_CAPABILITIES, chargeModels: ["direct"] as const }),
    marketSupport: (q: MarketQuery): MarketSupport => {
      const supported = q.recipientCountry === "US";
      return { provider: id, recipientCountry: q.recipientCountry, supported, chargeModels: supported ? ["direct"] : [], settlementCurrencies: supported ? ["USD"] : [], presentmentCurrencySupported: q.presentmentCurrency == null ? null : supported, reason: supported ? "supported" : "country_not_supported" };
    },
  } as unknown as Record<string, unknown>;
  for (const op of PAYMENT_PROVIDER_OPERATIONS) {
    provider[op] = async () => {
      reached.push(op);
      if (toThrow) { const { e } = toThrow; toThrow = null; throw e; }
      if (toAnswer) { const { v } = toAnswer; toAnswer = null; return v; }
      return paymentOk(id, values[op]);
    };
  }
  return { provider: provider as unknown as PaymentProvider, reached, throwNext: (e) => { toThrow = { e }; }, answerNext: (v) => { toAnswer = { v }; } };
}
