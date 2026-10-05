/**
 * checkout — a verified traveller pays a verified buddy for an accepted booking,
 * through the PaymentProvider contract, in the provider's TEST mode only.
 *
 *   quote     what will be charged and how it splits (shown before checkout)
 *   start     create the payment intent (direct charge on the buddy's account,
 *             the commission as a separate platform fee, automatic capture)
 *   confirm   the payer confirms with a payment method (server-side confirm;
 *             a native SDK may confirm with the client secret instead)
 *
 * Nothing here marks a booking PAID. Money is recognised only when the
 * provider's signed webhook says so (webhookProcessor.ts), and booked to the
 * ledger before any state changes. The answers here are `pending` at best.
 *
 * ── REFUSALS, IN THE ORDER THEY ARE CHECKED ─────────────────────────────────
 *   503 payments_unavailable      payments readiness is not operational (no
 *                                 provider / live key refused / not certified /
 *                                 no market enabled / tax not configured)
 *   404 not_found                 no such booking (or not readable as one)
 *   403 forbidden                 the caller is not the booking's traveller
 *   409 booking_not_payable       not accepted yet, or already started/ended
 *   409 already_paid              a payment for this booking succeeded
 *   403 (identity codes)          either person is not a current, real,
 *                                 verified adult, or is restricted
 *   409 buddy_payments_not_ready  the buddy has no provider account, or the
 *                                 provider says it cannot be charged/paid out
 *   422 quote_changed             the total differs from the one the traveller
 *                                 was shown
 *   402 payment_declined          the provider declined (nothing moved)
 * A failed read anywhere is 503 and creates nothing.
 */
import {
  intentHandle,
  selectChargeModel,
  type CreatePaymentIntentRequest,
  type PaymentIntentSnapshot,
  type PaymentResult,
} from "../PaymentProvider.js";
import { quoteBookingCharge, type BookingQuote } from "./bookingQuote.js";
import { outcome, refusal, type PaymentSliceDeps, type SliceOutcome } from "./deps.js";
import {
  PAYABLE_BOOKING_STATUSES,
  RETRYABLE_PAYMENT_STATES,
  type BookingForPayment,
  type BookingPaymentRecord,
  type BookingPaymentState,
  type RecipientRecord,
} from "./model.js";

const PAID_STATES: readonly BookingPaymentState[] = ["succeeded", "partially_refunded", "refunded", "disputed", "reversed"];
const OPEN_STATES: readonly BookingPaymentState[] = ["creating", "awaiting_payment", "processing"];

const UNAVAILABLE = () => refusal(503, "payments_unavailable", "Payments are not available right now. No charge was made.");
const READ_FAILED = () => refusal(503, "degraded_unavailable", "We couldn't load this booking's payment details. Please try again. No charge was made.");

/** The intent's provider state, as the slice's own lifecycle. */
export function stateFromIntent(s: PaymentIntentSnapshot): BookingPaymentState {
  switch (s.state) {
    case "requires_payment_method":
    case "requires_confirmation":
    case "requires_action":
      return "awaiting_payment";
    case "processing":
    case "requires_capture":
      return "processing";
    case "canceled":
      return "canceled";
    case "succeeded":
      if (s.amountRefundedMinor > 0) return s.amountRefundedMinor >= s.amountCapturedMinor ? "refunded" : "partially_refunded";
      return "succeeded";
  }
}

interface Loaded {
  readonly booking: BookingForPayment;
  readonly payments: readonly BookingPaymentRecord[];
}

/** Load and authorise. Answers the refusal, or the booking and its payments. */
async function loadForTraveller(deps: PaymentSliceDeps, bookingId: string, actorUserId: string): Promise<SliceOutcome | Loaded> {
  const b = await deps.store.loadBooking(bookingId);
  if (!b.ok) return READ_FAILED();
  if (!b.value) return refusal(404, "not_found", "Booking not found.");
  if (b.value.travelerId !== actorUserId) return refusal(403, "forbidden", "Only the traveller on this booking can pay for it.");
  const p = await deps.store.listPaymentsForBooking(bookingId);
  if (!p.ok) return READ_FAILED();
  return { booking: b.value, payments: p.value };
}

const isOutcome = (v: SliceOutcome | Loaded): v is SliceOutcome => "httpStatus" in v;

/** The buddy's provider account, validated live with the provider. */
async function readyRecipient(deps: PaymentSliceDeps, booking: BookingForPayment): Promise<SliceOutcome | RecipientRecord> {
  const notReady = refusal(409, "buddy_payments_not_ready", "This Buddy can't receive in-app payments yet, so this booking can't be paid for. No charge was made.");
  if (!booking.buddyUserId) return notReady;
  // The buddy is named by their payment PARTY from here on (3821), never by profile.
  const party = await deps.store.partyForProfile(booking.buddyUserId);
  if (!party.ok) return READ_FAILED();
  if (!party.value) return notReady;
  const r = await deps.store.getRecipient(party.value);
  if (!r.ok) return READ_FAILED();
  if (!r.value || r.value.provider !== deps.provider.id) return notReady;
  const v = await deps.provider.validateRecipient(r.value.recipientRef);
  if (v.status === "failed" || v.status === "unavailable") return v.status === "unavailable" && v.retriable ? UNAVAILABLE() : notReady;
  if (v.status !== "ok" || !v.value.chargesEnabled || !v.value.payoutsEnabled) return notReady;
  return { ...r.value, country: v.value.country, settlementCurrency: v.value.settlementCurrency };
}

const isRecipient = (v: SliceOutcome | RecipientRecord): v is RecipientRecord => "recipientRef" in v;

function payableNow(booking: BookingForPayment): boolean {
  return PAYABLE_BOOKING_STATUSES.includes(booking.status);
}

export interface QuoteRequest {
  readonly bookingId: string;
  readonly actorUserId: string;
  /** A tip the traveller chose to add. 0 when none. */
  readonly tipMinor?: number;
}

async function buildQuote(deps: PaymentSliceDeps, booking: BookingForPayment, recipient: RecipientRecord, tipMinor: number): Promise<SliceOutcome | BookingQuote> {
  if (booking.serviceMinor === null) return READ_FAILED();
  // Place of supply: an in-person service is supplied where it is performed, so
  // the buyer market is the booking's service country. Which jurisdiction taxes
  // what is the TaxProvider's answer per market; this only states the facts.
  const buyerMarket = booking.serviceCountry ?? recipient.country;
  const q = await quoteBookingCharge(
    { serviceMinor: booking.serviceMinor, tipMinor, currency: booking.currency, buyerMarket, sellerMarket: recipient.country },
    deps.tax,
  );
  if (!q.ok) {
    if (q.reason === "tax_not_configured" || q.reason === "tax_unavailable") return refusal(503, "payments_unavailable", "Payments are not available for this booking's location yet. No charge was made.", { reason: q.reason });
    return refusal(422, "quote_unavailable", "This booking can't be priced for payment.", { reason: q.reason });
  }
  return q.quote;
}

const isQuote = (v: SliceOutcome | BookingQuote): v is BookingQuote => "components" in v;

/** GET the quote: every line the traveller is shown before paying. Makes no provider call except validating the buddy's account. */
export async function quoteBookingPayment(deps: PaymentSliceDeps, req: QuoteRequest): Promise<SliceOutcome> {
  if (!deps.paymentsOperational().operational) return UNAVAILABLE();
  const loaded = await loadForTraveller(deps, req.bookingId, req.actorUserId);
  if (isOutcome(loaded)) return loaded;
  if (!payableNow(loaded.booking)) return refusal(409, "booking_not_payable", "This booking can't be paid for in its current state."); if (loaded.booking.paymentMode !== "full_in_app") return NOT_IN_APP();
  const recipient = await readyRecipient(deps, loaded.booking);
  if (!isRecipient(recipient)) return recipient;
  const q = await buildQuote(deps, loaded.booking, recipient, req.tipMinor ?? 0);
  if (!isQuote(q)) return q;
  return outcome(200, { quote: quoteBody(q) });
}

function quoteBody(q: BookingQuote) {
  return {
    total: q.amount,
    lines: q.lines,
    commission: { rate: q.commission.display, bps: q.commission.bps, ruleVersion: q.commission.version },
    deposit: null,
    refundPolicy:
      "Full refund if your Buddy cancels, the service is unavailable, a safety report is upheld, or you cancel before the service starts. " +
      "After the service starts, contact support. Fees are refunded with the payment when a refund applies.",
  };
}

export interface StartCheckoutRequest extends QuoteRequest {
  /** The total the traveller was shown. When given, a different total refuses rather than charging it. */
  readonly expectedTotalMinor?: number;
}

/** POST checkout: create (or resume) the payment intent for an accepted booking. */
export async function startBookingCheckout(deps: PaymentSliceDeps, req: StartCheckoutRequest): Promise<SliceOutcome> {
  if (!deps.paymentsOperational().operational) return UNAVAILABLE();
  const loaded = await loadForTraveller(deps, req.bookingId, req.actorUserId);
  if (isOutcome(loaded)) return loaded;
  const { booking, payments } = loaded;
  if (payments.some((p) => PAID_STATES.includes(p.state))) return refusal(409, "already_paid", "This booking has already been paid for.");
  if (!payableNow(booking)) return refusal(409, "booking_not_payable", "This booking can't be paid for in its current state."); if (booking.paymentMode !== "full_in_app") return NOT_IN_APP(); const owed = await settleOwedCancels(deps, payments); if (owed) return owed; // Step 5(b): an earlier declined intent is closed first

  const parties = await deps.bookingParties(booking);
  if (!parties.allowed) return refusal(parties.httpStatus, parties.code, parties.message, { side: parties.side });

  const recipient = await readyRecipient(deps, booking);
  if (!isRecipient(recipient)) return recipient;

  const quote = await buildQuote(deps, booking, recipient, req.tipMinor ?? 0);
  if (!isQuote(quote)) return quote;
  if (req.expectedTotalMinor !== undefined && req.expectedTotalMinor !== quote.amount.amountMinor) {
    return refusal(422, "quote_changed", "The price changed since it was shown. Please review the new total. No charge was made.", { quote: quoteBody(quote) });
  }

  const market = deps.provider.marketSupport({ recipientCountry: recipient.country, presentmentCurrency: quote.amount.currency });
  const model = selectChargeModel(deps.provider.capabilities(), market, "refuse");
  if (!model.ok) {
    return refusal(503, "payments_unavailable", "In-app payment isn't available for this Buddy's country yet. No charge was made.", { reason: model.reason });
  }

  const open = payments.find((p) => OPEN_STATES.includes(p.state));
  const attemptNo = open ? open.attemptNo : payments.length + 1;
  const idempotencyKey = open ? open.idempotencyKey : `rab-checkout:${booking.bookingId}:${attemptNo}`;
  const now = deps.now().toISOString();

  let record: BookingPaymentRecord;
  if (open) {
    if (open.amount.amountMinor !== quote.amount.amountMinor || open.amount.currency !== quote.amount.currency) {
      // An open attempt was created for a different total. It must not be confirmed for an amount nobody sees now.
      return refusal(409, "payment_in_progress", "A payment for a different amount is already in progress for this booking. Please contact support.");
    }
    record = open;
    if (open.state !== "creating" && open.intentRef) {
      const current = await deps.provider.getPaymentIntent({ intentRef: open.intentRef, chargeModel: open.chargeModel, recipientRef: open.recipientRef });
      return answerIntent(deps, record, current, quote);
    }
  } else {
    record = {
      id: deps.newId(),
      bookingId: booking.bookingId,
      attemptNo,
      provider: deps.provider.id,
      idempotencyKey,
      intentRef: null,
      recipientRef: recipient.recipientRef,
      recipientPartyId: recipient.partyId,
      chargeModel: model.chargeModel,
      state: "creating",
      intentState: null,
      amount: quote.amount,
      components: quote.components,
      platformFee: quote.platformFee,
      commissionBps: quote.commission.bps,
      commissionRuleVersion: quote.commission.version,
      taxProvider: quote.taxProvider,
      taxCalculationRefs: quote.tax.map((t) => t.calculationRef ?? "").filter((s) => s.length > 0),
      buyerMarket: quote.tax[0]?.buyerMarket ?? recipient.country,
      sellerMarket: recipient.country,
      amountCapturedMinor: 0,
      amountRefundedMinor: 0,
      platformFeeCollectedMinor: 0,
      platformFeeRefundedMinor: 0,
      settlement: null,
      lastSnapshot: null,
      failureReason: null,
      providerCancelOwed: false,
      payoutId: null,
      createdAt: now,
      updatedAt: now,
    };
    // The row exists BEFORE the provider is asked, under the key the provider
    // will see: a crash between the two is resumed by re-sending the same key.
    const ins = await deps.store.insertPayment(record);
    if (!ins.ok) {
      return ins.conflict
        ? refusal(409, "payment_in_progress", "A payment for this booking is already being set up. Please try again in a moment.")
        : READ_FAILED();
    }
  }

  const request: CreatePaymentIntentRequest = {
    idempotencyKey,
    reference: { kind: "rent_buddy_booking", id: booking.bookingId },
    payerProfileId: booking.travelerId,
    payerCountry: record.buyerMarket,
    amount: quote.amount,
    components: quote.components,
    chargeModel: record.chargeModel,
    recipientRef: record.recipientRef,
    recipientCountry: record.sellerMarket,
    platformFee: quote.platformFee,
    capture: "automatic",
    tax: quote.tax,
  };
  const created = await deps.provider.createPaymentIntent(request);
  const statusWrite = await deps.store.setBookingPaymentStatus(booking.bookingId, "pending");
  if (!statusWrite.ok) return READ_FAILED();
  return answerIntent(deps, record, created, quote);
}

/** Persist what the provider said about the intent and answer the route. */
async function answerIntent(
  deps: PaymentSliceDeps,
  record: BookingPaymentRecord,
  r: PaymentResult<PaymentIntentSnapshot>,
  quote: BookingQuote,
): Promise<SliceOutcome> {
  const now = deps.now().toISOString();
  if (r.status === "ok" || r.status === "requires_action" || (r.status === "declined" && r.value)) {
    const snap = r.value as PaymentIntentSnapshot;
    const state: BookingPaymentState = r.status === "declined" ? "failed" : stateFromIntent(snap);
    const write = await deps.store.updatePayment(record.id, {
      intentRef: snap.intentRef,
      intentState: snap.state,
      state: record.state === "creating" || OPEN_STATES.includes(record.state) ? state : record.state,
      failureReason: r.status === "declined" ? r.reason : null,
      updatedAt: now,
    });
    if (!write.ok) return READ_FAILED();
    if (r.status === "declined") {
      const cancelled = await cancelDeclinedIntent(deps, { ...record, intentRef: snap.intentRef }); const cw = await deps.store.updatePayment(record.id, { intentState: cancelled ? "canceled" : snap.state, providerCancelOwed: !cancelled, updatedAt: now }); if (!cw.ok) return READ_FAILED();
      return refusal(402, "payment_declined", "Your payment was declined. No charge was made. You can try another payment method.", { paymentId: record.id });
    }
    return outcome(r.status === "requires_action" ? 202 : 201, {
      paymentId: record.id,
      state,
      provider: deps.provider.id,
      clientSecret: snap.clientSecret,
      nextAction: r.status === "requires_action" ? r.action.kind : state === "awaiting_payment" ? "confirm_payment" : null,
      quote: quoteBody(quote),
    });
  }
  if (r.status === "declined") {
    const write = await deps.store.updatePayment(record.id, { state: "failed", failureReason: r.reason, updatedAt: now });
    if (!write.ok) return READ_FAILED();
    return refusal(402, "payment_declined", "Your payment was declined. No charge was made.", { paymentId: record.id });
  }
  // failed / unavailable. A retriable answer keeps the row `creating` so the same key is re-sent next time.
  if (!r.retriable) {
    const write = await deps.store.updatePayment(record.id, { state: "failed", failureReason: `${r.status}:${r.reason}`, updatedAt: now });
    if (!write.ok) return READ_FAILED();
  }
  return r.status === "unavailable"
    ? refusal(503, "payments_unavailable", "Payments are not available right now. No charge was made.", { reason: r.reason })
    : refusal(r.retriable ? 503 : 422, "payment_failed", "The payment could not be set up. No charge was made.", { reason: r.reason });
}

export interface ConfirmRequest {
  readonly bookingId: string;
  readonly actorUserId: string;
  /** The provider's reference for the payer's payment method (e.g. from the provider's client SDK). */
  readonly paymentMethodRef: string;
  readonly returnUrl: string | null;
  /**
   * The caller's Idempotency-Key, already bound to their payment party by
   * lib/http.ts requireIdempotencyKey and hashed by the route. A retried request
   * re-sends the same provider key, so a double-submitted confirm is ONE confirm.
   */
  readonly requestKey?: string;
}

/** POST confirm: the payer confirms the open payment with a payment method. */
export async function confirmBookingPayment(deps: PaymentSliceDeps, req: ConfirmRequest): Promise<SliceOutcome> {
  if (!deps.paymentsOperational().operational) return UNAVAILABLE();
  if (typeof req.paymentMethodRef !== "string" || req.paymentMethodRef.trim().length === 0) {
    return refusal(400, "invalid_payload", "paymentMethodRef is required.");
  }
  const loaded = await loadForTraveller(deps, req.bookingId, req.actorUserId);
  if (isOutcome(loaded)) return loaded;
  const open = loaded.payments.find((p) => p.state === "awaiting_payment" && p.intentRef);
  if (!open || !open.intentRef) return refusal(409, "no_open_payment", "There is no payment waiting to be confirmed for this booking.");
  const r = await deps.provider.confirmPaymentIntent({
    idempotencyKey: `${open.idempotencyKey}:confirm:${req.requestKey ?? req.paymentMethodRef}`,
    intent: intentHandle({ intentRef: open.intentRef, chargeModel: open.chargeModel, recipientRef: open.recipientRef }),
    paymentMethodRef: req.paymentMethodRef,
    returnUrl: req.returnUrl,
  });
  const now = deps.now().toISOString();
  if (r.status === "ok" || r.status === "requires_action") {
    // NOT 'succeeded' here, even if the snapshot says so: money is recognised by the signed webhook only.
    const snap = r.value;
    const state: BookingPaymentState = snap.state === "succeeded" ? "processing" : stateFromIntent(snap);
    const w = await deps.store.updatePayment(open.id, { intentState: snap.state, state, updatedAt: now });
    if (!w.ok) return READ_FAILED();
    return outcome(r.status === "requires_action" ? 202 : 200, {
      paymentId: open.id,
      state,
      nextAction: r.status === "requires_action" ? r.action.kind : null,
      clientSecret: r.status === "requires_action" ? snap.clientSecret : null,
      message: "Payment submitted. Your booking is marked paid when the payment provider confirms it.",
    });
  }
  if (r.status === "declined") {
    const cancelled = await cancelDeclinedIntent(deps, open); const w = await deps.store.updatePayment(open.id, { state: "failed", failureReason: r.reason, intentState: cancelled ? "canceled" : (r.value?.state ?? open.intentState), providerCancelOwed: !cancelled, updatedAt: now });
    if (!w.ok) return READ_FAILED();
    const s = await deps.store.setBookingPaymentStatus(open.bookingId, "failed");
    if (!s.ok) return READ_FAILED();
    return refusal(402, "payment_declined", "Your payment was declined. No charge was made. You can try another payment method.", { paymentId: open.id });
  }
  return r.status === "unavailable"
    ? refusal(503, "payments_unavailable", "Payments are not available right now. No charge was made.", { reason: r.reason })
    : refusal(r.retriable ? 503 : 422, "payment_failed", "The payment could not be confirmed. No charge was made.", { reason: r.reason });
}

// ── Step 5(b): a declined attempt's intent is cancelled through the contract ──
// A declined confirmation leaves the provider's intent open
// (requires_payment_method), so the payer's card form could still complete it
// later against an attempt this slice has marked failed. It is cancelled here,
// reason "abandoned", under a key derived from the ATTEMPT (`<key>:cancel`), so
// a retry is the same request. A cancel that does not go through is recorded
// on the row (provider_cancel_owed, 3931) and retried by the next checkout for
// the booking, which opens no new intent while one is still owed: at most one
// open intent per booking.

/** True when the intent is closed (cancelled now, or no longer cancellable because it already ended). */
async function cancelDeclinedIntent(deps: PaymentSliceDeps, p: Pick<BookingPaymentRecord, "idempotencyKey" | "intentRef" | "chargeModel" | "recipientRef">): Promise<boolean> {
  if (!p.intentRef) return true;
  const r = await deps.provider.cancelPaymentIntent({
    idempotencyKey: `${p.idempotencyKey}:cancel`,
    intent: intentHandle({ intentRef: p.intentRef, chargeModel: p.chargeModel, recipientRef: p.recipientRef }),
    reason: "abandoned",
  });
  if (r.status === "ok") return true;
  // illegal_state: the intent already ended (cancelled, or captured — which the
  // signed webhook reconciles as money). Nothing is left to cancel.
  return r.status === "failed" && r.reason === "illegal_state";
}

/** Retry every owed cancellation for the booking; a refusal while one is still owed, else null. */
async function settleOwedCancels(deps: PaymentSliceDeps, payments: readonly BookingPaymentRecord[]): Promise<SliceOutcome | null> {
  for (const p of payments) {
    if (!p.providerCancelOwed) continue;
    const done = await cancelDeclinedIntent(deps, p);
    if (!done) {
      return refusal(503, "payments_unavailable", "A previous payment attempt for this booking is still being closed. No charge was made. Please try again shortly.", { reason: "provider_cancel_owed" });
    }
    const w = await deps.store.updatePayment(p.id, { providerCancelOwed: false, intentState: "canceled", updatedAt: deps.now().toISOString() });
    if (!w.ok) return READ_FAILED();
  }
  return null;
}

// ── Only a FULL IN-APP booking is charged in the app (found in Step 6) ───────
// A `deposit_plus_cash` booking's agreed terms put part of the price — or, with
// #603's deposit switch off, all of it — in cash with the buddy
// (cash_balance_usd). Charging its `total_usd` in the app would take the money
// twice. OD-PAY-3 rules out a deposit in the first release, so nothing but
// 'full_in_app' is charged; anything else is refused before a provider is asked.
function NOT_IN_APP(): SliceOutcome {
  return refusal(409, "payment_not_in_app", "This booking was agreed with part of the price paid directly to your Buddy, so it can't be paid in the app. No charge was made. Please contact support.");
}
