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

// The five 3931 tables. Every `.from(...)` below spells its table as a string
// LITERAL, not through these names: check:write-path-columns and
// check:schema-references can only check the columns of a call whose table is a
// literal. A `.from(T_PAYMENTS)` is a "dynamic table name" blind spot to both.
// These constants remain for the schema suite. rentBuddyPaymentStoreSchema.test.ts
// holds the literals and these names to the same five tables.
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

/**
 * Drop the keys whose value is `undefined`, in place: a PATCH writes only the
 * columns it names. `null` is a value and is kept.
 *
 * WHY THE ROW BUILDERS ARE ONE OBJECT LITERAL EACH. `check:write-path-columns`
 * (live schema) and `check:schema-references` (baseline + migrations) read the
 * columns a write names out of the TypeScript AST. They follow a same-file
 * builder to the object literal its returned variable is initialised with, and
 * no further. A builder that assembled its row key by key was invisible to
 * both. So every column each builder can write is spelled once, in one literal,
 * under a variable name used nowhere else in this file. The extractor resolves
 * an identifier to the nearest declaration of that NAME before the call site,
 * so a shared name would be checked against another table's columns.
 */
function dropUndefined(row: Record<string, unknown>): void {
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
}

/** The row for a (partial) payment record. Only the keys present are written. */
export function paymentRow(p: Partial<BookingPaymentRecord>): Record<string, unknown> {
  const paymentColumnsWritten: Record<string, unknown> = {
    id: p.id, booking_id: p.bookingId, attempt_no: p.attemptNo, provider: p.provider,
    idempotency_key: p.idempotencyKey, intent_ref: p.intentRef, recipient_ref: p.recipientRef,
    recipient_party_id: p.recipientPartyId, charge_model: p.chargeModel, state: p.state, intent_state: p.intentState,
    currency: p.amount?.currency, amount_minor: p.amount?.amountMinor,
    service_minor: p.components?.serviceMinor, payer_fee_minor: p.components?.payerFeeMinor,
    tip_minor: p.components?.tipMinor, tax_minor: p.components?.taxMinor,
    commission_minor: p.platformFee?.commissionMinor, platform_payer_fee_minor: p.platformFee?.payerFeeMinor, platform_tax_minor: p.platformFee?.taxMinor,
    commission_bps: p.commissionBps, commission_rule_version: p.commissionRuleVersion, tax_provider: p.taxProvider,
    tax_calculation_refs: p.taxCalculationRefs ? [...p.taxCalculationRefs] : undefined,
    buyer_market: p.buyerMarket, seller_market: p.sellerMarket,
    amount_captured_minor: p.amountCapturedMinor, amount_refunded_minor: p.amountRefundedMinor,
    platform_fee_collected_minor: p.platformFeeCollectedMinor, platform_fee_refunded_minor: p.platformFeeRefundedMinor,
    settlement: p.settlement === undefined ? undefined : projectSettlement(p.settlement),
    last_snapshot: p.lastSnapshot === undefined ? undefined : projectIntentSnapshot(p.lastSnapshot),
    failure_reason: p.failureReason, provider_cancel_owed: p.providerCancelOwed, payout_id: p.payoutId,
    created_at: p.createdAt, updated_at: p.updatedAt,
  };
  dropUndefined(paymentColumnsWritten);
  return paymentColumnsWritten;
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

/** The row for a (partial) refund record. `updatedAt` is the UPDATE's own stamp (RefundRecord carries none). */
export function refundRow(p: Partial<RefundRecord>, updatedAt?: string): Record<string, unknown> {
  const refundColumnsWritten: Record<string, unknown> = {
    id: p.id, booking_payment_id: p.bookingPaymentId, provider: p.provider, idempotency_key: p.idempotencyKey,
    refund_ref: p.refundRef, state: p.state, reason: p.reason, amount_minor: p.amountMinor, currency: p.currency,
    refund_platform_fee: p.refundPlatformFee, requested_by_role: p.requestedByRole, requested_by_party_id: p.requestedByPartyId,
    last_snapshot: p.lastSnapshot === undefined ? undefined : projectRefundSnapshot(p.lastSnapshot),
    created_at: p.createdAt, updated_at: updatedAt,
  };
  dropUndefined(refundColumnsWritten);
  return refundColumnsWritten;
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
  const payoutColumnsWritten: Record<string, unknown> = {
    id: p.id, recipient_party_id: p.recipientPartyId, provider: p.provider, period: p.period, currency: p.currency, amount_minor: p.amountMinor,
    state: p.state, idempotency_key: p.idempotencyKey, payout_ref: p.payoutRef, recipient_ref: p.recipientRef,
    booking_payment_ids: p.bookingPaymentIds ? [...p.bookingPaymentIds] : undefined,
    hold_reason: p.holdReason, held_by: p.heldBy, held_at: p.heldAt, released_by: p.releasedBy, released_at: p.releasedAt,
    release_reason: p.releaseReason, carry_reason: p.carryReason, failure_code: p.failureCode,
    last_snapshot: p.lastSnapshot === undefined ? undefined : projectPayoutSnapshot(p.lastSnapshot),
    created_at: p.createdAt, updated_at: p.updatedAt,
  };
  dropUndefined(payoutColumnsWritten);
  return payoutColumnsWritten;
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
    getRecipient: (partyId) => one(sc.from("rent_buddy_payment_recipients").select(RECIPIENT_COLUMNS).eq("party_id", partyId).maybeSingle(), toRecipient),
    findRecipientByRef: (provider, ref) => one(sc.from("rent_buddy_payment_recipients").select(RECIPIENT_COLUMNS).eq("provider", provider).eq("recipient_ref", ref).maybeSingle(), toRecipient),
    upsertRecipient: (rec) =>
      touched(sc.from("rent_buddy_payment_recipients").upsert({
        party_id: rec.partyId, provider: rec.provider, recipient_ref: rec.recipientRef, country: rec.country,
        settlement_currency: rec.settlementCurrency, onboarding: rec.onboarding, charges_enabled: rec.chargesEnabled,
        payouts_enabled: rec.payoutsEnabled, requirements_due: [...rec.requirementsDue], provider_updated_at: rec.providerUpdatedAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: "party_id" }).select("party_id")),

    listPaymentsForBooking: (bookingId) => many(sc.from("rent_buddy_booking_payments").select(PAYMENT_COLUMNS).eq("booking_id", bookingId).order("attempt_no", { ascending: true }), toPayment),
    findPaymentByIntent: (provider, intentRef) => one(sc.from("rent_buddy_booking_payments").select(PAYMENT_COLUMNS).eq("provider", provider).eq("intent_ref", intentRef).maybeSingle(), toPayment),
    insertPayment: (rec) => touched(sc.from("rent_buddy_booking_payments").insert(paymentRow(rec)).select("id")),
    updatePayment: (id, patch) => touched(sc.from("rent_buddy_booking_payments").update(paymentRow({ ...patch, id: undefined })).eq("id", id).select("id")),
    updatePaymentIfUnchanged: (id, held, patch) => {
      let q = sc.from("rent_buddy_booking_payments").update(paymentRow({ ...patch, id: undefined })).eq("id", id)
        .eq("updated_at", held.updatedAt).eq("state", held.state)
        .eq("amount_captured_minor", held.amountCapturedMinor).eq("amount_refunded_minor", held.amountRefundedMinor);
      q = held.intentState === null ? q.is("intent_state", null) : q.eq("intent_state", held.intentState);
      return touched(q.select("id"), true); // zero rows = another write landed first (F1)
    },
    listUnpaidSucceededPayments: (partyId) => {
      let q = sc.from("rent_buddy_booking_payments").select(PAYMENT_COLUMNS).is("payout_id", null).in("state", ["succeeded", "partially_refunded", "disputed"]);
      if (partyId !== null) q = q.eq("recipient_party_id", partyId);
      return many(q, toPayment);
    },

    insertRefund: (rec) => touched(sc.from("rent_buddy_payment_refunds").insert(refundRow(rec)).select("id")),
    findRefundByRef: (provider, ref) => one(sc.from("rent_buddy_payment_refunds").select(REFUND_COLUMNS).eq("provider", provider).eq("refund_ref", ref).maybeSingle(), toRefund),
    updateRefund: (id, patch) => touched(sc.from("rent_buddy_payment_refunds").update(refundRow({ ...patch, id: undefined }, new Date().toISOString())).eq("id", id).select("id")),
    listRefundsForPayment: (paymentId) => many(sc.from("rent_buddy_payment_refunds").select(REFUND_COLUMNS).eq("booking_payment_id", paymentId), toRefund),

    insertPayout: (rec) => touched(sc.from("rent_buddy_monthly_payouts").insert(payoutRow(rec)).select("id")),
    getPayout: (id) => one(sc.from("rent_buddy_monthly_payouts").select(PAYOUT_COLUMNS).eq("id", id).maybeSingle(), toPayout),
    findPayoutByRef: (_provider, ref) => one(sc.from("rent_buddy_monthly_payouts").select(PAYOUT_COLUMNS).eq("payout_ref", ref).maybeSingle(), toPayout),
    findPayoutByKey: (key) => one(sc.from("rent_buddy_monthly_payouts").select(PAYOUT_COLUMNS).eq("idempotency_key", key).maybeSingle(), toPayout),
    transitionPayout: (id, from, patch) =>
      touched(sc.from("rent_buddy_monthly_payouts").update(payoutRow({ ...patch, id: undefined })).eq("id", id).in("state", [...from]).select("id"), true),

    async recordWebhookEvent(provider, eventId, meta) {
      try {
        const { error: insErr } = await sc.from("payment_webhook_events").insert({
          provider, provider_event_id: eventId, endpoint: meta.endpoint, event_type: meta.type, occurred_at: meta.occurredAt,
        });
        if (insErr && !isUnique(insErr)) return readFail("event insert failed");
        const { data, error } = await sc.from("payment_webhook_events").select("processed_at").eq("provider", provider).eq("provider_event_id", eventId).maybeSingle();
        if (error || !data) return readFail("event read failed");
        return readOk({ alreadyProcessed: (data as Record<string, unknown>)["processed_at"] != null });
      } catch {
        return readFail("event record threw");
      }
    },
    markWebhookEventProcessed: (provider, eventId, outcome) =>
      touched(sc.from("payment_webhook_events").update({ processed_at: new Date().toISOString(), outcome }).eq("provider", provider).eq("provider_event_id", eventId).select("provider")),
  };
}
