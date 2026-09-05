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
 * ── THIS IS NOT PAYMENT ─────────────────────────────────────────────────────
 * The row is an ESTIMATE (`is_estimated: true`) of what a booking would settle
 * to. No money moves: `pay-deposit` / `pay-full` return 503 `payment_stub:true`,
 * and the dashboard says so in as many words ("Payout system not connected").
 * Payout creation and disbursement remain deliberately unbuilt.
 *
 * Best-effort by design: the booking is already committed by the time this runs,
 * so a ledger failure is logged and swallowed rather than failing the booking.
 * `onConflict: "booking_id"` makes a re-run idempotent.
 */
import { logger } from "./logger.js";

/** Platform fee applied when no fee rule exists for the buddy's level. */
export const DEFAULT_PLATFORM_FEE_PERCENT = 22;

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
): Promise<void> {
  if (!svc || !booking || !buddyProfileId) return;

  const { data: buddy } = await svc
    .from("rent_buddy_profiles")
    .select("user_id, buddy_level")
    .eq("id", buddyProfileId)
    .maybeSingle();
  if (!buddy) return;

  const { data: feeRule } = await svc
    .from("rent_buddy_fee_rules")
    .select("*")
    .eq("buddy_level", (buddy as any).buddy_level ?? "new")
    .maybeSingle();

  const feePercent = (feeRule as any)?.platform_fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT;
  const travelerSvcFee = Number((feeRule as any)?.traveler_service_fee_usd ?? 0);
  const total = Number(booking.total_usd ?? 0);
  const platformFeeAmount = Math.round(total * feePercent / 100 * 100) / 100;
  const buddyGross = total + Number(booking.tip_usd ?? 0);
  const buddyNet = Math.round((buddyGross - platformFeeAmount) * 100) / 100;

  const { error: ledgerErr } = await svc.from("rent_buddy_earnings_ledger").upsert({
    booking_id: booking.id,
    buddy_user_id: (buddy as any).user_id,
    traveler_id: booking.traveler_id,
    pricing_type: booking.pricing_type ?? "hourly",
    total_booking_usd: total,
    addons_usd: Number(booking.addons_total_usd ?? 0),
    tip_usd: Number(booking.tip_usd ?? 0),
    platform_fee_percent: feePercent,
    platform_fee_amount: platformFeeAmount,
    traveler_service_fee_amount: travelerSvcFee,
    buddy_gross_amount: buddyGross,
    buddy_net_estimated_amount: buddyNet,
    deposit_amount: Number(booking.deposit_usd ?? 0),
    in_app_amount_collected: Number(booking.deposit_usd ?? 0),
    cash_balance_due: Number(booking.cash_balance_usd ?? 0),
    cash_balance_confirmed: false,
    is_estimated: true,
  }, { onConflict: "booking_id" });
  if (ledgerErr) logger.error({ err: ledgerErr, bookingId: booking.id }, "earnings ledger upsert failed (best-effort)");
}
