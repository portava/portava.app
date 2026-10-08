/**
 * StripeConnectProvider — the `PaymentProvider` contract over Stripe Connect,
 * TEST MODE ONLY (owner, OD-PAY-1: "Use Stripe Connect in test mode as the
 * first integration, behind a payment-provider interface"; OD-PAY-11: "keep
 * payments in test mode until payment, identity, and tax readiness are
 * established").
 *
 * ── THIS ADAPTER HAS NEVER SPOKEN TO STRIPE ──────────────────────────────────
 * Every behaviour below is proven against a STUBBED transport
 * (test/helpers/stripeSimulator.ts) that asserts the method, path, form fields,
 * Idempotency-Key and Stripe-Account header of each request and answers in the
 * documented shapes. No request has been sent to api.stripe.com. It is
 * registered `certified: false` (providerRegistry.ts), so no route can reach
 * it; certification needs a TEST secret key, the two webhook signing secrets
 * (platform endpoint, Connect endpoint) and a connected test account, and a
 * sandbox transcript produced with `{ certificationRun: true }`.
 *
 * ── WHAT IS SENT, AND WHERE IT WAS VERIFIED (provider docs, fetched 2026-10-05)
 *   direct charge     POST /v1/payment_intents with `Stripe-Account: <acct>` and
 *                     `application_fee_amount` — docs.stripe.com/connect/direct-charges
 *                     ("must be positive and less than the amount of the charge")
 *   refund            POST /v1/refunds as the connected account, with
 *                     `refund_application_fee` STATED every time ("Application
 *                     fees aren't automatically refunded") — same page
 *   connected account POST /v1/accounts with `controller[...]` — docs.stripe.com/api/accounts/create
 *                     (`type` is deprecated in favour of `controller`)
 *   onboarding link   POST /v1/account_links, type=account_onboarding
 *   payout            POST /v1/payouts as the connected account; `manual`
 *                     interval needed for a platform-run schedule — docs.stripe.com/connect/manage-payout-schedule
 *                     ("Platforms that manage fraud and dispute liability, or
 *                     have platform controls, can adjust the payout interval")
 *   webhooks          `Stripe-Signature` (t=…,v1=…) over the RAW body, through
 *                     paymentWebhookSignature.ts; one secret per endpoint
 *   markets           stripe.com/global: US, JP, TH listed; PH and VN are NOT.
 *                     Manila and Da Nang cannot be served by direct charges.
 *
 * ── THE CONNECT ACCOUNT CONFIGURATION IS THE OWNER'S, AND HAS NO DEFAULT ─────
 * `STRIPE_CONNECT_ACCOUNT_CONFIGURATION` picks who pays Stripe's fees, who
 * bears negative balances (refunds and disputes the buddy's balance cannot
 * cover) and what dashboard the buddy gets. Those change money outcomes, so
 * the adapter refuses to create a connected account or an onboarding link
 * while the setting is unset or unknown (`capability_not_supported`, naming
 * the setting). Nothing else depends on it.
 *
 * ── NOT MODELLED IN THIS VERSION (said, not hidden) ──────────────────────────
 *   * `settlement` is always null: the balance transaction (Stripe's fee, the
 *     rate) is not read yet, so no provider-fee posting is made from Stripe.
 *   * destination charges, transfers, payout HOLD (Stripe has none: Portava
 *     holds a payout by not requesting it — bookingPayments/payouts.ts),
 *     currency conversion. Each is reported false in `capabilities()`.
 *   * the Stripe API version is not pinned (`Stripe-Version`); pin it at
 *     certification.
 *
 * No npm dependency: `fetch` and form encoding only.
 */
import {
  PAYMENT_CONNECT_WEBHOOK_SECRET_ENV,
  PAYMENT_KEY_ENV,
  PAYMENT_WEBHOOK_SECRET_ENV,
  assertProviderKeyAllowed,
  evaluatePaymentKey,
  webhookLivemodeRefused,
} from "../../lib/paymentsMode.js";
import { verifyPaymentWebhookSignature } from "./paymentWebhookSignature.js";
import {
  paymentDeclined,
  paymentFailed,
  paymentOk,
  paymentRequiresAction,
  paymentUnavailable,
  platformFeeTotalMinor,
  resolveCapture,
  unsupportedMarket,
  type AmountComponents,
  type CancelPaymentIntentRequest,
  type CapturePaymentIntentRequest,
  type ChargeModel,
  type ConfirmPaymentIntentRequest,
  type CreatePaymentIntentRequest,
  type CreateRecipientRequest,
  type DeclineReason,
  type DisputeSnapshot,
  type DisputeState,
  type IntentHandle,
  type MarketQuery,
  type MarketSupport,
  type PaymentIntentSnapshot,
  type PaymentIntentState,
  type PaymentProvider,
  type PaymentProviderCapabilities,
  type PaymentReference,
  type PaymentRefusal,
  type PaymentResult,
  type PaymentWebhookBody,
  type PaymentWebhookEvent,
  type PayoutHandle,
  type PayoutSnapshot,
  type PayoutState,
  type PlatformFee,
  type RecipientOnboardingLink,
  type RecipientOnboardingLinkRequest,
  type RecipientOnboardingState,
  type RecipientSnapshot,
  type RefundPaymentRequest,
  type RefundReason,
  type RefundSnapshot,
  type RefundState,
  type RequestPayoutRequest,
  type ReverseOrHoldPayoutRequest,
  type WebhookDelivery,
} from "./PaymentProvider.js";

export const STRIPE_PROVIDER_ID = "stripe" as const;
export const STRIPE_API_ORIGIN = "https://api.stripe.com";

// ─────────────────────────────────────────────────────────────────────────────
// The owner's setting
// ─────────────────────────────────────────────────────────────────────────────

export const STRIPE_CONNECT_ACCOUNT_CONFIGURATION_ENV = "STRIPE_CONNECT_ACCOUNT_CONFIGURATION" as const;

/**
 * The connected-account configurations the adapter can create, each as the
 * Accounts v1 `controller` fields it sends (docs.stripe.com/connect/accounts-v2/
 * connected-account-configuration, "Accounts v1 controller property map").
 * `losses = application` requires `fees = application` (same page).
 */
export const STRIPE_CONNECT_ACCOUNT_CONFIGURATIONS = Object.freeze({
  /** Stripe's recommendation for direct charges: the buddy has the full Stripe Dashboard; Stripe bears negative balances; Stripe's fee is taken from the buddy's account. */
  full_dashboard_stripe_liable: Object.freeze({ feesPayer: "account", lossesPayments: "stripe", dashboard: "full" }),
  /** Express Dashboard; Stripe bears negative balances; Stripe's fee from the buddy's account. */
  express_stripe_liable: Object.freeze({ feesPayer: "account", lossesPayments: "stripe", dashboard: "express" }),
  /** Express Dashboard; PORTAVA bears negative balances and pays Stripe's fee; Portava controls the payout schedule. */
  express_platform_liable: Object.freeze({ feesPayer: "application", lossesPayments: "application", dashboard: "express" }),
} as const);

export type StripeConnectAccountConfiguration = keyof typeof STRIPE_CONNECT_ACCOUNT_CONFIGURATIONS;

export function connectAccountConfiguration(env: NodeJS.ProcessEnv): StripeConnectAccountConfiguration | null {
  const v = (env[STRIPE_CONNECT_ACCOUNT_CONFIGURATION_ENV] ?? "").trim();
  return Object.prototype.hasOwnProperty.call(STRIPE_CONNECT_ACCOUNT_CONFIGURATIONS, v) ? (v as StripeConnectAccountConfiguration) : null;
}

const CONFIGURATION_UNSET_DETAIL =
  `${STRIPE_CONNECT_ACCOUNT_CONFIGURATION_ENV} is not set to one of ${Object.keys(STRIPE_CONNECT_ACCOUNT_CONFIGURATIONS).join(", ")}. ` +
  "It decides who pays Stripe's fees, who bears refunds and disputes the buddy's balance cannot cover, and who controls payouts; " +
  "it is the owner's decision and has no default, so no connected account is created.";

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities and markets
// ─────────────────────────────────────────────────────────────────────────────

export const STRIPE_CAPABILITIES: PaymentProviderCapabilities = Object.freeze({
  chargeModels: Object.freeze(["direct"]) as readonly ChargeModel[],
  manualCapture: true,
  partialCapture: true,
  partialRefund: true,
  platformFeeRefund: true,
  connectedAccounts: true,
  transfers: false,
  payouts: true,
  payoutHold: false,
  payoutReversal: true,
  currencyConversion: false,
  signedWebhooks: true,
});

/**
 * Countries the adapter declares, each with the one currency it charges and
 * settles in (no conversion is modelled). Source: stripe.com/global, fetched
 * 2026-10-05 (US, JP, TH listed; PH and VN absent). Every currency here has
 * the ISO 4217 exponent on Stripe's wire (USD 2, JPY 0, THB 2), so amounts
 * cross unconverted. A country is offered only when the platform ALSO enables
 * it (PAYMENTS_ENABLED_MARKETS, providerRegistry.ts), which is empty by default.
 */
export const STRIPE_DOCUMENTED_MARKETS: Readonly<Record<string, string>> = Object.freeze({ US: "USD", JP: "JPY", TH: "THB" });

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

export interface StripeRequest {
  readonly method: "GET" | "POST";
  /** e.g. `/v1/payment_intents`. */
  readonly path: string;
  /** Query string pairs (GET expansions). */
  readonly query: ReadonlyArray<readonly [string, string]>;
  /** Form-encoded body pairs (POST), in order. */
  readonly form: ReadonlyArray<readonly [string, string]>;
  /** `Authorization`, `Idempotency-Key`, `Stripe-Account`, `Content-Type`. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface StripeResponse {
  readonly status: number;
  readonly body: unknown;
}

export type StripeTransport = (req: StripeRequest) => Promise<StripeResponse>;

/** The production transport: `fetch`, nothing else. Never logs the request. */
export const fetchStripeTransport: StripeTransport = async (req) => {
  const qs = req.query.length > 0 ? `?${new URLSearchParams(req.query.map(([k, v]): [string, string] => [k, v])).toString()}` : "";
  const res = await fetch(`${STRIPE_API_ORIGIN}${req.path}${qs}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === "POST" ? new URLSearchParams(req.form.map(([k, v]): [string, string] => [k, v])).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

export interface StripeConnectProviderOptions {
  /** Read at CALL time (key, secrets, configuration). Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly transport?: StripeTransport;
  /** The time stamped on snapshots read through the API. Default `Date.now`. */
  readonly nowMs?: () => number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const isoFromUnix = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null);

const META = {
  refKind: "portava_ref_kind",
  refId: "portava_ref_id",
  service: "portava_service_minor",
  payerFee: "portava_payer_fee_minor",
  tip: "portava_tip_minor",
  tax: "portava_tax_minor",
  commission: "portava_commission_minor",
  platformPayerFee: "portava_platform_payer_fee_minor",
  platformTax: "portava_platform_tax_minor",
  recipient: "portava_ref",
  refundReason: "portava_refund_reason",
} as const;

const metaInt = (m: Obj, k: string): number | null => {
  const v = m[k];
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
};

const STRIPE_INTENT_STATES: readonly PaymentIntentState[] = [
  "requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "succeeded", "canceled",
];
const REFUND_REASONS: readonly RefundReason[] = ["provider_cancelled", "service_unavailable", "safety_issue_upheld", "cancelled_before_service", "support_decision", "duplicate"];

function declineReasonOf(code: unknown): DeclineReason {
  switch (code) {
    case "insufficient_funds": return "insufficient_funds";
    case "expired_card": return "payment_method_expired";
    case "fraudulent":
    case "stolen_card":
    case "lost_card":
    case "merchant_blacklist":
    case "pickup_card": return "fraud_suspected";
    case "authentication_required":
    case "payment_intent_authentication_failure": return "authentication_failed";
    case "card_declined":
    case "generic_decline":
    case "do_not_honor": return "card_declined";
    default: return "declined_other";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The adapter
// ─────────────────────────────────────────────────────────────────────────────

export function createStripeConnectProvider(options: StripeConnectProviderOptions = {}): PaymentProvider {
  const env = options.env ?? process.env;
  const transport = options.transport ?? fetchStripeTransport;
  const nowMs = options.nowMs ?? (() => Date.now());
  const id = STRIPE_PROVIDER_ID;
  const nowIso = () => new Date(nowMs()).toISOString();

  /** The key, or the refusal. Test keys ONLY, whatever PAYMENTS_ALLOW_LIVE says. Read on every call. */
  const secretKey = (): string | PaymentRefusal => {
    const d = evaluatePaymentKey("stripe", env);
    if (d.refusal === "key_absent") return paymentUnavailable(id, "key_absent", `no Stripe secret key is configured (${PAYMENT_KEY_ENV.stripe}); this adapter sends nothing without one`);
    if (d.refusal === "unknown_key_prefix") return paymentUnavailable(id, "unknown_key_prefix", "the Stripe key has an unrecognised prefix; only documented test/live secret-key prefixes are accepted");
    if (d.mode !== "test") {
      return paymentUnavailable(id, "live_key_not_allowed", "this adapter is TEST MODE ONLY (owner OD-PAY-1 / OD-PAY-11): a live key is refused before any request, whatever PAYMENTS_ALLOW_LIVE says");
    }
    const key = env[PAYMENT_KEY_ENV.stripe] as string;
    assertProviderKeyAllowed("stripe", key, env); // the shared second lock (paymentsMode.ts)
    return key;
  };

  type Call = { ok: true; body: Obj } | { ok: false; refusal: PaymentRefusal; status: number; error: Obj | null };

  const send = async (
    method: "GET" | "POST",
    path: string,
    params: { form?: Array<[string, string]>; query?: Array<[string, string]>; account?: string | null; idempotencyKey?: string | null } = {},
  ): Promise<Call> => {
    const key = secretKey();
    if (typeof key !== "string") return { ok: false, refusal: key, status: 0, error: null };
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (params.idempotencyKey) headers["Idempotency-Key"] = params.idempotencyKey;
    if (params.account) headers["Stripe-Account"] = params.account;
    let res: StripeResponse;
    try {
      res = await transport({ method, path, query: params.query ?? [], form: params.form ?? [], headers });
    } catch {
      return { ok: false, refusal: paymentUnavailable(id, "provider_unreachable", "Stripe could not be reached", true), status: 0, error: null };
    }
    if (res.status >= 200 && res.status < 300 && isObj(res.body)) return { ok: true, body: res.body };
    const error = isObj(res.body) && isObj(res.body["error"]) ? (res.body["error"] as Obj) : null;
    return { ok: false, refusal: refusalOf(res.status, error), status: res.status, error };
  };

  /** Stripe's error to the contract's. Only CODES cross: never Stripe's message, which can quote request values. */
  const refusalOf = (status: number, error: Obj | null): PaymentRefusal => {
    const code = safeCode(error?.["code"]);
    const type = safeCode(error?.["type"]);
    if (status === 0 || status >= 500) return paymentUnavailable(id, "provider_unreachable", `Stripe answered ${status || "nothing"}`, true);
    if (status === 429) return paymentUnavailable(id, "rate_limited", "Stripe rate-limited the request", true);
    if (status === 401 || status === 403) return paymentFailed(id, "provider_error", `Stripe refused the key (${status})`);
    if (type === "idempotency_error") return paymentFailed(id, "idempotency_conflict", "the idempotency key was used before with a different request");
    if (status === 404 || code === "resource_missing") return paymentFailed(id, "not_found", `Stripe: ${code ?? "not found"}`);
    if (code === "payment_intent_unexpected_state" || code === "charge_already_refunded" || code === "payout_not_cancelable" || code === "payouts_not_allowed") {
      return paymentFailed(id, "illegal_state", `Stripe: ${code}`);
    }
    if (code === "amount_too_large" || code === "refund_amount_too_large") return paymentFailed(id, "amount_exceeds_refundable", `Stripe: ${code}`);
    return paymentFailed(id, "invalid_request", `Stripe: ${type ?? "error"}${code ? `/${code}` : ""}`);
  };

  // ── mapping Stripe objects to the contract's snapshots ─────────────────────

  const componentsOf = (m: Obj): { components: AmountComponents; platformFee: PlatformFee; reference: PaymentReference } | null => {
    const service = metaInt(m, META.service), payerFee = metaInt(m, META.payerFee), tip = metaInt(m, META.tip), tax = metaInt(m, META.tax);
    const commission = metaInt(m, META.commission), pPayer = metaInt(m, META.platformPayerFee), pTax = metaInt(m, META.platformTax);
    const kind = str(m[META.refKind]), refId = str(m[META.refId]);
    if (service === null || payerFee === null || tip === null || tax === null || commission === null || pPayer === null || pTax === null || !kind || !refId) return null;
    return {
      components: { serviceMinor: service, payerFeeMinor: payerFee, tipMinor: tip, taxMinor: tax },
      platformFee: { commissionMinor: commission, payerFeeMinor: pPayer, taxMinor: pTax },
      reference: { kind, id: refId },
    };
  };

  interface FeeFacts { readonly collectedMinor: number; readonly refundedMinor: number }

  const intentSnapshot = (pi: Obj, recipientRef: string, fee: FeeFacts | null, updatedAt: string): PaymentIntentSnapshot | null => {
    const intentRef = str(pi["id"]);
    const state = pi["status"] as PaymentIntentState;
    const amount = int(pi["amount"]);
    const currency = str(pi["currency"]);
    const meta = isObj(pi["metadata"]) ? pi["metadata"] : {};
    const parts = componentsOf(meta);
    if (!intentRef || !STRIPE_INTENT_STATES.includes(state) || amount === null || !currency || !parts) return null;
    const charge = isObj(pi["latest_charge"]) ? pi["latest_charge"] : null;
    const awaitingPayer = state === "requires_payment_method" || state === "requires_confirmation" || state === "requires_action";
    return {
      intentRef,
      chargeModel: "direct",
      recipientRef,
      reference: parts.reference,
      state,
      amount: { amountMinor: amount, currency: currency.toUpperCase() },
      components: parts.components,
      platformFee: parts.platformFee,
      capture: pi["capture_method"] === "manual" ? "manual" : "automatic",
      amountCapturableMinor: int(pi["amount_capturable"]) ?? 0,
      amountCapturedMinor: int(pi["amount_received"]) ?? 0,
      amountRefundedMinor: charge ? int(charge["amount_refunded"]) ?? 0 : 0,
      platformFeeCollectedMinor: fee ? fee.collectedMinor : 0,
      platformFeeRefundedMinor: fee ? fee.refundedMinor : 0,
      settlement: null,
      clientSecret: awaitingPayer ? str(pi["client_secret"]) : null,
      livemode: pi["livemode"] === true,
      updatedAt,
    };
  };

  const malformed = (what: string) => paymentFailed(id, "provider_error", `Stripe answered with a ${what} this adapter cannot read, or one this platform did not create`, true);

  /** The intent with its charge expanded and the platform's application fee read: the only way to know the refunded and fee counters. */
  const readIntentFull = async (h: IntentHandle, updatedAt = nowIso()): Promise<PaymentResult<PaymentIntentSnapshot>> => {
    if (h.chargeModel !== "direct" || !h.recipientRef) return paymentUnavailable(id, "charge_model_not_supported", "this adapter implements direct charges only");
    const r = await send("GET", `/v1/payment_intents/${encodeURIComponent(h.intentRef)}`, { query: [["expand[]", "latest_charge"]], account: h.recipientRef });
    if (!r.ok) return r.refusal;
    const charge = isObj(r.body["latest_charge"]) ? r.body["latest_charge"] : null;
    let fee: FeeFacts = { collectedMinor: 0, refundedMinor: 0 };
    const feeId = charge ? str(charge["application_fee"]) : null;
    if (feeId) {
      // Application fees live on the PLATFORM's account: no Stripe-Account header.
      const f = await send("GET", `/v1/application_fees/${encodeURIComponent(feeId)}`);
      if (!f.ok) return f.refusal;
      fee = { collectedMinor: int(f.body["amount"]) ?? 0, refundedMinor: int(f.body["amount_refunded"]) ?? 0 };
    }
    const snap = intentSnapshot(r.body, h.recipientRef, fee, updatedAt);
    return snap ? paymentOk(id, snap) : malformed("payment intent");
  };

  const recipientSnapshot = (a: Obj, updatedAt: string): RecipientSnapshot | null => {
    const recipientRef = str(a["id"]);
    const country = str(a["country"]);
    const currency = str(a["default_currency"]);
    if (!recipientRef || !country || !currency) return null;
    const req = isObj(a["requirements"]) ? a["requirements"] : {};
    const due = Array.isArray(req["currently_due"]) ? (req["currently_due"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const pending = Array.isArray(req["pending_verification"]) ? (req["pending_verification"] as unknown[]).filter((x) => typeof x === "string") : [];
    const disabledReason = str(req["disabled_reason"]);
    const charges = a["charges_enabled"] === true;
    const payouts = a["payouts_enabled"] === true;
    const submitted = a["details_submitted"] === true;
    let onboarding: RecipientOnboardingState;
    if (disabledReason && disabledReason.startsWith("rejected.")) onboarding = "rejected";
    else if (charges && payouts && due.length === 0) onboarding = "verified";
    else if (!submitted) onboarding = "not_started";
    else if (due.length > 0) onboarding = "in_progress";
    else if (pending.length > 0) onboarding = "pending_verification";
    else onboarding = "restricted";
    const meta = isObj(a["metadata"]) ? a["metadata"] : {};
    return {
      recipientRef,
      profileId: str(meta[META.recipient]),
      country: country.toUpperCase(),
      settlementCurrency: currency.toUpperCase(),
      onboarding,
      chargesEnabled: charges,
      payoutsEnabled: payouts,
      requirementsDue: due, // Stripe's requirement CODES (e.g. "individual.id_number"): names of fields, never their values
      requirementsDeadline: isoFromUnix(req["current_deadline"]),
      disabledReason,
      livemode: a["livemode"] === true,
      updatedAt,
    };
  };

  const PAYOUT_STATE: Record<string, PayoutState> = { pending: "pending", in_transit: "in_transit", paid: "paid", failed: "failed", canceled: "canceled" };

  const payoutSnapshot = (p: Obj, recipientRef: string, updatedAt: string): PayoutSnapshot | null => {
    const payoutRef = str(p["id"]);
    const amount = int(p["amount"]);
    const currency = str(p["currency"]);
    const state = PAYOUT_STATE[String(p["status"])];
    if (!payoutRef || amount === null || !currency || !state) return null;
    const meta = isObj(p["metadata"]) ? p["metadata"] : {};
    const kind = str(meta[META.refKind]), refId = str(meta[META.refId]);
    return {
      payoutRef,
      kind: "payout",
      recipientRef,
      // A payout Stripe made on the account's own schedule carries no reference of the platform's.
      reference: p["automatic"] === true || !kind || !refId ? null : { kind, id: refId },
      state,
      amount: { amountMinor: amount, currency: currency.toUpperCase() },
      amountReversedMinor: 0,
      settlement: null,
      failureCode: str(p["failure_code"]),
      expectedArrivalAt: isoFromUnix(p["arrival_date"]),
      livemode: p["livemode"] === true,
      updatedAt,
    };
  };

  const REFUND_STATE: Record<string, RefundState> = { pending: "pending", requires_action: "pending", succeeded: "succeeded", failed: "failed", canceled: "canceled" };

  const refundSnapshot = (r: Obj, recipientRef: string, extra: { feeRefundedMinor: number; fullyRefunded: boolean; reason?: RefundReason }, updatedAt: string): RefundSnapshot | null => {
    const refundRef = str(r["id"]);
    const intentRef = str(r["payment_intent"]);
    const amount = int(r["amount"]);
    const currency = str(r["currency"]);
    const state = REFUND_STATE[String(r["status"])];
    if (!refundRef || !intentRef || amount === null || !currency || !state) return null;
    const meta = isObj(r["metadata"]) ? r["metadata"] : {};
    const metaReason = meta[META.refundReason] as RefundReason;
    return {
      refundRef,
      intentRef,
      recipientRef,
      state,
      amount: { amountMinor: amount, currency: currency.toUpperCase() },
      platformFeeRefundedMinor: extra.feeRefundedMinor,
      fullyRefunded: extra.fullyRefunded,
      reason: extra.reason ?? (REFUND_REASONS.includes(metaReason) ? metaReason : "support_decision"),
      livemode: r["livemode"] === true,
      updatedAt,
    };
  };

  const DISPUTE_STATE: Record<string, DisputeState> = {
    warning_needs_response: "needs_response", needs_response: "needs_response",
    warning_under_review: "under_review", under_review: "under_review",
    won: "won", warning_closed: "won", lost: "lost",
  };

  const disputeSnapshot = (d: Obj, recipientRef: string | null, updatedAt: string): DisputeSnapshot | null => {
    const disputeRef = str(d["id"]);
    const intentRef = str(d["payment_intent"]);
    const amount = int(d["amount"]);
    const currency = str(d["currency"]);
    const state = DISPUTE_STATE[String(d["status"])];
    if (!disputeRef || !intentRef || amount === null || !currency || !state) return null;
    return {
      disputeRef, intentRef, recipientRef, state,
      amount: { amountMinor: amount, currency: currency.toUpperCase() },
      reasonCode: safeCode(d["reason"]) ?? "unknown",
      livemode: d["livemode"] === true,
      updatedAt,
    };
  };

  const marketOf = (country: string): string | null => STRIPE_DOCUMENTED_MARKETS[country] ?? null;

  /** A card error on confirm carries the intent: the decline is answered WITH its snapshot. */
  const declinedFrom = (call: Extract<Call, { ok: false }>, recipientRef: string): PaymentResult<PaymentIntentSnapshot> | null => {
    if (safeCode(call.error?.["type"]) !== "card_error") return null;
    const pi = isObj(call.error?.["payment_intent"]) ? (call.error?.["payment_intent"] as Obj) : null;
    const snap = pi ? intentSnapshot(pi, recipientRef, null, nowIso()) : null;
    const reason = declineReasonOf(call.error?.["decline_code"] ?? call.error?.["code"]);
    return paymentDeclined<PaymentIntentSnapshot>(id, reason, `Stripe declined the payment (${reason})`, snap);
  };

  const provider: PaymentProvider = {
    id,

    capabilities: () => STRIPE_CAPABILITIES,

    marketSupport(query: MarketQuery): MarketSupport {
      const cur = marketOf(query.recipientCountry);
      if (!cur) return unsupportedMarket(id, query, "country_not_supported");
      const presentment = query.presentmentCurrency ?? null;
      const presentmentOk = presentment === null ? null : presentment === cur;
      return {
        provider: id,
        recipientCountry: query.recipientCountry,
        supported: presentmentOk !== false,
        chargeModels: presentmentOk === false ? [] : ["direct"],
        settlementCurrencies: presentmentOk === false ? [] : [cur],
        presentmentCurrencySupported: presentmentOk,
        reason: presentmentOk === false ? "currency_not_supported" : "supported",
      };
    },

    async createPaymentIntent(req: CreatePaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>> {
      if (req.chargeModel !== "direct" || !req.recipientRef) return paymentUnavailable(id, "charge_model_not_supported", "this adapter implements direct charges only (OD-PAY-2)");
      const cur = req.recipientCountry ? marketOf(req.recipientCountry) : null;
      if (!cur) return paymentUnavailable(id, "unsupported_market", `recipients in ${req.recipientCountry ?? "?"} are not served by this adapter`);
      if (cur !== req.amount.currency) return paymentUnavailable(id, "unsupported_currency", `${req.amount.currency} is not charged for a recipient in ${req.recipientCountry}`);
      const fee = platformFeeTotalMinor(req.platformFee);
      const form: Array<[string, string]> = [
        ["amount", String(req.amount.amountMinor)],
        ["currency", req.amount.currency.toLowerCase()],
        ["capture_method", req.capture === "manual" ? "manual" : "automatic"],
        ["automatic_payment_methods[enabled]", "true"],
      ];
      if (fee > 0) form.push(["application_fee_amount", String(fee)]);
      form.push(
        [`metadata[${META.refKind}]`, req.reference.kind],
        [`metadata[${META.refId}]`, req.reference.id],
        [`metadata[${META.service}]`, String(req.components.serviceMinor)],
        [`metadata[${META.payerFee}]`, String(req.components.payerFeeMinor)],
        [`metadata[${META.tip}]`, String(req.components.tipMinor)],
        [`metadata[${META.tax}]`, String(req.components.taxMinor)],
        [`metadata[${META.commission}]`, String(req.platformFee.commissionMinor)],
        [`metadata[${META.platformPayerFee}]`, String(req.platformFee.payerFeeMinor)],
        [`metadata[${META.platformTax}]`, String(req.platformFee.taxMinor)],
      );
      // The payer's profile id is NOT sent: the booking reference is the only subject Stripe holds.
      const r = await send("POST", "/v1/payment_intents", { form, account: req.recipientRef, idempotencyKey: req.idempotencyKey });
      if (!r.ok) return r.refusal;
      const snap = intentSnapshot(r.body, req.recipientRef, { collectedMinor: 0, refundedMinor: 0 }, nowIso());
      return snap ? paymentOk(id, snap) : malformed("payment intent");
    },

    async confirmPaymentIntent(req: ConfirmPaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>> {
      if (req.intent.chargeModel !== "direct" || !req.intent.recipientRef) return paymentUnavailable(id, "charge_model_not_supported", "this adapter implements direct charges only");
      const recipientRef = req.intent.recipientRef;
      const form: Array<[string, string]> = [];
      if (req.paymentMethodRef) form.push(["payment_method", req.paymentMethodRef]);
      if (req.returnUrl) form.push(["return_url", req.returnUrl]);
      const r = await send("POST", `/v1/payment_intents/${encodeURIComponent(req.intent.intentRef)}/confirm`, { form, account: recipientRef, idempotencyKey: req.idempotencyKey });
      if (!r.ok) return declinedFrom(r, recipientRef) ?? r.refusal;
      const snap = intentSnapshot(r.body, recipientRef, null, nowIso());
      if (!snap) return malformed("payment intent");
      if (snap.state === "requires_action") {
        const next = isObj(r.body["next_action"]) ? r.body["next_action"] : {};
        const redirect = isObj(next["redirect_to_url"]) ? str(next["redirect_to_url"]["url"]) : null;
        return paymentRequiresAction(id, "payer_authentication_required", "the payer must authenticate this payment",
          { kind: "payer_authentication", clientSecret: snap.clientSecret ?? "", redirectUrl: redirect }, snap);
      }
      if (snap.state === "requires_payment_method") {
        const err = isObj(r.body["last_payment_error"]) ? r.body["last_payment_error"] : {};
        const reason = declineReasonOf(err["decline_code"] ?? err["code"]);
        return paymentDeclined(id, reason, `Stripe declined the payment (${reason})`, snap);
      }
      // succeeded / processing / requires_capture: read the counters back.
      return readIntentFull(req.intent);
    },

    async capturePaymentIntent(req: CapturePaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>> {
      const before = await readIntentFull(req.intent);
      if (before.status !== "ok") return before;
      const cap = resolveCapture(before.value, req);
      const form: Array<[string, string]> = [["amount_to_capture", String(cap.amountMinor)]];
      const fee = platformFeeTotalMinor(cap.platformFee);
      if (fee > 0) form.push(["application_fee_amount", String(fee)]);
      const r = await send("POST", `/v1/payment_intents/${encodeURIComponent(req.intent.intentRef)}/capture`, { form, account: req.intent.recipientRef, idempotencyKey: req.idempotencyKey });
      if (!r.ok) return r.refusal;
      return readIntentFull(req.intent);
    },

    async cancelPaymentIntent(req: CancelPaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>> {
      if (req.intent.chargeModel !== "direct" || !req.intent.recipientRef) return paymentUnavailable(id, "charge_model_not_supported", "this adapter implements direct charges only");
      // Stripe's reasons: duplicate, fraudulent, requested_by_customer, abandoned. A reason with no honest match is not sent.
      const stripeReason = req.reason === "abandoned" ? "abandoned" : req.reason === "duplicate" ? "duplicate" : req.reason === "requested_by_payer" ? "requested_by_customer" : null;
      const form: Array<[string, string]> = stripeReason ? [["cancellation_reason", stripeReason]] : [];
      const r = await send("POST", `/v1/payment_intents/${encodeURIComponent(req.intent.intentRef)}/cancel`, { form, account: req.intent.recipientRef, idempotencyKey: req.idempotencyKey });
      if (!r.ok) return r.refusal;
      const snap = intentSnapshot(r.body, req.intent.recipientRef, { collectedMinor: 0, refundedMinor: 0 }, nowIso());
      return snap ? paymentOk(id, snap) : malformed("payment intent");
    },

    getPaymentIntent: (h: IntentHandle) => readIntentFull(h),

    async refundPayment(req: RefundPaymentRequest): Promise<PaymentResult<RefundSnapshot>> {
      const before = await readIntentFull(req.intent);
      if (before.status !== "ok") return before.status === "failed" || before.status === "unavailable" ? before : malformed("payment intent");
      const form: Array<[string, string]> = [["payment_intent", req.intent.intentRef]];
      if (req.amountMinor !== "full") form.push(["amount", String(req.amountMinor)]);
      // STATED every time (docs: "Application fees aren't automatically refunded").
      form.push(["refund_application_fee", req.refundPlatformFee ? "true" : "false"]);
      if (req.reason === "duplicate") form.push(["reason", "duplicate"]);
      form.push([`metadata[${META.refundReason}]`, req.reason]);
      const r = await send("POST", "/v1/refunds", { form, account: req.intent.recipientRef, idempotencyKey: req.idempotencyKey });
      if (!r.ok) return r.refusal;
      // The fee refunded by THIS refund is what the platform's application fee says now, less what it said before.
      const after = await readIntentFull(req.intent);
      if (after.status !== "ok") return after.status === "failed" || after.status === "unavailable" ? after : malformed("payment intent");
      const snap = refundSnapshot(r.body, req.intent.recipientRef as string, {
        feeRefundedMinor: Math.max(0, after.value.platformFeeRefundedMinor - before.value.platformFeeRefundedMinor),
        fullyRefunded: after.value.amountCapturedMinor > 0 && after.value.amountRefundedMinor >= after.value.amountCapturedMinor,
        reason: req.reason,
      }, nowIso());
      return snap ? paymentOk(id, snap) : malformed("refund");
    },

    async createRecipient(req: CreateRecipientRequest): Promise<PaymentResult<RecipientSnapshot>> {
      const config = connectAccountConfiguration(env);
      if (!config) return paymentUnavailable(id, "capability_not_supported", CONFIGURATION_UNSET_DETAIL);
      const cur = marketOf(req.country);
      if (!cur) return paymentUnavailable(id, "unsupported_market", `recipients in ${req.country} are not served by this adapter (stripe.com/global)`);
      if (cur !== req.settlementCurrency) return paymentUnavailable(id, "unsupported_currency", `a recipient in ${req.country} is settled in ${cur} by this adapter`);
      const c = STRIPE_CONNECT_ACCOUNT_CONFIGURATIONS[config];
      const form: Array<[string, string]> = [
        ["country", req.country],
        ["default_currency", req.settlementCurrency.toLowerCase()],
        ["business_type", req.entityType],
        ["controller[fees][payer]", c.feesPayer],
        ["controller[losses][payments]", c.lossesPayments],
        ["controller[stripe_dashboard][type]", c.dashboard],
        ["capabilities[card_payments][requested]", "true"],
        ["capabilities[transfers][requested]", "true"],
        // The platform's opaque reference for the recipient (a payment PARTY id on this platform): no name, no email.
        [`metadata[${META.recipient}]`, req.profileId],
      ];
      const r = await send("POST", "/v1/accounts", { form, idempotencyKey: req.idempotencyKey });
      if (!r.ok) return r.refusal;
      const snap = recipientSnapshot(r.body, nowIso());
      if (!snap) return malformed("account");
      if (snap.onboarding === "verified") return paymentOk(id, snap);
      return paymentRequiresAction(id, "recipient_onboarding_required", "the recipient must complete Stripe's hosted onboarding",
        { kind: "recipient_onboarding", url: null, requirementsDue: [...snap.requirementsDue] }, snap);
    },

    async createRecipientOnboardingLink(req: RecipientOnboardingLinkRequest): Promise<PaymentResult<RecipientOnboardingLink>> {
      if (!connectAccountConfiguration(env)) return paymentUnavailable(id, "capability_not_supported", CONFIGURATION_UNSET_DETAIL);
      const form: Array<[string, string]> = [
        ["account", req.recipientRef],
        ["refresh_url", req.refreshUrl],
        ["return_url", req.returnUrl],
        ["type", "account_onboarding"],
      ];
      const r = await send("POST", "/v1/account_links", { form, idempotencyKey: req.idempotencyKey });
      if (!r.ok) return r.refusal;
      const url = str(r.body["url"]);
      const expiresAt = isoFromUnix(r.body["expires_at"]);
      if (!url || !expiresAt) return malformed("account link");
      return paymentOk(id, { recipientRef: req.recipientRef, url, expiresAt });
    },

    async validateRecipient(recipientRef: string): Promise<PaymentResult<RecipientSnapshot>> {
      const r = await send("GET", `/v1/accounts/${encodeURIComponent(recipientRef)}`);
      if (!r.ok) return r.refusal;
      const snap = recipientSnapshot(r.body, nowIso());
      if (!snap) return malformed("account");
      if (snap.onboarding === "rejected") return paymentDeclined(id, "recipient_rejected", "Stripe rejected this connected account", snap);
      if (snap.onboarding === "verified") return paymentOk(id, snap);
      if (snap.onboarding === "pending_verification") {
        return paymentRequiresAction(id, "recipient_verification_pending", "everything due is submitted; Stripe is still verifying",
          { kind: "recipient_onboarding", url: null, requirementsDue: [] }, snap);
      }
      return paymentRequiresAction(id, "recipient_onboarding_required", "the recipient has requirements outstanding with Stripe",
        { kind: "recipient_onboarding", url: null, requirementsDue: [...snap.requirementsDue] }, snap);
    },

    async requestPayout(req: RequestPayoutRequest): Promise<PaymentResult<PayoutSnapshot>> {
      if (req.kind !== "payout") return paymentUnavailable(id, "capability_not_supported", "transfers are not used with direct charges and are not implemented");
      const form: Array<[string, string]> = [
        ["amount", String(req.amount.amountMinor)],
        ["currency", req.amount.currency.toLowerCase()],
        [`metadata[${META.refKind}]`, req.reference.kind],
        [`metadata[${META.refId}]`, req.reference.id],
      ];
      const r = await send("POST", "/v1/payouts", { form, account: req.recipientRef, idempotencyKey: req.idempotencyKey });
      if (!r.ok) {
        const code = safeCode(r.error?.["code"]);
        if (code === "balance_insufficient") return paymentDeclined<PayoutSnapshot>(id, "insufficient_balance", "the connected account's available balance does not cover this payout");
        if (code === "payouts_not_allowed") return paymentDeclined<PayoutSnapshot>(id, "recipient_not_eligible", "Stripe does not allow payouts for this account yet");
        return r.refusal;
      }
      const snap = payoutSnapshot(r.body, req.recipientRef, nowIso());
      return snap ? paymentOk(id, snap) : malformed("payout");
    },

    async getPayoutStatus(h: PayoutHandle): Promise<PaymentResult<PayoutSnapshot>> {
      if (h.kind !== "payout") return paymentUnavailable(id, "capability_not_supported", "transfers are not implemented");
      const r = await send("GET", `/v1/payouts/${encodeURIComponent(h.payoutRef)}`, { account: h.recipientRef });
      if (!r.ok) return r.refusal;
      const snap = payoutSnapshot(r.body, h.recipientRef, nowIso());
      return snap ? paymentOk(id, snap) : malformed("payout");
    },

    async reverseOrHoldPayout(req: ReverseOrHoldPayoutRequest): Promise<PaymentResult<PayoutSnapshot>> {
      if (req.action !== "reverse") {
        return paymentUnavailable(id, "capability_not_supported", "Stripe has no hold on a payout: Portava holds one by not requesting it (bookingPayments/payouts.ts)");
      }
      if (req.payout.kind !== "payout") return paymentUnavailable(id, "capability_not_supported", "transfers are not implemented");
      // A pending payout is cancelled whole (Stripe: only a `pending` payout can be cancelled).
      const r = await send("POST", `/v1/payouts/${encodeURIComponent(req.payout.payoutRef)}/cancel`, { account: req.payout.recipientRef, idempotencyKey: req.idempotencyKey });
      if (!r.ok) return r.refusal;
      const snap = payoutSnapshot(r.body, req.payout.recipientRef, nowIso());
      return snap ? paymentOk(id, snap) : malformed("payout");
    },

    async verifyAndParseWebhook(delivery: WebhookDelivery): Promise<PaymentResult<PaymentWebhookEvent>> {
      const secret = env[delivery.endpoint === "connect" ? PAYMENT_CONNECT_WEBHOOK_SECRET_ENV.stripe : PAYMENT_WEBHOOK_SECRET_ENV.stripe];
      // 1. the signature over the RAW body, with THIS endpoint's secret
      const bad = verifyPaymentWebhookSignature({ provider: id, delivery, headerName: "stripe-signature", secret, nowMs: nowMs() });
      if (bad) return bad;
      // 2. parse
      let event: unknown;
      try {
        event = JSON.parse(delivery.rawBody);
      } catch {
        return paymentFailed(id, "webhook_malformed", "the verified body is not JSON");
      }
      if (!isObj(event) || !str(event["id"]) || !str(event["type"]) || typeof event["created"] !== "number" || !isObj(event["data"]) || !isObj((event["data"] as Obj)["object"])) {
        return paymentFailed(id, "webhook_malformed", "the verified body is not a Stripe event");
      }
      // 3. mode: a live event is refused in this TEST-MODE adapter (and by the shared rule)
      if (event["livemode"] === true || webhookLivemodeRefused(event["livemode"], env)) {
        return paymentUnavailable(id, "livemode_not_allowed", "a live-mode event reached a test-mode adapter; refused");
      }
      // 4. normalise
      const type = event["type"] as string;
      const object = (event["data"] as Obj)["object"] as Obj;
      const accountRef = str(event["account"]);
      const occurredAt = isoFromUnix(event["created"]) as string;
      const base = { provider: id, providerEventId: event["id"] as string, endpoint: delivery.endpoint, providerEventType: type, livemode: false, occurredAt, accountRef };
      const done = (body: PaymentWebhookBody): PaymentResult<PaymentWebhookEvent> => paymentOk(id, { ...base, body });

      // Intents and charges: the event's object lacks the refunded and fee counters, so the intent is RE-READ
      // (providerRegistry.ts checklist item 7), stamped with the event's own time.
      const intentRef = type.startsWith("payment_intent.") ? str(object["id"]) : type.startsWith("charge.") && !type.startsWith("charge.dispute.") ? str(object["payment_intent"]) : null;
      if (intentRef) {
        if (!accountRef) return done({ kind: "ignored" }); // a platform-account charge: not one this direct-charge adapter makes
        const read = await readIntentFull({ intentRef, chargeModel: "direct", recipientRef: accountRef }, occurredAt);
        if (read.status === "ok") return done({ kind: "payment_intent", intent: read.value });
        if (read.status === "failed" && (read.reason === "not_found" || read.reason === "provider_error")) return done({ kind: "ignored" });
        return read.status === "failed" || read.status === "unavailable" ? read : paymentFailed(id, "provider_error", "the intent could not be re-read", true);
      }
      if (type.startsWith("refund.") || type === "charge.refund.updated") {
        if (!accountRef) return done({ kind: "ignored" });
        const piRef = str(object["payment_intent"]);
        let fully = false;
        if (piRef) {
          const read = await readIntentFull({ intentRef: piRef, chargeModel: "direct", recipientRef: accountRef }, occurredAt);
          if (read.status === "ok") fully = read.value.amountCapturedMinor > 0 && read.value.amountRefundedMinor >= read.value.amountCapturedMinor;
        }
        // The fee a single refund returned is not on the refund object; the MONEY is booked from the intent's counters.
        const snap = refundSnapshot(object, accountRef, { feeRefundedMinor: 0, fullyRefunded: fully }, occurredAt);
        return done(snap ? { kind: "refund", refund: snap } : { kind: "ignored" });
      }
      if (type === "account.updated") {
        const snap = recipientSnapshot(object, occurredAt);
        return done(snap ? { kind: "recipient", recipient: snap } : { kind: "ignored" });
      }
      if (type.startsWith("payout.")) {
        if (!accountRef) return done({ kind: "ignored" }); // the platform's own payouts are not a recipient's
        const snap = payoutSnapshot(object, accountRef, occurredAt);
        return done(snap ? { kind: "payout", payout: snap } : { kind: "ignored" });
      }
      if (type.startsWith("charge.dispute.")) {
        const snap = disputeSnapshot(object, accountRef, occurredAt);
        return done(snap ? { kind: "dispute", dispute: snap } : { kind: "ignored" });
      }
      return done({ kind: "ignored" });
    },
  };
  return Object.freeze(provider);
}

/** A provider CODE as it may be logged: lowercase token characters only, bounded. */
function safeCode(v: unknown): string | null {
  return typeof v === "string" && /^[a-z0-9_.]{1,64}$/.test(v) ? v : null;
}
