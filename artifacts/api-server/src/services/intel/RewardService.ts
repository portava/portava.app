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
  /**
   * Optional caller-supplied idempotency key. When set, booking the SAME
   * (actor, key) twice credits the ledger once: the second call returns the
   * ORIGINAL entry rather than appending a duplicate. Derive it from the
   * earning event (e.g. `outcome:<outcomeId>`), not per-attempt, so an
   * at-least-once caller (retry, redelivery) cannot double-credit.
   */
  idempotencyKey?: string;
}

export type RecordRewardResult =
  | { ok: true; ledgerEntry: any; earnedUnits: number; replayed?: true }
  | { ok: false; reason: "disabled" | "ineligible" | "db_error"; reasons?: string[]; detail?: string };

/**
 * Record earned credits. Fail-closed no-op when the flag is off. Refuses (records
 * nothing) when the contributor is not eligible, returning the exact reasons.
 * Always non-cash.
 *
 * Idempotent when an idempotencyKey is supplied: the ledger is append-only (no
 * UPDATE/DELETE grant), so a replay is detected by the unique-violation on
 * (actor_id, idempotency_key) — we then read back and return the original entry,
 * never a second credit.
 */
export async function recordEarnedReward(sc: any, actorId: string, input: RecordRewardInput): Promise<RecordRewardResult> {
  if (!(await isFlagEnabled(sc, REWARDS_FLAG))) return { ok: false, reason: "disabled" };

  const elig = evaluateRewardEligibility(input.eligibility);
  if (!elig.eligible) return { ok: false, reason: "ineligible", reasons: elig.reasons };

  const earned = computeEarnedReward(input.qiu);
  const key = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim().length > 0
    ? input.idempotencyKey.trim()
    : null;
  const row: Record<string, unknown> = {
    actor_id: actorId,
    source: input.source,
    qiu: input.qiu,
    earned_units: earned.earnedUnits,
    cash_amount: earned.cashAmount, // 0
    ledger_version: input.ledgerVersion,
    commercial_use_permission: true, // eligibility already required it
  };
  // Only carry the column when a key is present: a NULL key is exempt from the
  // partial unique index, so keyless callers keep the prior append-always
  // behaviour untouched.
  if (key !== null) row["idempotency_key"] = key;

  const { data, error } = await sc.from("intel_reward_ledger").insert(row).select().single();
  if (!error) return { ok: true, ledgerEntry: data, earnedUnits: earned.earnedUnits };

  // Idempotent replay: the row already exists for this (actor, key). Return the
  // ORIGINAL entry so the credit is booked exactly once. Any other error is real.
  if (key !== null && String((error as any).code) === "23505") {
    const { data: existing, error: readErr } = await sc
      .from("intel_reward_ledger")
      .select()
      .eq("actor_id", actorId)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (!readErr && existing) {
      const units = typeof (existing as any).earned_units === "number"
        ? (existing as any).earned_units
        : earned.earnedUnits;
      return { ok: true, ledgerEntry: existing, earnedUnits: units, replayed: true };
    }
    return { ok: false, reason: "db_error", detail: "idempotent replay lookup failed" };
  }
  return { ok: false, reason: "db_error", detail: String((error as any).message ?? "") };
}
