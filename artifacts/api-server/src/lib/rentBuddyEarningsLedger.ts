/**
 * rent_buddy_earnings_ledger — the single per-booking fee-breakdown writer.
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
 * The ledger writer lived as a module-private helper inside
 * rentABuddyMarketplace.ts and was therefore reachable only from the last two.
 * `GET /rent-a-buddy/me/earnings/ledger` reads that table and nothing else, so
 * for a buddy whose bookings came through the canonical route — which is the
 * ordinary way a booking is made — the ledger was permanently empty and the
 * endpoint returned `{ ledger: [], total: 0 }` no matter how much work they did.
 *
 * Extracting it here makes all five paths share one implementation, so the fee
 * percentages, the traveller service fee and the gross/net arithmetic cannot
 * drift between them.
 *
 * ── THE TAKE RATE COMES FROM ONE PLACE, AND IT CAN REFUSE (M1 / M10) ────────
 * This module used to carry `DEFAULT_PLATFORM_FEE_PERCENT = 22` and price a
 * booking at it whenever the buddy's level had no fee row. That literal is
 * gone. `lib/rentBuddyFeeSchedule.ts` is now the only reader of
 * `rent_buddy_fee_rules`, and it returns a three-state result; a booking whose
 * fee cannot be resolved gets NO ledger row rather than a row priced on a
 * guess. See that module's header for why a numeric fallback is the defect and
 * not the safety net.
 *
 * ── THIS IS NOT PAYMENT, AND THE ROW NO LONGER CLAIMS OTHERWISE ────────────
 * The row is an ESTIMATE (`is_estimated: true`): `pay-deposit` / `pay-full`
 * return 503 `payment_stub:true`, and nothing here clears `is_estimated` (M6).
 * One mutable summary row per booking is also why `09` §1.3.1 says *"It records
 * money as collected that was never collected."* Migration 2901 adds the
 * append-only source; `lib/creatorLedgerEntries.ts` argues it in full. Those
 * entries are the truth, THIS ROW IS THEIR PROJECTION, and it is not written
 * unless they were. A replay appends nothing (`ignoreDuplicates`), and the
 * booking is already committed when this runs, so a failure is logged and
 * swallowed rather than failing the booking.
 */
import { logger } from "./logger.js";
import { buildBookingEntries, fromMinor, reconstructBalances } from "./creatorLedgerEntries.js";
import { RENT_BUDDY_FEE_RULE_VERSION, toEarningsEntryRow } from "./creatorLedgerRows.js";
import {
  describeFeeScheduleFailure,
  platformFeeUsdFor,
  resolveFeeSchedule,
  travelerServiceFeeIsChargeable,
  travelerServiceFeeUsdFor,
} from "./rentBuddyFeeSchedule.js";

/**
 * What happened to the ledger row for one booking.
 *
 * Every caller today is `await createEarningsLedgerEntry(...).catch(() => {})`
 * — deliberately best-effort, because the booking is already committed. The
 * result is returned anyway so that a caller which DOES care (and the tests)
 * can tell the three outcomes apart instead of inferring them from silence.
 *
 * `fee_unresolved` and the two `entries_*` refusals are the ones that matter:
 * each means the booking exists and has no ledger row. That is the intended
 * behaviour — see the module header — and all three are logged at error level.
 */
export type LedgerWriteResult =
  | { status: "written"; bookingId: string; platformFeePercent: number }
  | { status: "skipped"; reason: "missing_arguments" | "buddy_not_found" }
  | { status: "fee_unresolved"; reason: "no_such_level" | "read_failed"; detail: string }
  | { status: "entries_refused"; reason: string; detail: string }
  | { status: "entries_write_failed"; detail: string }
  | { status: "write_failed"; detail: string };

/**
 * Write (or refresh) the estimated earnings-ledger row for one booking.
 *
 * @param svc            service-role client
 * @param booking        the just-inserted rent_buddy_bookings row
 * @param buddyProfileId rent_buddy_profiles.id of the buddy being booked
 */
export async function createEarningsLedgerEntry(
  svc: any,
  booking: any,
  buddyProfileId: string,
): Promise<LedgerWriteResult> {
  if (!svc || !booking || !buddyProfileId) {
    return { status: "skipped", reason: "missing_arguments" };
  }

  const { data: buddy } = await svc
    .from("rent_buddy_profiles")
    .select("user_id, buddy_level")
    .eq("id", buddyProfileId)
    .maybeSingle();
  if (!buddy) return { status: "skipped", reason: "buddy_not_found" };

  const buddyLevel = (buddy as any).buddy_level ?? null;
  const schedule = await resolveFeeSchedule(svc, buddyLevel);

  if (schedule.status !== "resolved") {
    // NO ROW IS WRITTEN. The previous behaviour was to price the booking at a
    // hard-coded 22 %, which produced a money record indistinguishable from one
    // an operator had configured. An absent ledger row is visibly absent; a row
    // carrying a fee nobody chose is not. `08` §2.3, §2.6.
    const detail = describeFeeScheduleFailure(schedule);
    logger.error(
      { bookingId: booking.id, buddyProfileId, buddyLevel, feeScheduleStatus: schedule.status, detail },
      "earnings ledger NOT written: platform fee could not be resolved from rent_buddy_fee_rules",
    );
    return { status: "fee_unresolved", reason: schedule.status, detail };
  }

  const rule = schedule.rule;
  const total = Number(booking.total_usd ?? 0);
  const platformFeeAmount = platformFeeUsdFor(total, rule);

  // M4 (mismatch half). The schedule amount now reads BOTH fee columns, so an
  // admin-set `_pct` is no longer invisible. Whether it is applied is gated:
  // while `rent_buddy_enabled` is off — which it is in production — the
  // recorded amount is 0, exactly as it is today. Charging travellers is
  // Stage 4 and requires ruling R1; see travelerServiceFeeIsChargeable.
  const scheduledTravelerFee = travelerServiceFeeUsdFor(total, rule);
  const chargeable = await travelerServiceFeeIsChargeable(svc);
  const travelerServiceFeeAmount = chargeable ? scheduledTravelerFee : 0;

  // ── 1. The append-only entries. These are the truth. ──────────────────────
  //
  // `collectedMinor: 0` is not decoration: it is the caller stating, in the one
  // place the builder will check, that nothing was collected. A non-zero value
  // is REFUSED rather than recorded (`09` §1; pay-deposit / pay-full are 503s).
  const built = buildBookingEntries({
    bookingId: booking.id,
    beneficiaryUserId: (buddy as any).user_id,
    ruleVersion: RENT_BUDDY_FEE_RULE_VERSION,
    totalUsd: total,
    tipUsd: Number(booking.tip_usd ?? 0),
    platformFeeUsd: platformFeeAmount,
    travelerServiceFeeUsd: travelerServiceFeeAmount,
    collectedMinor: 0,
  });
  if (built.status !== "built") {
    logger.error(
      { bookingId: booking.id, buddyProfileId, reason: built.reason, detail: built.detail },
      "earnings entries NOT written: the priced breakdown is not a bookable entry set",
    );
    return { status: "entries_refused", reason: built.reason, detail: built.detail };
  }

  const { error: entriesErr } = await svc
    .from("rent_buddy_earnings_entries")
    .upsert(built.entries.map((e) => toEarningsEntryRow(e, booking.id)), {
      // Append-only: a replay DOES NOTHING. `ignoreDuplicates` is what makes
      // this an INSERT … ON CONFLICT DO NOTHING rather than an overwrite, and
      // the index it infers (rbee_idempotency_key_once) is TOTAL, so inference
      // matches it — see 2180:17-19 for why a partial index would not.
      onConflict: "idempotency_key",
      ignoreDuplicates: true,
    });
  if (entriesErr) {
    logger.error(
      { err: entriesErr, bookingId: booking.id },
      "earnings entries append failed — the summary row is deliberately NOT written",
    );
    return { status: "entries_write_failed", detail: entriesErr.message ?? String(entriesErr) };
  }

  // ── 2. The summary row, DERIVED by folding those entries. ─────────────────
  //
  // Every money figure below comes from one arithmetic path. `09` §1.3.3's
  // defect is three call sites computing net three ways; this is the one that
  // writes it, and it no longer computes anything twice.
  const balances = reconstructBalances(built.entries);

  // NET = the buddy_payable balance: what the platform would owe, after the fee
  // was debited from it. GROSS = the credits into that account before the fee —
  // the booking total plus the tip — read off the same entries rather than
  // recomputed from the inputs.
  const buddyNet = fromMinor(balances.buddy_payable);
  const buddyGross = fromMinor(
    built.entries
      .filter((e) => e.account === "buddy_payable" && e.amountMinor > 0)
      .reduce((n, e) => n + e.amountMinor, 0),
  );

  const { error: ledgerErr } = await svc.from("rent_buddy_earnings_ledger").upsert({
    booking_id: booking.id,
    buddy_user_id: (buddy as any).user_id,
    traveler_id: booking.traveler_id,
    pricing_type: booking.pricing_type ?? "hourly",
    total_booking_usd: total,
    addons_usd: Number(booking.addons_total_usd ?? 0),
    tip_usd: Number(booking.tip_usd ?? 0),
    platform_fee_percent: rule.platformFeePercent,
    platform_fee_amount: platformFeeAmount,
    traveler_service_fee_amount: travelerServiceFeeAmount,
    buddy_gross_amount: buddyGross,
    buddy_net_estimated_amount: buddyNet,
    deposit_amount: Number(booking.deposit_usd ?? 0),
    // M5 / `09` §1.3.1. Derived from the entries, and NO entry can assert a
    // settlement (`cash_settled_minor = 0` is CHECK-enforced by 2901), so this
    // is 0 — where it used to be `deposit_usd`, i.e. money nobody paid.
    in_app_amount_collected: fromMinor(0),
    cash_balance_due: Number(booking.cash_balance_usd ?? 0),
    // Neither of these is ever cleared by anything in this tree (M6). They are
    // written true/false here and no settlement writer exists to change them.
    cash_balance_confirmed: false,
    is_estimated: true,
  }, { onConflict: "booking_id" });

  if (ledgerErr) {
    logger.error({ err: ledgerErr, bookingId: booking.id }, "earnings ledger upsert failed (best-effort)");
    return { status: "write_failed", detail: ledgerErr.message ?? String(ledgerErr) };
  }

  return { status: "written", bookingId: booking.id, platformFeePercent: rule.platformFeePercent };
}
