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

// ═══════════════════════════════════════════════════════════════════════════
// The CREATOR-TYPE gate — `07` §10 for all SIX of §2's creator value types
// ═══════════════════════════════════════════════════════════════════════════
//
// APPENDED, NOT INTERLEAVED. `docs/architecture/07_Creator_Economy.md:163` and
// `:173` cite `rewardEligibility.ts:35-43` and `:10-13` by line, and a citation
// is a claim about a line number. Everything above is byte-identical and every
// line above keeps its number; only this section is new.
//
// ── WHAT THE GATE ABOVE COVERS, AND WHAT IT DOES NOT ───────────────────────
// `evaluateRewardEligibility` is the INTEL gate. Its five conditions are right
// and unchanged, but it knows nothing about creator TYPE: it is reached only
// from the intel reward path, and `07` §2's other five types have no way to ask
// it anything. It also has ONE `ledgerVersion` for the whole platform, where
// `07` §8/§10 want the rule VERSIONED PER TYPE — one shared version means
// re-pricing Trails silently re-prices intel.
//
// So this adds the type dimension WITHOUT changing the intel gate's meaning:
// `evaluateCreatorTypeEligibility` DELEGATES every one of the five conditions
// above and then adds the ones that only make sense per type. Duplicating the
// five would create a second place for them to drift, which is the defect the
// `2170`/`rent_buddy_earnings_ledger` split already demonstrates.
//
// STILL NO CASH, FOR ANY TYPE. Passing this gate authorises RECORDING an
// earning (`07` §10: "earnings can be recorded without paying"). It authorises
// no transfer, and there is no wallet, balance or disbursement path behind it
// (`09` §1). RUNTIME EFFECT: NONE on its own.
import { creatorTypeFacts, isCreatorType, type CreatorType } from "./creatorTypes.js";

export interface CreatorTypeEligibilityContext extends RewardEligibilityContext {
  /** Which of `07` §2's six types this earning would be booked under. */
  creatorType: CreatorType;
  /**
   * The rule version in force for THAT type — 2920's derived current
   * `creator_rule_versions` row. Null ⇒ the type has no versioned rule and
   * nothing may be booked against it (`07` §10 "rules are versioned").
   */
  typeRuleVersion: string | null;
  /**
   * Whether a value event was actually recorded for this contribution. FALSE
   * for the four types with no producer: their attributions are seams, and a
   * seam has nothing to earn against. 2921's trigger enforces the same rule.
   */
  valueEventRecorded: boolean;
}

/**
 * Evaluate every reward-eligibility gate for one creator type. Fail-closed:
 * any missing gate refuses, and every failure is named so the refusal is
 * auditable rather than a bare false.
 */
export function evaluateCreatorTypeEligibility(
  ctx: CreatorTypeEligibilityContext,
): RewardEligibility {
  const reasons: string[] = [];

  if (!isCreatorType(ctx.creatorType)) {
    // Refuse EARLY and alone: the type decides which rules apply, so nothing
    // else that follows from an unknown type is worth reporting.
    return { eligible: false, reasons: ["unknown_creator_type"] };
  }

  // The five intel conditions, DELEGATED rather than restated.
  reasons.push(...evaluateRewardEligibility(ctx).reasons);

  if (!ctx.typeRuleVersion) reasons.push("no_type_rule_version");
  else {
    // The version must belong to THIS type's lineage, or a Trail re-pricing
    // could be booked under the intel schedule and per-type versioning would be
    // decorative. Same lineage rule as lib/creatorTypeAttribution.ts.
    const lineage = (v: string) => v.replace(/\/v\d+$/, "");
    if (lineage(ctx.typeRuleVersion) !== lineage(creatorTypeFacts(ctx.creatorType).defaultRuleVersion)) {
      reasons.push("rule_version_type_mismatch");
    }
  }

  if (!ctx.valueEventRecorded) reasons.push("no_value_event_recorded");

  // A type with NO producer can never satisfy the gate above, and saying so
  // explicitly turns "this always refuses" from a mystery into a named fact a
  // reader can check against lib/creatorTypes.ts.
  if (creatorTypeFacts(ctx.creatorType).valueEventProducer === null) {
    reasons.push("no_value_event_producer");
  }

  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}
