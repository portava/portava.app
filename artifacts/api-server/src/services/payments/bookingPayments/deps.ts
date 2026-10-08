/**
 * What the Rent-a-Buddy payment slice needs, as one injectable bundle, and the
 * tagged answer every operation in it gives an HTTP route.
 */
import type { PaymentProvider } from "../PaymentProvider.js";
import type { TaxProvider } from "../TaxProvider.js";
import type { BookingPartyEligibility } from "../../../lib/rentBuddyIdentityEligibility.js";
import type { BookingForPayment, BookingPaymentStore } from "./model.js";
import type { PaymentLedgerPort } from "./ledgerPostings.js";

export interface PaymentSliceDeps {
  /** The configured provider, already guarded and policy-wrapped by providerRegistry.ts. */
  readonly provider: PaymentProvider;
  /** The registered tax provider (TaxProvider.taxProviderOrNone). */
  readonly tax: TaxProvider;
  readonly store: BookingPaymentStore;
  readonly ledger: PaymentLedgerPort;
  /** services/payments/readiness.ts — payment, key, certification, markets and tax, all at once. */
  readonly paymentsOperational: () => { readonly operational: boolean; readonly reason: string };
  /** Both people: current REAL identity, adult, not restricted (lib/rentBuddyIdentityEligibility.ts). */
  readonly bookingParties: (booking: BookingForPayment) => Promise<BookingPartyEligibility>;
  /** Current identity verification of one person, for payout eligibility. */
  readonly personVerified: (userId: string) => Promise<"verified" | "not_verified" | "unreadable">;
  readonly newId: () => string;
  readonly now: () => Date;
}

/** What an operation answers. `httpStatus` is the route's; `body` is safe to return as-is. */
export interface SliceOutcome<B = Record<string, unknown>> {
  readonly httpStatus: number;
  readonly body: B;
}

export function outcome<B extends Record<string, unknown>>(httpStatus: number, body: B): SliceOutcome<B> {
  return { httpStatus, body };
}

/** The user-facing refusal shape every route in the slice uses. Never a provider detail, key or raw config. */
export function refusal(httpStatus: number, error: string, message: string, extra: Record<string, unknown> = {}): SliceOutcome {
  return { httpStatus, body: { error, message, ...extra } };
}
