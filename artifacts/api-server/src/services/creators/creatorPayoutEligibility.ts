/**
 * creatorPayoutEligibility — `11` §6's fourth creator read, answered honestly
 * while its rule does not exist (census-discovery §134, DC-23).
 *
 * `07` §4 "Earnings eligibility" gives a SUGGESTED progression and the inputs
 * eligibility CAN consider. It sets no threshold, no order of precedence and no
 * weighting: those are the owner's decision W10D-B5. Until it is made, the only
 * true answer for every creator is "undecided", with nothing payable. That is
 * what this returns. It reads nothing, so it cannot leak a trust or fraud signal
 * to the person it describes, and it cannot be mistaken for a computed verdict.
 */

/** `07` §4's suggested progression, in the specification's order. Vocabulary only: no creator is placed on it. */
export const PAYOUT_PROGRESSION = [
  "explorer", "contributor", "trusted_contributor", "trail_builder_local_expert", "monetization_eligible", "creator_partner",
] as const;

/** `07` §4's "eligibility can consider" list, in the specification's order. None is read here. */
export const PAYOUT_ELIGIBILITY_INPUTS = [
  "account_age", "verification", "trust_safety", "contribution_history", "fraud_signals", "payout_compliance",
] as const;

/** The decision the answer waits on. */
export const PAYOUT_ELIGIBILITY_DECISION = "W10D-B5";

export interface PayoutEligibilityAnswer {
  status: "undecided";
  eligible: null;
  payable: false;
  reason: "thresholds_unset";
  decision: typeof PAYOUT_ELIGIBILITY_DECISION;
  progression: readonly string[];
  considers: readonly string[];
}

/** The answer for any creator while W10D-B5 is open. */
export function payoutEligibilityAnswer(): PayoutEligibilityAnswer {
  return {
    status: "undecided",
    eligible: null,
    payable: false,
    reason: "thresholds_unset",
    decision: PAYOUT_ELIGIBILITY_DECISION,
    progression: [...PAYOUT_PROGRESSION],
    considers: [...PAYOUT_ELIGIBILITY_INPUTS],
  };
}
