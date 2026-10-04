/**
 * rentBuddyLedgerPosting — the API's ONE door to the Rent-a-Buddy money record.
 *
 * ── WHAT THIS MODULE IS ─────────────────────────────────────────────────────
 * Four thin, typed callers of the SQL functions migration
 * `3824_rent_buddy_ledger_posting.sql` creates:
 *
 *   rb_post_booking_ledger           entries + summary, one transaction
 *   rb_buddy_ledger_totals           the earnings summary, folded in SQL
 *   rb_resolve_platform_fee_percent  the commission, read from configuration
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
export const PLATFORM_FEE_RPC = "rb_resolve_platform_fee_percent";
export const PAYOUT_TRANSITION_RPC = "rb_admin_payout_transition";
/** 2330's cash-confirmation function. A money write, so it comes through here too. */
export const CASH_CONFIRMATION_RPC = "rb_confirm_booking_cash";

/** The named error for "the function is not there". HTTP 503. */
export const LEDGER_UNAVAILABLE = "ledger_unavailable";
/** The named error for "the call was made and errored". HTTP 503. */
export const LEDGER_WRITE_FAILED = "ledger_write_failed";

/**
 * The prefix rb_post_booking_ledger writes to the summary row's `note` when it
 * reverses a booking's earning entries. The database test holds the SQL to it.
 */
export const LEDGER_REVERSED_NOTE_PREFIX = "Earning entries reversed";

/** The events a ROUTE may post. `settlement` exists in SQL and is not here. */
export type RoutePostableLedgerEvent = "booking_created" | "tip" | "reversal";

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
  };
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

// ── The commission, as configured ────────────────────────────────────────────

/** Where a resolved commission came from. See 3824's header for the order. */
export type PlatformFeeSource = "launch_control" | "fee_schedule" | "owner_default";

export type PlatformFeeResult =
  | { status: "ok"; feePercent: number; feeSource: PlatformFeeSource }
  | MoneyRpcFailure;

/**
 * The commission that WOULD apply to a booking with this buddy, market and
 * product — the figure shown before checkout. It is read from the same SQL
 * function the posting uses, so the quote and the ledger cannot disagree.
 */
export async function resolvePlatformFeePercent(
  client: any,
  sel: { buddyLevel?: string | null; countryCode?: string | null; city?: string | null; category?: string | null },
): Promise<PlatformFeeResult> {
  const answer = await callMoneyRpc(client, PLATFORM_FEE_RPC, {
    p_buddy_level: sel.buddyLevel ?? null,
    p_country_code: sel.countryCode ?? null,
    p_city: sel.city ?? null,
    p_category: sel.category ?? null,
  });
  if (!("ok" in answer)) return answer;
  const row = unwrap(answer.data);
  const pct = asNullableNumber(row?.fee_percent);
  const source = row?.fee_source;
  if (pct === null || (source !== "launch_control" && source !== "fee_schedule" && source !== "owner_default")) {
    return {
      status: "failed", error: LEDGER_WRITE_FAILED, rpc: PLATFORM_FEE_RPC,
      detail: "the commission function returned no usable row",
    };
  }
  return { status: "ok", feePercent: pct, feeSource: source };
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
