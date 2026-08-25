/**
 * Intelligence Gathering — reward service (rewards internal).
 *
 * Records a contributor's earned NON-CASH credits to public.intel_reward_ledger,
 * behind the intel_rewards flag. Eligibility (lib/rewardEligibility) and the
 * QIU→credits conversion (lib/rewardEarnings) are pure; this is the impure half
 * that persists the append-only ledger entry.
 *
 * NEVER CASH. cash_amount is always 0 (the table CHECK enforces it too). A money
 * transfer is a separate switch behind payments/KYC/tax/fraud infrastructure that
 * does not exist — a financial-control boundary, not a user-count gate.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { evaluateRewardEligibility, type RewardEligibilityContext } from "../../lib/rewardEligibility.js";
import { computeEarnedReward } from "../../lib/rewardEarnings.js";

const REWARDS_FLAG = "intel_rewards";

export interface RecordRewardInput {
  qiu: number;
  eligibility: RewardEligibilityContext;
  source: string;        // 'outcome' | 'mission' | 'qiu' | …
  ledgerVersion: string; // the ledger version this earning is booked against
}

export type RecordRewardResult =
  | { ok: true; ledgerEntry: any; earnedUnits: number }
  | { ok: false; reason: "disabled" | "ineligible" | "db_error"; reasons?: string[]; detail?: string };

/**
 * Record earned credits. Fail-closed no-op when the flag is off. Refuses (records
 * nothing) when the contributor is not eligible, returning the exact reasons.
 * Always non-cash.
 */
export async function recordEarnedReward(sc: any, actorId: string, input: RecordRewardInput): Promise<RecordRewardResult> {
  if (!(await isFlagEnabled(sc, REWARDS_FLAG))) return { ok: false, reason: "disabled" };

  const elig = evaluateRewardEligibility(input.eligibility);
  if (!elig.eligible) return { ok: false, reason: "ineligible", reasons: elig.reasons };

  const earned = computeEarnedReward(input.qiu);
  const row = {
    actor_id: actorId,
    source: input.source,
    qiu: input.qiu,
    earned_units: earned.earnedUnits,
    cash_amount: earned.cashAmount, // 0
    ledger_version: input.ledgerVersion,
    commercial_use_permission: true, // eligibility already required it
  };
  const { data, error } = await sc.from("intel_reward_ledger").insert(row).select().single();
  if (error) return { ok: false, reason: "db_error", detail: String((error as any).message ?? "") };
  return { ok: true, ledgerEntry: data, earnedUnits: earned.earnedUnits };
}
