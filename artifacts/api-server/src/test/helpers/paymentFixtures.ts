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

import type { FakePaymentProvider } from "../../services/payments/FakePaymentProvider.js";
import type {
  CaptureMethod,
  ChargeModel,
  CreatePaymentIntentRequest,
  PaymentResult,
  PlatformFee,
} from "../../services/payments/PaymentProvider.js";
import { createFakeTaxProvider, type TaxComputation, type TaxProductKind, type TaxProvider } from "../../services/payments/TaxProvider.js";

/** An env with positive evidence of a local run — what the fake needs. */
export const LOCAL_ENV = Object.freeze({ NODE_ENV: "test" }) as unknown as NodeJS.ProcessEnv;

/** Envs in which the fake must be refused, with why. */
export const REFUSED_ENVS: ReadonlyArray<readonly [string, NodeJS.ProcessEnv]> = [
  ["NODE_ENV=production", { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv],
  ["REPLIT_DEPLOYMENT set under NODE_ENV=development", { NODE_ENV: "development", REPLIT_DEPLOYMENT: "1" } as unknown as NodeJS.ProcessEnv],
  ["REPLIT_DEPLOYMENT set under node --test", { NODE_TEST_CONTEXT: "child-v8", REPLIT_DEPLOYMENT: "1" } as unknown as NodeJS.ProcessEnv],
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
