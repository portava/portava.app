/**
 * rentBuddyCollectedMoney — the ONE place that answers "how much has been
 * collected in app?", for every rent-a-buddy money aggregate.
 *
 * ── WHY A MODULE FOR A ZERO ─────────────────────────────────────────────────
 * `09` §1.3.1 names the defect: *"It records money as collected that was never
 * collected."* It was filed against the ledger writer, and the ledger writer
 * was fixed — `lib/rentBuddyEarningsLedger.ts` now writes
 * `in_app_amount_collected: fromMinor(0)`, derived from entries that CANNOT
 * assert a settlement (`2901` CHECK-constrains `cash_settled_minor = 0`).
 *
 * The AGGREGATES were not fixed in that change, and there are four of them.
 * Each one independently summed `rent_buddy_bookings.deposit_usd` and published
 * the result under a name containing the word *collected*:
 *
 *   routes/rentABuddyMarketplace.ts  GET /rent-a-buddy/me/earnings/summary
 *                                    `completed.depositCollected`,
 *                                    `completed.inAppAmountCollected`
 *   routes/rentABuddy.ts             GET /rent-a-buddy/dashboard/earnings/summary
 *                                    `totalInAppUsd`, `monthlyBreakdown[].inApp`
 *   migrations/2330 …summary()       the SQL twin of the line above
 *   routes/rentABuddyMarketplace.ts  GET /…/admin/marketplace/analytics
 *                                    `bookings.byCity[city].inApp`,
 *                                    `revenue.deposit` (rendered as "Deposit
 *                                    collected" by admin/marketplace.tsx)
 *
 * So the ledger row said nothing was collected while four aggregates over the
 * same bookings said a deposit was — and for `payment_mode = 'full_in_app'`,
 * `deposit_usd` WAS the whole booking total on every booking written before
 * migration 3824 (the booking route set `depositUsd = totalUsd`; see the foot), so
 * they claimed the ENTIRE booking value had been charged. Nothing had:
 * `pay-deposit` and `pay-full` both return 503 `payment_stub:true`, there is no
 * processor, and no row in this tree can record a settlement.
 *
 * One module rather than four literals, because four call sites computing the
 * same money figure four ways is `09` §1.3.3's defect, and it is how the three
 * disagreeing take rates survived as long as they did.
 *
 * ── WHAT IS NOT ZEROED, AND WHY ─────────────────────────────────────────────
 * The scheduled figure is kept, under a name that does not claim it was taken.
 * That is the ledger row's own shape: it keeps `deposit_amount` (what the
 * booking says the deposit IS) beside `in_app_amount_collected` (0). A buddy
 * still needs to know what a booking is worth and what is owed to them; what
 * they must not be told is that it has already been paid.
 *
 * Consequently the NET estimate does not move. `totalNetUsd` keeps deriving
 * from the SCHEDULED in-app amount plus cash minus fees, which is the same
 * number it has always produced. Deriving net from the collected zero instead
 * would have published a negative balance for every `full_in_app` booking — a
 * second wrong number in place of the first, which is not a repair.
 *
 * ── WHEN A PROCESSOR EXISTS ─────────────────────────────────────────────────
 * This is the file that changes. `collectedInAppUsd()` becomes a read of the
 * settlement entries, and the test that makes a NON-zero answer reachable must
 * land in the same change as the writer that settles anything.
 */

/**
 * How much of a set of bookings has actually been collected in app.
 *
 * Takes the scheduled amount so that call sites read as an assertion about
 * THOSE bookings rather than as a bare `0` a later reader would be tempted to
 * "fix" back to the deposit sum.
 *
 * The argument is then DISCARDED, and that is the whole statement: there is no
 * payment path, so no part of any scheduled amount has been taken. The `void`
 * is explicit rather than an underscore-prefixed parameter because this
 * repository's eslint config has no `argsIgnorePattern`, and a new warning is a
 * worse marker than a line that says what it does.
 */
export function collectedInAppUsd(scheduledUsd: number): number {
  void scheduledUsd;
  return 0;
}

/**
 * The sentence every surface that reports a money total must carry, appended to
 * whatever else it says.
 *
 * `rentABuddyMarketplace.ts`'s ledger read already publishes
 * `LEDGER_NOT_SETTLED_WARNING` ("Estimated — payout not processed") per row.
 * That warning was honest about the PAYOUT and silent about the CHARGE, which
 * is how a dashboard could carry it and still report a collected deposit.
 */
export const NOTHING_COLLECTED_WARNING =
  "No payment has been collected: in-app charging is not connected, so every collected total is 0.";

/** One month of the dashboard breakdown, as the SQL aggregate and the fold both emit it. */
export interface EarningsMonthAgg {
  month: string;
  totalUsd: number;
  bookingCount: number;
  /** Collected in app. Always 0. */
  inApp: number;
  /** What the bookings say WOULD be charged in app. */
  inAppScheduled: number;
  cash: number;
  fees: number;
}

/**
 * Re-state a `rb_buddy_earnings_summary` result so it cannot claim a collection,
 * whatever the deployed function returns.
 *
 * This is not belt-and-braces. The SQL function is replaced by migration
 * `3530`, migrations here are applied by hand after CI, and until `3530` is
 * applied every database still holds the `2330` body that returns the deposit
 * sum as `totalInAppUsd`. A route that forwarded the aggregate verbatim would
 * keep publishing the false figure for exactly as long as that gap lasts. So
 * the route re-states it, and the fix does not depend on a migration press.
 *
 * `totalNetUsd` and `monthlyBreakdown[].totalUsd` are passed through untouched:
 * both are estimates derived from the booking value, and neither names a
 * collection.
 *
 * A result carrying no `monthlyBreakdown` comes back with `[]` rather than with
 * the key missing. The deployed function always COALESCEs that key to `'[]'`,
 * so this only bites a partial fake, and `[]` is the shape the client's type
 * already declares — but it IS a change of shape, so it is said here.
 */
export function withNothingCollected(agg: Record<string, any>): Record<string, any> {
  const scheduled = Number(agg.totalInAppScheduledUsd ?? agg.totalInAppUsd ?? 0);
  const months: any[] = Array.isArray(agg.monthlyBreakdown) ? agg.monthlyBreakdown : [];

  return {
    ...agg,
    totalInAppScheduledUsd: scheduled,
    totalInAppUsd: collectedInAppUsd(scheduled),
    monthlyBreakdown: months.map((m) => {
      const monthScheduled = Number(m?.inAppScheduled ?? m?.inApp ?? 0);
      return {
        ...m,
        inAppScheduled: monthScheduled,
        inApp: collectedInAppUsd(monthScheduled),
      };
    }),
  };
}

/**
 * What ONE booking says would be charged in app — the "scheduled" figure the
 * aggregates keep beside the collected zero.
 *
 * ── WHY IT IS NOT SIMPLY `deposit_usd` ──────────────────────────────────────
 * It was, and for every booking written before migration 3824 the two are the
 * same number: a `full_in_app` booking stored its whole price as `deposit_usd`
 * (see the header), and a `deposit_plus_cash` booking stored its deposit share.
 *
 * 3824 changed what is STORED. Under the owner's ruling of 2026-10-04 no
 * deposit is taken in the first release, so a new booking carries
 * `deposit_usd = 0` in either mode (`rb_booking_payment_terms`). For
 * `deposit_plus_cash` that is the truth: the whole price is cash. For
 * `full_in_app` it left nothing saying the price is due in app — and the
 * breakdown's net, `scheduled + cash - fees`, would have come out NEGATIVE for
 * exactly the buddies whose bookings are paid entirely in app. That is the
 * wrong answer the paragraph above ("WHAT IS NOT ZEROED") exists to prevent,
 * arriving by a different road.
 *
 * So the in-app share is read from the payment MODE: the whole price for
 * `full_in_app`, the stored deposit otherwise. This is the expression the
 * operator analytics already used for the same figure; it now has one home.
 * `rb_buddy_earnings_summary` carries the same CASE in SQL (3824, replacing
 * 3530's body), so the two paths of the breakdown still answer alike.
 */
export function scheduledInAppUsd(booking: { payment_mode?: unknown; total_usd?: unknown; deposit_usd?: unknown }): number {
  return booking.payment_mode === "full_in_app"
    ? Number(booking.total_usd ?? 0)
    : Number(booking.deposit_usd ?? 0);
}
