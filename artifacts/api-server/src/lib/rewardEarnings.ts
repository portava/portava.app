/**
 * Intelligence Gathering — reward earnings (rewards internal, spec §23/§30).
 *
 * Converts a contributor's shadow QIU (lib/qiuShadow) into earned NON-CASH
 * credits. Two invariants the spec is explicit about:
 *   • "no fixed rate per post" (§23) — earnings are QIU-derived, never a flat
 *     per-submission amount, so gaming volume without impact earns nothing;
 *   • "Stamps/credits; no cash" (§30) — cashAmount is ALWAYS 0 here.
 *
 * Pure; fail-closed to 0 credits on a non-positive or non-finite QIU (a QIU of 0
 * — integrity failed or the claim expired before the action — earns nothing).
 */

export const REWARD_UNIT = "credit" as const;

/**
 * Credits per unit of QIU. An owner-tunable conversion (§30 initial-rewards
 * decision), deliberately a multiplier on QIU rather than a per-post rate.
 */
export const QIU_TO_CREDITS = 100;

export interface EarnedReward {
  unit: typeof REWARD_UNIT;
  earnedUnits: number; // non-cash credits
  cashAmount: 0;       // never cash in this system
}

/** Earned non-cash credits for a shadow QIU. 0 when QIU is non-positive/invalid. */
export function computeEarnedReward(qiu: number): EarnedReward {
  if (!Number.isFinite(qiu) || qiu <= 0) return { unit: REWARD_UNIT, earnedUnits: 0, cashAmount: 0 };
  return { unit: REWARD_UNIT, earnedUnits: Math.round(qiu * QIU_TO_CREDITS), cashAmount: 0 };
}
