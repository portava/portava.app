/**
 * rent_buddy_earnings_ledger — the booking-creation side of the earnings ledger.
 *
 * ── WHY THIS IS A SHARED MODULE ─────────────────────────────────────────────
 * Five routes INSERT into rent_buddy_bookings:
 *
 *   rentABuddy.ts            POST /rent-a-buddy/bookings          (canonical)
 *   rentABuddy.ts            POST /bookings/:id/rebook
 *   rentABuddySpec.ts        POST /rent-a-buddy/requests          (spec request)
 *   rentABuddyMarketplace.ts offer-accept
 *   rentABuddyMarketplace.ts package-book
 *
 * The ledger writer once lived as a module-private helper inside
 * rentABuddyMarketplace.ts and was reachable only from the last two, so a buddy
 * booked the ordinary way saw a permanently empty ledger. All five share this.
 *
 * ── WHAT CHANGED (payments PAY-050 / PAY-055 / PAY-018) ─────────────────────
 * This function used to DO the ledger: it read `rent_buddy_fee_rules`, computed
 * the fee and the net in JavaScript floats, upserted the entries, and then
 * upserted the summary row in a SECOND statement — after the booking had
 * committed, with every caller swallowing the result
 * (`.catch(() => {})`). So the entries could exist without their summary, a
 * booking could exist with neither, and the split was arithmetic done in the
 * API process.
 *
 * Now it makes ONE call. `public.rb_post_booking_ledger` (migration
 * `3824_rent_buddy_ledger_posting.sql`) prices the booking from configuration,
 * appends its entries and derives the summary row by folding them, in one
 * database transaction, idempotent per booking. Nothing here reads a fee,
 * multiplies, subtracts or rounds.
 *
 * ── A BOOKING IS NOT LEFT WITHOUT ITS LEDGER ────────────────────────────────
 * The result is no longer best-effort. A caller that gets anything other than
 * `written` withdraws the booking it just inserted (`withdrawUnledgeredBooking`)
 * and answers `sendBookingLedgerRefusal` — a NAMED error, 503 — instead of
 * handing back a booking whose earnings record does not exist. With the SQL
 * function absent that means booking creation is refused. That is deliberate:
 * the alternative is the read-modify-write fallback `09` §3 refusal 2 forbids
 * for money.
 *
 * ── THIS IS NOT PAYMENT ────────────────────────────────────────────────────
 * The row is an ESTIMATE. `pay-deposit` / `pay-full` return 503, nothing is
 * collected (`in_app_amount_collected` is the fold of settlement entries, of
 * which there are none), and `is_estimated` is cleared only by a settlement
 * entry that no route can write.
 */
import { logger } from "./logger.js";
import {
  LEDGER_UNAVAILABLE,
  LEDGER_WRITE_FAILED,
  postBookingLedgerEvent,
} from "./rentBuddyLedgerPosting.js";

/**
 * What happened to the ledger for one booking.
 *
 *   written      the entries and the summary exist (or already existed: a
 *                replay appends nothing and is still `written`)
 *   skipped      the caller passed nothing to post
 *   refused      the database looked and said no — `refusal` names why
 *   unavailable  `rb_post_booking_ledger` is not there. NAMED
 *                `ledger_unavailable`; nothing was written and nothing was
 *                attempted a second way.
 *   failed       the call errored. NAMED `ledger_write_failed`.
 */
export type LedgerWriteResult =
  | { status: "written"; bookingId: string; platformFeePercent: number | null; replayed: boolean }
  | { status: "skipped"; reason: "missing_arguments" }
  | { status: "refused"; refusal: string; detail: string }
  | { status: "unavailable"; error: typeof LEDGER_UNAVAILABLE; detail: string }
  | { status: "failed"; error: typeof LEDGER_WRITE_FAILED; detail: string };

/**
 * Post the estimated earnings ledger for one just-inserted booking.
 *
 * @param svc            service-role client
 * @param booking        the just-inserted rent_buddy_bookings row
 * @param buddyProfileId rent_buddy_profiles.id of the buddy being booked. Kept
 *                       in the signature for the five call sites and the logs;
 *                       the DATABASE derives the payee from the booking row,
 *                       never from this argument.
 */
export async function createEarningsLedgerEntry(
  svc: any,
  booking: any,
  buddyProfileId: string,
): Promise<LedgerWriteResult> {
  if (!svc || !booking || !booking.id || !buddyProfileId) {
    return { status: "skipped", reason: "missing_arguments" };
  }

  const posted = await postBookingLedgerEvent(svc, booking.id, "booking_created");

  if (posted.status === "posted") {
    return {
      status: "written",
      bookingId: booking.id,
      platformFeePercent: posted.summary?.platformFeePercent ?? posted.feePercent,
      replayed: posted.replayed,
    };
  }

  if (posted.status === "refused") {
    logger.error(
      { bookingId: booking.id, buddyProfileId, refusal: posted.refusal, detail: posted.detail },
      "earnings ledger NOT written: rb_post_booking_ledger refused the booking",
    );
    return { status: "refused", refusal: posted.refusal, detail: posted.detail };
  }

  logger.error(
    { bookingId: booking.id, buddyProfileId, error: posted.error, rpc: posted.rpc, detail: posted.detail },
    posted.status === "unavailable"
      ? "earnings ledger NOT written: rb_post_booking_ledger is unavailable (is migration 3824 applied?) — no fallback is attempted"
      : "earnings ledger NOT written: rb_post_booking_ledger failed",
  );
  // Nothing is priced here any more, so nothing here asks whether a traveller
  // fee is chargeable: the posting function books no traveller service fee at
  // all (owner question R1 is unruled). This module therefore no longer reads
  // `rent_buddy_enabled`, which is seeded FALSE (2210) and off in production, `08` §1.1.
  return posted.status === "unavailable"
    ? { status: "unavailable", error: posted.error, detail: posted.detail }
    : { status: "failed", error: posted.error, detail: posted.detail };
}

/**
 * Undo the INSERT of a booking whose ledger could not be posted.
 *
 * The ledger call is the first thing every creation path does after its insert,
 * so nothing references the row yet: no event, no notification, no thread. A
 * status guard is not needed for the same reason — nobody else has seen it.
 *
 * Returns whether the row is gone. A `false` is logged at error level with the
 * booking id: it is the one way a booking can still exist without its ledger,
 * and an operator must be able to find it.
 */
export async function withdrawUnledgeredBooking(svc: any, bookingId: string): Promise<boolean> {
  if (!svc || !bookingId) return false;
  try {
    const { error } = await svc.from("rent_buddy_bookings").delete().eq("id", bookingId);
    if (error) {
      logger.error(
        { err: error, bookingId },
        "an unledgered booking could NOT be withdrawn — it exists with no earnings ledger",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error(
      { err, bookingId },
      "withdrawing an unledgered booking threw — it may exist with no earnings ledger",
    );
    return false;
  }
}

/**
 * Answer a booking-creation request whose ledger was not written.
 *
 * 503 for all three: the traveller did nothing wrong and may try again. The
 * body carries the NAMED error — `ledger_unavailable` when the SQL function is
 * missing, `ledger_write_failed` when it errored, `ledger_refused` (with the
 * database's own refusal) when it said no — so the cause is never reported as a
 * generic database error, and never as a booking that was made.
 */
export function sendBookingLedgerRefusal(
  res: any,
  result: Exclude<LedgerWriteResult, { status: "written" }>,
): void {
  const error =
    result.status === "unavailable" || result.status === "failed" ? result.error
    : result.status === "refused" ? "ledger_refused"
    : LEDGER_WRITE_FAILED;
  res.status(503).json({
    error,
    retryable: true,
    ...(result.status === "refused" ? { refusal: result.refusal } : {}),
    message: "Your booking was not created: its earnings record could not be written. Nothing was charged. Please try again shortly.",
  });
}
