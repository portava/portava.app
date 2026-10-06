/**
 * The production BookingPaymentStore: migration 3931's tables plus the booking
 * reads and the one booking write (`payment_status`), through a SERVICE-ROLE
 * supabase client.
 *
 * supabase-js RESOLVES `{ data, error }`; every call here reads `error`, and a
 * failed read is `{ ok: false }` — never an empty list, never "not found".
 * Every write that must have touched a row asks for it back (`.select()`), so
 * "matched nothing" is not mistaken for success.
 *
 * `test/rentBuddyPaymentStoreSchema.test.ts` holds every column this file names
 * against migration 3931 and the baseline, so a typo here fails a test rather
 * than a production statement.
 */
import type { PaymentIntentSnapshot, PayoutSnapshot, RefundSnapshot, SettlementDetails } from "../PaymentProvider.js";
import { ensurePaymentAccount } from "../PaymentLedger.js";
import { majorDecimalToMinor } from "./bookingQuote.js";
import { serviceStartInstant } from "./serviceStart.js";
import {
  readFail,
  readOk,
  writeFail,
  writeOk,
  type BookingForPayment,
  type BookingPaymentRecord,
  type BookingPaymentStore,
  type MonthlyPayoutRecord,
  type MonthlyPayoutState,
  type Read,
  type RecipientRecord,
  type RefundRecord,
  type Write,
} from "./model.js";

export const T_RECIPIENTS = "rent_buddy_payment_recipients";
export const T_PAYMENTS = "rent_buddy_booking_payments";
export const T_REFUNDS = "rent_buddy_payment_refunds";
export const T_PAYOUTS = "rent_buddy_monthly_payouts";
export const T_EVENTS = "payment_webhook_events";

export const BOOKING_COLUMNS =
  "id, status, payment_status, traveler_id, buddy_id, country_code, city, total_usd, booking_date, start_time, completed_at, dispute_window_expires_at, is_test_booking, payment_mode";
export const RECIPIENT_COLUMNS =
  "party_id, provider, recipient_ref, country, settlement_currency, onboarding, charges_enabled, payouts_enabled, requirements_due, provider_updated_at";
export const PAYMENT_COLUMNS =
  "id, booking_id, attempt_no, provider, idempotency_key, intent_ref, recipient_ref, recipient_party_id, charge_model, state, intent_state, currency, amount_minor, " +
  "service_minor, payer_fee_minor, tip_minor, tax_minor, commission_minor, platform_payer_fee_minor, platform_tax_minor, commission_bps, commission_rule_version, " +
  "tax_provider, tax_calculation_refs, buyer_market, seller_market, amount_captured_minor, amount_refunded_minor, platform_fee_collected_minor, " +
  "platform_fee_refunded_minor, settlement, last_snapshot, failure_reason, provider_cancel_owed, payout_id, created_at, updated_at";
export const REFUND_COLUMNS =
  "id, booking_payment_id, provider, idempotency_key, refund_ref, state, reason, amount_minor, currency, refund_platform_fee, requested_by_role, requested_by_party_id, last_snapshot, created_at";
export const PAYOUT_COLUMNS =
  "id, recipient_party_id, provider, period, currency, amount_minor, state, idempotency_key, payout_ref, recipient_ref, booking_payment_ids, hold_reason, held_by, held_at, released_by, released_at, release_reason, carry_reason, failure_code, last_snapshot, created_at, updated_at";

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The earliest-possible start, kept as a named export for the schema suite; the rule lives in serviceStart.ts. */
export function earliestStartInstant(bookingDate: unknown, startTime: unknown): string | null {
  const s = serviceStartInstant(bookingDate, startTime, null);
  return s ? s.instant : null;
}

// ── Allow-listed projections of provider objects (OD-PAY-8) ─────────────────
// What reaches a jsonb column is BUILT here from named fields, never copied: a
// provider object (or an adapter that passes one through) can carry a name, an
// email, a phone number, an address or card digits, and a jsonb column would
// keep them past any erasure. The client secret is never stored either.

const pick = <T extends object>(o: T | null | undefined, keys: readonly (keyof T)[]): Partial<T> | null => {
  if (!o || typeof o !== "object") return null;
  const out: Partial<T> = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
};
const money = (m: unknown): { amountMinor: unknown; currency: unknown } | null =>
  m && typeof m === "object" ? { amountMinor: (m as Record<string, unknown>)["amountMinor"], currency: (m as Record<string, unknown>)["currency"] } : null;

export function projectSettlement(s: SettlementDetails | null | undefined): SettlementDetails | null {
  if (!s || typeof s !== "object") return null;
  const conv = (c: unknown) =>
    c && typeof c === "object" ? pick(c as Record<string, unknown>, ["fromCurrency", "toCurrency", "rate", "rateSource", "rateAt"]) : null;
  return {
    settled: money(s.settled),
    conversion: conv(s.conversion),
    providerFee: s.providerFee ? { amount: money(s.providerFee.amount), paidBy: s.providerFee.paidBy } : null,
    platformFeeSettled: s.platformFeeSettled ? { settled: money(s.platformFeeSettled.settled), conversion: conv(s.platformFeeSettled.conversion) } : null,
  } as unknown as SettlementDetails;
}

export function projectIntentSnapshot(s: PaymentIntentSnapshot | null | undefined): PaymentIntentSnapshot | null {
  const out = pick(s, [
    "intentRef", "chargeModel", "recipientRef", "state", "capture", "amountCapturableMinor", "amountCapturedMinor",
    "amountRefundedMinor", "platformFeeCollectedMinor", "platformFeeRefundedMinor", "livemode", "updatedAt",
  ]);
  if (!out || !s) return null;
  return {
    ...out,
    reference: s.reference ? { kind: s.reference.kind, id: s.reference.id } : s.reference,
    amount: money(s.amount),
    components: pick(s.components, ["serviceMinor", "payerFeeMinor", "tipMinor", "taxMinor"]),
    platformFee: pick(s.platformFee, ["commissionMinor", "payerFeeMinor", "taxMinor"]),
    settlement: projectSettlement(s.settlement),
    clientSecret: null,
  } as unknown as PaymentIntentSnapshot;
}

export function projectRefundSnapshot(s: RefundSnapshot | null | undefined): RefundSnapshot | null {
  const out = pick(s, ["refundRef", "intentRef", "recipientRef", "state", "platformFeeRefundedMinor", "fullyRefunded", "reason", "livemode", "updatedAt"]);
  if (!out || !s) return null;
  return { ...out, amount: money(s.amount) } as unknown as RefundSnapshot;
}

export function projectPayoutSnapshot(s: PayoutSnapshot | null | undefined): PayoutSnapshot | null {
  const out = pick(s, ["payoutRef", "kind", "recipientRef", "state", "amountReversedMinor", "failureCode", "expectedArrivalAt", "livemode", "updatedAt"]);
  if (!out || !s) return null;
  return {
    ...out,
    reference: s.reference ? { kind: s.reference.kind, id: s.reference.id } : null,
    amount: money(s.amount),
    settlement: projectSettlement(s.settlement),
  } as unknown as PayoutSnapshot;
}

function toPayment(r: Record<string, unknown>): BookingPaymentRecord {
  const currency = String(r["currency"]);
  return {
    id: String(r["id"]),
    bookingId: String(r["booking_id"]),
    attemptNo: num(r["attempt_no"]),
    provider: String(r["provider"]),
    idempotencyKey: String(r["idempotency_key"]),
    intentRef: str(r["intent_ref"]),
    recipientRef: String(r["recipient_ref"]),
    recipientPartyId: String(r["recipient_party_id"]),
    chargeModel: r["charge_model"] as BookingPaymentRecord["chargeModel"],
    state: r["state"] as BookingPaymentRecord["state"],
    intentState: (r["intent_state"] ?? null) as BookingPaymentRecord["intentState"],
    amount: { amountMinor: num(r["amount_minor"]), currency },
    components: { serviceMinor: num(r["service_minor"]), payerFeeMinor: num(r["payer_fee_minor"]), tipMinor: num(r["tip_minor"]), taxMinor: num(r["tax_minor"]) },
    platformFee: { commissionMinor: num(r["commission_minor"]), payerFeeMinor: num(r["platform_payer_fee_minor"]), taxMinor: num(r["platform_tax_minor"]) },
    commissionBps: num(r["commission_bps"]),
    commissionRuleVersion: String(r["commission_rule_version"]),
    taxProvider: String(r["tax_provider"]),
    taxCalculationRefs: Array.isArray(r["tax_calculation_refs"]) ? (r["tax_calculation_refs"] as string[]) : [],
    buyerMarket: String(r["buyer_market"]),
    sellerMarket: String(r["seller_market"]),
    amountCapturedMinor: num(r["amount_captured_minor"]),
    amountRefundedMinor: num(r["amount_refunded_minor"]),
    platformFeeCollectedMinor: num(r["platform_fee_collected_minor"]),
    platformFeeRefundedMinor: num(r["platform_fee_refunded_minor"]),
    settlement: (r["settlement"] ?? null) as BookingPaymentRecord["settlement"],
    lastSnapshot: (r["last_snapshot"] ?? null) as PaymentIntentSnapshot | null,
    failureReason: str(r["failure_reason"]),
    providerCancelOwed: r["provider_cancel_owed"] === true,
    payoutId: str(r["payout_id"]),
    createdAt: String(r["created_at"]),
    updatedAt: String(r["updated_at"]),
  };
}

/** The row for a (partial) payment record. Only the keys present are written. */
export function paymentRow(p: Partial<BookingPaymentRecord>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { if (v !== undefined) row[k] = v; };
  set("id", p.id); set("booking_id", p.bookingId); set("attempt_no", p.attemptNo); set("provider", p.provider);
  set("idempotency_key", p.idempotencyKey); set("intent_ref", p.intentRef); set("recipient_ref", p.recipientRef);
  set("recipient_party_id", p.recipientPartyId); set("charge_model", p.chargeModel); set("state", p.state); set("intent_state", p.intentState);
  if (p.amount) { set("currency", p.amount.currency); set("amount_minor", p.amount.amountMinor); }
  if (p.components) {
    set("service_minor", p.components.serviceMinor); set("payer_fee_minor", p.components.payerFeeMinor);
    set("tip_minor", p.components.tipMinor); set("tax_minor", p.components.taxMinor);
  }
  if (p.platformFee) {
    set("commission_minor", p.platformFee.commissionMinor); set("platform_payer_fee_minor", p.platformFee.payerFeeMinor); set("platform_tax_minor", p.platformFee.taxMinor);
  }
  set("commission_bps", p.commissionBps); set("commission_rule_version", p.commissionRuleVersion); set("tax_provider", p.taxProvider);
  if (p.taxCalculationRefs) set("tax_calculation_refs", [...p.taxCalculationRefs]);
  set("buyer_market", p.buyerMarket); set("seller_market", p.sellerMarket);
  set("amount_captured_minor", p.amountCapturedMinor); set("amount_refunded_minor", p.amountRefundedMinor);
  set("platform_fee_collected_minor", p.platformFeeCollectedMinor); set("platform_fee_refunded_minor", p.platformFeeRefundedMinor);
  if (p.settlement !== undefined) set("settlement", projectSettlement(p.settlement)); if (p.lastSnapshot !== undefined) set("last_snapshot", projectIntentSnapshot(p.lastSnapshot)); set("failure_reason", p.failureReason); set("provider_cancel_owed", p.providerCancelOwed); set("payout_id", p.payoutId);
  set("created_at", p.createdAt); set("updated_at", p.updatedAt);
  return row;
}

function toRecipient(r: Record<string, unknown>): RecipientRecord {
  return {
    partyId: String(r["party_id"]),
    provider: String(r["provider"]),
    recipientRef: String(r["recipient_ref"]),
    country: String(r["country"]),
    settlementCurrency: String(r["settlement_currency"]),
    onboarding: r["onboarding"] as RecipientRecord["onboarding"],
    chargesEnabled: r["charges_enabled"] === true,
    payoutsEnabled: r["payouts_enabled"] === true,
    requirementsDue: Array.isArray(r["requirements_due"]) ? (r["requirements_due"] as string[]) : [],
    providerUpdatedAt: str(r["provider_updated_at"]),
  };
}

function toRefund(r: Record<string, unknown>): RefundRecord {
  return {
    id: String(r["id"]),
    bookingPaymentId: String(r["booking_payment_id"]),
    provider: String(r["provider"]),
    idempotencyKey: String(r["idempotency_key"]),
    refundRef: str(r["refund_ref"]),
    state: r["state"] as RefundRecord["state"],
    reason: r["reason"] as RefundRecord["reason"],
    amountMinor: r["amount_minor"] === null || r["amount_minor"] === undefined ? null : num(r["amount_minor"]),
    currency: String(r["currency"]),
    refundPlatformFee: r["refund_platform_fee"] === true,
    requestedByRole: r["requested_by_role"] as RefundRecord["requestedByRole"],
    requestedByPartyId: str(r["requested_by_party_id"]),
    lastSnapshot: (r["last_snapshot"] ?? null) as RefundSnapshot | null,
    createdAt: String(r["created_at"]),
  };
}

export function refundRow(p: Partial<RefundRecord>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { if (v !== undefined) row[k] = v; };
  set("id", p.id); set("booking_payment_id", p.bookingPaymentId); set("provider", p.provider); set("idempotency_key", p.idempotencyKey);
  set("refund_ref", p.refundRef); set("state", p.state); set("reason", p.reason); set("amount_minor", p.amountMinor); set("currency", p.currency);
  set("refund_platform_fee", p.refundPlatformFee); set("requested_by_role", p.requestedByRole); set("requested_by_party_id", p.requestedByPartyId); if (p.lastSnapshot !== undefined) set("last_snapshot", projectRefundSnapshot(p.lastSnapshot)); set("created_at", p.createdAt);
  return row;
}

function toPayout(r: Record<string, unknown>): MonthlyPayoutRecord {
  return {
    id: String(r["id"]),
    recipientPartyId: String(r["recipient_party_id"]),
    provider: String(r["provider"]),
    period: String(r["period"]),
    currency: String(r["currency"]),
    amountMinor: num(r["amount_minor"]),
    state: r["state"] as MonthlyPayoutState,
    idempotencyKey: String(r["idempotency_key"]),
    payoutRef: str(r["payout_ref"]),
    recipientRef: String(r["recipient_ref"]),
    bookingPaymentIds: Array.isArray(r["booking_payment_ids"]) ? (r["booking_payment_ids"] as string[]) : [],
    holdReason: str(r["hold_reason"]),
    heldBy: str(r["held_by"]),
    heldAt: str(r["held_at"]),
    releasedBy: str(r["released_by"]),
    releasedAt: str(r["released_at"]),
    releaseReason: str(r["release_reason"]),
    carryReason: str(r["carry_reason"]),
    failureCode: str(r["failure_code"]),
    lastSnapshot: (r["last_snapshot"] ?? null) as PayoutSnapshot | null,
    createdAt: String(r["created_at"]),
    updatedAt: String(r["updated_at"]),
  };
}

export function payoutRow(p: Partial<MonthlyPayoutRecord>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { if (v !== undefined) row[k] = v; };
  set("id", p.id); set("recipient_party_id", p.recipientPartyId); set("provider", p.provider); set("period", p.period); set("currency", p.currency); set("amount_minor", p.amountMinor);
  set("state", p.state); set("idempotency_key", p.idempotencyKey); set("payout_ref", p.payoutRef); set("recipient_ref", p.recipientRef);
  if (p.bookingPaymentIds) set("booking_payment_ids", [...p.bookingPaymentIds]);
  set("hold_reason", p.holdReason); set("held_by", p.heldBy); set("held_at", p.heldAt); set("released_by", p.releasedBy); set("released_at", p.releasedAt); set("release_reason", p.releaseReason); set("carry_reason", p.carryReason); set("failure_code", p.failureCode); if (p.lastSnapshot !== undefined) set("last_snapshot", projectPayoutSnapshot(p.lastSnapshot));
  set("created_at", p.createdAt); set("updated_at", p.updatedAt);
  return row;
}

const isUnique = (e: { code?: string } | null | undefined): boolean => e?.code === "23505";

/** Build the store over a service-role client. */
export function supabaseBookingPaymentStore(sc: any): BookingPaymentStore {
  const one = async <T>(q: PromiseLike<{ data: unknown; error: unknown }>, map: (r: Record<string, unknown>) => T): Promise<Read<T | null>> => {
    try {
      const { data, error } = await q;
      if (error) return readFail("read failed");
      return readOk(data ? map(data as Record<string, unknown>) : null);
    } catch {
      return readFail("read threw");
    }
  };
  const many = async <T>(q: PromiseLike<{ data: unknown; error: unknown }>, map: (r: Record<string, unknown>) => T): Promise<Read<readonly T[]>> => {
    try {
      const { data, error } = await q;
      if (error || !Array.isArray(data)) return readFail("read failed");
      return readOk((data as Record<string, unknown>[]).map(map));
    } catch {
      return readFail("read threw");
    }
  };
  /** A write that must touch exactly the rows it names: zero rows is a failure (or a CAS conflict). */
  const touched = async (q: PromiseLike<{ data: unknown; error: unknown }>, zeroIsConflict = false): Promise<Write> => {
    try {
      const { data, error } = await q;
      if (error) return writeFail("write failed", isUnique(error as { code?: string }));
      if (!Array.isArray(data) || data.length === 0) return writeFail("write matched no row", zeroIsConflict);
      return writeOk;
    } catch {
      return writeFail("write threw");
    }
  };

  return {
    async loadBooking(bookingId) {
      try {
        const { data, error } = await sc.from("rent_buddy_bookings").select(BOOKING_COLUMNS).eq("id", bookingId).maybeSingle();
        if (error) return readFail("booking read failed");
        if (!data) return readOk(null);
        const b = data as Record<string, unknown>;
        const { data: bp, error: bpErr } = await sc.from("rent_buddy_profiles").select("user_id").eq("id", b["buddy_id"]).maybeSingle();
        if (bpErr) return readFail("buddy read failed");
        const booking: BookingForPayment = {
          bookingId: String(b["id"]),
          status: String(b["status"]),
          paymentStatus: String(b["payment_status"]),
          travelerId: String(b["traveler_id"]),
          buddyProfileId: String(b["buddy_id"]),
          buddyUserId: str((bp as Record<string, unknown> | null)?.["user_id"]),
          serviceCountry: typeof b["country_code"] === "string" && /^[A-Z]{2}$/.test(b["country_code"] as string) ? (b["country_code"] as string) : null,
          serviceMinor: majorDecimalToMinor(b["total_usd"]),
          currency: "USD",
          // In the booking city's zone when it is known; the earliest-possible
          // instant only when it is not (serviceStart.ts, OD-PAY-5).
          ...((): { startsAt: string | null; startBasis: BookingForPayment["startBasis"] } => {
            const st = serviceStartInstant(b["booking_date"], b["start_time"], b["city"]);
            return { startsAt: st ? st.instant : null, startBasis: st ? st.basis : null };
          })(),
          completedAt: str(b["completed_at"]),
          disputeWindowExpiresAt: str(b["dispute_window_expires_at"]),
          isTestBooking: b["is_test_booking"] === true, paymentMode: str(b["payment_mode"]) ?? "",
        };
        return readOk(booking);
      } catch {
        return readFail("booking read threw");
      }
    },
    setBookingPaymentStatus: (bookingId, status) =>
      touched(sc.from("rent_buddy_bookings").update({ payment_status: status, updated_at: new Date().toISOString() }).eq("id", bookingId).select("id")),

    partyForProfile: async (profileId) => {
      const r = await one(sc.from("payment_parties").select("id").eq("profile_id", profileId).maybeSingle(), (x) => String(x["id"]));
      return r;
    },
    profileForParty: async (partyId) => {
      try {
        const { data, error } = await sc.from("payment_parties").select("profile_id").eq("id", partyId).maybeSingle();
        if (error || !data) return readFail("party read failed"); // a party this slice named must exist
        return readOk(str((data as Record<string, unknown>)["profile_id"]));
      } catch {
        return readFail("party read threw");
      }
    },
    ensureUserParty: async (profileId, currency, accountType = "user_payable") => {
      try {
        const r = await ensurePaymentAccount(sc, { owner: { kind: "user", profileId }, accountType, currency });
        return r.ok ? readOk(r.partyId) : readFail(`payment_account_ensure refused: ${r.reason}`);
      } catch {
        return readFail("payment_account_ensure threw");
      }
    },
    ensurePlatformParty: async (currency) => {
      try {
        const r = await ensurePaymentAccount(sc, { owner: { kind: "platform", label: "portava" }, accountType: "refund_liability", currency });
        return r.ok ? readOk(r.partyId) : readFail(`payment_account_ensure refused: ${r.reason}`);
      } catch {
        return readFail("payment_account_ensure threw");
      }
    },
    getRecipient: (partyId) => one(sc.from(T_RECIPIENTS).select(RECIPIENT_COLUMNS).eq("party_id", partyId).maybeSingle(), toRecipient),
    findRecipientByRef: (provider, ref) => one(sc.from(T_RECIPIENTS).select(RECIPIENT_COLUMNS).eq("provider", provider).eq("recipient_ref", ref).maybeSingle(), toRecipient),
    upsertRecipient: (rec) =>
      touched(sc.from(T_RECIPIENTS).upsert({
        party_id: rec.partyId, provider: rec.provider, recipient_ref: rec.recipientRef, country: rec.country,
        settlement_currency: rec.settlementCurrency, onboarding: rec.onboarding, charges_enabled: rec.chargesEnabled,
        payouts_enabled: rec.payoutsEnabled, requirements_due: [...rec.requirementsDue], provider_updated_at: rec.providerUpdatedAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: "party_id" }).select("party_id")),

    listPaymentsForBooking: (bookingId) => many(sc.from(T_PAYMENTS).select(PAYMENT_COLUMNS).eq("booking_id", bookingId).order("attempt_no", { ascending: true }), toPayment),
    findPaymentByIntent: (provider, intentRef) => one(sc.from(T_PAYMENTS).select(PAYMENT_COLUMNS).eq("provider", provider).eq("intent_ref", intentRef).maybeSingle(), toPayment),
    insertPayment: (rec) => touched(sc.from(T_PAYMENTS).insert(paymentRow(rec)).select("id")),
    updatePayment: (id, patch) => touched(sc.from(T_PAYMENTS).update(paymentRow({ ...patch, id: undefined })).eq("id", id).select("id")),
    updatePaymentIfUnchanged: (id, held, patch) => {
      let q = sc.from(T_PAYMENTS).update(paymentRow({ ...patch, id: undefined })).eq("id", id)
        .eq("updated_at", held.updatedAt).eq("state", held.state)
        .eq("amount_captured_minor", held.amountCapturedMinor).eq("amount_refunded_minor", held.amountRefundedMinor);
      q = held.intentState === null ? q.is("intent_state", null) : q.eq("intent_state", held.intentState);
      return touched(q.select("id"), true); // zero rows = another write landed first (F1)
    },
    listUnpaidSucceededPayments: (partyId) => {
      let q = sc.from(T_PAYMENTS).select(PAYMENT_COLUMNS).is("payout_id", null).in("state", ["succeeded", "partially_refunded", "disputed"]);
      if (partyId !== null) q = q.eq("recipient_party_id", partyId);
      return many(q, toPayment);
    },

    insertRefund: (rec) => touched(sc.from(T_REFUNDS).insert(refundRow(rec)).select("id")),
    findRefundByRef: (provider, ref) => one(sc.from(T_REFUNDS).select(REFUND_COLUMNS).eq("provider", provider).eq("refund_ref", ref).maybeSingle(), toRefund),
    updateRefund: (id, patch) => touched(sc.from(T_REFUNDS).update({ ...refundRow({ ...patch, id: undefined }), updated_at: new Date().toISOString() }).eq("id", id).select("id")),
    listRefundsForPayment: (paymentId) => many(sc.from(T_REFUNDS).select(REFUND_COLUMNS).eq("booking_payment_id", paymentId), toRefund),

    insertPayout: (rec) => touched(sc.from(T_PAYOUTS).insert(payoutRow(rec)).select("id")),
    getPayout: (id) => one(sc.from(T_PAYOUTS).select(PAYOUT_COLUMNS).eq("id", id).maybeSingle(), toPayout),
    findPayoutByRef: (_provider, ref) => one(sc.from(T_PAYOUTS).select(PAYOUT_COLUMNS).eq("payout_ref", ref).maybeSingle(), toPayout),
    findPayoutByKey: (key) => one(sc.from(T_PAYOUTS).select(PAYOUT_COLUMNS).eq("idempotency_key", key).maybeSingle(), toPayout),
    transitionPayout: (id, from, patch) =>
      touched(sc.from(T_PAYOUTS).update(payoutRow({ ...patch, id: undefined })).eq("id", id).in("state", [...from]).select("id"), true),

    async recordWebhookEvent(provider, eventId, meta) {
      try {
        const { error: insErr } = await sc.from(T_EVENTS).insert({
          provider, provider_event_id: eventId, endpoint: meta.endpoint, event_type: meta.type, occurred_at: meta.occurredAt,
        });
        if (insErr && !isUnique(insErr)) return readFail("event insert failed");
        const { data, error } = await sc.from(T_EVENTS).select("processed_at").eq("provider", provider).eq("provider_event_id", eventId).maybeSingle();
        if (error || !data) return readFail("event read failed");
        return readOk({ alreadyProcessed: (data as Record<string, unknown>)["processed_at"] != null });
      } catch {
        return readFail("event record threw");
      }
    },
    markWebhookEventProcessed: (provider, eventId, outcome) =>
      touched(sc.from(T_EVENTS).update({ processed_at: new Date().toISOString(), outcome }).eq("provider", provider).eq("provider_event_id", eventId).select("provider")),
  };
}
