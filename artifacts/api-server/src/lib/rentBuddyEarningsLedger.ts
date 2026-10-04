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
 * ── A BOOKING IS NOT LEFT WITHOUT ITS LEDGER, AND IS NEVER DENIED ───────────
 * The result is not best-effort. Every creation path calls `settleBookingLedger`:
 * an UNKNOWN result (the call errored — it may have committed) is confirmed by
 * re-posting, which is idempotent; only then is the booking withdrawn and a
 * NAMED error answered. If the booking cannot be withdrawn it EXISTS, and the
 * caller is given the booking — never "not created" about a row that is there.
 * With the SQL function absent creation is refused: the alternative is the
 * read-modify-write fallback `09` §3 refusal 2 forbids for money.
 *
 * ── THIS IS NOT PAYMENT ────────────────────────────────────────────────────
 * The row is an ESTIMATE. `pay-deposit` / `pay-full` return 503, nothing is
 * collected (`in_app_amount_collected` is the fold of settlement entries, of
 * which there are none), and `is_estimated` is cleared only by a settlement
 * entry that no route can write.
 */
import { logger } from "./logger.js";
import {
  LEDGER_UNAVAILABLE, LEDGER_WRITE_FAILED,
  postBookingLedgerEvent,
  sendLedgerRefusal,
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
 * Returns whether the row is gone. `false` means the booking STILL EXISTS — in
 * practice because its ledger entries exist too (the posting committed and its
 * answer was lost) and migration 3510 refuses to cascade a DELETE over
 * append-only ledger entries. The caller must then treat the booking as
 * created; see `settleBookingLedger`.
 */
export async function withdrawUnledgeredBooking(svc: any, bookingId: string): Promise<boolean> {
  if (!svc || !bookingId) return false;
  try {
    const { error } = await svc.from("rent_buddy_bookings").delete().eq("id", bookingId);
    if (error) {
      logger.error(
        { err: error, bookingId },
        "a booking whose ledger call did not answer could NOT be withdrawn — the booking exists and is treated as created",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error(
      { err, bookingId },
      "withdrawing a booking threw — the booking may exist and is treated as created",
    );
    return false;
  }
}

/**
 * What became of a just-inserted booking and its ledger.
 *
 *   ledgered   the booking and its ledger both exist. Proceed.
 *   kept       the ledger call did not answer `written`, and the booking could
 *              NOT be withdrawn — so it exists. Proceed, and return it: the
 *              caller must not answer "not created", must not release an offer
 *              claim, and must not let a retry make a second booking.
 *   withdrawn  the booking row is gone. Answer `sendBookingLedgerRefusal`.
 */
export type BookingLedgerSettlement =
  | { outcome: "ledgered"; ledger: Extract<LedgerWriteResult, { status: "written" }>; confirmedOnRetry: boolean }
  | { outcome: "kept"; ledger: Exclude<LedgerWriteResult, { status: "written" }> }
  | { outcome: "withdrawn"; ledger: Exclude<LedgerWriteResult, { status: "written" }> };

/**
 * Post a just-inserted booking's ledger and decide, truthfully, what the caller
 * may tell the traveller.
 *
 * THE DEFECT THIS REPLACES. Each creation path did `post → if not written,
 * DELETE the booking → 503 "not created, try again"`. When the posting had in
 * fact COMMITTED and only its answer was lost, the DELETE was refused (3510
 * will not cascade over ledger entries), the booking and its ledger stayed, the
 * traveller was told nothing had been created — and tried again, making a
 * second booking. On offer-accept the claim was released as well, so one offer
 * produced two bookings and two ledgers.
 *
 * NOW:
 *   1. post.
 *   2. An UNKNOWN result (`failed`: the call errored and may have committed) is
 *      CONFIRMED by posting again. `rb_post_booking_ledger` is idempotent per
 *      booking, so a posting that had committed answers `replayed` and nothing
 *      is written twice; one that had not is simply made now.
 *   3. Only a booking that is still unledgered is withdrawn.
 *   4. If the withdrawal fails the booking exists: `kept`.
 * A `refused` or `unavailable` first answer is definite — the database said
 * nothing was written, or the function is not there — and is not re-posted.
 */
export async function settleBookingLedger(
  svc: any,
  booking: any,
  buddyProfileId: string,
): Promise<BookingLedgerSettlement> {
  let ledger = await createEarningsLedgerEntry(svc, booking, buddyProfileId);
  if (ledger.status === "written") return { outcome: "ledgered", ledger, confirmedOnRetry: false };

  if (ledger.status === "failed") {
    const confirmed = await createEarningsLedgerEntry(svc, booking, buddyProfileId);
    if (confirmed.status === "written") {
      logger.warn(
        { bookingId: booking?.id, buddyProfileId, replayed: confirmed.replayed },
        "earnings ledger confirmed on re-post after an unanswered call — the booking is created",
      );
      return { outcome: "ledgered", ledger: confirmed, confirmedOnRetry: true };
    }
    ledger = confirmed;
  }

  const gone = await withdrawUnledgeredBooking(svc, booking?.id);
  if (gone) return { outcome: "withdrawn", ledger };
  logger.error(
    { bookingId: booking?.id, buddyProfileId, ledgerStatus: ledger.status },
    "booking kept: its ledger call did not answer `written` and the booking could not be withdrawn — returned to the caller as created; check its ledger",
  );
  return { outcome: "kept", ledger };
}

/**
 * Answer a booking-creation request whose booking was WITHDRAWN.
 *
 *   refused                        the database said no (buddy_not_found,
 *                                  invalid_total, …). Permanent for this
 *                                  request: 4xx, `retryable: false`, with the
 *                                  refusal named.
 *   unavailable / failed / skipped the function is missing or the call errored:
 *                                  503, `retryable: true`, a NAMED error.
 * Never a generic database error, and never a booking that was made.
 */
export function sendBookingLedgerRefusal(
  res: any,
  result: Exclude<LedgerWriteResult, { status: "written" }>,
): void {
  if (result.status === "refused") {
    sendLedgerRefusal(
      res, result.refusal,
      "Your booking was not created: it cannot be given an earnings record. Nothing was charged. Trying again will not help — please contact support.",
    );
    return;
  }
  res.status(503).json({
    error: result.status === "unavailable" || result.status === "failed" ? result.error : LEDGER_WRITE_FAILED,
    retryable: true,
    message: "Your booking was not created: its earnings record could not be written. Nothing was charged. Please try again shortly.",
  });
}

// ── Idempotent creation ──────────────────────────────────────────────────────
//
// The repair above covers an answer lost between the API and the database. An
// answer lost between the APP and the API is the client's to retry, and a retry
// must not make a second booking. A client sends `Idempotency-Key` (generated
// once per attempt and re-sent on every retry of it); the key is stored on the
// booking, scoped by the acting traveller and the resource being booked, behind
// a unique index (`rbb_creation_key_once`, migration 3824).

/** What a client may send: 8–120 characters of [A-Za-z0-9_.:-]. */
export const CREATION_KEY_RE = /^[A-Za-z0-9_.:-]{8,120}$/;
export const CREATION_KEY_MESSAGE = "Idempotency-Key must be 8-120 characters of letters, digits, '_', '.', ':' or '-'.";

/**
 * The creation key for this request, or `null` when the client sent none.
 * `invalid` for a key that WAS sent and is unusable: it is refused rather than
 * dropped, because a client that sent a key believes its retry is safe.
 *
 * `scope` names the path and the resource ("book:<buddy id>", "offer:<offer
 * id>", …), so one client key cannot collide across two different things.
 */
export function readCreationKey(req: any, scope: string): { status: "none" } | { status: "invalid" } | { status: "key"; key: string } {
  const supplied = req?.get?.("Idempotency-Key") ?? req?.body?.idempotencyKey;
  if (supplied === undefined || supplied === null || supplied === "") return { status: "none" };
  if (typeof supplied !== "string" || !CREATION_KEY_RE.test(supplied)) return { status: "invalid" };
  return { status: "key", key: `${scope}:${supplied}` };
}

/** PostgreSQL's unique-violation on the creation-key index: a concurrent retry won. */
export function isCreationKeyConflict(error: any): boolean {
  return String(error?.code ?? "") === "23505" && /rbb_creation_key_once/.test(`${error?.message ?? ""} ${error?.details ?? ""}`);
}

export type PriorBookingLookup =
  | { status: "none" }
  | { status: "found"; booking: any }
  | { status: "error"; message: string };

/** The booking this traveller already created with this key, if any. */
export async function findBookingByCreationKey(svc: any, travelerId: string, creationKey: string): Promise<PriorBookingLookup> {
  const { data, error } = await svc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("traveler_id", travelerId)
    .eq("creation_key", creationKey)
    .limit(1);
  if (error) return { status: "error", message: String(error.message ?? error) };
  const row = Array.isArray(data) ? data[0] : data;
  return row ? { status: "found", booking: row } : { status: "none" };
}

/**
 * The idempotent-creation half every creation path shares.
 *
 * `begin` reads the key and looks for the original booking. If it finds one it
 * makes sure that booking's ledger exists (the posting is idempotent), ANSWERS
 * with `respond(booking)` — status 200, `idempotentReplay: true` — and returns
 * `done: true`: the handler must stop. Otherwise the handler carries on and
 * stores `key` on the row it inserts.
 *
 * `replayOnConflict` is for the insert's error path: when two retries race, the
 * loser's INSERT hits the unique index, and it answers with the winner's
 * booking instead of an error.
 */
export interface IdempotentCreation {
  done: boolean;
  /** The value for `rent_buddy_bookings.creation_key`; null when no key was sent. */
  key: string | null;
  replayOnConflict(insertError: any): Promise<boolean>;
}

export async function beginIdempotentCreation(
  req: any,
  res: any,
  svc: any,
  travelerId: string,
  scope: string,
  respond: (booking: any) => Record<string, unknown>,
): Promise<IdempotentCreation> {
  const read = readCreationKey(req, scope);
  if (read.status === "invalid") {
    res.status(400).json({ error: "invalid_idempotency_key", message: CREATION_KEY_MESSAGE });
    return { done: true, key: null, replayOnConflict: async () => false };
  }
  if (read.status === "none") return { done: false, key: null, replayOnConflict: async () => false };

  const key = read.key;
  const replay = async (): Promise<"sent" | "none"> => {
    const prior = await findBookingByCreationKey(svc, travelerId, key);
    if (prior.status === "error") {
      logger.error({ travelerId, scope, detail: prior.message }, "idempotent creation: the original booking could not be looked up");
      res.status(503).json({ error: "db_error", retryable: true, message: "We couldn't check whether this booking was already made. Please try again." });
      return "sent";
    }
    if (prior.status === "none") return "none";
    // The original may be the one whose ledger answer was lost. Posting again
    // is idempotent: it confirms the ledger or makes it.
    const ledger = await createEarningsLedgerEntry(svc, prior.booking, prior.booking.buddy_id);
    if (ledger.status !== "written") {
      logger.error({ bookingId: prior.booking.id, ledgerStatus: ledger.status }, "idempotent replay: the original booking's ledger could not be confirmed");
    }
    res.status(200).json({ ...respond(prior.booking), idempotentReplay: true });
    return "sent";
  };

  if ((await replay()) === "sent") return { done: true, key, replayOnConflict: async () => false };
  return {
    done: false,
    key,
    replayOnConflict: async (insertError: any) => isCreationKeyConflict(insertError) && (await replay()) === "sent",
  };
}
