/**
 * Intelligence Gathering — reward eligibility ORACLE (rewards internal).
 *
 * lib/rewardEligibility.evaluateRewardEligibility is PURE: it grades a
 * RewardEligibilityContext of booleans/strings and never touches the database.
 * Nothing computed that context from real state, so the whole reward loop was
 * dead — the gate only ever saw caller-supplied booleans. This module is the
 * missing half: it assembles the context from REAL DB facts about a contributor's
 * earning candidate, so eligibility is DERIVED, not trusted.
 *
 * It stays out of the pure gate: the oracle maps observed state -> context, and
 * evaluateRewardEligibility still decides. Every gate value below is traceable to
 * a real column read by the producer (lib/intelRewardScheduler).
 *
 * NEVER CASH (spec §30). The funding-source gate here concerns non-cash
 * recognition credits only; cash_amount is 0 and the table CHECK enforces it.
 */
import {
  evaluateRewardEligibility,
  type RewardEligibilityContext,
  type RewardEligibility,
} from "../../lib/rewardEligibility.js";

/**
 * The ledger version this producer books earnings against (§23 requires an
 * explicit ledger version). A constant, not caller input; bump it when the
 * earning model changes so historical bookings stay attributable to their model.
 */
export const CURRENT_REWARD_LEDGER_VERSION = "v1";

/**
 * Non-cash recognition credits are funded from the platform's own recognition
 * pool, which always exists — there is no external funding source to look up and
 * no money leaves the platform (cash_amount = 0, enforced by the table). A real
 * CASH payout would require a funding source, KYC, tax and fraud infrastructure
 * that does not exist; that is a separate switch and deliberately NOT what this
 * producer books. So for the non-cash ledger the funding source is known by
 * construction. Documented default, surfaced as a constant so the assumption is
 * visible rather than buried in a literal `true`.
 */
export const NONCASH_FUNDING_SOURCE_KNOWN = true;

/**
 * Observation moderation states that SUPPRESS earning. An observation that has
 * been restricted/blocked/removed is treated as a fraud/abuse hold: it never
 * earns, even if a co-located claim reached the served state from OTHER
 * contributors' evidence. (pending/allowed are admissible — the same whitelist
 * the promotion path applies.)
 */
const SUPPRESSED_MODERATION = new Set(["restricted", "blocked", "removed"]);

/**
 * A contributor's earning candidate, assembled by the producer from real intel_*
 * table reads. Every field is a fact about actual state, never a caller boolean.
 */
export interface EarningCandidate {
  /** The contributor (intel_observations.actor_id → profiles.id). */
  actorId: string;
  /** The observation being considered for reward (its id is the natural key). */
  observationId: string;
  /**
   * TRUE iff a privacy-eligible, un-expired intel_state_snapshots row exists for
   * this observation's (subject_id, zone_id, claim_type) — i.e. the evidence
   * reached the SERVED live state, having passed the downstream privacy gate.
   * This is the closest real signal to a "finalized, policy-eligible outcome"
   * (spec §4) the data model carries.
   */
  served: boolean;
  /**
   * The served snapshot's realized confidence (0..1) — the shadow QIU for this
   * contribution. Impact-weighted, not a flat per-post rate (§23). null/absent
   * when the snapshot carried no confidence ⇒ earns nothing (fail-closed).
   */
  servedConfidence: number | null;
  /** intel_observations.moderation_state at scan time. */
  moderationState: string;
  /** intel_contribution_consent.enabled for this actor (false if no row). */
  consentEnabled: boolean;
  /** intel_contribution_consent.withdrawn_at IS NOT NULL for this actor. */
  consentWithdrawn: boolean;
}

/**
 * Assemble the pure eligibility context from real candidate state. Keep this the
 * ONLY place that maps observed facts → RewardEligibilityContext.
 */
export function buildRewardEligibilityContext(c: EarningCandidate): RewardEligibilityContext {
  return {
    // Reached the served live state (privacy gate passed) — the finalized-outcome
    // signal, computed from a real snapshot, never trusted from the caller.
    outcomeFinalized: c.served === true,
    // The contributor's current, un-withdrawn contribution consent IS their
    // explicit permission for their intel to be used commercially (§23). A
    // withdrawn or absent consent removes the permission — fail-closed.
    commercialUsePermission: c.consentEnabled === true && c.consentWithdrawn !== true,
    // Non-cash recognition pool — known by construction (see the constant).
    fundingSourceKnown: NONCASH_FUNDING_SOURCE_KNOWN,
    // The current ledger version constant (§23).
    ledgerVersion: CURRENT_REWARD_LEDGER_VERSION,
    // A suppressed moderation state is a real abuse hold.
    fraudHold: SUPPRESSED_MODERATION.has(c.moderationState),
  };
}

/** Grade a candidate through the pure gate. Convenience over build + evaluate. */
export function evaluateCandidate(c: EarningCandidate): RewardEligibility {
  return evaluateRewardEligibility(buildRewardEligibilityContext(c));
}

/**
 * The shadow QIU for a candidate: the served snapshot's realized confidence.
 * Impact-weighted (a higher-confidence served claim is worth more) and 0 —
 * earning nothing — when the snapshot has no positive realized confidence
 * (fail-closed). This is the v1 proxy; the full IG-10 factor product
 * (lib/qiuShadow) refines it once a per-observation factor pipeline is wired.
 */
export function candidateQiu(c: EarningCandidate): number {
  const conf = c.servedConfidence;
  if (typeof conf !== "number" || !Number.isFinite(conf) || conf <= 0) return 0;
  return conf;
}
