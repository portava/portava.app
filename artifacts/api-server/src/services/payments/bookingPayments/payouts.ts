/**
 * payouts — monthly payouts to buddies, after earnings are finalised, the
 * service is completed and verification is complete; small balances carried
 * forward.
 *
 * Owner ruling (2026-10-04, "Payout schedule"): "Pay creators monthly, after
 * earnings are finalized, services are completed, and required verification is
 * complete. Carry small balances forward to a locally appropriate minimum."
 *
 * ── TWO STEPS, SO A PERSON CAN HOLD ONE ─────────────────────────────────────
 *   plan     for a period (YYYY-MM): each buddy's eligible earnings, per
 *            currency, become ONE `planned` payout row, and the payments in it
 *            are marked as included (so no payment is ever planned twice). A
 *            total under the minimum — or with NO configured minimum — is a
 *            `carried_forward` row instead, and its payments stay unincluded,
 *            so they roll into the next month's plan.
 *   execute  each `planned` row is requested from the provider. An admin may
 *            HOLD a planned row first (and release it); a held row is skipped.
 * The provider's signed payout events move a requested row to in_transit /
 * paid / failed / returned (webhookProcessor.ts), and only `paid` is booked to
 * the ledger. A failed or returned payout releases its payments to the next
 * plan: nothing was paid after all.
 *
 * ── ELIGIBILITY OF ONE PAYMENT (every clause is a refusal reason) ───────────
 *   completed       the booking has `completed_at`, before the period's end
 *   finalised       its dispute window has CLOSED (`dispute_window_expires_at`
 *                   in the past). Unknown is not closed.
 *   settled         the payment is `succeeded` or `partially_refunded` — not
 *                   disputed, reversed or fully refunded — and has no refund
 *                   still pending
 *   same_currency   it settled in the currency it was charged in. A converted
 *                   settlement needs reconciliation by a person: no conversion
 *                   rate is invented here.
 * and of the BUDDY: a current REAL identity verification, and the provider
 * says the account can be paid out (`validateRecipient` ok, payouts enabled).
 *
 * ── THE MINIMUM IS NOT DECIDED, SO IT IS CONFIGURATION WITH NO DEFAULT ──────
 * "a locally appropriate minimum" names no number for any market. Each
 * currency's minimum is read from RAB_PAYOUT_MINIMUMS (e.g. "USD:2500") and a
 * currency with no entry pays NOTHING out — its balance is carried forward with
 * reason `payout_minimum_not_configured`. Inventing a default would be choosing
 * the owner's number for them.
 */
import { outcome, refusal, type PaymentSliceDeps, type SliceOutcome } from "./deps.js";
import type { BookingPaymentRecord, MonthlyPayoutRecord, MonthlyPayoutState } from "./model.js";

export const PAYOUT_MINIMUMS_ENV = "RAB_PAYOUT_MINIMUMS" as const;

export interface PayoutPolicy {
  /** Minimum payout per currency, integer minor units. A currency absent here pays nothing out. */
  readonly minimumByCurrency: Readonly<Record<string, number>>;
}

/** "USD:2500,GBP:2000" → { USD: 2500, GBP: 2000 }. Malformed tokens are ignored (and so pay nothing out). */
export function payoutPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PayoutPolicy {
  const out: Record<string, number> = {};
  for (const token of (env[PAYOUT_MINIMUMS_ENV] ?? "").split(",")) {
    const m = /^\s*([A-Z]{3})\s*:\s*(\d{1,12})\s*$/.exec(token);
    if (m) out[m[1] as string] = Number(m[2]);
  }
  return { minimumByCurrency: Object.freeze(out) };
}

/** [start, endExclusive) of a YYYY-MM period in UTC, or null when malformed. */
export function periodBounds(period: string): { start: Date; endExclusive: Date } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { start: new Date(Date.UTC(y, mo - 1, 1)), endExclusive: new Date(Date.UTC(y, mo, 1)) };
}

export type IneligibleReason =
  | "not_completed"
  | "completed_after_period"
  | "dispute_window_open"
  | "finalisation_unknown"
  | "not_settled"
  | "refund_pending"
  | "settled_in_other_currency"
  | "booking_unreadable";

/** What remains on the buddy's provider balance from one payment: captured − fee − provider fee − (refunded − fee refunded). */
export function netForRecipientMinor(p: BookingPaymentRecord): number {
  const providerFee =
    p.settlement?.providerFee && p.settlement.providerFee.paidBy === "recipient" && p.settlement.providerFee.amount.currency === p.amount.currency
      ? p.settlement.providerFee.amount.amountMinor
      : 0;
  return p.amountCapturedMinor - p.platformFeeCollectedMinor - providerFee - (p.amountRefundedMinor - p.platformFeeRefundedMinor);
}

export interface PlanReportLine {
  readonly recipientPartyId: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly result: "planned" | "carried_forward" | "skipped";
  readonly reason: string | null;
  readonly payoutId: string | null;
  readonly paymentCount: number;
}

/** PLAN the payouts for a period. Admin-triggered; idempotent per (recipient account, period, currency). */
export async function planMonthlyPayouts(deps: PaymentSliceDeps, policy: PayoutPolicy, period: string): Promise<SliceOutcome> {
  const bounds = periodBounds(period);
  if (!bounds) return refusal(400, "invalid_payload", "period must be YYYY-MM.");
  const now = deps.now();
  if (now < bounds.endExclusive) return refusal(409, "period_not_closed", "A month is paid out only after it has ended.");

  const unpaid = await deps.store.listUnpaidSucceededPayments(null);
  if (!unpaid.ok) return refusal(503, "degraded_unavailable", "Payments could not be read; nothing was planned.");

  const ineligible: Array<{ paymentId: string; reason: IneligibleReason }> = [];
  const groups = new Map<string, BookingPaymentRecord[]>();
  for (const p of unpaid.value) {
    if (p.state !== "succeeded" && p.state !== "partially_refunded") { ineligible.push({ paymentId: p.id, reason: "not_settled" }); continue; }
    const b = await deps.store.loadBooking(p.bookingId);
    if (!b.ok || !b.value) { ineligible.push({ paymentId: p.id, reason: "booking_unreadable" }); continue; }
    const booking = b.value;
    if (!booking.completedAt) { ineligible.push({ paymentId: p.id, reason: "not_completed" }); continue; }
    if (Date.parse(booking.completedAt) >= bounds.endExclusive.getTime()) { ineligible.push({ paymentId: p.id, reason: "completed_after_period" }); continue; }
    if (!booking.disputeWindowExpiresAt) { ineligible.push({ paymentId: p.id, reason: "finalisation_unknown" }); continue; }
    if (Date.parse(booking.disputeWindowExpiresAt) > now.getTime()) { ineligible.push({ paymentId: p.id, reason: "dispute_window_open" }); continue; }
    const refunds = await deps.store.listRefundsForPayment(p.id);
    if (!refunds.ok) { ineligible.push({ paymentId: p.id, reason: "booking_unreadable" }); continue; }
    if (refunds.value.some((r) => r.state === "requested" || r.state === "pending")) { ineligible.push({ paymentId: p.id, reason: "refund_pending" }); continue; }
    const settled = p.settlement?.settled.currency;
    if (settled && settled !== p.amount.currency) { ineligible.push({ paymentId: p.id, reason: "settled_in_other_currency" }); continue; }
    const key = `${p.recipientPartyId}\u0000${p.recipientRef}\u0000${p.amount.currency}\u0000${p.provider}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  const report: PlanReportLine[] = [];
  for (const [key, items] of groups) {
    const [recipientPartyId, recipientRef, currency, provider] = key.split("\u0000") as [string, string, string, string];
    const amountMinor = items.reduce((n, p) => n + netForRecipientMinor(p), 0);
    const base = { recipientPartyId, currency, amountMinor, paymentCount: items.length };

    // The buddy: verified, and payable by the provider.
    // Verification is a fact about a PERSON: the party leads back to one only
    // while the identity link exists. After an erasure there is nobody to verify,
    // so nothing is paid out (the balance stays on the pseudonymous party).
    const profile = await deps.store.profileForParty(recipientPartyId);
    if (!profile.ok) { report.push({ ...base, result: "skipped", reason: "verification_unreadable", payoutId: null }); continue; }
    if (!profile.value) { report.push({ ...base, result: "skipped", reason: "identity_removed", payoutId: null }); continue; }
    const verified = await deps.personVerified(profile.value);
    if (verified !== "verified") {
      report.push({ ...base, result: "skipped", reason: verified === "unreadable" ? "verification_unreadable" : "recipient_not_verified", payoutId: null });
      continue;
    }
    const acct = await deps.provider.validateRecipient(recipientRef);
    if (acct.status !== "ok" || !acct.value.payoutsEnabled) {
      report.push({ ...base, result: "skipped", reason: "recipient_payouts_not_enabled", payoutId: null });
      continue;
    }

    const idempotencyKey = `rab-payout:${recipientRef}:${period}:${currency}`;
    const existing = await deps.store.findPayoutByKey(idempotencyKey);
    if (!existing.ok) return refusal(503, "degraded_unavailable", "Payouts could not be read; planning stopped part-way and can be re-run.", { report });
    if (existing.value && existing.value.state !== "carried_forward") {
      report.push({ ...base, result: "skipped", reason: `already_${existing.value.state}`, payoutId: existing.value.id });
      continue;
    }

    const minimum = policy.minimumByCurrency[currency];
    const carryReason = minimum === undefined ? "payout_minimum_not_configured" : amountMinor < minimum ? "below_minimum" : amountMinor <= 0 ? "nothing_owed" : null;
    const nowIso = now.toISOString();
    const rec: MonthlyPayoutRecord = {
      id: existing.value?.id ?? deps.newId(),
      recipientPartyId,
      provider,
      period,
      currency,
      amountMinor,
      state: carryReason ? "carried_forward" : "planned",
      idempotencyKey,
      payoutRef: null,
      recipientRef,
      bookingPaymentIds: carryReason ? [] : items.map((p) => p.id),
      holdReason: null,
      heldBy: null,
      heldAt: null,
      releasedBy: null,
      releasedAt: null,
      releaseReason: null,
      carryReason,
      failureCode: null,
      lastSnapshot: null,
      createdAt: existing.value?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    const w = existing.value
      ? await deps.store.transitionPayout(rec.id, ["carried_forward"], rec)
      : await deps.store.insertPayout(rec);
    if (!w.ok) return refusal(503, "degraded_unavailable", "A payout could not be recorded; planning stopped part-way and can be re-run.", { report });
    if (!carryReason) {
      for (const p of items) {
        const u = await deps.store.updatePayment(p.id, { payoutId: rec.id, updatedAt: nowIso });
        if (!u.ok) return refusal(503, "degraded_unavailable", "A payment could not be marked as planned; planning stopped part-way and can be re-run.", { report });
      }
    }
    report.push({ ...base, result: carryReason ? "carried_forward" : "planned", reason: carryReason, payoutId: rec.id });
  }
  return outcome(200, { period, report, ineligible });
}

/** EXECUTE: request every planned (not held) payout of a period from the provider. */
export async function executePlannedPayouts(deps: PaymentSliceDeps, payoutIds: readonly string[]): Promise<SliceOutcome> {
  const results: Array<{ payoutId: string; result: string }> = [];
  for (const id of payoutIds) {
    const r = await deps.store.getPayout(id);
    if (!r.ok) { results.push({ payoutId: id, result: "unreadable" }); continue; }
    const payout = r.value;
    if (!payout) { results.push({ payoutId: id, result: "not_found" }); continue; }
    if (payout.state !== "planned") { results.push({ payoutId: id, result: `skipped_${payout.state}` }); continue; }
    // P-3 (lead ruling 2026-10-07, pending legal review): a payout to an ERASED party is held, not released —
    // never requested — pending manual review. Planning skips such a party; this is a row planned before the erasure.
    const who = await deps.store.profileForParty(payout.recipientPartyId);
    if (!who.ok) { results.push({ payoutId: id, result: "skipped_recipient_unreadable" }); continue; }
    if (!who.value) { results.push({ payoutId: id, result: "held_recipient_identity_removed" }); continue; }
    const res = await deps.provider.requestPayout({
      idempotencyKey: payout.idempotencyKey,
      kind: "payout",
      recipientRef: payout.recipientRef,
      amount: { amountMinor: payout.amountMinor, currency: payout.currency },
      reference: { kind: "rab_monthly_payout", id: payout.id },
    });
    const nowIso = deps.now().toISOString();
    if (res.status === "ok") {
      const w = await deps.store.transitionPayout(payout.id, ["planned"], { state: "requested", payoutRef: res.value.payoutRef, updatedAt: nowIso });
      results.push({ payoutId: id, result: w.ok ? "requested" : w.conflict ? "changed_concurrently" : "write_failed" });
      continue;
    }
    if ((res.status === "failed" && !res.retriable) || res.status === "declined") {
      const w = await deps.store.transitionPayout(payout.id, ["planned"], { state: "failed", failureCode: res.reason, updatedAt: nowIso });
      let released = w.ok;
      if (w.ok) {
        for (const pid of payout.bookingPaymentIds) {
          const u = await deps.store.updatePayment(pid, { payoutId: null, updatedAt: nowIso });
          if (!u.ok) released = false;
        }
      }
      // A payout that failed but whose payments could not be released must be SEEN: they would otherwise never be paid.
      results.push({ payoutId: id, result: released ? `failed:${res.reason}` : `failed:${res.reason}:payments_not_released` });
      continue;
    }
    results.push({ payoutId: id, result: `retry_later:${res.reason}` });
  }
  return outcome(200, { results });
}

/**
 * Admin HOLD of a planned payout (before it is requested), and RELEASE back to
 * planned. Compare-and-swap, and the ACTOR and the REASON are written in the
 * same single UPDATE as the state change, so a hold that happened always says
 * who placed it and why — and a refused transition records nothing.
 * A reason is required both ways (at least 5 characters).
 */
export async function holdOrReleasePayout(
  deps: PaymentSliceDeps,
  input: { payoutId: string; action: "hold" | "release"; reason: string | null; actorUserId: string },
): Promise<SliceOutcome> {
  if (!input.reason || input.reason.trim().length < 5) {
    return refusal(400, "invalid_payload", `A ${input.action} needs a reason (at least 5 characters).`);
  }
  if (typeof input.actorUserId !== "string" || input.actorUserId.length === 0) return refusal(403, "forbidden", "No acting admin.");
  const r = await deps.store.getPayout(input.payoutId);
  if (!r.ok) return refusal(503, "degraded_unavailable", "The payout could not be read.");
  if (!r.value) return refusal(404, "not_found", "Payout not found.");
  const from: readonly MonthlyPayoutState[] = input.action === "hold" ? ["planned"] : ["held"];
  const now = deps.now().toISOString();
  const reason = input.reason.trim();
  const w = await deps.store.transitionPayout(
    input.payoutId,
    from,
    input.action === "hold"
      ? { state: "held", holdReason: reason, heldBy: input.actorUserId, heldAt: now, updatedAt: now }
      : { state: "planned", releaseReason: reason, releasedBy: input.actorUserId, releasedAt: now, updatedAt: now },
  );
  if (!w.ok) {
    return w.conflict
      ? refusal(409, "payout_not_in_state", `Only a ${from[0]} payout can be ${input.action === "hold" ? "held" : "released"}.`, { state: r.value.state })
      : refusal(503, "degraded_unavailable", "The payout could not be updated.");
  }
  return outcome(200, { payoutId: input.payoutId, state: input.action === "hold" ? "held" : "planned" });
}
