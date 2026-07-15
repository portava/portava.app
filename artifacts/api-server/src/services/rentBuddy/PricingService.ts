/**
 * PricingService
 *
 * Two key functions:
 *   1. getPricingSuggestion — returns a human-readable suggested range label
 *      (shown to Buddy only, never enforced)
 *   2. calculateDeposit — applies risk rules to compute deposit amount and
 *      payment mode; returns deposit_rule_applied, deposit_percent, deposit_reason
 */

export interface PricingSuggestionResult {
  label: string;
  minUsd: number;
  maxUsd: number;
  pricingType: string;
}

export interface DepositCalculationInput {
  category: string;
  pricingType: string;  // 'hourly'|'half_day'|'full_day'|'nightlife_block'|'arrival'|'package'|'custom'
  buddyLevel: string;
  travelerCompletedBookings: number;
  travelerId: string;
  isGroupBooking: boolean;
  cashBalanceDisabled: boolean;
  fullInAppRequired: boolean;
  disableDepositCash: boolean;
  buddyCashBalanceAccepted: boolean;
  riskHold: boolean;
  totalUsd: number;
}

export interface DepositCalculationResult {
  depositPercent: number;
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

// ── Deposit calculator ─────────────────────────────────────────────────────────

export function calculateDeposit(input: DepositCalculationInput): DepositCalculationResult {
  // Step 1: base deposit % from category / pricing type
  let depositPercent = 20;
  let ruleApplied = 'standard';
  let reason = 'Standard daytime booking';

  if (input.pricingType === 'arrival' || input.category === 'arrival') {
    depositPercent = 25; ruleApplied = 'arrival'; reason = 'Arrival support — 25% deposit';
  } else if (input.pricingType === 'nightlife_block' || input.category === 'nightlife') {
    depositPercent = 35; ruleApplied = 'nightlife'; reason = 'Nightlife booking — 35% deposit';
  } else if (input.category === 'content') {
    depositPercent = 25; ruleApplied = 'content'; reason = 'Content creation — 25% deposit';
  } else if (input.isGroupBooking) {
    depositPercent = 35; ruleApplied = 'group'; reason = 'Group booking — 35% deposit';
  }

  // Step 2: new Buddy penalty
  if (input.buddyLevel === 'new') {
    depositPercent = Math.max(depositPercent, 35);
    ruleApplied = 'new_buddy';
    reason = 'New Buddy — minimum 35% deposit';
  }

  // Step 3: new traveler penalty
  if (input.travelerCompletedBookings === 0) {
    depositPercent = Math.max(depositPercent, 40);
    ruleApplied = 'new_traveler';
    reason = 'First-time traveler — 40% deposit';
  } else if (input.travelerCompletedBookings < 3) {
    depositPercent = Math.max(depositPercent, 35);
    if (ruleApplied === 'standard') {
      ruleApplied = 'limited_history'; reason = 'Limited booking history — 35% deposit';
    }
  }

  // Step 4: high-trust repeat — reduce deposit
  if (
    input.travelerCompletedBookings >= 5 &&
    input.buddyLevel !== 'new' &&
    !input.riskHold &&
    depositPercent === 20
  ) {
    depositPercent = 20; ruleApplied = 'repeat_trusted'; reason = 'Trusted repeat traveler — 20% deposit';
  }

  // Step 5: risk hold → full in-app
  if (input.riskHold || input.cashBalanceDisabled || input.fullInAppRequired) {
    return {
      depositPercent: 100,
      depositUsd: input.totalUsd,
      cashBalanceDue: 0,
      paymentMode: 'full_in_app',
      depositRuleApplied: input.riskHold ? 'risk_hold' : 'admin_full_in_app',
      depositReason: input.riskHold ? 'Risk hold — full in-app required' : 'Admin restriction — full in-app required',
      isFullInApp: true,
    };
  }

  const depositUsd = Math.round(input.totalUsd * depositPercent / 100 * 100) / 100;
  const cashBalanceDue = Math.round((input.totalUsd - depositUsd) * 100) / 100;

  // Step 6: payment mode eligibility
  const canUseDpC =
    !input.disableDepositCash &&
    input.buddyCashBalanceAccepted &&
    cashBalanceDue > 0 &&
    depositPercent < 100;

  const paymentMode: 'full_in_app' | 'deposit_plus_cash' = canUseDpC ? 'deposit_plus_cash' : 'full_in_app';
  const actualCashBalance = paymentMode === 'full_in_app' ? 0 : cashBalanceDue;
  const actualDeposit = paymentMode === 'full_in_app' ? input.totalUsd : depositUsd;

  return {
    depositPercent: paymentMode === 'full_in_app' ? 100 : depositPercent,
    depositUsd: actualDeposit,
    cashBalanceDue: actualCashBalance,
    paymentMode,
    depositRuleApplied: ruleApplied,
    depositReason: reason,
    isFullInApp: paymentMode === 'full_in_app',
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
