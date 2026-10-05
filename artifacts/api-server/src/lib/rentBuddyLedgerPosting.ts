/**
 * rentBuddyLedgerPosting — the API's ONE door to the Rent-a-Buddy money record.
 *
 * ── WHAT THIS MODULE IS ─────────────────────────────────────────────────────
 * Thin, typed callers of the SQL functions migration
 * `3824_rent_buddy_ledger_posting.sql` creates:
 *
 *   rb_quote_booking                 price, commission and payment terms — what
 *                                    checkout shows and what creation stores
 *   rb_post_booking_ledger           entries + summary, one transaction
 *                                    (booking_created, tip, addons, reversal)
 *   rb_buddy_ledger_totals           the earnings summary, folded in SQL
 *   rb_admin_payout_transition       a payout hold / release + its audit row
 *
 * It contains NO money arithmetic. `09` §8: "the API never performs money
 * arithmetic in JavaScript at all." A fee, a net, a fold and a balance are
 * computed in the database, in integer minor units; this file passes the
 * booking id and reads back what the database decided.
 *
 * ── THERE IS NO FALLBACK, AND THAT IS THE POINT (`09` §3 refusal 2) ─────────
 * Every function here answers one of four ways and a caller must handle all
 * four:
 *
 *   posted / ok   the database did it
 *   refused       the database looked and said no (a named refusal; nothing was
 *                 written)
 *   unavailable   the function is not there — 3824 is not applied, or the
 *                 client has no `.rpc`. NAMED `ledger_unavailable`.
 *   failed        the call errored for any other reason. NAMED
 *                 `ledger_write_failed`.
 *
 * `unavailable` used to be the cue for a read-modify-write fallback from the
 * API process (`routes/rentABuddy.ts`, the tip and cash-confirmation helpers).
 * A fallback that is "not atomic and says so" still writes a money figure
 * derived from a read another request can invalidate, and it kept the
 * JavaScript arithmetic alive on exactly the path nobody watches. It is gone:
 * with the function absent a money write is REFUSED, and the refusal has a name
 * a caller, a log and a test can all see.
 *
 * ── THIS MODULE MOVES NO MONEY ──────────────────────────────────────────────
 * No processor is installed (`09` §1.1). The one event that would record money
 * arriving — `settlement` — is deliberately NOT exposed here: there is no
 * `postBookingSettlement`. The payment state machine (PAY-T09) adds its caller
 * when a provider exists; until then the event is reachable only from SQL.
 */

/** The SQL functions, by name. One place, so a test can pin every call site. */
export const LEDGER_POSTING_RPC = "rb_post_booking_ledger";
export const LEDGER_TOTALS_RPC = "rb_buddy_ledger_totals";
export const BOOKING_QUOTE_RPC = "rb_quote_booking";
export const PAYOUT_TRANSITION_RPC = "rb_admin_payout_transition";
/** 2330's cash-confirmation function. A money write, so it comes through here too. */
export const CASH_CONFIRMATION_RPC = "rb_confirm_booking_cash";

/** The named error for "the function is not there". HTTP 503. */
export const LEDGER_UNAVAILABLE = "ledger_unavailable";
/** The named error for "the call was made and errored". HTTP 503. */
export const LEDGER_WRITE_FAILED = "ledger_write_failed";
/**
 * The named error for "the database looked and said no". The request will be
 * refused again however often it is retried, so this is a 4xx with
 * `retryable: false` — never a 503.
 */
export const LEDGER_REFUSED = "ledger_refused";

/**
 * The tip event key the posting function keeps for itself: it is the
 * transaction a pre-3824 tips row is carried into the entries under. A client
 * that sent it would collide with that transaction, and the new tip would be
 * dropped while the call answered ok. Refused here and in SQL.
 */
export const RESERVED_TIP_EVENT_KEY = "carried-over";

/**
 * numeric(10,2) holds amounts below 10^8. An amount at or above it, or one that
 * is not a finite number, is a VALIDATION error (400) — not something to send
 * to the database and report as a 503 when the column overflows.
 */
export const MONEY_AMOUNT_LIMIT_USD = 100_000_000;

/** A positive, finite amount a money column can hold. No arithmetic. */
export function isPositiveMoneyAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < MONEY_AMOUNT_LIMIT_USD;
}

/**
 * The prefix rb_post_booking_ledger writes to the summary row's `note` when it
 * reverses a booking's earning entries. The database test holds the SQL to it.
 */
export const LEDGER_REVERSED_NOTE_PREFIX = "Earning entries reversed";

/** The events a ROUTE may post. `settlement` exists in SQL and is not here. */
export type RoutePostableLedgerEvent = "booking_created" | "tip" | "addons" | "reversal";

/** What an `addons` event leaves on the booking row. Database-computed. */
export interface BookingTermsAfterAddons {
  totalUsd: number;
  addonsTotalUsd: number;
  depositUsd: number;
  cashBalanceUsd: number;
  paymentMode: string | null;
  /** The summed price of the add-ons THIS call attached (0 on a replay). */
  addedUsd: number;
}

/** The summary row as `rb_post_booking_ledger` returns it. Database-computed. */
export interface LedgerSummary {
  bookingId: string;
  totalBookingUsd: number;
  tipUsd: number;
  platformFeePercent: number | null;
  platformFeeAmount: number;
  travelerServiceFeeAmount: number;
  buddyGrossAmount: number;
  buddyNetEstimatedAmount: number;
  inAppAmountCollected: number;
  isEstimated: boolean;
}

export type MoneyRpcFailure =
  | { status: "unavailable"; error: typeof LEDGER_UNAVAILABLE; rpc: string; detail: string }
  | { status: "failed"; error: typeof LEDGER_WRITE_FAILED; rpc: string; detail: string };

export type LedgerPostResult =
  | {
      status: "posted";
      event: RoutePostableLedgerEvent;
      /** True when the event had already been recorded and nothing was appended. */
      replayed: boolean;
      entriesAppended: number;
      /** Set only by the call that PRICED the booking; null on a replay. */
      feePercent: number | null;
      feeSource: string | null;
      /** Null only for a reversal of a booking that was never ledgered. */
      summary: LedgerSummary | null;
      /** `addons` only: how many add-ons THIS call attached (0 = all were already attached). */
      addonsAdded: number | null;
      /** `addons` only: the booking's total and terms after the call. */
      booking: BookingTermsAfterAddons | null;
    }
  | { status: "refused"; refusal: string; detail: string }
  | MoneyRpcFailure;

export type MoneyRpcAnswer =
  | { ok: true; data: any }
  | MoneyRpcFailure;

/**
 * Is this the error PostgREST / PostgreSQL gives for a function that does not
 * exist? `PGRST202` is PostgREST's "could not find the function in the schema
 * cache"; `42883` is PostgreSQL's undefined_function. The message match is the
 * fallback for a client that surfaces neither code.
 */
function isFunctionMissing(error: any): boolean {
  const code = String(error?.code ?? "");
  if (code === "PGRST202" || code === "42883") return true;
  const message = String(error?.message ?? "");
  return /could not find the function/i.test(message)
    || /function .* does not exist/i.test(message);
}

/**
 * Call one of the money functions and classify the answer.
 *
 * supabase-js RESOLVES on a rejected query, so a failure is in `res.error` and
 * is never thrown; the try/catch is for a client that throws on a method it
 * does not implement. Neither path leads to a fallback.
 */
export async function callMoneyRpc(client: any, fn: string, args: Record<string, unknown>): Promise<MoneyRpcAnswer> {
  if (!client || typeof client.rpc !== "function") {
    return { status: "unavailable", error: LEDGER_UNAVAILABLE, rpc: fn, detail: "the database client has no rpc()" };
  }
  let res: any;
  try {
    res = await client.rpc(fn, args);
  } catch (err: any) {
    return { status: "failed", error: LEDGER_WRITE_FAILED, rpc: fn, detail: String(err?.message ?? err) };
  }
  if (res?.error) {
    const detail = String(res.error.message ?? res.error);
    return isFunctionMissing(res.error)
      ? { status: "unavailable", error: LEDGER_UNAVAILABLE, rpc: fn, detail }
      : { status: "failed", error: LEDGER_WRITE_FAILED, rpc: fn, detail };
  }
  return { ok: true, data: res?.data };
}

/** A jsonb-returning function surfaces as the object, or as a one-element array. */
function unwrap(data: any): any {
  return Array.isArray(data) ? data[0] : data;
}

/** A database numeric arrives as a number or a numeric string. No arithmetic. */
function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toLedgerSummary(raw: any): LedgerSummary | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    bookingId: String(raw.booking_id ?? ""),
    totalBookingUsd: asNumber(raw.total_booking_usd),
    tipUsd: asNumber(raw.tip_usd),
    platformFeePercent: asNullableNumber(raw.platform_fee_percent),
    platformFeeAmount: asNumber(raw.platform_fee_amount),
    travelerServiceFeeAmount: asNumber(raw.traveler_service_fee_amount),
    buddyGrossAmount: asNumber(raw.buddy_gross_amount),
    buddyNetEstimatedAmount: asNumber(raw.buddy_net_estimated_amount),
    inAppAmountCollected: asNumber(raw.in_app_amount_collected),
    isEstimated: raw.is_estimated !== false,
  };
}

/**
 * Post one event to a booking's ledger: its entries and the summary that is
 * their fold, in one database transaction, idempotent per (booking, event).
 */
export async function postBookingLedgerEvent(
  client: any,
  bookingId: string,
  event: RoutePostableLedgerEvent,
  opts: { eventKey?: string | null; args?: Record<string, unknown> } = {},
): Promise<LedgerPostResult> {
  if (!bookingId) {
    return { status: "refused", refusal: "booking_required", detail: "no booking id" };
  }
  const answer = await callMoneyRpc(client, LEDGER_POSTING_RPC, {
    p_booking_id: bookingId,
    p_event: event,
    p_event_key: opts.eventKey ?? null,
    p_args: opts.args ?? {},
  });
  if (!("ok" in answer)) return answer;

  const body = unwrap(answer.data);
  if (!body || typeof body !== "object") {
    return {
      status: "failed", error: LEDGER_WRITE_FAILED, rpc: LEDGER_POSTING_RPC,
      detail: "the posting function returned no answer",
    };
  }
  if (body.ok !== true) {
    return {
      status: "refused",
      refusal: String(body.refusal ?? "refused"),
      detail: String(body.detail ?? ""),
    };
  }
  return {
    status: "posted",
    event,
    replayed: body.replayed === true,
    entriesAppended: asNumber(body.entries_appended),
    feePercent: asNullableNumber(body.fee_percent),
    feeSource: typeof body.fee_source === "string" ? body.fee_source : null,
    summary: toLedgerSummary(body.summary),
    addonsAdded: asNullableNumber(body.addons_added),
    booking: body.booking && typeof body.booking === "object"
      ? {
          totalUsd: asNumber(body.booking.total_usd),
          addonsTotalUsd: asNumber(body.booking.addons_total_usd),
          depositUsd: asNumber(body.booking.deposit_usd),
          cashBalanceUsd: asNumber(body.booking.cash_balance_usd),
          paymentMode: typeof body.booking.payment_mode === "string" ? body.booking.payment_mode : null,
          addedUsd: asNumber(body.booking.added_usd),
        }
      : null,
  };
}

/** What attaching add-ons did. `attached` carries no nullable money. */
export type AddonsPostResult =
  | { status: "attached"; addonsAdded: number; replayed: boolean; entriesAppended: number; booking: BookingTermsAfterAddons }
  | { status: "refused"; refusal: string; detail: string }
  | MoneyRpcFailure;

/**
 * Attach add-ons to a booking: the join rows, the booking's new total and
 * terms, and the ledger's ADJUSTMENT entries, in one transaction under the
 * booking's row lock. Idempotent by state — an add-on already attached is not
 * attached, priced or ledgered again. The sum and the commission on it are the
 * database's; nothing is added up here.
 */
export async function postBookingAddons(
  client: any,
  input: {
    bookingId: string; travelerId: string; addonIds: string[]; allowedStatuses: readonly string[];
    paymentMode?: string | null; depositPercent?: number | null; depositRule?: string | null; depositReason?: string | null;
  },
): Promise<AddonsPostResult> {
  const posted = await postBookingLedgerEvent(client, input.bookingId, "addons", {
    args: {
      traveler_id: input.travelerId,
      addon_ids: input.addonIds,
      allowed_statuses: [...input.allowedStatuses],
      payment_mode: input.paymentMode ?? null,
      deposit_percent: input.depositPercent ?? null,
      deposit_rule: input.depositRule ?? null,
      deposit_reason: input.depositReason ?? null,
    },
  });
  if (posted.status !== "posted") return posted;
  // An `addons` answer without the booking's new terms is not an answer the
  // route can show: say so by name rather than report a total of 0.
  if (!posted.booking || posted.addonsAdded === null) {
    return { status: "failed", error: LEDGER_WRITE_FAILED, rpc: LEDGER_POSTING_RPC, detail: "the add-ons answer carries no booking terms" };
  }
  return { status: "attached", addonsAdded: posted.addonsAdded, replayed: posted.replayed, entriesAppended: posted.entriesAppended, booking: posted.booking };
}

/** A tip: one balanced pair, traveller → buddy. The database books no fee leg. */
export async function postBookingTip(
  client: any,
  input: { bookingId: string; travelerId: string; amountUsd: number; note?: string | null; eventKey: string },
): Promise<LedgerPostResult> {
  return postBookingLedgerEvent(client, input.bookingId, "tip", {
    eventKey: input.eventKey,
    // The amount is passed through as the caller gave it. Converting it to
    // minor units is the database's job (round(amount_usd * 100)), not this
    // module's.
    args: { traveler_id: input.travelerId, amount_usd: input.amountUsd, note: input.note ?? null },
  });
}

// ── The earnings summary ─────────────────────────────────────────────────────

/** `rb_buddy_ledger_totals`: every figure is a SUM the database did. */
export interface BuddyLedgerTotals {
  completedCount: number;
  /** Completed bookings with no ledger row: counted, and priced by nothing. */
  unledgeredCompletedCount: number;
  completedTotalUsd: number;
  /** The deposit the completed bookings NAME (sum of their stored `deposit_usd`); never a collection (#610). */
  depositScheduledUsd: number;
  ledgeredGrossUsd: number;
  estimatedPlatformFeeUsd: number;
  estimatedBuddyEarningsUsd: number;
  tipsTotalUsd: number;
  tipCount: number;
  /** The fold of settlement entries. 0 until a payment path exists. */
  inAppAmountCollectedUsd: number;
  cashBalanceDueUsd: number;
  cashBalanceConfirmedUsd: number;
  isEstimated: boolean;
}

export type BuddyLedgerTotalsResult =
  | { status: "ok"; totals: BuddyLedgerTotals }
  | MoneyRpcFailure;

export async function readBuddyLedgerTotals(client: any, buddyUserId: string): Promise<BuddyLedgerTotalsResult> {
  const answer = await callMoneyRpc(client, LEDGER_TOTALS_RPC, { p_buddy_user_id: buddyUserId });
  if (!("ok" in answer)) return answer;
  const raw = unwrap(answer.data);
  if (!raw || typeof raw !== "object") {
    return {
      status: "failed", error: LEDGER_WRITE_FAILED, rpc: LEDGER_TOTALS_RPC,
      detail: "the totals function returned no answer",
    };
  }
  return {
    status: "ok",
    totals: {
      completedCount: asNumber(raw.completedCount),
      unledgeredCompletedCount: asNumber(raw.unledgeredCompletedCount),
      completedTotalUsd: asNumber(raw.completedTotalUsd),
      depositScheduledUsd: asNumber(raw.depositScheduledUsd),
      ledgeredGrossUsd: asNumber(raw.ledgeredGrossUsd),
      estimatedPlatformFeeUsd: asNumber(raw.estimatedPlatformFeeUsd),
      estimatedBuddyEarningsUsd: asNumber(raw.estimatedBuddyEarningsUsd),
      tipsTotalUsd: asNumber(raw.tipsTotalUsd),
      tipCount: asNumber(raw.tipCount),
      inAppAmountCollectedUsd: asNumber(raw.inAppAmountCollectedUsd),
      cashBalanceDueUsd: asNumber(raw.cashBalanceDueUsd),
      cashBalanceConfirmedUsd: asNumber(raw.cashBalanceConfirmedUsd),
      isEstimated: raw.isEstimated !== false,
    },
  };
}

// ── The quote: price, commission and terms, as the database decides them ─────

/** Where a resolved commission came from. See 3824's header for the order. */
export type PlatformFeeSource = "launch_control" | "fee_schedule" | "owner_default";

/**
 * `rb_quote_booking`'s answer. Every figure is the database's.
 *
 * The MARKET is the buddy's own country and city (`rb_booking_market`) — the
 * same row `rb_post_booking_ledger` prices on — so the commission a traveller
 * is shown before checkout and the commission posted for the booking cannot be
 * resolved for two different places. Nothing here takes a city from a request.
 */
export interface BookingQuote {
  feePercent: number;
  feeSource: PlatformFeeSource;
  marketCountry: string | null;
  marketCity: string | null;
  /** False for a rate-only quote (no price was sent): the money fields are null. */
  priced: boolean;
  totalUsd: number | null;
  feeUsd: number | null;
  buddyNetUsd: number | null;
  paymentMode: string | null;
  /** The ONE deposit switch (`rent_buddy_global_controls.deposits_enabled`). False = every deposit is 0. */
  depositEnabled: boolean | null;
  depositPercent: number | null;
  depositUsd: number | null;
  cashBalanceUsd: number | null;
}

export type BookingQuoteResult =
  | { status: "ok"; quote: BookingQuote }
  | { status: "refused"; refusal: string; detail: string }
  | MoneyRpcFailure;

/**
 * Quote a booking with this buddy and category. With a unit price and a
 * quantity (an hourly rate and hours; a fixed price and 1) the answer carries
 * the total, the commission amount and the payment terms booking creation
 * stores; without them it is the rate-only quote the checkout screen shows.
 *
 * The API multiplies nothing: `unit × quantity`, the commission on it and the
 * deposit split are numeric arithmetic in SQL, in minor units.
 */
export async function quoteBooking(
  client: any,
  input: {
    buddyProfileId: string; category?: string | null;
    unitPriceUsd?: number | null; quantity?: number | null;
    paymentMode?: string | null; depositPercent?: number | null;
  },
): Promise<BookingQuoteResult> {
  const answer = await callMoneyRpc(client, BOOKING_QUOTE_RPC, {
    p_buddy_profile_id: input.buddyProfileId,
    p_category: input.category ?? null,
    p_unit_price_usd: input.unitPriceUsd ?? null,
    p_quantity: input.quantity ?? 1,
    p_payment_mode: input.paymentMode ?? null,
    p_deposit_percent: input.depositPercent ?? null,
  });
  if (!("ok" in answer)) return answer;
  const body = unwrap(answer.data);
  if (!body || typeof body !== "object") {
    return { status: "failed", error: LEDGER_WRITE_FAILED, rpc: BOOKING_QUOTE_RPC, detail: "the quote function returned no answer" };
  }
  if (body.ok !== true) {
    // A refusal NAMES itself. An answer that is neither `ok` nor a named refusal
    // is malformed — a failure to retry, not a permanent verdict on the request.
    if (body.ok === false && typeof body.refusal === "string" && body.refusal.length > 0) {
      return { status: "refused", refusal: body.refusal, detail: String(body.detail ?? "") };
    }
    return { status: "failed", error: LEDGER_WRITE_FAILED, rpc: BOOKING_QUOTE_RPC, detail: "the quote function answered neither ok nor a named refusal" };
  }
  const pct = asNullableNumber(body.fee_percent);
  const source = body.fee_source;
  const priced = body.priced === true;
  if (pct === null || (source !== "launch_control" && source !== "fee_schedule" && source !== "owner_default")) {
    return { status: "failed", error: LEDGER_WRITE_FAILED, rpc: BOOKING_QUOTE_RPC, detail: "the quote carries no usable commission" };
  }
  const quote: BookingQuote = {
    feePercent: pct,
    feeSource: source,
    marketCountry: typeof body.market_country === "string" ? body.market_country : null,
    marketCity: typeof body.market_city === "string" ? body.market_city : null,
    priced,
    totalUsd: priced ? asNullableNumber(body.total_usd) : null,
    feeUsd: priced ? asNullableNumber(body.fee_usd) : null,
    buddyNetUsd: priced ? asNullableNumber(body.buddy_net_usd) : null,
    paymentMode: typeof body.payment_mode === "string" ? body.payment_mode : null,
    depositEnabled: typeof body.deposit_enabled === "boolean" ? body.deposit_enabled : null,
    depositPercent: priced ? asNullableNumber(body.deposit_percent) : null,
    depositUsd: priced ? asNullableNumber(body.deposit_usd) : null,
    cashBalanceUsd: priced ? asNullableNumber(body.cash_balance_usd) : null,
  };
  // A priced quote that is missing a money figure is not a quote. Creation
  // would otherwise store a null total; refuse it here instead.
  if (priced && (quote.totalUsd === null || quote.feeUsd === null || quote.depositUsd === null || quote.cashBalanceUsd === null)) {
    return { status: "failed", error: LEDGER_WRITE_FAILED, rpc: BOOKING_QUOTE_RPC, detail: "the priced quote is missing a money figure" };
  }
  return { status: "ok", quote };
}

/** A quote WITH a price: what booking creation stores. No field is nullable. */
export interface PricedBookingQuote {
  feePercent: number;
  feeSource: PlatformFeeSource;
  totalUsd: number;
  feeUsd: number;
  paymentMode: string;
  depositEnabled: boolean;
  depositPercent: number;
  depositUsd: number;
  cashBalanceUsd: number;
}

export type PricedBookingQuoteResult =
  | { status: "ok"; quote: PricedBookingQuote }
  | { status: "refused"; refusal: string; detail: string }
  | MoneyRpcFailure;

/**
 * The quote a creation path stores on the booking row. A price that is not a
 * finite number is refused HERE: JSON would send it as `null`, which the SQL
 * function reads as "no price — rate only".
 */
export async function quotePricedBooking(
  client: any,
  input: {
    buddyProfileId: string; category?: string | null; unitPriceUsd: number; quantity?: number | null;
    paymentMode?: string | null; depositPercent?: number | null;
  },
): Promise<PricedBookingQuoteResult> {
  const quantity = input.quantity ?? 1;
  if (typeof input.unitPriceUsd !== "number" || !Number.isFinite(input.unitPriceUsd)
      || typeof quantity !== "number" || !Number.isFinite(quantity)) {
    return { status: "refused", refusal: "invalid_total", detail: "the price or the quantity is not a finite number" };
  }
  const answer = await quoteBooking(client, { ...input, quantity });
  if (answer.status !== "ok") return answer;
  const q = answer.quote;
  if (!q.priced || q.totalUsd === null || q.feeUsd === null || q.depositUsd === null || q.cashBalanceUsd === null
      || q.paymentMode === null || q.depositEnabled === null || q.depositPercent === null) {
    return { status: "failed", error: LEDGER_WRITE_FAILED, rpc: BOOKING_QUOTE_RPC, detail: "the quote function answered without a price" };
  }
  return {
    status: "ok",
    quote: {
      feePercent: q.feePercent, feeSource: q.feeSource, totalUsd: q.totalUsd, feeUsd: q.feeUsd,
      paymentMode: q.paymentMode, depositEnabled: q.depositEnabled, depositPercent: q.depositPercent,
      depositUsd: q.depositUsd, cashBalanceUsd: q.cashBalanceUsd,
    },
  };
}

/** The deposit columns of a booking row, as the ONE switch leaves them. */
export function depositColumns(
  quote: PricedBookingQuote,
  whenEnabled: { rule?: string | null; reason?: string | null } = {},
): { deposit_percent: number; deposit_rule_applied: string | null; deposit_reason: string | null } {
  return quote.depositEnabled
    ? { deposit_percent: quote.depositPercent, deposit_rule_applied: whenEnabled.rule ?? null, deposit_reason: whenEnabled.reason ?? null }
    : { deposit_percent: 0, deposit_rule_applied: "no_deposit", deposit_reason: "No deposit is taken in the first release (owner ruling 2026-10-04)." };
}

// ── Payout hold / release ────────────────────────────────────────────────────

export type PayoutAction = "hold" | "release";

export type PayoutTransitionResult =
  | { status: "applied"; action: PayoutAction; fromStatus: string; toStatus: string; auditId: string | null; payout: any }
  | { status: "refused"; refusal: "not_found" | "not_admin" | "reason_required" | "unknown_action" | "conflict" | string; detail: string; currentStatus: string | null }
  | MoneyRpcFailure;

/**
 * Apply an admin payout hold or release. The status change and its
 * `rent_buddy_admin_actions` row are ONE database transaction: if the audit row
 * cannot be written, the status does not move (`09` §10, PAY-075).
 */
export async function transitionPayout(
  client: any,
  input: { payoutId: string; action: PayoutAction; adminId: string; reason: string },
): Promise<PayoutTransitionResult> {
  const answer = await callMoneyRpc(client, PAYOUT_TRANSITION_RPC, {
    p_payout_id: input.payoutId,
    p_action: input.action,
    p_admin_id: input.adminId,
    p_reason: input.reason,
  });
  if (!("ok" in answer)) return answer;
  const body = unwrap(answer.data);
  if (!body || typeof body !== "object") {
    return {
      status: "failed", error: LEDGER_WRITE_FAILED, rpc: PAYOUT_TRANSITION_RPC,
      detail: "the payout transition function returned no answer",
    };
  }
  if (body.ok !== true) {
    return {
      status: "refused",
      refusal: String(body.refusal ?? "refused"),
      detail: String(body.detail ?? ""),
      currentStatus: typeof body.current_status === "string" ? body.current_status : null,
    };
  }
  return {
    status: "applied",
    action: input.action,
    fromStatus: String(body.from_status ?? ""),
    toStatus: String(body.to_status ?? ""),
    auditId: typeof body.audit_id === "string" ? body.audit_id : null,
    payout: body.payout ?? null,
  };
}

// ── A refusal is not an outage ───────────────────────────────────────────────

/**
 * The HTTP status for a NAMED database refusal. All of them are permanent for
 * the request as sent — retrying it changes nothing — so none is a 503.
 */
export function ledgerRefusalHttpStatus(refusal: string): number {
  switch (refusal) {
    case "booking_not_found":
    case "buddy_not_found":
      return 404;
    case "not_traveler":
      return 403;
    case "idempotency_key_reused":
    case "booking_not_ledgerable":
    case "booking_reversed":
    case "booking_not_open":
    case "booking_not_completed":
      return 409;
    default:
      // invalid_total, invalid_amount, invalid_arguments, invalid_payment_mode,
      // event_key_required, event_key_reserved, no_valid_addons, unknown_event …
      return 422;
  }
}

/**
 * Answer a request the database REFUSED. 4xx, `retryable: false`, the
 * database's own refusal named — so a client does not sit in a retry loop on a
 * request that can never succeed, and an operator can see why.
 */
export function sendLedgerRefusal(res: any, refusal: string, message: string): void {
  res.status(ledgerRefusalHttpStatus(refusal)).json({
    error: LEDGER_REFUSED,
    refusal,
    retryable: false,
    message,
  });
}

/** Answer a request whose booking (or offer) could not be priced. Nothing was created. */
export function sendBookingQuoteFailure(
  res: any,
  result: { status: "refused"; refusal: string; detail: string } | MoneyRpcFailure,
  what: "booking" | "offer" = "booking",
): void {
  if (result.status === "refused") {
    sendLedgerRefusal(res, result.refusal, `This ${what} could not be priced, so it was not created. Nothing was charged.`);
    return;
  }
  sendMoneyRpcFailure(res, result, `The ${what} could not be priced right now, so it was not created. Nothing was charged. Please try again shortly.`);
}

// ── One response shape for "the money write did not happen" ──────────────────

/**
 * Answer a request whose money write was not made. 503 in both cases — the
 * caller did nothing wrong and may retry — with the NAMED error in the body, so
 * "the ledger function is missing" is never reported as a generic database
 * error or, worse, as a success.
 */
export function sendMoneyRpcFailure(res: any, failure: MoneyRpcFailure, message: string): void {
  res.status(503).json({
    error: failure.error,
    retryable: true,
    rpc: failure.rpc,
    message,
  });
}
