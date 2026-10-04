/**
 * PaymentProvider — the one provider-agnostic contract between Portava and
 * whatever charges, refunds, onboards and pays out.
 *
 * `09_Payment_Architecture.md` §9 named a six-operation payout interface and
 * §11 recorded that no processor was chosen. The owner has since ruled
 * (2026-10-04, "Payments and creator economy"); this contract is built to those
 * rulings and to nothing more:
 *
 *   • "Use Stripe Connect in test mode as the first integration, behind a
 *     payment-provider interface. Don't treat Stripe as worldwide coverage."
 *       → nothing in any signature below names a processor; every provider
 *         answers `capabilities()` and a per-country `marketSupport()`, and an
 *         unsupported market is an `unavailable` answer, never a guess.
 *   • "Make the service provider the seller for their service and, where
 *     supported, use a direct-charge model."
 *       → `chargeModel: "direct"` charges ON THE RECIPIENT'S ACCOUNT with a
 *         SEPARATE platform fee amount (`platformFee`). A provider or market
 *         that cannot do that says so in its capability flags, and
 *         `selectChargeModel` REFUSES by default rather than quietly falling
 *         back to a model in which the platform is the seller.
 *   • "10% platform commission on the pre-tax service price … no platform
 *     commission on tips … keep them configurable by product and market."
 *       → the contract carries NO rate. The caller states the fee as amounts;
 *         the contract only enforces the two structural facts the ruling makes
 *         rate-independent: commission is bounded by the pre-tax SERVICE
 *         component, and there is no field through which a tip could carry one.
 *   • "Store the original transaction currency and amount, plus any conversion
 *     details; don't assume one currency or payout method works globally."
 *       → every snapshot carries the ORIGINAL `amount` (integer minor units +
 *         ISO 4217) and, once the provider reports it, a `SettlementDetails`
 *         with the settled amount and the rate actually applied, its source and
 *         its timestamp (`09` §8: a settlement rate is not a display rate).
 *   • "Add a tax-provider interface and configure each launch country before
 *     enabling checkout."
 *       → `createPaymentIntent` REQUIRES the `TaxComputation`s for the charge
 *         (TaxProvider.ts); without them the answer is
 *         `unavailable / tax_not_configured`.
 *   • "Keep payments in test mode until payment, identity, and tax readiness
 *     are established."
 *       → a live or unrecognised key, and a `livemode: true` event, are refused
 *         by `lib/paymentsMode.ts` before any request (providerRegistry.ts).
 *
 * ── EVERY ANSWER IS A TAGGED RESULT ─────────────────────────────────────────
 *   ok               the operation happened as asked
 *   declined         the payer's bank, the provider's risk rules or the
 *                    recipient's standing said no; nothing moved
 *   requires_action  a person must do something first (authenticate a payment,
 *                    finish onboarding); `action` says what
 *   failed           the request was wrong or the provider rejected it
 *                    (`retriable` says whether the same request may be re-sent)
 *   unavailable      this cannot be done here and now: no provider chosen, key
 *                    refused, market or charge model unsupported, tax not
 *                    configured, provider unreachable
 * Each non-ok answer carries a machine `reason` from a closed union and a
 * `detail` for the server log. Nothing is thrown: `guardPaymentProvider` wraps
 * every adapter so that even a bug in one surfaces as `failed / provider_error`.
 * `detail` never carries a key, a signature or a request body.
 *
 * ── AMOUNTS ─────────────────────────────────────────────────────────────────
 * Integer minor units and an upper-case ISO 4217 code, always together
 * (`Money`). No float crosses this boundary. A provider that needs a currency's
 * exponent (zero-decimal currencies) owns that table; the contract does not
 * convert.
 *
 * ── WHAT THIS FILE IS NOT ────────────────────────────────────────────────────
 * It is not the ledger and the ledger must not import it (pinned by
 * `test/paymentProviderArchitecture.test.ts`). It records nothing, decides no
 * fee, and holds no credential. The Stripe adapter is PAY-T04 and is not here;
 * the adapter-author checklist is in providerRegistry.ts.
 */

import { isPaymentsLiveModeRefusal } from "../../lib/paymentsMode.js";
import type { TaxComputation } from "./TaxProvider.js";

// ─────────────────────────────────────────────────────────────────────────────
// Money
// ─────────────────────────────────────────────────────────────────────────────

/** An amount in integer minor units with its ISO 4217 currency (upper case). */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

const CURRENCY_CODE = /^[A-Z]{3}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;

export function isCurrencyCode(v: unknown): v is string {
  return typeof v === "string" && CURRENCY_CODE.test(v);
}

export function isCountryCode(v: unknown): v is string {
  return typeof v === "string" && COUNTRY_CODE.test(v);
}

/** A non-negative safe integer: the only number this contract accepts as an amount. */
export function isMinorUnits(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

export function isMoney(v: unknown): v is Money {
  if (typeof v !== "object" || v === null) return false;
  const m = v as { amountMinor?: unknown; currency?: unknown };
  return isMinorUnits(m.amountMinor) && isCurrencyCode(m.currency);
}

/**
 * What landed on the receiving balance, and how it got there.
 *
 * `conversion` is null when presentment and settlement currency are the same.
 * When they differ it is the rate the PROVIDER applied — a decimal string, so
 * no float is involved — with where the rate came from and when (`09` §8). The
 * original amount is never overwritten: it stays on the snapshot's `amount`.
 */
export interface SettlementDetails {
  readonly settled: Money;
  readonly conversion: CurrencyConversion | null;
}

export interface CurrencyConversion {
  readonly fromCurrency: string;
  readonly toCurrency: string;
  /** Units of `toCurrency` per one unit of `fromCurrency`, in MAJOR units, as a decimal string. */
  readonly rate: string;
  /** Who set the rate, e.g. the provider's name. Never `fx_rates` reference data. */
  readonly rateSource: string;
  /** ISO 8601 instant the rate was applied. */
  readonly rateAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tagged results
// ─────────────────────────────────────────────────────────────────────────────

export type DeclineReason =
  | "card_declined"
  | "insufficient_funds"
  | "authentication_failed"
  | "payment_method_expired"
  | "fraud_suspected"
  | "recipient_not_eligible"
  | "recipient_rejected"
  | "insufficient_balance"
  | "declined_other";

export type ActionReason =
  | "payer_authentication_required"
  | "payment_method_required"
  | "recipient_onboarding_required"
  | "recipient_verification_pending";

export type FailureReason =
  | "invalid_request"
  | "invalid_amount"
  | "invalid_currency"
  | "currency_mismatch"
  | "fee_exceeds_commissionable_amount"
  | "amount_exceeds_capturable"
  | "amount_exceeds_refundable"
  | "not_found"
  | "illegal_state"
  | "idempotency_conflict"
  | "payout_rejected"
  | "signature_invalid"
  | "webhook_malformed"
  | "provider_error";

export type UnavailableReason =
  | "payments_disabled"
  | "provider_not_registered"
  | "provider_not_certified"
  | "fake_not_permitted"
  | "key_absent"
  | "live_key_not_allowed"
  | "unknown_key_prefix"
  | "livemode_not_allowed"
  | "webhook_secret_not_configured"
  | "unsupported_market"
  | "unsupported_currency"
  | "charge_model_not_supported"
  | "capability_not_supported"
  | "tax_not_configured"
  | "provider_unreachable"
  | "rate_limited";

/** What a person must do before the operation can complete. */
export type RequiredAction =
  | {
      /** The payer must authenticate (e.g. a bank challenge). The client completes it with `clientSecret`. */
      readonly kind: "payer_authentication";
      readonly clientSecret: string;
      readonly redirectUrl: string | null;
    }
  | {
      /** The payer must supply (another) payment method. */
      readonly kind: "payment_method";
      readonly clientSecret: string;
    }
  | {
      /** The recipient must complete the provider's hosted onboarding. */
      readonly kind: "recipient_onboarding";
      /** A fresh hosted-onboarding URL when the provider returned one; else request one with `createRecipientOnboardingLink`. */
      readonly url: string | null;
      /** The provider's requirement CODES. Never a document, a number or a date of birth. */
      readonly requirementsDue: readonly string[];
    };

export type PaymentOk<T> = { readonly status: "ok"; readonly provider: string; readonly value: T };
export type PaymentDeclined<T> = {
  readonly status: "declined";
  readonly provider: string;
  readonly reason: DeclineReason;
  readonly detail: string;
  /** The object's state after the decline, when there is one. */
  readonly value: T | null;
};
export type PaymentRequiresAction<T> = {
  readonly status: "requires_action";
  readonly provider: string;
  readonly reason: ActionReason;
  readonly detail: string;
  readonly action: RequiredAction;
  readonly value: T;
};
export type PaymentFailed = {
  readonly status: "failed";
  readonly provider: string;
  readonly reason: FailureReason;
  readonly detail: string;
  /** May the SAME request (same idempotency key) be sent again? */
  readonly retriable: boolean;
};
export type PaymentUnavailable = {
  readonly status: "unavailable";
  readonly provider: string;
  readonly reason: UnavailableReason;
  readonly detail: string;
  readonly retriable: boolean;
};

/** A non-ok answer that carries no value: what validation and guards produce. */
export type PaymentRefusal = PaymentFailed | PaymentUnavailable;

/** Every answer a provider operation can give. */
export type PaymentResult<T> = PaymentOk<T> | PaymentDeclined<T> | PaymentRequiresAction<T> | PaymentFailed | PaymentUnavailable;

export type PaymentResultStatus = PaymentResult<unknown>["status"];

export const PAYMENT_RESULT_STATUSES: readonly PaymentResultStatus[] = ["ok", "declined", "requires_action", "failed", "unavailable"];

export function paymentOk<T>(provider: string, value: T): PaymentOk<T> {
  return { status: "ok", provider, value };
}
export function paymentDeclined<T>(provider: string, reason: DeclineReason, detail: string, value: T | null = null): PaymentDeclined<T> {
  return { status: "declined", provider, reason, detail, value };
}
export function paymentRequiresAction<T>(provider: string, reason: ActionReason, detail: string, action: RequiredAction, value: T): PaymentRequiresAction<T> {
  return { status: "requires_action", provider, reason, detail, action, value };
}
export function paymentFailed(provider: string, reason: FailureReason, detail: string, retriable = false): PaymentFailed {
  return { status: "failed", provider, reason, detail, retriable };
}
export function paymentUnavailable(provider: string, reason: UnavailableReason, detail: string, retriable = false): PaymentUnavailable {
  return { status: "unavailable", provider, reason, detail, retriable };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities and markets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the charge is created, and so who the seller of record on the charge is.
 *
 *   direct       the charge is created ON THE RECIPIENT'S ACCOUNT; the recipient
 *                is the seller; the platform takes `platformFee` as a separate
 *                amount. The owner's ruling, "where supported".
 *   destination  the charge is created on the platform's account and the funds
 *                are routed to the recipient less the platform fee. The platform
 *                is the seller on the charge. NOT used unless a caller opts in
 *                (`selectChargeModel`).
 *   platform     the charge is the platform's own (no recipient). For revenue
 *                that has no service provider behind it.
 *
 * The charge model affects who the provider debits for fees, refunds and
 * disputes. It does not settle who the legal merchant of record is in a given
 * country — the owner's ruling says so in as many words.
 */
export type ChargeModel = "direct" | "destination" | "platform";

export const CHARGE_MODELS: readonly ChargeModel[] = ["direct", "destination", "platform"];

/** What a provider can do at all. Static; no I/O. A market may narrow it further (`MarketSupport`). */
export interface PaymentProviderCapabilities {
  /** Charge models this provider implements. Empty means it cannot charge. */
  readonly chargeModels: readonly ChargeModel[];
  /** Authorise now, capture later. */
  readonly manualCapture: boolean;
  /** Capture less than was authorised. */
  readonly partialCapture: boolean;
  readonly partialRefund: boolean;
  /** Return the platform's fee (in proportion) when a charge is refunded. */
  readonly platformFeeRefund: boolean;
  /** Onboard recipients as connected accounts. */
  readonly connectedAccounts: boolean;
  /** Move platform funds to a recipient's provider balance. */
  readonly transfers: boolean;
  /** Pay a recipient's provider balance out to their bank. */
  readonly payouts: boolean;
  readonly payoutHold: boolean;
  readonly payoutReversal: boolean;
  /** Charge in the payer's currency and settle in the recipient's. */
  readonly currencyConversion: boolean;
  /** Webhooks are signed and `verifyAndParseWebhook` verifies them. */
  readonly signedWebhooks: boolean;
}

export const NO_PAYMENT_CAPABILITIES: PaymentProviderCapabilities = Object.freeze({
  chargeModels: Object.freeze([]) as readonly ChargeModel[],
  manualCapture: false,
  partialCapture: false,
  partialRefund: false,
  platformFeeRefund: false,
  connectedAccounts: false,
  transfers: false,
  payouts: false,
  payoutHold: false,
  payoutReversal: false,
  currencyConversion: false,
  signedWebhooks: false,
});

export interface MarketQuery {
  /** ISO 3166-1 alpha-2 of the country the RECIPIENT (the seller) is established in. */
  readonly recipientCountry: string;
  /** The currency the payer would be charged in, when known. */
  readonly presentmentCurrency?: string | null;
}

export type MarketSupportReason = "supported" | "country_not_supported" | "currency_not_supported" | "no_provider";

/**
 * A provider's answer for ONE country. `supported: false` is a first-class
 * answer — the owner ruled that no single provider is to be represented as
 * universal, so every caller asks before it offers payment in a market.
 */
export interface MarketSupport {
  readonly provider: string;
  readonly recipientCountry: string;
  /** A recipient in this country can be onboarded, charged for and paid out. */
  readonly supported: boolean;
  /** Charge models available for recipients in this country. May be narrower than the provider's. */
  readonly chargeModels: readonly ChargeModel[];
  /** Currencies a recipient in this country can be settled in. */
  readonly settlementCurrencies: readonly string[];
  /** Whether `presentmentCurrency` can be charged here; null when the query named none. */
  readonly presentmentCurrencySupported: boolean | null;
  readonly reason: MarketSupportReason;
}

export function unsupportedMarket(provider: string, query: MarketQuery, reason: MarketSupportReason): MarketSupport {
  return {
    provider,
    recipientCountry: query.recipientCountry,
    supported: false,
    chargeModels: [],
    settlementCurrencies: [],
    presentmentCurrencySupported: query.presentmentCurrency == null ? null : false,
    reason,
  };
}

/**
 * What to do when the direct-charge model is not available for a recipient.
 *
 *   refuse       (default) answer `charge_model_not_supported`. The owner ruled
 *                "where supported, use a direct-charge model" and did not rule
 *                on what replaces it elsewhere; a different model changes who
 *                the seller on the charge is and who the provider debits for
 *                refunds and disputes, so it is not chosen on the owner's behalf.
 *   destination  use destination charges where the provider and market offer
 *                them. Only a caller acting on an owner ruling passes this.
 */
export type ChargeModelFallback = "refuse" | "destination";

export type ChargeModelSelection =
  | { readonly ok: true; readonly chargeModel: ChargeModel }
  | { readonly ok: false; readonly reason: "unsupported_market" | "charge_model_not_supported"; readonly detail: string };

/** Pick the charge model for a recipient: direct where the provider AND the market offer it. */
export function selectChargeModel(
  capabilities: PaymentProviderCapabilities,
  market: MarketSupport,
  fallback: ChargeModelFallback = "refuse",
): ChargeModelSelection {
  if (!market.supported) {
    return { ok: false, reason: "unsupported_market", detail: `${market.provider} does not support recipients in ${market.recipientCountry} (${market.reason})` };
  }
  const offers = (m: ChargeModel) => capabilities.chargeModels.includes(m) && market.chargeModels.includes(m);
  if (offers("direct")) return { ok: true, chargeModel: "direct" };
  if (fallback === "destination" && offers("destination")) return { ok: true, chargeModel: "destination" };
  return {
    ok: false,
    reason: "charge_model_not_supported",
    detail: `${market.provider} cannot create direct charges for recipients in ${market.recipientCountry}, and no fallback model is permitted`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment intents
// ─────────────────────────────────────────────────────────────────────────────

/** The platform's own subject for a payment — a booking, a tip. Never a processor id. */
export interface PaymentReference {
  readonly kind: string;
  readonly id: string;
}

/**
 * What the payer's total is made of. The four parts sum to `amount.amountMinor`
 * exactly; a request whose parts do not add up is refused, so no residual cent
 * can be created at this boundary (`09` §8 "rounding is booked, not dropped").
 */
export interface AmountComponents {
  /** The pre-tax price of the service. The ONLY component a commission may be taken from. */
  readonly serviceMinor: number;
  /** A fee the platform charges the payer on top of the service price. Entirely the platform's. */
  readonly payerFeeMinor: number;
  /** A tip. Carries no platform commission: there is no field that could take one. */
  readonly tipMinor: number;
  readonly taxMinor: number;
}

/**
 * The platform's separate fee on a charge, stated as amounts. The provider
 * receives the SUM (`platformFeeTotalMinor`) as the application fee.
 *
 *   commissionMinor  ≤ components.serviceMinor. The rate that produced it is the
 *                    caller's (configurable by product and market); the bound is
 *                    the contract's, and it is why a tip can never be commissioned.
 *   payerFeeMinor    = components.payerFeeMinor.
 *   taxMinor         = the tax the PLATFORM must remit (the sum of the
 *                    `TaxComputation`s whose `remittedBy` is `platform`). Tax a
 *                    seller remits stays with the seller and is not a fee.
 */
export interface PlatformFee {
  readonly commissionMinor: number;
  readonly payerFeeMinor: number;
  readonly taxMinor: number;
}

export const NO_PLATFORM_FEE: PlatformFee = Object.freeze({ commissionMinor: 0, payerFeeMinor: 0, taxMinor: 0 });

export function platformFeeTotalMinor(fee: PlatformFee): number {
  return fee.commissionMinor + fee.payerFeeMinor + fee.taxMinor;
}

export type CaptureMethod = "automatic" | "manual";

export interface CreatePaymentIntentRequest {
  /** Derived from the EVENT (the booking), not the attempt (`09` §7). */
  readonly idempotencyKey: string;
  readonly reference: PaymentReference;
  /** The payer's profile id. */
  readonly payerProfileId: string;
  /** ISO 3166-1 alpha-2 of the payer's market. */
  readonly payerCountry: string;
  /** The ORIGINAL amount and currency the payer is charged. Never converted by the caller. */
  readonly amount: Money;
  readonly components: AmountComponents;
  readonly chargeModel: ChargeModel;
  /** The recipient's provider account. Required for `direct` and `destination`; null for `platform`. */
  readonly recipientRef: string | null;
  /** ISO 3166-1 alpha-2 of the recipient's market. Required whenever `recipientRef` is. */
  readonly recipientCountry: string | null;
  /** The platform's separate fee. All zero for `platform` charges, where the whole amount is the platform's. */
  readonly platformFee: PlatformFee;
  readonly capture: CaptureMethod;
  /**
   * The tax determination for every part of the charge — one `TaxComputation`
   * per taxed line, from `TaxProvider.computeTax`. Required and non-empty:
   * checkout refuses where tax is not configured.
   */
  readonly tax: readonly TaxComputation[];
}

export type PaymentIntentState =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "succeeded"
  | "canceled";

export const PAYMENT_INTENT_STATES: readonly PaymentIntentState[] = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
  "succeeded",
  "canceled",
];

/** A provider's view of one payment intent at one instant. */
export interface PaymentIntentSnapshot {
  readonly intentRef: string;
  readonly chargeModel: ChargeModel;
  readonly recipientRef: string | null;
  readonly reference: PaymentReference;
  readonly state: PaymentIntentState;
  /** The ORIGINAL amount and currency. Never rewritten by a conversion. */
  readonly amount: Money;
  readonly components: AmountComponents;
  readonly platformFee: PlatformFee;
  readonly capture: CaptureMethod;
  /** Authorised and not yet captured, in `amount.currency`. */
  readonly amountCapturableMinor: number;
  readonly amountCapturedMinor: number;
  readonly amountRefundedMinor: number;
  /** The platform fee actually taken on what was captured. */
  readonly platformFeeCollectedMinor: number;
  readonly platformFeeRefundedMinor: number;
  /** What the recipient (or the platform) was settled, with conversion details; null until the provider reports it. */
  readonly settlement: SettlementDetails | null;
  /** Handed to the client to complete a payer action. Present while one may be needed. */
  readonly clientSecret: string | null;
  /** True for an object in the provider's LIVE mode. This process refuses those unless PAYMENTS_ALLOW_LIVE is "true". */
  readonly livemode: boolean;
  /** ISO 8601, the provider's clock. Strictly increases with each change to the object. */
  readonly updatedAt: string;
}

/**
 * How to address an intent after it exists. Under direct charges the object
 * lives on the recipient's account, so the recipient travels with the id.
 */
export interface IntentHandle {
  readonly intentRef: string;
  readonly chargeModel: ChargeModel;
  readonly recipientRef: string | null;
}

export function intentHandle(s: Pick<PaymentIntentSnapshot, "intentRef" | "chargeModel" | "recipientRef">): IntentHandle {
  return { intentRef: s.intentRef, chargeModel: s.chargeModel, recipientRef: s.recipientRef };
}

export interface ConfirmPaymentIntentRequest {
  readonly idempotencyKey: string;
  readonly intent: IntentHandle;
  /** The provider's reference for the payer's payment method, when the server supplies it. */
  readonly paymentMethodRef: string | null;
}

export interface CapturePaymentIntentRequest {
  readonly idempotencyKey: string;
  readonly intent: IntentHandle;
  /** Minor units to capture, or `full` for everything capturable. */
  readonly amountMinor: number | "full";
  /**
   * The platform fee on a PARTIAL capture. Required when less than the full
   * amount is captured (the original fee was computed on the full amount);
   * ignored for `full`. Bounded by the captured amount.
   */
  readonly platformFeeMinor: number | null;
}

export type CancelReason = "requested_by_payer" | "requested_by_recipient" | "service_unavailable" | "safety" | "abandoned" | "duplicate";

export interface CancelPaymentIntentRequest {
  readonly idempotencyKey: string;
  readonly intent: IntentHandle;
  readonly reason: CancelReason;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refunds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why money is going back. The first four are the owner's refund rules
 * (2026-10-04, "Refunds"); `support_decision` covers cancellations after the
 * service began, which the ruling sends to support and local rules.
 */
export type RefundReason =
  | "provider_cancelled"
  | "service_unavailable"
  | "safety_issue_upheld"
  | "cancelled_before_service"
  | "support_decision"
  | "duplicate";

export interface RefundPaymentRequest {
  readonly idempotencyKey: string;
  readonly intent: IntentHandle;
  /** Minor units to refund in the intent's currency, or `full` for everything not yet refunded. */
  readonly amountMinor: number | "full";
  readonly reason: RefundReason;
  /**
   * Return the platform's fee in proportion to the refund. REQUIRED, with no
   * default: the owner ruled "don't promise that fees … are non-refundable", so
   * each caller states which it is doing.
   */
  readonly refundPlatformFee: boolean;
}

export type RefundState = "pending" | "succeeded" | "failed" | "canceled";

export interface RefundSnapshot {
  readonly refundRef: string;
  readonly intentRef: string;
  readonly recipientRef: string | null;
  readonly state: RefundState;
  /** The refunded amount, in the ORIGINAL charge currency. */
  readonly amount: Money;
  readonly platformFeeRefundedMinor: number;
  /** True when, after this refund, nothing captured remains un-refunded. */
  readonly fullyRefunded: boolean;
  readonly reason: RefundReason;
  readonly livemode: boolean;
  readonly updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipients (connected accounts)
// ─────────────────────────────────────────────────────────────────────────────

export type RecipientEntityType = "individual" | "company";

export interface CreateRecipientRequest {
  readonly idempotencyKey: string;
  /** The recipient's profile id. Never sent to the provider as anything but opaque metadata. */
  readonly profileId: string;
  /** ISO 3166-1 alpha-2 of the country the recipient is established in. */
  readonly country: string;
  readonly entityType: RecipientEntityType;
  /** ISO 4217 the recipient wants to be settled in. */
  readonly settlementCurrency: string;
  /** Where the provider sends the recipient after hosted onboarding. */
  readonly returnUrl: string;
  /** Where the provider sends the recipient when the onboarding link expired. */
  readonly refreshUrl: string;
}

/**
 * Where a recipient stands with the provider.
 *
 *   not_started           the account exists; nothing submitted
 *   in_progress           the recipient started hosted onboarding
 *   pending_verification  everything due is submitted; the provider is checking
 *   verified              may be charged for and paid out
 *   restricted            was usable, and the provider has since limited it
 *   rejected              the provider refused the recipient; terminal
 */
export type RecipientOnboardingState = "not_started" | "in_progress" | "pending_verification" | "verified" | "restricted" | "rejected";

export interface RecipientSnapshot {
  readonly recipientRef: string;
  readonly profileId: string | null;
  readonly country: string;
  readonly settlementCurrency: string;
  readonly onboarding: RecipientOnboardingState;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  /** The provider's requirement CODES still due. Codes only: no documents, numbers or dates of birth cross this boundary. */
  readonly requirementsDue: readonly string[];
  /** ISO 8601 by which the requirements must be met, when the provider sets one. */
  readonly requirementsDeadline: string | null;
  readonly disabledReason: string | null;
  readonly livemode: boolean;
  readonly updatedAt: string;
}

export interface RecipientOnboardingLinkRequest {
  readonly recipientRef: string;
  readonly returnUrl: string;
  readonly refreshUrl: string;
}

export interface RecipientOnboardingLink {
  readonly recipientRef: string;
  readonly url: string;
  readonly expiresAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payouts and transfers
// ─────────────────────────────────────────────────────────────────────────────

/**
 *   transfer  platform funds → the recipient's balance WITH THE PROVIDER
 *             (creator earnings, a correction). Not needed for direct charges,
 *             where the recipient's share lands on their balance at capture.
 *   payout    the recipient's balance with the provider → their bank.
 */
export type PayoutKind = "transfer" | "payout";

export interface RequestPayoutRequest {
  /** The platform's idempotency key for this payout (`09` §10). */
  readonly idempotencyKey: string;
  readonly kind: PayoutKind;
  readonly recipientRef: string;
  readonly amount: Money;
  readonly reference: PaymentReference;
}

/**
 * The provider's states. `09` §9.1's platform lifecycle (eligible → requested →
 * approved → instructed → paid, with on_hold / failed / returned / cancelled)
 * is the platform's and lives with the ledger; these are what a provider
 * reports once a payout has been instructed.
 */
export type PayoutState = "pending" | "on_hold" | "in_transit" | "paid" | "failed" | "returned" | "canceled" | "reversed";

export const PAYOUT_STATES: readonly PayoutState[] = ["pending", "on_hold", "in_transit", "paid", "failed", "returned", "canceled", "reversed"];

export interface PayoutSnapshot {
  readonly payoutRef: string;
  readonly kind: PayoutKind;
  readonly recipientRef: string;
  readonly reference: PaymentReference;
  readonly state: PayoutState;
  /** The ORIGINAL amount and currency requested. */
  readonly amount: Money;
  /** What reached the recipient, with conversion details; null until the provider reports it. */
  readonly settlement: SettlementDetails | null;
  /** The provider's failure or return CODE, when failed or returned. */
  readonly failureCode: string | null;
  readonly expectedArrivalAt: string | null;
  readonly livemode: boolean;
  readonly updatedAt: string;
}

export interface PayoutHandle {
  readonly payoutRef: string;
  readonly kind: PayoutKind;
  readonly recipientRef: string;
}

export function payoutHandle(s: Pick<PayoutSnapshot, "payoutRef" | "kind" | "recipientRef">): PayoutHandle {
  return { payoutRef: s.payoutRef, kind: s.kind, recipientRef: s.recipientRef };
}

export interface ReverseOrHoldPayoutRequest {
  readonly idempotencyKey: string;
  readonly payout: PayoutHandle;
  /** `hold` stops a payout that has not left; `release` undoes a hold; `reverse` pulls a transfer back or cancels a payout that has not left. */
  readonly action: "hold" | "release" | "reverse";
}

// ─────────────────────────────────────────────────────────────────────────────
// Disputes (reported by webhook only)
// ─────────────────────────────────────────────────────────────────────────────

export type DisputeState = "needs_response" | "under_review" | "won" | "lost";

export interface DisputeSnapshot {
  readonly disputeRef: string;
  readonly intentRef: string;
  readonly recipientRef: string | null;
  readonly state: DisputeState;
  readonly amount: Money;
  /** The provider's reason CODE. */
  readonly reasonCode: string;
  readonly livemode: boolean;
  readonly updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhooks
// ─────────────────────────────────────────────────────────────────────────────

/** A delivery exactly as it arrived. `rawBody` is the bytes as delivered — never a re-serialised object. */
export interface WebhookDelivery {
  readonly rawBody: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

export type PaymentWebhookBody =
  | { readonly kind: "payment_intent"; readonly intent: PaymentIntentSnapshot }
  | { readonly kind: "refund"; readonly refund: RefundSnapshot }
  | { readonly kind: "recipient"; readonly recipient: RecipientSnapshot }
  | { readonly kind: "payout"; readonly payout: PayoutSnapshot }
  | { readonly kind: "dispute"; readonly dispute: DisputeSnapshot }
  /** Signature-verified, and about something this contract does not model. Acknowledge and drop. */
  | { readonly kind: "ignored" };

/**
 * A signature-verified, parsed, mode-checked event.
 *
 * `providerEventId` is the idempotency key for the handler (`09` §7): the same
 * id delivered twice is one event. Events arrive late, twice and out of order;
 * each carries the object's full snapshot at the moment it was produced, and
 * `paymentEventFold.ts` is the order-independent way to combine them.
 */
export interface PaymentWebhookEvent {
  readonly provider: string;
  readonly providerEventId: string;
  /** The provider's own type string, for logs. Do not branch on it; branch on `body.kind`. */
  readonly providerEventType: string;
  readonly livemode: boolean;
  /** ISO 8601, when the provider produced the event (not when it was delivered). */
  readonly occurredAt: string;
  /** The recipient account the event belongs to, for events about objects on a recipient's account. */
  readonly accountRef: string | null;
  readonly body: PaymentWebhookBody;
}

// ─────────────────────────────────────────────────────────────────────────────
// The contract
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentProvider {
  /** Recorded beside every provider reference the platform stores. */
  readonly id: string;

  /** What this provider can do at all. No I/O. */
  capabilities(): PaymentProviderCapabilities;
  /** Whether, and how, this provider serves recipients in one country. No I/O. */
  marketSupport(query: MarketQuery): MarketSupport;

  createPaymentIntent(req: CreatePaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>>;
  confirmPaymentIntent(req: ConfirmPaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>>;
  capturePaymentIntent(req: CapturePaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>>;
  cancelPaymentIntent(req: CancelPaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>>;
  /** Read an intent's current state — the fallback when a webhook lags or its order is in doubt. */
  getPaymentIntent(intent: IntentHandle): Promise<PaymentResult<PaymentIntentSnapshot>>;

  /** Full (`amountMinor: "full"`) or partial refund of a captured intent. */
  refundPayment(req: RefundPaymentRequest): Promise<PaymentResult<RefundSnapshot>>;

  /** Create the recipient's account. Normally answers `requires_action`: onboarding is the recipient's to complete. */
  createRecipient(req: CreateRecipientRequest): Promise<PaymentResult<RecipientSnapshot>>;
  createRecipientOnboardingLink(req: RecipientOnboardingLinkRequest): Promise<PaymentResult<RecipientOnboardingLink>>;
  /**
   * Report a recipient's onboarding and verification state. `ok` ONLY when the
   * recipient may be charged for and paid out; otherwise `requires_action`
   * (with what is due) or `declined` (rejected), each carrying the snapshot.
   */
  validateRecipient(recipientRef: string): Promise<PaymentResult<RecipientSnapshot>>;

  requestPayout(req: RequestPayoutRequest): Promise<PaymentResult<PayoutSnapshot>>;
  getPayoutStatus(payout: PayoutHandle): Promise<PaymentResult<PayoutSnapshot>>;
  reverseOrHoldPayout(req: ReverseOrHoldPayoutRequest): Promise<PaymentResult<PayoutSnapshot>>;

  /**
   * Verify the signature over the RAW body, then parse, then check the mode —
   * in that order. Answers `failed / signature_invalid` for a delivery that
   * cannot be proven to come from the provider, `failed / webhook_malformed`
   * for a verified body it cannot read, and `unavailable / livemode_not_allowed`
   * for a verified live-mode event while live is not allowed.
   */
  verifyAndParseWebhook(delivery: WebhookDelivery): Promise<PaymentResult<PaymentWebhookEvent>>;
}

/** The thirteen operations that may reach a provider. `capabilities` and `marketSupport` never do. */
export const PAYMENT_PROVIDER_OPERATIONS = [
  "createPaymentIntent",
  "confirmPaymentIntent",
  "capturePaymentIntent",
  "cancelPaymentIntent",
  "getPaymentIntent",
  "refundPayment",
  "createRecipient",
  "createRecipientOnboardingLink",
  "validateRecipient",
  "requestPayout",
  "getPayoutStatus",
  "reverseOrHoldPayout",
  "verifyAndParseWebhook",
] as const;

export type PaymentProviderOperation = (typeof PAYMENT_PROVIDER_OPERATIONS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Validation every provider shares
// ─────────────────────────────────────────────────────────────────────────────

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Idempotency keys are opaque, non-empty and bounded (the common provider limit is 255). */
export function isIdempotencyKey(v: unknown): v is string {
  return nonEmpty(v) && (v as string).length <= 255;
}

/**
 * Is this create-intent request one a provider may act on? Returns the refusal,
 * or null. Pure; every provider (the fake included) calls it first, so the
 * structural rules hold whatever the adapter does.
 *
 * The rules, in the order they are checked:
 *   1. shape — key, reference, payer, countries, charge model, capture method
 *   2. the amount is positive money and the four components sum to it EXACTLY
 *   3. a recipient is named for `direct`/`destination` and not for `platform`
 *   4. the platform fee: commission ≤ the pre-tax service component; payer fee
 *      equals the payer-fee component; platform-remitted tax ≤ the tax
 *      component; no fee at all on a `platform` charge
 *   5. tax: at least one computation (`tax_not_configured` otherwise), each for
 *      this currency and these markets; they tax the whole pre-tax amount;
 *      their tax sums to the tax component; the platform-remitted part equals
 *      `platformFee.taxMinor`
 */
export function validateCreatePaymentIntent(provider: string, req: CreatePaymentIntentRequest): PaymentRefusal | null {
  const invalid = (detail: string) => paymentFailed(provider, "invalid_request", detail);
  if (typeof req !== "object" || req === null) return invalid("request is not an object");
  if (!isIdempotencyKey(req.idempotencyKey)) return invalid("idempotencyKey must be a non-empty string of at most 255 characters");
  if (typeof req.reference !== "object" || req.reference === null || !nonEmpty(req.reference.kind) || !nonEmpty(req.reference.id)) {
    return invalid("reference needs a kind and an id");
  }
  if (!nonEmpty(req.payerProfileId)) return invalid("payerProfileId is required");
  if (!isCountryCode(req.payerCountry)) return invalid("payerCountry must be an ISO 3166-1 alpha-2 code in upper case");
  if (!CHARGE_MODELS.includes(req.chargeModel)) return invalid("chargeModel is not one this contract knows");
  if (req.capture !== "automatic" && req.capture !== "manual") return invalid("capture must be automatic or manual");

  if (typeof req.amount !== "object" || req.amount === null) return invalid("amount is required");
  if (!isCurrencyCode(req.amount.currency)) return paymentFailed(provider, "invalid_currency", "amount.currency must be an ISO 4217 code in upper case");
  if (!isMinorUnits(req.amount.amountMinor) || req.amount.amountMinor === 0) {
    return paymentFailed(provider, "invalid_amount", "amount.amountMinor must be a positive integer of minor units");
  }
  const c = req.components;
  if (typeof c !== "object" || c === null || ![c.serviceMinor, c.payerFeeMinor, c.tipMinor, c.taxMinor].every(isMinorUnits)) {
    return paymentFailed(provider, "invalid_amount", "components must be four non-negative integers of minor units");
  }
  if (c.serviceMinor + c.payerFeeMinor + c.tipMinor + c.taxMinor !== req.amount.amountMinor) {
    return paymentFailed(provider, "invalid_amount", "components do not sum to the amount");
  }

  if (req.chargeModel === "platform") {
    if (req.recipientRef !== null || req.recipientCountry !== null) return invalid("a platform charge names no recipient");
  } else {
    if (!nonEmpty(req.recipientRef)) return invalid(`a ${req.chargeModel} charge needs recipientRef`);
    if (!isCountryCode(req.recipientCountry)) return invalid("recipientCountry must be an ISO 3166-1 alpha-2 code in upper case");
  }

  const f = req.platformFee;
  if (typeof f !== "object" || f === null || ![f.commissionMinor, f.payerFeeMinor, f.taxMinor].every(isMinorUnits)) {
    return paymentFailed(provider, "invalid_amount", "platformFee must be three non-negative integers of minor units");
  }
  if (req.chargeModel === "platform" && platformFeeTotalMinor(f) !== 0) {
    return invalid("a platform charge carries no separate platform fee: the whole amount is the platform's");
  }
  if (f.commissionMinor > c.serviceMinor) {
    return paymentFailed(
      provider,
      "fee_exceeds_commissionable_amount",
      "commission exceeds the pre-tax service component; tips, tax and payer fees are not commissionable",
    );
  }
  if (req.chargeModel !== "platform" && f.payerFeeMinor !== c.payerFeeMinor) {
    return paymentFailed(provider, "invalid_amount", "platformFee.payerFeeMinor must equal components.payerFeeMinor");
  }
  if (f.taxMinor > c.taxMinor) {
    return paymentFailed(provider, "invalid_amount", "platform-remitted tax exceeds the tax component");
  }

  if (!Array.isArray(req.tax) || req.tax.length === 0) {
    return paymentUnavailable(
      provider,
      "tax_not_configured",
      "no tax computation accompanies this charge; checkout refuses where tax is not configured for the market",
    );
  }
  let taxable = 0;
  let tax = 0;
  let platformRemitted = 0;
  for (const t of req.tax) {
    if (typeof t !== "object" || t === null || t.configured !== true) {
      return paymentUnavailable(provider, "tax_not_configured", "a tax computation does not come from a configured market");
    }
    if (!isMinorUnits(t.taxableMinor) || !isMinorUnits(t.taxMinor)) return paymentFailed(provider, "invalid_amount", "a tax computation carries a non-integer amount");
    if (t.currency !== req.amount.currency) return paymentFailed(provider, "currency_mismatch", "a tax computation is in a different currency from the charge");
    if (t.buyerMarket !== req.payerCountry) return invalid("a tax computation was made for a different buyer market");
    if (req.recipientCountry !== null && t.sellerMarket !== req.recipientCountry) return invalid("a tax computation was made for a different seller market");
    taxable += t.taxableMinor;
    tax += t.taxMinor;
    if (t.remittedBy === "platform") platformRemitted += t.taxMinor;
  }
  if (taxable !== req.amount.amountMinor - c.taxMinor) {
    return paymentFailed(provider, "invalid_amount", "the tax computations do not cover the whole pre-tax amount");
  }
  if (tax !== c.taxMinor) return paymentFailed(provider, "invalid_amount", "the tax computations do not sum to the tax component");
  if (req.chargeModel !== "platform" && platformRemitted !== f.taxMinor) {
    return paymentFailed(provider, "invalid_amount", "platformFee.taxMinor must equal the tax the platform remits");
  }
  return null;
}

/** Shape check for a payout request. Returns the refusal, or null. */
export function validateRequestPayout(provider: string, req: RequestPayoutRequest): PaymentRefusal | null {
  const invalid = (detail: string) => paymentFailed(provider, "invalid_request", detail);
  if (typeof req !== "object" || req === null) return invalid("request is not an object");
  if (!isIdempotencyKey(req.idempotencyKey)) return invalid("idempotencyKey must be a non-empty string of at most 255 characters");
  if (req.kind !== "transfer" && req.kind !== "payout") return invalid("kind must be transfer or payout");
  if (!nonEmpty(req.recipientRef)) return invalid("recipientRef is required");
  if (typeof req.reference !== "object" || req.reference === null || !nonEmpty(req.reference.kind) || !nonEmpty(req.reference.id)) {
    return invalid("reference needs a kind and an id");
  }
  if (typeof req.amount !== "object" || req.amount === null) return invalid("amount is required");
  if (!isCurrencyCode(req.amount.currency)) return paymentFailed(provider, "invalid_currency", "amount.currency must be an ISO 4217 code in upper case");
  if (!isMinorUnits(req.amount.amountMinor) || req.amount.amountMinor === 0) {
    return paymentFailed(provider, "invalid_amount", "amount.amountMinor must be a positive integer of minor units");
  }
  return null;
}

/** Shape check for a recipient request. Returns the refusal, or null. */
export function validateCreateRecipient(provider: string, req: CreateRecipientRequest): PaymentRefusal | null {
  const invalid = (detail: string) => paymentFailed(provider, "invalid_request", detail);
  if (typeof req !== "object" || req === null) return invalid("request is not an object");
  if (!isIdempotencyKey(req.idempotencyKey)) return invalid("idempotencyKey must be a non-empty string of at most 255 characters");
  if (!nonEmpty(req.profileId)) return invalid("profileId is required");
  if (!isCountryCode(req.country)) return invalid("country must be an ISO 3166-1 alpha-2 code in upper case");
  if (req.entityType !== "individual" && req.entityType !== "company") return invalid("entityType must be individual or company");
  if (!isCurrencyCode(req.settlementCurrency)) return paymentFailed(provider, "invalid_currency", "settlementCurrency must be an ISO 4217 code in upper case");
  if (!nonEmpty(req.returnUrl) || !nonEmpty(req.refreshUrl)) return invalid("returnUrl and refreshUrl are required");
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Providers that only refuse, and the guard every adapter runs behind
// ─────────────────────────────────────────────────────────────────────────────

export const NONE_PAYMENT_PROVIDER_ID = "none" as const;

/**
 * A provider whose every operation answers one `unavailable` refusal. It opens
 * no socket, reads no credential and no argument, and holds no state.
 */
export function refusingPaymentProvider(id: string, reason: UnavailableReason, detail: string, retriable = false): PaymentProvider {
  const refuse = <T>(): Promise<PaymentResult<T>> => Promise.resolve(paymentUnavailable(id, reason, detail, retriable));
  return Object.freeze({
    id,
    capabilities: () => NO_PAYMENT_CAPABILITIES,
    marketSupport: (query: MarketQuery) => unsupportedMarket(id, query, "no_provider"),
    createPaymentIntent: () => refuse<PaymentIntentSnapshot>(),
    confirmPaymentIntent: () => refuse<PaymentIntentSnapshot>(),
    capturePaymentIntent: () => refuse<PaymentIntentSnapshot>(),
    cancelPaymentIntent: () => refuse<PaymentIntentSnapshot>(),
    getPaymentIntent: () => refuse<PaymentIntentSnapshot>(),
    refundPayment: () => refuse<RefundSnapshot>(),
    createRecipient: () => refuse<RecipientSnapshot>(),
    createRecipientOnboardingLink: () => refuse<RecipientOnboardingLink>(),
    validateRecipient: () => refuse<RecipientSnapshot>(),
    requestPayout: () => refuse<PayoutSnapshot>(),
    getPayoutStatus: () => refuse<PayoutSnapshot>(),
    reverseOrHoldPayout: () => refuse<PayoutSnapshot>(),
    verifyAndParseWebhook: () => refuse<PaymentWebhookEvent>(),
  });
}

const PAYMENTS_DISABLED_DETAIL =
  "No payment provider is configured (PAYMENT_PROVIDER is unset or `none`). Nothing is charged, refunded or paid out.";

/** The no-money provider: the default. Every operation answers `unavailable / payments_disabled`. */
export const NONE_PAYMENT_PROVIDER: PaymentProvider = refusingPaymentProvider(NONE_PAYMENT_PROVIDER_ID, "payments_disabled", PAYMENTS_DISABLED_DETAIL);

/**
 * Turn anything an adapter threw into a tagged result. A sandbox-guard refusal
 * (`lib/paymentsMode.ts`) keeps its meaning; everything else is
 * `failed / provider_error`, retriable, with the error's NAME and stable `code`
 * only — a message may quote a request, and a request may hold a credential.
 */
export function paymentResultFromThrown(provider: string, err: unknown): PaymentRefusal {
  if (isPaymentsLiveModeRefusal(err)) {
    const refusal: unknown = (err as { decision?: { refusal?: unknown } }).decision?.refusal;
    const reason: UnavailableReason =
      refusal === "unknown_key_prefix"
        ? "unknown_key_prefix"
        : refusal === "key_absent"
          ? "key_absent"
          : refusal === "live_event_not_allowed"
            ? "livemode_not_allowed"
            : "live_key_not_allowed";
    return paymentUnavailable(provider, reason, "refused by the sandbox-only guard before any request was sent");
  }
  const name = err instanceof Error ? err.name : typeof err;
  const code = typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? ` code=${(err as { code: string }).code}` : "";
  return paymentFailed(provider, "provider_error", `the provider adapter threw (${name}${code})`, true);
}

/**
 * Wrap a provider so that, before EVERY operation, `precheck` may refuse, and
 * so that nothing the provider throws escapes as an exception. The registry
 * hands out only guarded providers: a key that is live, unrecognised or absent
 * is refused here, before the adapter's code runs at all.
 *
 * `capabilities` and `marketSupport` are passed through — they reach nothing.
 */
export function guardPaymentProvider(inner: PaymentProvider, precheck: () => PaymentRefusal | null): PaymentProvider {
  const run = <A, T>(op: (arg: A) => Promise<PaymentResult<T>>) =>
    async (arg: A): Promise<PaymentResult<T>> => {
      try {
        const refusal = precheck();
        if (refusal) return refusal;
        return await op.call(inner, arg);
      } catch (err) {
        return paymentResultFromThrown(inner.id, err);
      }
    };
  return Object.freeze({
    id: inner.id,
    capabilities: () => inner.capabilities(),
    marketSupport: (query: MarketQuery) => inner.marketSupport(query),
    createPaymentIntent: run(inner.createPaymentIntent),
    confirmPaymentIntent: run(inner.confirmPaymentIntent),
    capturePaymentIntent: run(inner.capturePaymentIntent),
    cancelPaymentIntent: run(inner.cancelPaymentIntent),
    getPaymentIntent: run(inner.getPaymentIntent),
    refundPayment: run(inner.refundPayment),
    createRecipient: run(inner.createRecipient),
    createRecipientOnboardingLink: run(inner.createRecipientOnboardingLink),
    validateRecipient: run(inner.validateRecipient),
    requestPayout: run(inner.requestPayout),
    getPayoutStatus: run(inner.getPayoutStatus),
    reverseOrHoldPayout: run(inner.reverseOrHoldPayout),
    verifyAndParseWebhook: run(inner.verifyAndParseWebhook),
  });
}
