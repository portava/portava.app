/**
 * FakePaymentProvider — a deterministic, in-memory PaymentProvider.
 *
 * It exists so that everything built on the contract (checkout, the webhook
 * route, payouts, reconciliation) can be exercised end to end with no account,
 * no key and no network, and so that the failure paths — which are the common
 * case in money — can be produced on demand instead of waited for.
 *
 * ── WHAT IT GUARANTEES ───────────────────────────────────────────────────────
 *   • DETERMINISTIC. Ids come from counters (`fake_pi_000001`), time from an
 *     internal clock that starts at a fixed instant and advances one second per
 *     change. No wall clock, no randomness: the same calls give the same answers.
 *   • NO I/O. It opens no socket and reads no file. `node:crypto` is used to
 *     sign and verify its own webhooks (HMAC), which is arithmetic.
 *   • IT ENFORCES THE CONTRACT. Every request goes through the same validators
 *     a real adapter runs behind — the create-time fee and tax rules, and
 *     `validateCapturePaymentIntent` for a partial capture's fee — idempotency
 *     keys replay or conflict, money is conserved across its balances, and
 *     webhooks are signed and verified through the same verifier the real
 *     adapters use, with one secret per endpoint.
 *
 * ── WHERE IT MAY RUN ─────────────────────────────────────────────────────────
 * Refused in production, whenever REPLIT_DEPLOYMENT is defined (even empty),
 * and in any process with no local-run signal — `lib/paymentsMode.ts
 * fakePaymentProviderPermitted`, which IS the mock identity provider's rule
 * (`mockIdentityPermitted`), not a copy of it. The registry refuses to hand the
 * fake out, and — because an instance can be constructed directly — every
 * operation checks again at call time and answers `unavailable /
 * fake_not_permitted`. THE HOSTED TESTING APP IS A REPLIT DEPLOYMENT, so the
 * fake cannot run there: testers exercise payments only once a real test-mode
 * adapter is registered.
 *
 * ── WHAT CAN BE SCRIPTED (`control.script`) ──────────────────────────────────
 *   declineNextConfirm        the next confirm is declined
 *   requireActionOnNextConfirm the next confirm needs the payer to authenticate
 *   failNextPayout            the next payout is rejected at request, or fails
 *                             after it was instructed (funds return to balance)
 *   returnNextPayout          the next payout is paid, then returned
 *   failNextOperation         the next call of one operation is `unavailable`
 * and through `control`: finish or fail a payer authentication, move a
 * recipient through onboarding, step a payout along its path, have the provider
 * start a payout of its own, open and resolve a dispute, and hand webhook
 * deliveries out late, twice and out of order (`control.webhooks.deliver`),
 * including one that claims `livemode: true`.
 *
 * ── FAKE DATA ────────────────────────────────────────────────────────────────
 * The market table and the exchange rates below describe NO real provider and
 * NO real market. They exist so the contract's three market answers can each be
 * produced: a country with direct charges, a country without them, and a
 * country that is not supported at all.
 */

import crypto from "node:crypto";

import { fakePaymentProviderPermitted, webhookLivemodeRefused } from "../../lib/paymentsMode.js";
import { canonicalJson } from "./paymentEventFold.js";
import { verifyPaymentWebhookSignature } from "./paymentWebhookSignature.js";
import {
  isIdempotencyKey,
  isPaymentWebhookBody,
  minorUnitExponent,
  paymentDeclined,
  paymentFailed,
  paymentOk,
  paymentRequiresAction,
  paymentUnavailable,
  resolveCapture,
  unsupportedMarket,
  validateCancelPaymentIntent,
  validateCapturePaymentIntent,
  validateConfirmPaymentIntent,
  validateCreatePaymentIntent,
  validateCreateRecipient,
  validateRecipientOnboardingLink,
  validateRefundAgainstIntent,
  validateRefundPayment,
  validateRequestPayout,
  validateReverseOrHoldPayout,
  validateWebhookDelivery,
  platformFeeTotalMinor,
  type AmountComponents,
  type CancelPaymentIntentRequest,
  type CapturePaymentIntentRequest,
  type CaptureMethod,
  type ChargeModel,
  type ConfirmPaymentIntentRequest,
  type CreatePaymentIntentRequest,
  type CreateRecipientRequest,
  type CurrencyConversion,
  type DeclineReason,
  type DisputeSnapshot,
  type DisputeState,
  type IntentHandle,
  type MarketQuery,
  type MarketSupport,
  type Money,
  type PaymentIntentSnapshot,
  type PaymentIntentState,
  type PaymentProvider,
  type PaymentProviderCapabilities,
  type PaymentProviderOperation,
  type PaymentReference,
  type PaymentRefusal,
  type PaymentResult,
  type PaymentWebhookBody,
  type PaymentWebhookEvent,
  type PayoutHandle,
  type PayoutKind,
  type PayoutSnapshot,
  type PayoutState,
  type PlatformFee,
  type PlatformFeeSettlement,
  type RecipientOnboardingLink,
  type RecipientOnboardingLinkRequest,
  type RecipientOnboardingState,
  type RecipientSnapshot,
  type RefundPaymentRequest,
  type RefundSnapshot,
  type RequestPayoutRequest,
  type ReverseOrHoldPayoutRequest,
  type SettlementDetails,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "./PaymentProvider.js";

export const FAKE_PAYMENT_PROVIDER_ID = "fake" as const;

/** The fake's webhook signing secrets, one per endpoint. Not credentials: they sign events that never leave the process. */
export const FAKE_WEBHOOK_SECRET = "whsec_fake_local_run_only";
export const FAKE_CONNECT_WEBHOOK_SECRET = "whsec_fake_connect_local_run_only";
export const FAKE_SIGNATURE_HEADER = "fake-signature";

/** 2026-01-01T00:00:00.000Z — where the fake's clock starts. */
export const FAKE_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export interface FakeMarket {
  /** Charge models available to recipients in this country. */
  readonly chargeModels: readonly ChargeModel[];
  readonly settlementCurrencies: readonly string[];
  /** Currencies a payer can be charged in for a recipient in this country. */
  readonly presentmentCurrencies: readonly string[];
}

/** FAKE DATA — see the header. US and GB offer direct charges; JP offers destination charges only; nowhere else is supported. */
export const FAKE_DEFAULT_MARKETS: Readonly<Record<string, FakeMarket>> = Object.freeze({
  US: Object.freeze({ chargeModels: ["direct", "destination"] as const, settlementCurrencies: ["USD"], presentmentCurrencies: ["USD", "EUR", "GBP", "JPY", "KWD"] }),
  GB: Object.freeze({ chargeModels: ["direct", "destination"] as const, settlementCurrencies: ["GBP", "EUR"], presentmentCurrencies: ["USD", "EUR", "GBP"] }),
  JP: Object.freeze({ chargeModels: ["destination"] as const, settlementCurrencies: ["JPY"], presentmentCurrencies: ["JPY", "USD"] }),
});

/** FAKE DATA — decimal strings, major units of the second currency per one of the first. */
export const FAKE_DEFAULT_RATES: Readonly<Record<string, string>> = Object.freeze({
  "EUR>USD": "1.10",
  "USD>EUR": "0.90",
  "GBP>USD": "1.25",
  "USD>GBP": "0.80",
  "USD>JPY": "150",
  "JPY>USD": "0.0066",
  "KWD>USD": "3.25",
});

export const FAKE_CAPABILITIES: PaymentProviderCapabilities = Object.freeze({
  chargeModels: Object.freeze(["direct", "destination", "platform"]) as readonly ChargeModel[],
  manualCapture: true,
  partialCapture: true,
  partialRefund: true,
  platformFeeRefund: true,
  connectedAccounts: true,
  transfers: true,
  payouts: true,
  payoutHold: true,
  payoutReversal: true,
  currencyConversion: true,
  signedWebhooks: true,
});

export interface FakePaymentProviderOptions {
  /** Read at CALL time; the fake refuses unless this env is a local run. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  markets?: Readonly<Record<string, FakeMarket>>;
  rates?: Readonly<Record<string, string>>;
  /** Override capability flags, e.g. a provider with no direct charges. */
  capabilities?: Partial<PaymentProviderCapabilities>;
  /**
   * The fake's OWN processing fee, in basis points of the captured amount
   * (rounded down). Default 0. Debited from the recipient under direct charges
   * and from the platform otherwise, and reported as `settlement.providerFee`.
   */
  processingFeeBps?: number;
  /**
   * The currency of the platform's balance with the fake. Default: none — the
   * platform's fee stays in each charge's own currency. When set, the fee is
   * converted and `settlement.platformFeeSettled` carries the rate applied.
   */
  platformSettlementCurrency?: string;
}

export interface FakeDeliveryPlan {
  /**
   * Indexes into the PENDING events (emission order, 0 = oldest) to hand out
   * now, in this order. An index may repeat (delivered twice). A pending event
   * that is not listed stays pending and arrives LATE, on a later call.
   * Default: every pending event, oldest first.
   */
  readonly order?: readonly number[];
  /** Hand each chosen delivery out this many EXTRA times. */
  readonly duplicates?: number;
  /** Claim live mode on the envelope of the chosen deliveries (signed, so it verifies). */
  readonly livemode?: boolean;
}

export interface FakePendingEvent {
  readonly index: number;
  readonly providerEventId: string;
  readonly providerEventType: string;
  /** The endpoint the event will be delivered on: `connect` for events about a recipient's account. */
  readonly endpoint: WebhookEndpoint;
}

export interface FakePaymentScript {
  declineNextConfirm(reason?: DeclineReason): void;
  requireActionOnNextConfirm(): void;
  /** `at_request`: the next payout or transfer is rejected outright. `after_instruction`: the next payout is accepted, then fails in transit. */
  failNextPayout(when: "at_request" | "after_instruction", failureCode?: string): void;
  /** The next payout is paid and then returned by the bank. */
  returnNextPayout(failureCode?: string): void;
  /** The next call of `operation` answers `unavailable` with this reason (retriable). */
  failNextOperation(operation: PaymentProviderOperation, reason: "provider_unreachable" | "rate_limited"): void;
}

export interface FakeBalances {
  /** The platform's balance with the fake provider, by currency. */
  readonly platform: Readonly<Record<string, number>>;
  /** Each recipient's balance with the fake provider, by currency. */
  readonly recipients: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Paid out to recipients' banks, by currency. */
  readonly paidOut: Readonly<Record<string, number>>;
  /** The fake's own processing fees taken, by currency. */
  readonly providerFees: Readonly<Record<string, number>>;
}

export interface FakePaymentControl {
  readonly script: FakePaymentScript;
  /** The payer finishes (or fails) the authentication a `requires_action` confirm asked for. */
  completePayerAction(intentRef: string, outcome: "authenticated" | "failed"): PaymentIntentSnapshot;
  /** Move a recipient through onboarding, as the provider's review would. */
  setRecipientOnboarding(recipientRef: string, state: RecipientOnboardingState, requirementsDue?: readonly string[]): RecipientSnapshot;
  /** Step a payout one state along its (possibly scripted) path. */
  advancePayout(payoutRef: string): PayoutSnapshot;
  /**
   * The PROVIDER starts a payout of a recipient's balance on its own schedule.
   * The platform did not ask for it, so its snapshot has `reference: null`.
   */
  providerInitiatedPayout(recipientRef: string, amountMinor: number): PayoutSnapshot;
  /**
   * Open a dispute on a captured payment, for the amount not yet refunded. The
   * fake REPORTS disputes (as webhook events) and moves no balance for them:
   * who is debited for a dispute depends on the charge model and the account
   * type, which an adapter — not the fake — must get right.
   */
  openDispute(intentRef: string, reasonCode?: string): DisputeSnapshot;
  resolveDispute(disputeRef: string, outcome: "won" | "lost"): DisputeSnapshot;
  /** Add available funds to the platform's balance, so a transfer can be made. */
  fundPlatformBalance(money: Money): void;
  setRate(fromCurrency: string, toCurrency: string, rate: string | null): void;
  balances(): FakeBalances;
  /** The fake clock, ms since epoch. */
  nowMs(): number;
  advanceClock(ms: number): void;
  readonly webhooks: {
    /** Events emitted and not yet handed out, oldest first. */
    pending(): readonly FakePendingEvent[];
    /** Hand out signed deliveries. See `FakeDeliveryPlan` for late / twice / out of order. */
    deliver(plan?: FakeDeliveryPlan): WebhookDelivery[];
    /** Sign an already-delivered event again, as a provider retry would. */
    redeliver(providerEventId: string): WebhookDelivery;
    /** Sign an arbitrary body with one endpoint's secret — for a verified-but-unreadable delivery. */
    signRawBody(rawBody: string, endpoint?: WebhookEndpoint): WebhookDelivery;
  };
}

export interface FakePaymentProvider extends PaymentProvider {
  readonly control: FakePaymentControl;
}

// ── internal records (mutable; snapshots handed out are frozen copies) ───────

interface IntentRecord {
  intentRef: string;
  chargeModel: ChargeModel;
  recipientRef: string | null;
  reference: PaymentReference;
  state: PaymentIntentState;
  amount: Money;
  components: AmountComponents;
  platformFee: PlatformFee;
  capture: CaptureMethod;
  amountCapturableMinor: number;
  amountCapturedMinor: number;
  amountRefundedMinor: number;
  platformFeeCollectedMinor: number;
  platformFeeRefundedMinor: number;
  settlement: SettlementDetails | null;
  clientSecret: string;
  updatedAt: string;
}

interface RecipientRecord {
  recipientRef: string;
  profileId: string;
  country: string;
  settlementCurrency: string;
  onboarding: RecipientOnboardingState;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  requirementsDeadline: string | null;
  disabledReason: string | null;
  updatedAt: string;
}

interface PayoutRecord {
  payoutRef: string;
  kind: PayoutKind;
  recipientRef: string;
  reference: PaymentReference | null;
  state: PayoutState;
  amount: Money;
  amountReversedMinor: number;
  /** For a transfer: how much of what landed on the recipient's balance has been taken back. */
  settledReversedMinor: number;
  settlement: SettlementDetails | null;
  failureCode: string | null;
  expectedArrivalAt: string | null;
  /** States still to come, in order, when stepped by `advancePayout`. */
  path: PayoutState[];
  pendingFailureCode: string | null;
  updatedAt: string;
}

interface DisputeRecord {
  disputeRef: string;
  intentRef: string;
  recipientRef: string | null;
  state: DisputeState;
  amount: Money;
  reasonCode: string;
  updatedAt: string;
}

interface OutboxEvent {
  providerEventId: string;
  providerEventType: string;
  occurredAt: string;
  accountRef: string | null;
  endpoint: WebhookEndpoint;
  body: PaymentWebhookBody;
}

type Converted = { ok: true; settled: Money; conversion: CurrencyConversion | null } | { ok: false };

const ONBOARDING_REQUIREMENTS = ["fake.identity_document", "fake.payout_account"] as const;

/** amountMinor × rate, re-scaled between the two currencies' exponents, rounded half up — in integers. */
function convertMinor(amountMinor: number, rate: string, fromExponent: number, toExponent: number): number | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!m) return null;
  const fraction = m[2] ?? "";
  const numerator = BigInt(`${m[1]}${fraction}`) * BigInt(amountMinor) * 10n ** BigInt(toExponent);
  const denominator = 10n ** BigInt(fraction.length) * 10n ** BigInt(fromExponent);
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
}

/**
 * Build a fake provider with its own private state. `providerRegistry.ts`
 * holds the one the server uses in a local run; tests build their own.
 */
export function createFakePaymentProvider(options: FakePaymentProviderOptions = {}): FakePaymentProvider {
  const id = FAKE_PAYMENT_PROVIDER_ID;
  const env = (): NodeJS.ProcessEnv => options.env ?? process.env;
  const markets = options.markets ?? FAKE_DEFAULT_MARKETS;
  const capabilities: PaymentProviderCapabilities = Object.freeze({ ...FAKE_CAPABILITIES, ...(options.capabilities ?? {}) });
  const rates = new Map<string, string>(Object.entries(options.rates ?? FAKE_DEFAULT_RATES));
  const processingFeeBps = options.processingFeeBps ?? 0;
  const platformCurrency = options.platformSettlementCurrency ?? null;

  let clockMs = FAKE_EPOCH_MS;
  const counters: Record<string, number> = {};
  const intents = new Map<string, IntentRecord>();
  const recipients = new Map<string, RecipientRecord>();
  const payouts = new Map<string, PayoutRecord>();
  const disputes = new Map<string, DisputeRecord>();
  const refunds = new Map<string, RefundSnapshot>();
  const idempotent = new Map<string, { fingerprint: string; result: PaymentResult<unknown> }>();
  const platformBalance = new Map<string, number>();
  const recipientBalances = new Map<string, Map<string, number>>();
  const paidOut = new Map<string, number>();
  const providerFees = new Map<string, number>();
  const outbox: OutboxEvent[] = [];
  const history = new Map<string, OutboxEvent>();

  const scripted = {
    confirm: [] as Array<{ kind: "decline"; reason: DeclineReason } | { kind: "requires_action" }>,
    payoutAtRequest: [] as string[],
    payoutPath: [] as Array<{ path: PayoutState[]; failureCode: string }>,
    operations: new Map<PaymentProviderOperation, Array<"provider_unreachable" | "rate_limited">>(),
  };

  // ── primitives ────────────────────────────────────────────────────────────
  const tick = (): string => {
    clockMs += 1000;
    return new Date(clockMs).toISOString();
  };
  const nextRef = (prefix: string): string => {
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return `fake_${prefix}_${String(counters[prefix]).padStart(6, "0")}`;
  };
  const marketOf = (country: string): FakeMarket | undefined =>
    Object.prototype.hasOwnProperty.call(markets, country) ? markets[country] : undefined;
  const credit = (book: Map<string, number>, currency: string, minor: number): void => {
    book.set(currency, (book.get(currency) ?? 0) + minor);
  };
  const recipientBook = (recipientRef: string): Map<string, number> => {
    let book = recipientBalances.get(recipientRef);
    if (!book) {
      book = new Map();
      recipientBalances.set(recipientRef, book);
    }
    return book;
  };

  /** Convert a non-negative amount. A missing rate is a refusal (`ok: false`), never a guess. */
  const convert = (money: Money, toCurrency: string): Converted => {
    if (money.currency === toCurrency) return { ok: true, settled: money, conversion: null };
    const rate = rates.get(`${money.currency}>${toCurrency}`);
    if (rate === undefined) return { ok: false };
    const settledMinor = convertMinor(money.amountMinor, rate, minorUnitExponent(money.currency), minorUnitExponent(toCurrency));
    if (settledMinor === null) return { ok: false };
    return {
      ok: true,
      settled: { amountMinor: settledMinor, currency: toCurrency },
      conversion: { fromCurrency: money.currency, toCurrency, rate, rateSource: id, rateAt: new Date(clockMs).toISOString() },
    };
  };
  /** What an amount in a charge's currency is on the PLATFORM's balance. */
  const onPlatform = (money: Money): Converted => convert(money, platformCurrency ?? money.currency);
  const noRate = (from: string, to: string): PaymentRefusal =>
    paymentUnavailable(id, "unsupported_currency", `no rate from ${from} to ${to}; a missing rate is a refusal, not a guess`);

  const intentSnapshot = (r: IntentRecord): PaymentIntentSnapshot =>
    Object.freeze({
      intentRef: r.intentRef,
      chargeModel: r.chargeModel,
      recipientRef: r.recipientRef,
      reference: r.reference,
      state: r.state,
      amount: r.amount,
      components: r.components,
      platformFee: r.platformFee,
      capture: r.capture,
      amountCapturableMinor: r.amountCapturableMinor,
      amountCapturedMinor: r.amountCapturedMinor,
      amountRefundedMinor: r.amountRefundedMinor,
      platformFeeCollectedMinor: r.platformFeeCollectedMinor,
      platformFeeRefundedMinor: r.platformFeeRefundedMinor,
      settlement: r.settlement,
      clientSecret: r.state === "succeeded" || r.state === "canceled" ? null : r.clientSecret,
      livemode: false,
      updatedAt: r.updatedAt,
    });
  const recipientSnapshot = (r: RecipientRecord): RecipientSnapshot =>
    Object.freeze({
      recipientRef: r.recipientRef,
      profileId: r.profileId,
      country: r.country,
      settlementCurrency: r.settlementCurrency,
      onboarding: r.onboarding,
      chargesEnabled: r.chargesEnabled,
      payoutsEnabled: r.payoutsEnabled,
      requirementsDue: Object.freeze([...r.requirementsDue]),
      requirementsDeadline: r.requirementsDeadline,
      disabledReason: r.disabledReason,
      livemode: false,
      updatedAt: r.updatedAt,
    });
  const payoutSnapshot = (r: PayoutRecord): PayoutSnapshot =>
    Object.freeze({
      payoutRef: r.payoutRef,
      kind: r.kind,
      recipientRef: r.recipientRef,
      reference: r.reference,
      state: r.state,
      amount: r.amount,
      amountReversedMinor: r.amountReversedMinor,
      settlement: r.settlement,
      failureCode: r.failureCode,
      expectedArrivalAt: r.expectedArrivalAt,
      livemode: false,
      updatedAt: r.updatedAt,
    });
  const disputeSnapshot = (r: DisputeRecord): DisputeSnapshot =>
    Object.freeze({
      disputeRef: r.disputeRef,
      intentRef: r.intentRef,
      recipientRef: r.recipientRef,
      state: r.state,
      amount: r.amount,
      reasonCode: r.reasonCode,
      livemode: false,
      updatedAt: r.updatedAt,
    });

  // An event about an object on a RECIPIENT's account is delivered on the connect endpoint.
  const emit = (providerEventType: string, accountRef: string | null, body: PaymentWebhookBody): void => {
    const event: OutboxEvent = {
      providerEventId: nextRef("evt"),
      providerEventType,
      occurredAt: new Date(clockMs).toISOString(),
      accountRef,
      endpoint: accountRef === null ? "platform" : "connect",
      body,
    };
    outbox.push(event);
    history.set(event.providerEventId, event);
  };
  const emitIntent = (type: string, r: IntentRecord): void =>
    emit(`payment_intent.${type}`, r.chargeModel === "direct" ? r.recipientRef : null, { kind: "payment_intent", intent: intentSnapshot(r) });
  const emitRecipient = (type: string, r: RecipientRecord): void =>
    emit(`recipient.${type}`, r.recipientRef, { kind: "recipient", recipient: recipientSnapshot(r) });
  const emitPayout = (type: string, r: PayoutRecord): void =>
    emit(`${r.kind}.${type}`, r.kind === "payout" ? r.recipientRef : null, { kind: "payout", payout: payoutSnapshot(r) });

  const secretFor = (endpoint: WebhookEndpoint): string => (endpoint === "connect" ? FAKE_CONNECT_WEBHOOK_SECRET : FAKE_WEBHOOK_SECRET);
  const sign = (rawBody: string, endpoint: WebhookEndpoint): WebhookDelivery => {
    const t = Math.floor(clockMs / 1000);
    const v1 = crypto.createHmac("sha256", secretFor(endpoint)).update(`${t}.${rawBody}`, "utf8").digest("hex");
    return { rawBody, headers: { [FAKE_SIGNATURE_HEADER]: `t=${t},v1=${v1}` }, endpoint };
  };
  const envelope = (e: OutboxEvent, livemode: boolean): string =>
    JSON.stringify({
      id: e.providerEventId,
      type: e.providerEventType,
      livemode,
      created: e.occurredAt,
      account: e.accountRef,
      data: e.body,
    });

  // ── gates every operation passes, in this order ───────────────────────────
  const gate = (operation: PaymentProviderOperation): PaymentRefusal | null => {
    if (!fakePaymentProviderPermitted(env())) {
      return paymentUnavailable(
        id,
        "fake_not_permitted",
        "the fake payment provider is refused in production, on a hosted deployment, and without a local-run signal",
      );
    }
    const queue = scripted.operations.get(operation);
    const reason = queue?.shift();
    if (reason) return paymentUnavailable(id, reason, `scripted: ${operation} is unavailable`, true);
    return null;
  };

  /** Replay a key's original answer, refuse the key for a different request, or run and remember. */
  const once = <T>(operation: PaymentProviderOperation, key: unknown, request: unknown, run: () => PaymentResult<T>): PaymentResult<T> => {
    if (!isIdempotencyKey(key)) return paymentFailed(id, "invalid_request", "idempotencyKey must be a non-empty string of at most 255 characters");
    const slot = `${operation}:${key}`;
    const fingerprint = canonicalJson(request);
    const held = idempotent.get(slot);
    if (held) {
      if (held.fingerprint !== fingerprint) {
        return paymentFailed(id, "idempotency_conflict", "this idempotency key was used with a different request");
      }
      return held.result as PaymentResult<T>;
    }
    const result = run();
    // A refusal that changed nothing may be retried under the same key once the cause is fixed.
    if (result.status === "unavailable" || (result.status === "failed" && result.retriable)) return result;
    idempotent.set(slot, { fingerprint, result });
    return result;
  };

  const findIntent = (handle: IntentHandle): IntentRecord | PaymentRefusal => {
    const r = handle && typeof handle.intentRef === "string" ? intents.get(handle.intentRef) : undefined;
    if (!r || r.recipientRef !== handle.recipientRef || r.chargeModel !== handle.chargeModel) {
      return paymentFailed(id, "not_found", "no such payment intent for this recipient and charge model");
    }
    return r;
  };
  const findPayout = (handle: PayoutHandle): PayoutRecord | PaymentRefusal => {
    const p = handle && typeof handle.payoutRef === "string" ? payouts.get(handle.payoutRef) : undefined;
    if (!p || p.recipientRef !== handle.recipientRef || p.kind !== handle.kind) return paymentFailed(id, "not_found", "no such payout for this recipient");
    return p;
  };
  const isRefusal = (v: object): v is PaymentRefusal => "status" in v;

  /**
   * Money has moved. Take the platform's fee and the fake's own processing fee,
   * credit the receiving balance, and record all of it on the settlement.
   *
   *   direct       recipient gets capture − platform fee − processing fee
   *   destination  recipient gets capture − platform fee; the platform pays the processing fee
   *   platform     the platform gets capture − processing fee
   */
  const settleCapture = (r: IntentRecord, captureMinor: number, fee: PlatformFee): PaymentRefusal | null => {
    const currency = r.amount.currency;
    const feeMinor = platformFeeTotalMinor(fee);
    const processingMinor = Number((BigInt(captureMinor) * BigInt(processingFeeBps)) / 10000n);
    const recipient = r.recipientRef === null ? null : (recipients.get(r.recipientRef) as RecipientRecord);
    const recipientPays = recipient !== null && r.chargeModel === "direct";
    const recipientNetMinor = recipient ? captureMinor - feeMinor - (recipientPays ? processingMinor : 0) : 0;
    if (recipientNetMinor < 0) return paymentFailed(id, "invalid_amount", "the fees exceed the captured amount");

    // Work every conversion out first, so a missing rate changes nothing.
    const platformIn = platformCurrency ?? currency;
    const toRecipient = recipient ? convert({ amountMinor: recipientNetMinor, currency }, recipient.settlementCurrency) : null;
    if (recipient && (!toRecipient || !toRecipient.ok)) return noRate(currency, recipient.settlementCurrency);
    const toPlatform = onPlatform({ amountMinor: recipient ? feeMinor : captureMinor, currency });
    if (!toPlatform.ok) return noRate(currency, platformIn);
    const processing = convert({ amountMinor: processingMinor, currency }, recipientPays && recipient ? recipient.settlementCurrency : platformIn);
    if (!processing.ok) return noRate(currency, recipientPays && recipient ? recipient.settlementCurrency : platformIn);

    credit(platformBalance, toPlatform.settled.currency, toPlatform.settled.amountMinor);
    if (!recipientPays) credit(platformBalance, processing.settled.currency, -processing.settled.amountMinor);
    credit(providerFees, processing.settled.currency, processing.settled.amountMinor);
    const providerFee = { amount: processing.settled, paidBy: recipientPays ? ("recipient" as const) : ("platform" as const) };
    if (recipient && toRecipient && toRecipient.ok) {
      credit(recipientBook(recipient.recipientRef), toRecipient.settled.currency, toRecipient.settled.amountMinor);
      const platformFeeSettled: PlatformFeeSettlement = { settled: toPlatform.settled, conversion: toPlatform.conversion };
      r.settlement = { settled: toRecipient.settled, conversion: toRecipient.conversion, providerFee, platformFeeSettled };
    } else {
      r.settlement = {
        settled: { amountMinor: toPlatform.settled.amountMinor - processing.settled.amountMinor, currency: toPlatform.settled.currency },
        conversion: toPlatform.conversion,
        providerFee,
        platformFeeSettled: null,
      };
    }
    r.amountCapturedMinor = captureMinor;
    r.amountCapturableMinor = 0;
    r.platformFeeCollectedMinor = feeMinor;
    r.state = "succeeded";
    r.updatedAt = tick();
    emitIntent("succeeded", r);
    return null;
  };

  /** The payer's payment method was accepted: capture now, or hold for a manual capture. */
  const authorise = (r: IntentRecord): PaymentRefusal | null => {
    if (r.capture === "automatic") return settleCapture(r, r.amount.amountMinor, r.platformFee);
    r.state = "requires_capture";
    r.amountCapturableMinor = r.amount.amountMinor;
    r.updatedAt = tick();
    emitIntent("amount_capturable_updated", r);
    return null;
  };

  const requireControl = <T>(found: T | undefined, what: string): T => {
    if (found === undefined) throw new Error(`fake payment provider: unknown ${what}`);
    return found;
  };

  const newPayout = (recipient: RecipientRecord, amount: Money, reference: PaymentReference | null): PayoutRecord => {
    credit(recipientBook(recipient.recipientRef), amount.currency, -amount.amountMinor);
    const script = scripted.payoutPath.shift();
    const p: PayoutRecord = {
      payoutRef: nextRef("po"),
      kind: "payout",
      recipientRef: recipient.recipientRef,
      reference,
      state: "pending",
      amount: { amountMinor: amount.amountMinor, currency: amount.currency },
      amountReversedMinor: 0,
      settledReversedMinor: 0,
      settlement: null,
      failureCode: null,
      expectedArrivalAt: new Date(clockMs + 2 * 86_400_000).toISOString(),
      path: script ? [...script.path] : ["in_transit", "paid"],
      pendingFailureCode: script ? script.failureCode : null,
      updatedAt: tick(),
    };
    payouts.set(p.payoutRef, p);
    emitPayout("created", p);
    return p;
  };

  // ── the provider ──────────────────────────────────────────────────────────
  const provider: PaymentProvider = {
    id,
    capabilities: () => capabilities,

    marketSupport(query: MarketQuery): MarketSupport {
      const m = marketOf(query.recipientCountry);
      if (!m) return unsupportedMarket(id, query, "country_not_supported");
      const chargeModels = m.chargeModels.filter((c) => capabilities.chargeModels.includes(c));
      const asked = query.presentmentCurrency ?? null;
      const presentmentCurrencySupported = asked === null ? null : m.presentmentCurrencies.includes(asked);
      const supported = presentmentCurrencySupported !== false;
      return {
        provider: id,
        recipientCountry: query.recipientCountry,
        supported,
        chargeModels: supported ? chargeModels : [],
        settlementCurrencies: supported ? m.settlementCurrencies : [],
        presentmentCurrencySupported,
        reason: supported ? "supported" : "currency_not_supported",
      };
    },

    async createPaymentIntent(req: CreatePaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>> {
      const refused = gate("createPaymentIntent") ?? validateCreatePaymentIntent(id, req);
      if (refused) return refused;
      return once("createPaymentIntent", req.idempotencyKey, req, () => {
        if (!capabilities.chargeModels.includes(req.chargeModel)) {
          return paymentUnavailable(id, "charge_model_not_supported", `this provider cannot create ${req.chargeModel} charges`);
        }
        if (req.capture === "manual" && !capabilities.manualCapture) {
          return paymentUnavailable(id, "capability_not_supported", "this provider cannot authorise now and capture later");
        }
        if (req.recipientRef !== null) {
          const recipient = recipients.get(req.recipientRef);
          if (!recipient) return paymentFailed(id, "not_found", "no such recipient");
          if (recipient.country !== req.recipientCountry) return paymentFailed(id, "invalid_request", "recipientCountry does not match the recipient's country");
          const market = marketOf(recipient.country);
          if (!market) return paymentUnavailable(id, "unsupported_market", `recipients in ${recipient.country} are not supported`);
          if (!market.chargeModels.includes(req.chargeModel)) {
            return paymentUnavailable(id, "charge_model_not_supported", `${req.chargeModel} charges are not available for recipients in ${recipient.country}`);
          }
          if (!market.presentmentCurrencies.includes(req.amount.currency)) {
            return paymentUnavailable(id, "unsupported_currency", `${req.amount.currency} cannot be charged for a recipient in ${recipient.country}`);
          }
          if (!recipient.chargesEnabled) {
            return paymentDeclined<PaymentIntentSnapshot>(id, "recipient_not_eligible", "the recipient has not completed onboarding and cannot be charged for");
          }
          if (!convert({ amountMinor: 0, currency: req.amount.currency }, recipient.settlementCurrency).ok) return noRate(req.amount.currency, recipient.settlementCurrency);
        }
        if (!onPlatform({ amountMinor: 0, currency: req.amount.currency }).ok) return noRate(req.amount.currency, platformCurrency ?? req.amount.currency);
        const intentRef = nextRef("pi");
        const r: IntentRecord = {
          intentRef,
          chargeModel: req.chargeModel,
          recipientRef: req.recipientRef,
          reference: { kind: req.reference.kind, id: req.reference.id },
          state: "requires_confirmation",
          amount: { amountMinor: req.amount.amountMinor, currency: req.amount.currency },
          components: { ...req.components },
          platformFee: { ...req.platformFee },
          capture: req.capture,
          amountCapturableMinor: 0,
          amountCapturedMinor: 0,
          amountRefundedMinor: 0,
          platformFeeCollectedMinor: 0,
          platformFeeRefundedMinor: 0,
          settlement: null,
          clientSecret: `${intentRef}_secret`,
          updatedAt: tick(),
        };
        intents.set(intentRef, r);
        emitIntent("created", r);
        return paymentOk(id, intentSnapshot(r));
      });
    },

    async confirmPaymentIntent(req: ConfirmPaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>> {
      const refused = gate("confirmPaymentIntent") ?? validateConfirmPaymentIntent(id, req);
      if (refused) return refused;
      return once("confirmPaymentIntent", req.idempotencyKey, req, () => {
        const r = findIntent(req.intent);
        if (isRefusal(r)) return r;
        if (r.state !== "requires_confirmation" && r.state !== "requires_payment_method") {
          return paymentFailed(id, "illegal_state", `a payment intent in state ${r.state} cannot be confirmed`);
        }
        const script = scripted.confirm.shift();
        if (script?.kind === "decline") {
          r.state = "requires_payment_method";
          r.updatedAt = tick();
          emitIntent("payment_failed", r);
          return paymentDeclined(id, script.reason, "scripted: the payment method was declined", intentSnapshot(r));
        }
        if (script?.kind === "requires_action") {
          r.state = "requires_action";
          r.updatedAt = tick();
          emitIntent("requires_action", r);
          return paymentRequiresAction(
            id,
            "payer_authentication_required",
            "scripted: the payer must authenticate this payment",
            // With a return URL the payer is sent off-site and back; without one the client finishes in-app with the secret.
            { kind: "payer_authentication", clientSecret: r.clientSecret, redirectUrl: req.returnUrl === null ? null : `https://fake-payments.invalid/authenticate/${r.intentRef}` },
            intentSnapshot(r),
          );
        }
        const failed = authorise(r);
        return failed ?? paymentOk(id, intentSnapshot(r));
      });
    },

    async capturePaymentIntent(req: CapturePaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>> {
      const refused = gate("capturePaymentIntent");
      if (refused) return refused;
      return once("capturePaymentIntent", req?.idempotencyKey, req, () => {
        const r = findIntent(req.intent);
        if (isRefusal(r)) return r;
        // The SHARED rule: state, amount, and the fee held to the original scaled to what is captured.
        const invalid = validateCapturePaymentIntent(id, r, req);
        if (invalid) return invalid;
        const take = resolveCapture(r, req);
        if (take.amountMinor !== r.amountCapturableMinor && !capabilities.partialCapture) {
          return paymentUnavailable(id, "capability_not_supported", "this provider cannot capture part of an authorisation");
        }
        const failed = settleCapture(r, take.amountMinor, take.platformFee);
        return failed ?? paymentOk(id, intentSnapshot(r));
      });
    },

    async cancelPaymentIntent(req: CancelPaymentIntentRequest): Promise<PaymentResult<PaymentIntentSnapshot>> {
      const refused = gate("cancelPaymentIntent") ?? validateCancelPaymentIntent(id, req);
      if (refused) return refused;
      return once("cancelPaymentIntent", req.idempotencyKey, req, () => {
        const r = findIntent(req.intent);
        if (isRefusal(r)) return r;
        if (r.state === "succeeded" || r.state === "canceled" || r.state === "processing") {
          return paymentFailed(id, "illegal_state", `a payment intent in state ${r.state} cannot be cancelled; refund a captured payment instead`);
        }
        r.state = "canceled";
        r.amountCapturableMinor = 0;
        r.updatedAt = tick();
        emitIntent("canceled", r);
        return paymentOk(id, intentSnapshot(r));
      });
    },

    async getPaymentIntent(handle: IntentHandle): Promise<PaymentResult<PaymentIntentSnapshot>> {
      const refused = gate("getPaymentIntent");
      if (refused) return refused;
      const r = findIntent(handle);
      return isRefusal(r) ? r : paymentOk(id, intentSnapshot(r));
    },

    async refundPayment(req: RefundPaymentRequest): Promise<PaymentResult<RefundSnapshot>> {
      const refused = gate("refundPayment") ?? validateRefundPayment(id, req);
      if (refused) return refused;
      return once("refundPayment", req.idempotencyKey, req, () => {
        const r = findIntent(req.intent);
        if (isRefusal(r)) return r;
        // The SHARED rule: state, bound and granularity, against the intent.
        const invalid = validateRefundAgainstIntent(id, r, req);
        if (invalid) return invalid;
        const currency = r.amount.currency;
        const remaining = r.amountCapturedMinor - r.amountRefundedMinor;
        const full = req.amountMinor === "full" || req.amountMinor === remaining;
        const refundMinor = full ? remaining : (req.amountMinor as number);
        if (!full && !capabilities.partialRefund) return paymentUnavailable(id, "capability_not_supported", "this provider cannot refund part of a payment");
        const feeRemaining = r.platformFeeCollectedMinor - r.platformFeeRefundedMinor;
        const feeRefundMinor = !req.refundPlatformFee
          ? 0
          : full
            ? feeRemaining
            : Math.min(feeRemaining, Number((BigInt(r.platformFeeCollectedMinor) * BigInt(refundMinor)) / BigInt(r.amountCapturedMinor)));

        // Who bears it. Every conversion is worked out before any balance moves.
        const recipient = r.recipientRef === null ? null : (recipients.get(r.recipientRef) as RecipientRecord);
        const fromRecipient = recipient !== null && (r.chargeModel === "direct" || req.reverseTransfer);
        // platform charge: the platform pays it all. direct, or destination with the transfer reversed: the
        // recipient pays the refund less the returned fee, the platform returns the fee. destination with the
        // transfer left alone: the platform pays the refund, and a returned fee goes to the recipient.
        const recipientDeltaMinor = !recipient ? 0 : fromRecipient ? -(refundMinor - feeRefundMinor) : feeRefundMinor;
        const platformDebitMinor = !recipient ? refundMinor : fromRecipient ? feeRefundMinor : refundMinor + feeRefundMinor;
        const recipientMove = recipient ? convert({ amountMinor: Math.abs(recipientDeltaMinor), currency }, recipient.settlementCurrency) : null;
        if (recipientMove && !recipientMove.ok) return noRate(currency, (recipient as RecipientRecord).settlementCurrency);
        const platformMove = onPlatform({ amountMinor: platformDebitMinor, currency });
        if (!platformMove.ok) return noRate(currency, platformCurrency ?? currency);
        if (recipient && recipientMove && recipientMove.ok) {
          credit(recipientBook(recipient.recipientRef), recipientMove.settled.currency, Math.sign(recipientDeltaMinor) * recipientMove.settled.amountMinor);
        }
        credit(platformBalance, platformMove.settled.currency, -platformMove.settled.amountMinor);

        r.amountRefundedMinor += refundMinor;
        r.platformFeeRefundedMinor += feeRefundMinor;
        r.updatedAt = tick();
        const refund: RefundSnapshot = Object.freeze({
          refundRef: nextRef("re"),
          intentRef: r.intentRef,
          recipientRef: r.recipientRef,
          state: "succeeded" as const,
          amount: { amountMinor: refundMinor, currency },
          platformFeeRefundedMinor: feeRefundMinor,
          fullyRefunded: r.amountRefundedMinor === r.amountCapturedMinor,
          reason: req.reason,
          livemode: false,
          updatedAt: r.updatedAt,
        });
        refunds.set(refund.refundRef, refund);
        const account = r.chargeModel === "direct" ? r.recipientRef : null;
        emit("refund.succeeded", account, { kind: "refund", refund });
        emitIntent("refunded", r);
        return paymentOk(id, refund);
      });
    },

    async createRecipient(req: CreateRecipientRequest): Promise<PaymentResult<RecipientSnapshot>> {
      const refused = gate("createRecipient") ?? validateCreateRecipient(id, req);
      if (refused) return refused;
      return once("createRecipient", req.idempotencyKey, req, () => {
        if (!capabilities.connectedAccounts) return paymentUnavailable(id, "capability_not_supported", "this provider cannot onboard recipients");
        const market = marketOf(req.country);
        if (!market) return paymentUnavailable(id, "unsupported_market", `recipients in ${req.country} are not supported`);
        if (!market.settlementCurrencies.includes(req.settlementCurrency)) {
          return paymentUnavailable(id, "unsupported_currency", `a recipient in ${req.country} cannot be settled in ${req.settlementCurrency}`);
        }
        const r: RecipientRecord = {
          recipientRef: nextRef("acct"),
          profileId: req.profileId,
          country: req.country,
          settlementCurrency: req.settlementCurrency,
          onboarding: "not_started",
          chargesEnabled: false,
          payoutsEnabled: false,
          requirementsDue: [...ONBOARDING_REQUIREMENTS],
          requirementsDeadline: null,
          disabledReason: "requirements.past_due",
          updatedAt: tick(),
        };
        recipients.set(r.recipientRef, r);
        emitRecipient("created", r);
        return paymentRequiresAction(
          id,
          "recipient_onboarding_required",
          "the recipient must complete hosted onboarding before they can be charged for or paid out",
          { kind: "recipient_onboarding", url: `https://fake-payments.invalid/onboard/${r.recipientRef}`, requirementsDue: [...r.requirementsDue] },
          recipientSnapshot(r),
        );
      });
    },

    async createRecipientOnboardingLink(req: RecipientOnboardingLinkRequest): Promise<PaymentResult<RecipientOnboardingLink>> {
      const refused = gate("createRecipientOnboardingLink") ?? validateRecipientOnboardingLink(id, req);
      if (refused) return refused;
      // Keyed: a retried request gets the SAME link back, not a second one.
      return once("createRecipientOnboardingLink", req.idempotencyKey, req, () => {
        const r = recipients.get(req.recipientRef);
        if (!r) return paymentFailed(id, "not_found", "no such recipient");
        if (r.onboarding === "rejected") return paymentDeclined<RecipientOnboardingLink>(id, "recipient_rejected", "the provider rejected this recipient; onboarding cannot be resumed");
        return paymentOk(id, {
          recipientRef: r.recipientRef,
          url: `https://fake-payments.invalid/onboard/${r.recipientRef}/${nextRef("link")}`,
          expiresAt: new Date(clockMs + 5 * 60_000).toISOString(),
        });
      });
    },

    async validateRecipient(recipientRef: string): Promise<PaymentResult<RecipientSnapshot>> {
      const refused = gate("validateRecipient");
      if (refused) return refused;
      const r = typeof recipientRef === "string" ? recipients.get(recipientRef) : undefined;
      if (!r) return paymentFailed(id, "not_found", "no such recipient");
      const snapshot = recipientSnapshot(r);
      if (r.onboarding === "rejected") return paymentDeclined(id, "recipient_rejected", "the provider rejected this recipient", snapshot);
      if (r.onboarding === "verified" && r.chargesEnabled && r.payoutsEnabled) return paymentOk(id, snapshot);
      if (r.onboarding === "pending_verification") {
        return paymentRequiresAction(
          id,
          "recipient_verification_pending",
          "everything due is submitted; the provider has not finished verifying the recipient",
          { kind: "recipient_onboarding", url: null, requirementsDue: [] },
          snapshot,
        );
      }
      return paymentRequiresAction(
        id,
        "recipient_onboarding_required",
        "the recipient has requirements outstanding with the provider",
        { kind: "recipient_onboarding", url: null, requirementsDue: [...r.requirementsDue] },
        snapshot,
      );
    },

    async requestPayout(req: RequestPayoutRequest): Promise<PaymentResult<PayoutSnapshot>> {
      const refused = gate("requestPayout") ?? validateRequestPayout(id, req);
      if (refused) return refused;
      return once("requestPayout", req.idempotencyKey, req, () => {
        if (req.kind === "transfer" ? !capabilities.transfers : !capabilities.payouts) {
          return paymentUnavailable(id, "capability_not_supported", `this provider cannot make a ${req.kind}`);
        }
        const recipient = recipients.get(req.recipientRef);
        if (!recipient) return paymentFailed(id, "not_found", "no such recipient");
        const rejectedCode = scripted.payoutAtRequest.shift();
        if (rejectedCode !== undefined) return paymentFailed(id, "payout_rejected", `scripted: the provider rejected the ${req.kind} (${rejectedCode})`);
        if (recipient.onboarding !== "verified" || !recipient.payoutsEnabled) {
          return paymentDeclined<PayoutSnapshot>(id, "recipient_not_eligible", "the recipient is not verified for payouts");
        }
        const reference = { kind: req.reference.kind, id: req.reference.id };
        if (req.kind === "transfer") {
          if ((platformBalance.get(req.amount.currency) ?? 0) < req.amount.amountMinor) {
            return paymentDeclined<PayoutSnapshot>(id, "insufficient_balance", "the platform's balance does not cover this transfer");
          }
          const landed = convert(req.amount, recipient.settlementCurrency);
          if (!landed.ok) return noRate(req.amount.currency, recipient.settlementCurrency);
          credit(platformBalance, req.amount.currency, -req.amount.amountMinor);
          credit(recipientBook(recipient.recipientRef), recipient.settlementCurrency, landed.settled.amountMinor);
          const t: PayoutRecord = {
            payoutRef: nextRef("tr"),
            kind: "transfer",
            recipientRef: recipient.recipientRef,
            reference,
            state: "paid",
            amount: { amountMinor: req.amount.amountMinor, currency: req.amount.currency },
            amountReversedMinor: 0,
            settledReversedMinor: 0,
            settlement: { settled: landed.settled, conversion: landed.conversion, providerFee: null, platformFeeSettled: null },
            failureCode: null,
            expectedArrivalAt: null,
            path: [],
            pendingFailureCode: null,
            updatedAt: tick(),
          };
          payouts.set(t.payoutRef, t);
          emitPayout("paid", t);
          return paymentOk(id, payoutSnapshot(t));
        }
        if (req.amount.currency !== recipient.settlementCurrency) {
          return paymentFailed(id, "currency_mismatch", `a payout is made in the recipient's settlement currency (${recipient.settlementCurrency})`);
        }
        if ((recipientBook(recipient.recipientRef).get(req.amount.currency) ?? 0) < req.amount.amountMinor) {
          return paymentDeclined<PayoutSnapshot>(id, "insufficient_balance", "the recipient's balance does not cover this payout");
        }
        return paymentOk(id, payoutSnapshot(newPayout(recipient, req.amount, reference)));
      });
    },

    async getPayoutStatus(handle: PayoutHandle): Promise<PaymentResult<PayoutSnapshot>> {
      const refused = gate("getPayoutStatus");
      if (refused) return refused;
      const p = findPayout(handle);
      return isRefusal(p) ? p : paymentOk(id, payoutSnapshot(p));
    },

    async reverseOrHoldPayout(req: ReverseOrHoldPayoutRequest): Promise<PaymentResult<PayoutSnapshot>> {
      const refused = gate("reverseOrHoldPayout") ?? validateReverseOrHoldPayout(id, req);
      if (refused) return refused;
      return once("reverseOrHoldPayout", req.idempotencyKey, req, () => {
        const p = findPayout(req.payout);
        if (isRefusal(p)) return p;
        const illegal = () => paymentFailed(id, "illegal_state", `a ${p.kind} in state ${p.state} cannot be ${req.action === "hold" ? "held" : req.action === "release" ? "released" : "reversed"}`);
        if (req.action === "hold") {
          if (!capabilities.payoutHold) return paymentUnavailable(id, "capability_not_supported", "this provider cannot hold a payout");
          if (p.kind !== "payout" || p.state !== "pending") return illegal();
          p.state = "on_hold";
        } else if (req.action === "release") {
          if (p.kind !== "payout" || p.state !== "on_hold") return illegal();
          p.state = "pending";
        } else {
          if (!capabilities.payoutReversal) return paymentUnavailable(id, "capability_not_supported", "this provider cannot reverse a payout");
          if (p.kind === "transfer" && p.state === "paid") {
            // A transfer may come back in parts; the last part takes whatever is left of what landed.
            const remaining = p.amount.amountMinor - p.amountReversedMinor;
            const reverseMinor = req.amountMinor === "full" ? remaining : req.amountMinor;
            if (reverseMinor > remaining) return paymentFailed(id, "amount_exceeds_reversible", "cannot reverse more of a transfer than has not yet been reversed");
            const settled = (p.settlement as SettlementDetails).settled;
            let backMinor = settled.amountMinor - p.settledReversedMinor;
            if (reverseMinor !== remaining) {
              const part = convert({ amountMinor: reverseMinor, currency: p.amount.currency }, settled.currency);
              if (!part.ok) return noRate(p.amount.currency, settled.currency);
              backMinor = part.settled.amountMinor;
            }
            credit(recipientBook(p.recipientRef), settled.currency, -backMinor);
            credit(platformBalance, p.amount.currency, reverseMinor);
            p.amountReversedMinor += reverseMinor;
            p.settledReversedMinor += backMinor;
            if (p.amountReversedMinor === p.amount.amountMinor) p.state = "reversed";
          } else if (p.kind === "payout" && (p.state === "pending" || p.state === "on_hold")) {
            credit(recipientBook(p.recipientRef), p.amount.currency, p.amount.amountMinor);
            p.state = "canceled";
            p.path = [];
          } else {
            return illegal();
          }
        }
        p.updatedAt = tick();
        emitPayout(p.kind === "transfer" && req.action === "reverse" ? "reversed" : p.state, p);
        return paymentOk(id, payoutSnapshot(p));
      });
    },

    async verifyAndParseWebhook(delivery: WebhookDelivery): Promise<PaymentResult<PaymentWebhookEvent>> {
      const refused = gate("verifyAndParseWebhook") ?? validateWebhookDelivery(id, delivery);
      if (refused) return refused;
      // 1. signature over the RAW body, with the secret of the endpoint it arrived on — before a byte of it is parsed
      const unverified = verifyPaymentWebhookSignature({ provider: id, delivery, headerName: FAKE_SIGNATURE_HEADER, secret: secretFor(delivery.endpoint), nowMs: clockMs });
      if (unverified) return unverified;
      // 2. parse, and insist on the snapshot the body's kind promises
      let parsed: unknown;
      try {
        parsed = JSON.parse(delivery.rawBody);
      } catch {
        return paymentFailed(id, "webhook_malformed", "the verified body is not JSON");
      }
      const e = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { id?: unknown; type?: unknown; livemode?: unknown; created?: unknown; account?: unknown; data?: unknown };
      if (
        typeof e.id !== "string" || e.id.length === 0 || typeof e.type !== "string" || typeof e.created !== "string" || !Number.isFinite(Date.parse(e.created)) ||
        typeof e.livemode !== "boolean" || (e.account !== null && typeof e.account !== "string")
      ) {
        return paymentFailed(id, "webhook_malformed", "the verified body is not an event envelope");
      }
      if (!isPaymentWebhookBody(e.data)) {
        return paymentFailed(id, "webhook_malformed", "the verified event does not carry the object its kind promises");
      }
      // 3. mode — a verified LIVE event is still refused unless live is allowed
      if (webhookLivemodeRefused(e.livemode, env())) {
        return paymentUnavailable(id, "livemode_not_allowed", "a livemode event was refused: PAYMENTS_ALLOW_LIVE is not \"true\"");
      }
      return paymentOk(id, {
        provider: id,
        providerEventId: e.id,
        endpoint: delivery.endpoint,
        providerEventType: e.type,
        livemode: e.livemode,
        occurredAt: e.created,
        accountRef: e.account as string | null,
        body: e.data,
      });
    },
  };

  // ── the controls ──────────────────────────────────────────────────────────
  const control: FakePaymentControl = {
    script: {
      declineNextConfirm: (reason: DeclineReason = "card_declined") => { scripted.confirm.push({ kind: "decline", reason }); },
      requireActionOnNextConfirm: () => { scripted.confirm.push({ kind: "requires_action" }); },
      failNextPayout: (when, failureCode = "account_closed") => {
        if (when === "at_request") scripted.payoutAtRequest.push(failureCode);
        else scripted.payoutPath.push({ path: ["in_transit", "failed"], failureCode });
      },
      returnNextPayout: (failureCode = "bank_returned") => { scripted.payoutPath.push({ path: ["in_transit", "paid", "returned"], failureCode }); },
      failNextOperation: (operation, reason) => {
        const queue = scripted.operations.get(operation) ?? [];
        queue.push(reason);
        scripted.operations.set(operation, queue);
      },
    },

    completePayerAction(intentRef, outcome) {
      const r = requireControl(intents.get(intentRef), `payment intent ${intentRef}`);
      if (r.state !== "requires_action") throw new Error(`fake payment provider: ${intentRef} is ${r.state}, not requires_action`);
      if (outcome === "authenticated") {
        const failed = authorise(r);
        if (failed) throw new Error(`fake payment provider: ${failed.reason}`);
      } else {
        r.state = "requires_payment_method";
        r.updatedAt = tick();
        emitIntent("payment_failed", r);
      }
      return intentSnapshot(r);
    },

    setRecipientOnboarding(recipientRef, state, requirementsDue) {
      const r = requireControl(recipients.get(recipientRef), `recipient ${recipientRef}`);
      r.onboarding = state;
      r.chargesEnabled = state === "verified";
      r.payoutsEnabled = state === "verified";
      r.requirementsDue =
        requirementsDue !== undefined
          ? [...requirementsDue]
          : state === "verified" || state === "pending_verification" || state === "rejected"
            ? []
            : state === "restricted"
              ? ["fake.additional_document"]
              : [...ONBOARDING_REQUIREMENTS];
      r.disabledReason = state === "verified" ? null : state === "rejected" ? "rejected.other" : state === "pending_verification" ? "requirements.pending_verification" : "requirements.past_due";
      r.updatedAt = tick();
      emitRecipient("updated", r);
      return recipientSnapshot(r);
    },

    advancePayout(payoutRef) {
      const p = requireControl(payouts.get(payoutRef), `payout ${payoutRef}`);
      if (p.state === "on_hold") throw new Error(`fake payment provider: ${payoutRef} is on hold`);
      const next = p.path.shift();
      if (next === undefined) throw new Error(`fake payment provider: ${payoutRef} is ${p.state} and has nowhere further to go`);
      if (next === "paid") {
        credit(paidOut, p.amount.currency, p.amount.amountMinor);
        p.settlement = { settled: p.amount, conversion: null, providerFee: null, platformFeeSettled: null };
      }
      if (next === "failed" || next === "returned") {
        if (next === "returned") credit(paidOut, p.amount.currency, -p.amount.amountMinor);
        credit(recipientBook(p.recipientRef), p.amount.currency, p.amount.amountMinor);
        p.failureCode = p.pendingFailureCode;
        p.settlement = null;
      }
      p.state = next;
      p.updatedAt = tick();
      emitPayout(next, p);
      return payoutSnapshot(p);
    },

    providerInitiatedPayout(recipientRef, amountMinor) {
      const recipient = requireControl(recipients.get(recipientRef), `recipient ${recipientRef}`);
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("fake payment provider: pay out a positive integer of minor units");
      if ((recipientBook(recipientRef).get(recipient.settlementCurrency) ?? 0) < amountMinor) {
        throw new Error(`fake payment provider: ${recipientRef}'s balance does not cover ${amountMinor}`);
      }
      return payoutSnapshot(newPayout(recipient, { amountMinor, currency: recipient.settlementCurrency }, null));
    },

    openDispute(intentRef, reasonCode = "fraudulent") {
      const r = requireControl(intents.get(intentRef), `payment intent ${intentRef}`);
      if (r.state !== "succeeded") throw new Error(`fake payment provider: ${intentRef} is ${r.state}; only a captured payment can be disputed`);
      const d: DisputeRecord = {
        disputeRef: nextRef("dp"),
        intentRef,
        recipientRef: r.recipientRef,
        state: "needs_response",
        amount: { amountMinor: r.amountCapturedMinor - r.amountRefundedMinor, currency: r.amount.currency },
        reasonCode,
        updatedAt: tick(),
      };
      disputes.set(d.disputeRef, d);
      emit("dispute.created", r.chargeModel === "direct" ? r.recipientRef : null, { kind: "dispute", dispute: disputeSnapshot(d) });
      return disputeSnapshot(d);
    },

    resolveDispute(disputeRef, outcome) {
      const d = requireControl(disputes.get(disputeRef), `dispute ${disputeRef}`);
      if (d.state === "won" || d.state === "lost") throw new Error(`fake payment provider: ${disputeRef} is already ${d.state}`);
      d.state = outcome;
      d.updatedAt = tick();
      const intent = intents.get(d.intentRef);
      emit("dispute.closed", intent?.chargeModel === "direct" ? d.recipientRef : null, { kind: "dispute", dispute: disputeSnapshot(d) });
      return disputeSnapshot(d);
    },

    fundPlatformBalance(money) {
      if (!Number.isSafeInteger(money.amountMinor) || money.amountMinor < 0) throw new Error("fake payment provider: fund with a non-negative integer of minor units");
      credit(platformBalance, money.currency, money.amountMinor);
    },

    setRate(fromCurrency, toCurrency, rate) {
      if (rate === null) rates.delete(`${fromCurrency}>${toCurrency}`);
      else rates.set(`${fromCurrency}>${toCurrency}`, rate);
    },

    balances() {
      const plain = (book: Map<string, number>): Record<string, number> => Object.fromEntries([...book.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
      return {
        platform: plain(platformBalance),
        recipients: Object.fromEntries([...recipientBalances.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, book]) => [ref, plain(book)])),
        paidOut: plain(paidOut),
        providerFees: Object.fromEntries(Object.entries(plain(providerFees)).filter(([, v]) => v !== 0)),
      };
    },

    nowMs: () => clockMs,
    advanceClock(ms) {
      if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("fake payment provider: the clock only moves forward");
      clockMs += ms;
    },

    webhooks: {
      pending: () => outbox.map((e, index) => ({ index, providerEventId: e.providerEventId, providerEventType: e.providerEventType, endpoint: e.endpoint })),
      deliver(plan: FakeDeliveryPlan = {}) {
        const order = plan.order ?? outbox.map((_, i) => i);
        const chosen = order.map((i) => requireControl(outbox[i], `pending event index ${i}`));
        const extra = plan.duplicates ?? 0;
        const deliveries: WebhookDelivery[] = [];
        for (const e of chosen) {
          for (let n = 0; n <= extra; n += 1) deliveries.push(sign(envelope(e, plan.livemode === true), e.endpoint));
        }
        const handedOut = new Set(chosen);
        for (let i = outbox.length - 1; i >= 0; i -= 1) {
          if (handedOut.has(outbox[i] as OutboxEvent)) outbox.splice(i, 1);
        }
        return deliveries;
      },
      redeliver(providerEventId) {
        const e = requireControl(history.get(providerEventId), `event ${providerEventId}`);
        return sign(envelope(e, false), e.endpoint);
      },
      signRawBody: (rawBody, endpoint = "platform") => sign(rawBody, endpoint),
    },
  };

  return Object.freeze({ ...provider, control });
}
