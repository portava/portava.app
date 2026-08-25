/**
 * Intelligence Gathering — reward eligibility (rewards internal, spec §23).
 *
 * "Contributor payouts require explicit funding source, ledger version and
 * commercial-use permission" (spec §23), and trust/rewards update "only from
 * finalized, policy-eligible outcomes" (spec §4). This module is the eligibility
 * gate that must pass before any reward is recorded — pure, and it enumerates
 * exactly why it refused so the refusal is auditable.
 *
 * It never decides CASH. Even a fully eligible contributor earns non-cash
 * credits here (spec §30 "Stamps/credits; no cash"); an actual money transfer is
 * a separate switch behind payments/KYC/tax/fraud infrastructure that does not
 * exist. RUNTIME EFFECT: NONE on its own.
 */

export interface RewardEligibilityContext {
  /** The contributor granted explicit commercial-use permission (§23). */
  commercialUsePermission: boolean;
  /** An explicit funding source backs this earning (§23). */
  fundingSourceKnown: boolean;
  /** The ledger version this earning is booked against (§23); null ⇒ ineligible. */
  ledgerVersion: string | null;
  /** A fraud hold suspends earning (§25 mission fraud). */
  fraudHold: boolean;
  /** Rewards accrue only from a FINALIZED outcome (§4). */
  outcomeFinalized: boolean;
}

export interface RewardEligibility {
  eligible: boolean;
  reasons: string[]; // every gate that failed, for the audit trail
}

/** Evaluate every reward-eligibility gate. Fail-closed: any missing gate refuses. */
export function evaluateRewardEligibility(ctx: RewardEligibilityContext): RewardEligibility {
  const reasons: string[] = [];
  if (!ctx.outcomeFinalized) reasons.push("outcome_not_finalized");
  if (!ctx.commercialUsePermission) reasons.push("no_commercial_use_permission");
  if (!ctx.fundingSourceKnown) reasons.push("no_funding_source");
  if (!ctx.ledgerVersion) reasons.push("no_ledger_version");
  if (ctx.fraudHold) reasons.push("fraud_hold");
  return { eligible: reasons.length === 0, reasons };
}
