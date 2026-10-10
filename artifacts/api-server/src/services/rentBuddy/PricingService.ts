/**
 * PricingService
 *
 * Two key functions:
 *   1. getPricingSuggestion — returns a human-readable suggested range label
 *      (shown to Buddy only, never enforced)
 *   2. calculateDeposit — decides the in-app / cash split and the payment mode;
 *      returns deposit_rule_applied, deposit_percent, deposit_reason
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THERE IS NO BOOKING DEPOSIT. OWNER DECISION, 2026-10-04.
 * ══════════════════════════════════════════════════════════════════════════════
 *   "Set the booking deposit to 0% for the first release. Remove the shipped
 *    30% default."
 *
 * ── What shipped, and what is gone ──────────────────────────────────────────
 * Two independent deposit computations shipped. BOTH are deleted here, not
 * zeroed:
 *
 *   • a hard-coded 30 % literal in `routes/rentABuddy.ts`'s canonical booking
 *     creation — `totalUsd * 0.3` — which ignored every `deposit_percent`
 *     column that exists; and
 *   • the ladder that used to live in `calculateDeposit`: a 20 % base, 25 % for
 *     arrival and content, 35 % for nightlife and groups, a 35 % floor for a
 *     `new` buddy, a 40 % floor for a first-time traveller, and a
 *     `repeat_trusted` branch that could only ever re-assert the 20 % it was
 *     already at. Six rules producing five different fractions of a traveller's
 *     money, none of them the decided rate.
 *
 * No variable here holds 20, 25, 30, 35 or 40. `src/test/rentBuddyDepositZero.test.ts`
 * reads this file and `routes/rentABuddy.ts` as TEXT and fails if any of those
 * deposit fractions reappears, because a percentage that can be re-added by one
 * careless edit is not a removed percentage.
 *
 * ── Why the deposit CONCEPT survives even though the rate is zero ───────────
 * It cannot be deleted additively and it is load-bearing for something else:
 *
 *   • `rent_buddy_bookings.deposit_usd` / `cash_balance_usd` / `deposit_percent`
 *     / `deposit_rule_applied` / `deposit_reason` are shipped columns, several
 *     NOT NULL, and dropping them is a destructive migration;
 *   • `deposit_usd` is ALSO the in-app leg of a `full_in_app` booking —
 *     `routes/rentABuddy.ts#foldEarningsRows` reads it as `inApp`, and so does
 *     `rb_buddy_earnings_summary` (migration 2330). It is the amount charged in
 *     app, which for a fully prepaid booking is the whole price; and
 *   • a later release may reintroduce a deposit, and it must reintroduce it as
 *     a decision with a rate, not by re-growing a ladder.
 *
 * So the concept stays and "no deposit" is UNCONDITIONAL: every booking is
 * either fully prepaid in app (the whole price, which is not a deposit) or
 * carries no up-front money at all. There is no third, fractional answer. The
 * split is computed in exactly one place — `splitBookingPayment` below — and
 * every booking-creation path calls it.
 *
 * ── This charges nobody either way ─────────────────────────────────────────
 * `pay-deposit` and `pay-full` return 503, `rent_buddy_enabled` is FALSE on
 * every database, and payment processing stays in test mode. These numbers are
 * what a booking row records, not money that moves.
 */

export interface PricingSuggestionResult {
  label: string;
  minUsd: number;
  maxUsd: number;
  pricingType: string;
}

/**
 * What is left of the deposit calculator's input once the rate is zero.
 *
 * `category`, `pricingType`, `buddyLevel`, `travelerCompletedBookings`,
 * `travelerId` and `isGroupBooking` are GONE, not merely ignored. They existed
 * only to feed the deleted ladder, and a field a caller still supplies to a
 * calculator that no longer reads it is a decoy: the next reader assumes a
 * nightlife booking or a first-time traveller is priced differently, because
 * the call site still says so. Removing them makes it impossible to compute a
 * deposit from a category or a buddy level without re-adding the parameter and
 * saying why.
 *
 * Everything that remains answers one question — is this booking settled in app
 * or hand to hand — which is a payment-mode question, not a deposit question.
 */
export interface DepositCalculationInput {
  /** Admin restriction on this traveller: cash balances not allowed. */
  cashBalanceDisabled: boolean;
  /** Admin restriction on this traveller: the full price must be paid in app. */
  fullInAppRequired: boolean;
  /** This buddy has turned the cash-balance mode off. */
  disableDepositCash: boolean;
  /** This buddy accepts cash at all. */
  buddyCashBalanceAccepted: boolean;
  /** Safety/risk hold on the buddy: nothing is settled hand to hand. */
  riskHold: boolean;
  totalUsd: number;
}

export interface DepositCalculationResult {
  /**
   * The share of the total charged IN APP at booking, as a percentage. 0 or
   * 100 and nothing else — the deposit rate is zero, so a fractional share
   * cannot arise. Written to `rent_buddy_bookings.deposit_percent`.
   */
  depositPercent: number;
  /** The in-app leg. 0 for a cash booking; the whole price for a prepaid one. */
  depositUsd: number;
  cashBalanceDue: number;
  paymentMode: 'full_in_app' | 'deposit_plus_cash';
  depositRuleApplied: string;
  depositReason: string;
  isFullInApp: boolean;
}

// ── Pricing suggestion ─────────────────────────────────────────────────────────

const PRICING_DEFAULTS: Record<string, { min: number; max: number }> = {
  city:         { min: 15, max: 40 },
  nightlife:    { min: 25, max: 60 },
  language:     { min: 15, max: 35 },
  arrival:      { min: 20, max: 50 },
  content:      { min: 25, max: 60 },
  shopping:     { min: 15, max: 35 },
  food:         { min: 15, max: 35 },
  culture:      { min: 15, max: 35 },
  adventure:    { min: 20, max: 50 },
  wellness:     { min: 20, max: 45 },
  other:        { min: 15, max: 40 },
};

const CITY_MULTIPLIERS: Record<string, number> = {
  tokyo: 1.3, london: 1.4, paris: 1.3, new_york: 1.4, dubai: 1.5,
  singapore: 1.3, sydney: 1.2, zurich: 1.5, oslo: 1.4,
  bangkok: 0.8, bali: 0.7, mexico_city: 0.7, lisbon: 0.9, prague: 0.8,
};

const LEVEL_MULTIPLIERS: Record<string, number> = {
  new: 0.8, rising: 1.0, pro: 1.2, elite: 1.4, city_ambassador: 1.5,
};

export function getPricingSuggestion(
  city: string,
  category: string,
  durationMinutes: number,
  buddyLevel: string,
  groupSize: number,
  pricingType: string = 'hourly',
): PricingSuggestionResult {
  const base = PRICING_DEFAULTS[category] ?? PRICING_DEFAULTS.other;
  const cityKey = city.toLowerCase().replace(/\s+/g, '_');
  const cityMult = CITY_MULTIPLIERS[cityKey] ?? 1.0;
  const levelMult = LEVEL_MULTIPLIERS[buddyLevel] ?? 1.0;
  const groupMult = groupSize > 1 ? 1 + (groupSize - 1) * 0.15 : 1;

  let minUsd = base.min * cityMult * levelMult;
  let maxUsd = base.max * cityMult * levelMult;

  if (pricingType === 'half_day') {
    minUsd = minUsd * 3.5;
    maxUsd = maxUsd * 3.5;
  } else if (pricingType === 'full_day') {
    minUsd = minUsd * 6;
    maxUsd = maxUsd * 6;
  } else if (pricingType === 'nightlife_block') {
    minUsd = minUsd * 4;
    maxUsd = maxUsd * 4;
  } else if (pricingType === 'arrival') {
    minUsd = 40 * cityMult;
    maxUsd = 100 * cityMult;
  } else {
    // hourly — apply duration scaling
    const hours = durationMinutes / 60;
    minUsd = minUsd * hours;
    maxUsd = maxUsd * hours;
  }

  minUsd = minUsd * groupMult;
  maxUsd = maxUsd * groupMult;

  const min = Math.round(minUsd);
  const max = Math.round(maxUsd);
  const label = `Suggested range: $${min}–$${max} for ${category} in ${city}`;

  return { label, minUsd: min, maxUsd: max, pricingType };
}

// ── The in-app / cash split — the ONE place "no deposit" is implemented ───────

/**
 * The share of a booking total charged in app at booking time, expressed the
 * only two ways it can be expressed while the deposit rate is zero.
 *
 * `'none'` — nothing up front. The traveller settles the whole amount with the
 *            buddy directly (`deposit_plus_cash`). THIS is the 0 % deposit.
 * `'full'` — the whole price is prepaid in app (`full_in_app`). That is full
 *            prepayment of the price, not a deposit: nothing is held back and
 *            no balance is due later.
 *
 * There is deliberately no value between them. A fractional share IS a deposit,
 * and no deposit is approved for the first release.
 */
export type InAppShare = 'none' | 'full';

/**
 * Split a booking total into its in-app and cash legs. Called by every
 * booking-creation path so the split cannot differ between them.
 *
 * `deposit_usd` is the in-app leg — see the module header on why that column
 * carries the whole price for a prepaid booking and zero for a cash one.
 */
export function splitBookingPayment(
  totalUsd: number,
  share: InAppShare,
): { depositUsd: number; cashBalanceUsd: number } {
  const total = Math.round(Number(totalUsd) * 100) / 100;
  return share === 'full'
    ? { depositUsd: total, cashBalanceUsd: 0 }
    : { depositUsd: 0, cashBalanceUsd: total };
}

/**
 * What a booking's `deposit_percent` column records: the in-app share as a
 * percentage. 0 for a cash booking, 100 for a fully prepaid one. These are the
 * only two values any booking-creation path may write.
 */
export const IN_APP_SHARE_PERCENT: Record<InAppShare, number> = { none: 0, full: 100 };

/** Every `deposit_rule_applied` value this tree can now produce. */
export const DEPOSIT_RULES_APPLIED = [
  'no_deposit_first_release',
  'risk_hold',
  'admin_full_in_app',
  'cash_not_accepted',
] as const;

// ── Deposit calculator ─────────────────────────────────────────────────────────

export function calculateDeposit(input: DepositCalculationInput): DepositCalculationResult {
  // THE DEPOSIT RATE IS ZERO (owner decision 2026-10-04; module header). There
  // is no base rate, no category rate, no buddy-level floor and no
  // traveller-history floor to compute, so the only question left is WHERE the
  // money is settled — in app, or hand to hand.
  //
  // A booking is fully prepaid in app when any of these says so. Three of the
  // four were already decisive before this change; `!buddyCashBalanceAccepted`
  // and `disableDepositCash` previously reached the same outcome one branch
  // later, via a `canUseDpC` test that also had to check a deposit percentage.
  // With no deposit to check, they belong in the same place.
  const mustPrepayInApp =
    input.riskHold ||
    input.cashBalanceDisabled ||
    input.fullInAppRequired ||
    input.disableDepositCash ||
    !input.buddyCashBalanceAccepted;

  if (mustPrepayInApp) {
    const { depositUsd, cashBalanceUsd } = splitBookingPayment(input.totalUsd, 'full');
    const ruleApplied = input.riskHold
      ? 'risk_hold'
      : (input.cashBalanceDisabled || input.fullInAppRequired)
        ? 'admin_full_in_app'
        : 'cash_not_accepted';
    const reason = input.riskHold
      ? 'Risk hold — the full price is paid in app'
      : (input.cashBalanceDisabled || input.fullInAppRequired)
        ? 'Admin restriction — the full price is paid in app'
        : 'This Buddy does not take cash — the full price is paid in app';

    return {
      // 100 % in app. NOT a deposit: the whole price is prepaid and no balance
      // is due later. The column records the in-app share.
      depositPercent: IN_APP_SHARE_PERCENT.full,
      depositUsd,
      cashBalanceDue: cashBalanceUsd,
      paymentMode: 'full_in_app',
      depositRuleApplied: ruleApplied,
      depositReason: reason,
      isFullInApp: true,
    };
  }

  const { depositUsd, cashBalanceUsd } = splitBookingPayment(input.totalUsd, 'none');
  return {
    depositPercent: IN_APP_SHARE_PERCENT.none,
    depositUsd,
    cashBalanceDue: cashBalanceUsd,
    paymentMode: 'deposit_plus_cash',
    depositRuleApplied: 'no_deposit_first_release',
    depositReason: 'No deposit is taken. The full amount is settled with your Buddy directly.',
    isFullInApp: false,
  };
}

// ── Booking expiry helper ──────────────────────────────────────────────────────

export function getBookingExpiresAt(bookingDate: string, availableNow: boolean): Date {
  const now = new Date();
  const bDate = new Date(bookingDate);
  const todayStr = now.toISOString().slice(0, 10);
  const bDateStr = bDate.toISOString().slice(0, 10);

  if (availableNow) {
    return new Date(now.getTime() + 15 * 60 * 1000); // 15 min
  } else if (bDateStr === todayStr) {
    return new Date(now.getTime() + 60 * 60 * 1000); // 1 hr
  } else {
    return new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hrs
  }
}
