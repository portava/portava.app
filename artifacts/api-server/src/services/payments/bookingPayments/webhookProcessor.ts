/**
 * webhookProcessor — the one place money is RECOGNISED: a signature-verified
 * provider event is booked to the ledger, then reflected on the payment, the
 * refund, the recipient or the payout, then on the booking.
 *
 * `09` §7 / §10 (hash-verified spec): signed webhook verification, idempotency
 * keys. The provider delivers at least once, late, out of order and concurrently;
 * ANY order and number of deliveries end in the same books, and (step 5 is a
 * compare-and-set, verifier F1) in the same payment row and booking projection.
 *
 * ── THE ORDER OF OPERATIONS, AND WHY ────────────────────────────────────────
 *   1. verify the signature over the RAW body, parse, refuse live mode
 *      (PaymentProvider.verifyAndParseWebhook — the provider's own check)
 *   2. record the event id; if it was already PROCESSED, answer 200 duplicate
 *   3. decide stale vs new against the stored snapshot with the SAME ordering
 *      rule as paymentEventFold.ts (a later instant wins; equal instants are
 *      ordered by the counters that only grow)
 *   4. post the ledger postings the counter change implies — idempotent by key
 *   5. write the new snapshot and state; then the booking's payment_status
 *   6. mark the event processed — LAST
 * A failure at 2–6 answers 503 and marks nothing, so the provider re-delivers
 * and every step re-runs; steps 4–5 are idempotent, so a re-run converges. The
 * ledger is booked BEFORE the state changes: a booking never reads as paid on
 * money the books do not hold (`09` §2: the ledger is the source of truth).
 *
 * ── WHAT EACH ANSWER MEANS TO THE PROVIDER ──────────────────────────────────
 *   200  processed (applied / duplicate / stale / ignored) — do not retry
 *   400  signature invalid or body unreadable — retrying the same bytes is futile
 *   409  a verified LIVE-mode event while live is not allowed — a configuration
 *        fault this deployment refuses; not booked
 *   503  could not be processed now (store or ledger unavailable) — retry
 */
import {
  type DisputeSnapshot,
  type PaymentIntentSnapshot,
  type PaymentWebhookBody,
  type PaymentWebhookEvent,
  type PayoutSnapshot,
  type RecipientSnapshot,
  type RefundSnapshot,
  type WebhookDelivery,
} from "../PaymentProvider.js";
import { applyPaymentEvent, emptyPaymentEventState } from "../paymentEventFold.js";
import { outcome, type PaymentSliceDeps, type SliceOutcome } from "./deps.js";
import { stateFromIntent } from "./checkout.js";
import {
  planChargebackPosting,
  planPaymentPostings,
  planPayoutPaidPosting,
  planProviderFeePosting,
  planPayoutReturnedPosting,
  type LedgerPosting,
} from "./ledgerPostings.js";
import type { BookingPaymentRecord, MonthlyPayoutState, WebhookEventOutcome } from "./model.js";

const RETRY = (why: string): SliceOutcome => outcome(503, { error: "retry_later", detail: why });

/**
 * Would `incoming` replace `held` under the fold's ordering rule? Asks
 * paymentEventFold.ts itself — seed it with the held snapshot, apply the
 * incoming one, read the outcome — so the two can never disagree about "stale".
 */
function isNewer(held: PaymentWebhookBody | null, incoming: PaymentWebhookBody, updatedAt: (b: PaymentWebhookBody) => string): boolean {
  if (held === null) return true;
  const event = (id: string, body: PaymentWebhookBody): PaymentWebhookEvent => ({
    provider: "fold", providerEventId: id, endpoint: "platform", providerEventType: "fold", livemode: false,
    occurredAt: updatedAt(body), accountRef: null, body,
  });
  const seeded = applyPaymentEvent(emptyPaymentEventState(), event("held", held)).state;
  return applyPaymentEvent(seeded, event("incoming", incoming)).outcome === "applied";
}

const intentBody = (s: PaymentIntentSnapshot | null): PaymentWebhookBody | null => (s ? { kind: "payment_intent", intent: s } : null);
const refundBody = (s: RefundSnapshot | null): PaymentWebhookBody | null => (s ? { kind: "refund", refund: s } : null);
const payoutBody = (s: PayoutSnapshot | null): PaymentWebhookBody | null => (s ? { kind: "payout", payout: s } : null);
const bodyTime = (b: PaymentWebhookBody): string => {
  switch (b.kind) {
    case "payment_intent": return b.intent.updatedAt;
    case "refund": return b.refund.updatedAt;
    case "recipient": return b.recipient.updatedAt;
    case "payout": return b.payout.updatedAt;
    case "dispute": return b.dispute.updatedAt;
    default: return "";
  }
};

async function postAll(deps: PaymentSliceDeps, postings: readonly LedgerPosting[]): Promise<string | null> {
  for (const p of postings) {
    const r = await deps.ledger.post(p);
    if (!r.ok) return `${r.reason}: ${r.detail}`;
  }
  return null;
}

function bookingStatusFor(state: string): "pending" | "captured" | "partial" | "refunded" | "failed" | null {
  switch (state) {
    case "succeeded": return "captured";
    case "partially_refunded": return "partial";
    case "refunded": return "refunded";
    case "failed":
    case "canceled": return "failed";
    case "awaiting_payment":
    case "processing": return "pending";
    default: return null; // disputed / reversed keep the last money status; the payment row carries the dispute
  }
}

/**
 * Two deliveries for ONE intent can be processed at the same time (verifier F1).
 * Each read-decide-write below is a compare-and-set on what it read; a delivery
 * whose write finds the row changed re-reads and decides again (a stale one then
 * takes the `stale` path, which re-asserts the booking from the CURRENT row). A
 * booking projection written from a row that has since changed is re-asserted.
 * Bounded; past the bound the provider retries (503).
 */
const CAS_MISS = Symbol("cas_miss");
const CAS_ATTEMPTS = 4;

async function applyIntent(deps: PaymentSliceDeps, snap: PaymentIntentSnapshot, occurredAt: string): Promise<WebhookEventOutcome | string> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const r = await applyIntentOnce(deps, snap, occurredAt);
    if (r !== CAS_MISS) return r;
  }
  return "payment changed concurrently on every attempt";
}

/** The booking's payment_status from the payment row as it stands; CAS_MISS when the row moved underneath. */
async function projectBooking(deps: PaymentSliceDeps, payment: BookingPaymentRecord): Promise<string | null | typeof CAS_MISS> {
  const bs = bookingStatusFor(payment.state);
  if (!bs) return null;
  const b = await deps.store.setBookingPaymentStatus(payment.bookingId, bs);
  if (!b.ok) return "booking payment_status write failed";
  const again = await deps.store.findPaymentByIntent(deps.provider.id, payment.intentRef ?? "");
  if (!again.ok) return "store unreadable";
  if (again.value && !sameInstant(again.value.updatedAt, payment.updatedAt)) return CAS_MISS; // another delivery wrote the row after we read it (compared as INSTANTS: PostgREST answers "+00:00", JS writes "Z" — verifier NEW-1)
  return null;
}

async function applyIntentOnce(deps: PaymentSliceDeps, snap: PaymentIntentSnapshot, occurredAt: string): Promise<WebhookEventOutcome | string | typeof CAS_MISS> {
  const found = await deps.store.findPaymentByIntent(deps.provider.id, snap.intentRef);
  if (!found.ok) return "store unreadable";
  const payment = found.value;
  if (!payment) return "ignored"; // an intent this platform did not create through this slice
  if (snap.amount.amountMinor !== payment.amount.amountMinor || snap.amount.currency !== payment.amount.currency) {
    return "provider reported a different original amount for this intent; refusing to book it";
  }
  if (!isNewer(intentBody(payment.lastSnapshot), { kind: "payment_intent", intent: snap }, bodyTime)) {
    // Stale or a re-delivery of what is already applied. Re-assert the booking's
    // projection from the CURRENT payment state: if an earlier delivery wrote the
    // payment and then failed on the booking, this is what completes it.
    const projected = await projectBooking(deps, payment);
    if (projected !== null) return projected;
    return "stale";
  }

  const prev = {
    capturedMinor: payment.amountCapturedMinor,
    refundedMinor: payment.amountRefundedMinor,
    feeCollectedMinor: payment.platformFeeCollectedMinor,
    feeRefundedMinor: payment.platformFeeRefundedMinor,
  };
  const next = {
    capturedMinor: snap.amountCapturedMinor,
    refundedMinor: snap.amountRefundedMinor,
    feeCollectedMinor: snap.platformFeeCollectedMinor,
    feeRefundedMinor: snap.platformFeeRefundedMinor,
  };
  const feeOf = (st: PaymentIntentSnapshot["settlement"]): number =>
    st?.providerFee && st.providerFee.paidBy === "recipient" && st.providerFee.amount.currency === payment.amount.currency ? st.providerFee.amount.amountMinor : 0;
  const providerFee = planProviderFeePosting(payment, feeOf(payment.settlement), feeOf(snap.settlement ?? payment.settlement), occurredAt);
  const failure = await postAll(deps, [...planPaymentPostings(payment, prev, next, occurredAt), ...(providerFee ? [providerFee] : [])]);
  if (failure) return failure;

  let state = stateFromIntent(snap);
  if (payment.state === "disputed" || payment.state === "reversed") state = payment.state; // a dispute outranks the money status
  else if ((payment.state === "failed" || payment.state === "canceled") && snap.amountCapturedMinor === 0) state = payment.state; // an ended attempt is not reopened by a late event; only captured money would
  // A payment method that was SUBMITTED (confirmed, or sent to authenticate) and
  // is now wanted again failed: that attempt is `failed`, explicitly. An intent
  // that was never submitted shows the same provider state, so the record's own
  // history decides, not the snapshot alone.
  else if (snap.state === "requires_payment_method" && (payment.state === "processing" || payment.intentState === "requires_action")) state = "failed";
  // A `requires_confirmation` snapshot predates any confirmation: it never moves a submitted payment backwards.
  else if (snap.state === "requires_confirmation" && payment.state === "processing") state = "processing";
  const nowIso = deps.now().toISOString();
  const updatedAt = Date.parse(nowIso) > Date.parse(payment.updatedAt) ? nowIso : new Date(Date.parse(payment.updatedAt) + 1).toISOString(); // strictly after what was read (as instants, NEW-1), so the next compare-and-set sees this write
  const w = await deps.store.updatePaymentIfUnchanged(payment.id, payment, {
    intentState: snap.state,
    state,
    amountCapturedMinor: next.capturedMinor,
    amountRefundedMinor: next.refundedMinor,
    platformFeeCollectedMinor: next.feeCollectedMinor,
    platformFeeRefundedMinor: next.feeRefundedMinor,
    settlement: snap.settlement ?? payment.settlement,
    lastSnapshot: snap,
    failureReason: state === "failed" ? "payment_failed_after_confirmation" : payment.failureReason,
    updatedAt,
  });
  if (!w.ok) return w.conflict ? CAS_MISS : "payment write failed";
  const projected = await projectBooking(deps, { ...payment, state, updatedAt });
  if (projected === CAS_MISS) return CAS_MISS; // the stale-path re-run re-projects from the newer row; this delivery's money is already booked and idempotent
  if (projected !== null) return projected;
  return "applied";
}

async function applyRefund(deps: PaymentSliceDeps, snap: RefundSnapshot): Promise<WebhookEventOutcome | string> {
  // The MONEY of a refund is booked from the intent's refunded counter (applyIntent); this records the refund's own state.
  const found = await deps.store.findRefundByRef(deps.provider.id, snap.refundRef);
  if (!found.ok) return "store unreadable";
  if (!found.value) return "ignored";
  if (!isNewer(refundBody(found.value.lastSnapshot), { kind: "refund", refund: snap }, bodyTime)) return "stale";
  const w = await deps.store.updateRefund(found.value.id, { state: snap.state, amountMinor: snap.amount.amountMinor, lastSnapshot: snap });
  return w.ok ? "applied" : "refund write failed";
}

async function applyRecipient(deps: PaymentSliceDeps, snap: RecipientSnapshot): Promise<WebhookEventOutcome | string> {
  const found = await deps.store.findRecipientByRef(deps.provider.id, snap.recipientRef);
  if (!found.ok) return "store unreadable";
  if (!found.value) return "ignored";
  const held = found.value;
  if (held.providerUpdatedAt && snap.updatedAt < held.providerUpdatedAt) return "stale";
  const w = await deps.store.upsertRecipient({
    ...held,
    country: snap.country,
    settlementCurrency: snap.settlementCurrency,
    onboarding: snap.onboarding,
    chargesEnabled: snap.chargesEnabled,
    payoutsEnabled: snap.payoutsEnabled,
    requirementsDue: [...snap.requirementsDue],
    providerUpdatedAt: snap.updatedAt,
  });
  return w.ok ? "applied" : "recipient write failed";
}

const PAYOUT_STATE: Record<PayoutSnapshot["state"], MonthlyPayoutState> = {
  pending: "pending", on_hold: "held", in_transit: "in_transit", paid: "paid",
  failed: "failed", returned: "returned", canceled: "canceled", reversed: "canceled",
};

async function applyPayout(deps: PaymentSliceDeps, snap: PayoutSnapshot, occurredAt: string): Promise<WebhookEventOutcome | string> {
  if (snap.reference === null) return "ignored"; // a payout the provider started on its own schedule: not one of ours
  const found = await deps.store.findPayoutByRef(deps.provider.id, snap.payoutRef);
  if (!found.ok) return "store unreadable";
  const payout = found.value;
  if (!payout) return "ignored";
  if (!isNewer(payoutBody(payout.lastSnapshot), { kind: "payout", payout: snap }, bodyTime)) return "stale";
  const wasPaid = payout.lastSnapshot?.state === "paid";
  if (snap.state === "paid" && !wasPaid) {
    const f = await postAll(deps, [planPayoutPaidPosting(payout, occurredAt)]);
    if (f) return f;
  }
  if (snap.state === "returned") {
    // A return only reverses money that was booked as paid. Book "paid" first if this is the first we hear of it.
    const f = await postAll(deps, [planPayoutPaidPosting(payout, occurredAt), planPayoutReturnedPosting(payout, occurredAt)]);
    if (f) return f;
  }
  const w = await deps.store.transitionPayout(payout.id, [payout.state], {
    state: PAYOUT_STATE[snap.state],
    failureCode: snap.failureCode,
    lastSnapshot: snap,
    updatedAt: deps.now().toISOString(),
  });
  if (!w.ok) return w.conflict ? "payout changed concurrently" : "payout write failed";
  // A failed or returned payout releases its payments for the next run: nothing was paid out after all.
  if (snap.state === "failed" || snap.state === "returned" || snap.state === "canceled" || snap.state === "reversed") {
    for (const id of payout.bookingPaymentIds) {
      const u = await deps.store.updatePayment(id, { payoutId: null, updatedAt: deps.now().toISOString() });
      if (!u.ok) return "payment release write failed";
    }
  }
  return "applied";
}

async function applyDispute(deps: PaymentSliceDeps, snap: DisputeSnapshot, occurredAt: string): Promise<WebhookEventOutcome | string> {
  const found = await deps.store.findPaymentByIntent(deps.provider.id, snap.intentRef);
  if (!found.ok) return "store unreadable";
  const payment: BookingPaymentRecord | null = found.value;
  if (!payment) return "ignored";
  if (snap.state === "lost") {
    const f = await postAll(deps, [planChargebackPosting(payment, snap.disputeRef, snap.amount.amountMinor, occurredAt)]);
    if (f) return f;
  }
  const state =
    snap.state === "lost" ? "reversed"
    : snap.state === "won" ? (payment.amountRefundedMinor > 0 ? "partially_refunded" : "succeeded")
    : "disputed";
  const w = await deps.store.updatePayment(payment.id, { state, updatedAt: deps.now().toISOString() });
  return w.ok ? "applied" : "payment write failed";
}

/** Process one delivery end to end. Never throws. */
export async function processPaymentWebhook(deps: PaymentSliceDeps, delivery: WebhookDelivery): Promise<SliceOutcome> {
  try {
    const v = await deps.provider.verifyAndParseWebhook(delivery);
    if (v.status !== "ok") {
      if (v.status === "failed" && (v.reason === "signature_invalid" || v.reason === "webhook_malformed" || v.reason === "invalid_request")) {
        return outcome(400, { error: v.reason });
      }
      if (v.status === "unavailable" && v.reason === "livemode_not_allowed") return outcome(409, { error: "livemode_not_allowed" });
      return RETRY(`${v.status}:${v.reason}`);
    }
    const event = v.value;
    const receipt = await deps.store.recordWebhookEvent(event.provider, event.providerEventId, {
      endpoint: event.endpoint, type: event.providerEventType, occurredAt: event.occurredAt,
    });
    if (!receipt.ok) return RETRY("event record unavailable");
    if (receipt.value.alreadyProcessed) return outcome(200, { received: true, outcome: "duplicate" });

    let result: WebhookEventOutcome | string;
    switch (event.body.kind) {
      case "payment_intent": result = await applyIntent(deps, event.body.intent, event.occurredAt); break;
      case "refund": result = await applyRefund(deps, event.body.refund); break;
      case "recipient": result = await applyRecipient(deps, event.body.recipient); break;
      case "payout": result = await applyPayout(deps, event.body.payout, event.occurredAt); break;
      case "dispute": result = await applyDispute(deps, event.body.dispute, event.occurredAt); break;
      default: result = "ignored";
    }
    if (result !== "applied" && result !== "stale" && result !== "ignored" && result !== "duplicate") return RETRY(result);
    const done = await deps.store.markWebhookEventProcessed(event.provider, event.providerEventId, result);
    if (!done.ok) return RETRY("event mark failed");
    return outcome(200, { received: true, outcome: result });
  } catch {
    return RETRY("unexpected error");
  }
}

/** Two timestamps name the same instant, whatever their text form (PostgREST "…+00:00" vs JS "….000Z"). An unparsable one never matches. */
export function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}
