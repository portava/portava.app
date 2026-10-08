/**
 * refunds — the owner's refund rules (2026-10-04, "Refunds"), as a decision
 * function and an executor on the PaymentProvider contract.
 *
 *   "Refund in full when the provider cancels, the service is unavailable, or a
 *    safety issue is upheld. Give a full refund for cancellations before service
 *    begins; handle cancellations after it begins through support and
 *    applicable local rules. Don't promise that fees or deposits are
 *    non-refundable."
 *
 * Rules, as implemented:
 *   provider_cancelled        the BUDDY (the service provider) or an admin   → full
 *   service_unavailable       an admin                                       → full
 *   safety_issue_upheld       an admin (a safety report was upheld)          → full
 *   cancelled_before_service  the TRAVELLER, strictly before the start time  → full
 *                             (an unknown start time is not "before": support)
 *   support_decision          an admin, after the service began, with an
 *                             explicit amount — local rules are support's
 * Every refund returns the platform's fee IN PROPORTION (`refundPlatformFee:
 * true`): nothing here makes a fee non-refundable. There is no deposit.
 *
 * Money that was never captured is not "refunded": an open payment is
 * CANCELED with the provider instead, and nothing moves. The money of a
 * refund is booked when the provider's signed event reports it
 * (webhookProcessor.ts, from the intent's refunded counter), never here.
 */
import type { CancelReason, RefundReason } from "../PaymentProvider.js";
import { outcome, refusal, type PaymentSliceDeps, type SliceOutcome } from "./deps.js";
import type { BookingForPayment, BookingPaymentRecord, BookingPaymentState, RefundRecord } from "./model.js";

export type RefundTrigger = "provider_cancelled" | "service_unavailable" | "safety_issue_upheld" | "cancelled_before_service" | "support_decision";
export const REFUND_TRIGGERS: readonly RefundTrigger[] = ["provider_cancelled", "service_unavailable", "safety_issue_upheld", "cancelled_before_service", "support_decision"];

export type RefundActorRole = "traveler" | "buddy" | "admin";

export type RefundDecision =
  | { readonly ok: true; readonly amount: "full" | number; readonly reason: RefundReason; readonly refundPlatformFee: true }
  | { readonly ok: false; readonly httpStatus: number; readonly error: string; readonly message: string };

const REFUNDABLE_STATES: readonly BookingPaymentState[] = ["succeeded", "partially_refunded"];

/**
 * Who may trigger what, and for how much. Pure: no I/O, no clock of its own.
 */
export function decideRefund(input: {
  readonly trigger: RefundTrigger;
  readonly role: RefundActorRole;
  readonly booking: Pick<BookingForPayment, "startsAt">;
  readonly payment: Pick<BookingPaymentRecord, "amountCapturedMinor" | "amountRefundedMinor">;
  readonly now: Date;
  /** support_decision only: the amount support decided, minor units. */
  readonly amountMinor?: number;
}): RefundDecision {
  const deny = (httpStatus: number, error: string, message: string): RefundDecision => ({ ok: false, httpStatus, error, message });
  const refundable = input.payment.amountCapturedMinor - input.payment.amountRefundedMinor;
  if (refundable <= 0) return deny(409, "nothing_to_refund", "Everything paid for this booking has already been refunded.");

  switch (input.trigger) {
    case "provider_cancelled":
      if (input.role !== "buddy" && input.role !== "admin") return deny(403, "forbidden", "Only the Buddy or support can record that the Buddy cancelled.");
      return { ok: true, amount: "full", reason: "provider_cancelled", refundPlatformFee: true };
    case "service_unavailable":
    case "safety_issue_upheld":
      if (input.role !== "admin") return deny(403, "forbidden", "Only support can issue this refund.");
      return { ok: true, amount: "full", reason: input.trigger, refundPlatformFee: true };
    case "cancelled_before_service": {
      if (input.role !== "traveler" && input.role !== "admin") return deny(403, "forbidden", "Only the traveller can cancel their booking for a refund.");
      const startMs = input.booking.startsAt ? Date.parse(input.booking.startsAt) : NaN;
      if (!Number.isFinite(startMs)) {
        return deny(409, "contact_support", "We can't confirm this booking hasn't started, so this refund goes through support.");
      }
      if (input.now.getTime() >= startMs) {
        return deny(409, "service_already_started", "This booking has already started. Refunds after the start are handled by support.");
      }
      return { ok: true, amount: "full", reason: "cancelled_before_service", refundPlatformFee: true };
    }
    case "support_decision": {
      if (input.role !== "admin") return deny(403, "forbidden", "Only support can decide this refund.");
      const a = input.amountMinor;
      if (typeof a !== "number" || !Number.isSafeInteger(a) || a <= 0) return deny(400, "invalid_payload", "A support refund needs a positive amount in minor units.");
      if (a > refundable) return deny(422, "amount_exceeds_refundable", "That is more than remains refundable on this payment.");
      return { ok: true, amount: a === refundable ? "full" : a, reason: "support_decision", refundPlatformFee: true };
    }
  }
}

const CANCEL_REASON: Record<RefundTrigger, CancelReason> = {
  provider_cancelled: "requested_by_recipient",
  service_unavailable: "service_unavailable",
  safety_issue_upheld: "safety",
  cancelled_before_service: "requested_by_payer",
  support_decision: "requested_by_payer",
};

export interface RefundRequest {
  readonly bookingId: string;
  readonly actorUserId: string;
  /** Decided by the ROUTE from the verified token and the booking, never from the body. */
  readonly actorIsAdmin: boolean;
  readonly trigger: RefundTrigger;
  readonly amountMinor?: number;
  /** The caller's Idempotency-Key bound to their party and hashed by the route (see checkout.ts ConfirmRequest). */
  readonly requestKey?: string;
}

/** Execute a refund (or the cancellation of an uncaptured payment) for a booking. */
export async function requestBookingRefund(deps: PaymentSliceDeps, req: RefundRequest): Promise<SliceOutcome> {
  const READ_FAILED = refusal(503, "degraded_unavailable", "We couldn't load this booking's payment. Nothing was refunded. Please try again.");
  if (!REFUND_TRIGGERS.includes(req.trigger)) return refusal(400, "invalid_payload", "Unknown refund reason.");
  const b = await deps.store.loadBooking(req.bookingId);
  if (!b.ok) return READ_FAILED;
  if (!b.value) return refusal(404, "not_found", "Booking not found.");
  const booking = b.value;
  const role: RefundActorRole | null = req.actorIsAdmin
    ? "admin"
    : booking.travelerId === req.actorUserId ? "traveler"
    : booking.buddyUserId === req.actorUserId ? "buddy"
    : null;
  if (!role) return refusal(403, "forbidden", "You are not a party to this booking.");

  const ps = await deps.store.listPaymentsForBooking(booking.bookingId);
  if (!ps.ok) return READ_FAILED;
  const captured = ps.value.find((p) => REFUNDABLE_STATES.includes(p.state));
  const open = ps.value.find((p) => (p.state === "awaiting_payment" || p.state === "processing") && p.intentRef);

  if (!captured) {
    if (!open || !open.intentRef) return refusal(409, "nothing_to_refund", "No payment was taken for this booking.");
    // Not captured: cancel the intent. Nothing moved, so nothing is refunded.
    const r = await deps.provider.cancelPaymentIntent({
      idempotencyKey: `${open.idempotencyKey}:cancel`,
      intent: { intentRef: open.intentRef, chargeModel: open.chargeModel, recipientRef: open.recipientRef },
      reason: CANCEL_REASON[req.trigger],
    });
    if (r.status !== "ok") {
      return refusal(r.status === "unavailable" || (r.status === "failed" && r.retriable) ? 503 : 409, "cancel_failed", "The pending payment could not be cancelled. Please try again or contact support.", { reason: r.reason });
    }
    const w = await deps.store.updatePayment(open.id, { state: "canceled", intentState: r.value.state, updatedAt: deps.now().toISOString() });
    if (!w.ok) return READ_FAILED;
    const s = await deps.store.setBookingPaymentStatus(booking.bookingId, "failed");
    if (!s.ok) return READ_FAILED;
    return outcome(200, { canceled: true, refunded: false, paymentId: open.id, message: "The pending payment was cancelled. You were not charged." });
  }

  const decision = decideRefund({ trigger: req.trigger, role, booking, payment: captured, now: deps.now(), amountMinor: req.amountMinor });
  if (!decision.ok) return refusal(decision.httpStatus, decision.error, decision.message);
  if (!captured.intentRef) return READ_FAILED;

  // Who asked is recorded by ROLE and, for a traveller or a buddy, by their
  // payment party — never by profile id (OD-PAY-8). Support is recorded as a role.
  let requesterParty: string | null = null;
  if (role !== "admin") {
    const p = await deps.store.partyForProfile(req.actorUserId);
    if (!p.ok) return READ_FAILED;
    requesterParty = p.value;
  }
  const prior = await deps.store.listRefundsForPayment(captured.id);
  if (!prior.ok) return READ_FAILED;
  // One FULL refund per trigger per payment: a retried request is the same refund, not a second one.
  // A partial (support) refund is keyed by the caller's request key when there is
  // one: a double-submitted decision is ONE refund, two deliberate decisions are two.
  const seq = decision.amount === "full" ? "full" : req.requestKey ? `req:${req.requestKey}` : String(prior.value.length + 1);
  const idempotencyKey = `rab-refund:${captured.id}:${req.trigger}:${seq}`;
  const existing = prior.value.find((r) => r.idempotencyKey === idempotencyKey);
  // F11 (verifier): `refundable` above is computed from what the WEBHOOK has
  // booked. A different refund still `requested` or `pending` at the provider is
  // money already on its way back, so a second refund is refused HERE, before it
  // reaches the provider. A retry of THIS request (same key) is not a second one.
  const others = prior.value.filter((x) => x.idempotencyKey !== idempotencyKey && x.state !== "failed" && x.state !== "canceled" && x.state !== "refused");
  if (!existing && others.some((x) => x.state === "requested" || x.state === "pending")) {
    return refusal(409, "refund_in_progress", "A refund for this booking is already being processed. Nothing else was refunded.");
  }
  // A refund the provider already answered `succeeded` counts too until its intent
  // webhook moves amountRefundedMinor: the larger of the two is what is gone.
  const capturedMinor = captured.amountCapturedMinor;
  const byRows = others.reduce((sum, x) => sum + (x.amountMinor ?? capturedMinor), 0);
  const remaining = capturedMinor - Math.max(captured.amountRefundedMinor, byRows);
  if (!existing && remaining <= 0) {
    return refusal(409, "refund_in_progress", "A refund for this booking is already being processed. Nothing else was refunded.");
  }
  if (!existing && decision.amount !== "full" && decision.amount > remaining) {
    return refusal(409, "amount_exceeds_refundable", "That amount is more than is left to refund on this booking. Nothing was refunded.");
  }
  const now = deps.now().toISOString();
  const record: RefundRecord = existing ?? {
    id: deps.newId(),
    bookingPaymentId: captured.id,
    provider: deps.provider.id,
    idempotencyKey,
    refundRef: null,
    state: "requested",
    reason: decision.reason,
    amountMinor: decision.amount === "full" ? null : decision.amount,
    currency: captured.amount.currency,
    refundPlatformFee: decision.refundPlatformFee,
    requestedByRole: role,
    requestedByPartyId: role === "admin" ? null : requesterParty,
    lastSnapshot: null,
    createdAt: now,
  };
  if (!existing) {
    const ins = await deps.store.insertRefund(record);
    if (!ins.ok && !ins.conflict) return READ_FAILED;
  }
  const r = await deps.provider.refundPayment({
    idempotencyKey,
    intent: { intentRef: captured.intentRef, chargeModel: captured.chargeModel, recipientRef: captured.recipientRef },
    amountMinor: decision.amount,
    reason: decision.reason,
    refundPlatformFee: decision.refundPlatformFee,
    reverseTransfer: false, // direct charges: there is no transfer to reverse
  });
  if (r.status !== "ok") {
    const failedHard = r.status === "failed" && !r.retriable;
    if (failedHard) {
      const w = await deps.store.updateRefund(record.id, { state: "refused" });
      if (!w.ok) return READ_FAILED;
    }
    return refusal(failedHard ? 422 : 503, "refund_failed", "The refund could not be issued right now. Support has the details.", { reason: r.reason });
  }
  const w = await deps.store.updateRefund(record.id, { refundRef: r.value.refundRef, state: r.value.state, amountMinor: r.value.amount.amountMinor, lastSnapshot: r.value });
  if (!w.ok) return READ_FAILED;
  return outcome(202, {
    refundId: record.id,
    state: r.value.state,
    amount: r.value.amount,
    platformFeeRefundedMinor: r.value.platformFeeRefundedMinor,
    message: "Refund issued. It is final when the payment provider confirms it.",
  });
}
