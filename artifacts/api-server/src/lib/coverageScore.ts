/**
 * Intelligence Gathering — Coverage score (IG-08, spec §16).
 *
 *   coverage = demand_weight · freshness_gap · claim_importance
 *              · confidence_gap · source_diversity_gap
 *
 * Each factor is normalised to [0,1]; the product is the priority of filling a
 * (zone, claim-family) gap — 0 means well-covered, 1 means high-demand and
 * entirely uncovered. PURE: a scheduler/endpoint supplies the raw inputs; this
 * module invents no data and reads no clock.
 *
 * RUNTIME EFFECT: NONE on its own. Consumed by services/intel/CoverageService.ts.
 */

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Claim-family importance = decision weight × safety weight, folded to [0,1].
 * Safety/transit families dominate; comfort/vibe families are lightest. Unknown
 * families fall back to a neutral mid weight so a new claim type is never scored
 * as zero-importance (which would hide a real gap).
 */
export const CLAIM_IMPORTANCE: Record<string, number> = {
  "transit.condition": 1.0,
  "access.walk_in": 0.9,
  "queue.wait": 0.85,
  "crowd.level": 0.8,
  "crowd.trajectory": 0.65,
  "inventory.status": 0.6,
  "service.wait": 0.6,
  "access.reservation": 0.55,
  "crowd.mix": 0.4,
  "music.current": 0.3,
  "price.cover": 0.3,
  "access.dress": 0.25,
  "experience.next_move": 0.7,
};
const DEFAULT_IMPORTANCE = 0.5;

export function claimImportance(claimFamily: string): number {
  return CLAIM_IMPORTANCE[claimFamily] ?? DEFAULT_IMPORTANCE;
}

/** Demand saturates at 10 qualified events (the §16 mission-trigger threshold). */
export const DEMAND_SATURATION = 10;

export interface CoverageInputs {
  /** Qualified demand events (searches, saves, Compass candidates, trip plans, questions). */
  demandEvents: number;
  /** True when NO fresh qualifying claim exists for the family. */
  claimMissing: boolean;
  /** Age of the freshest claim as a fraction of its TTL, 0..1 (ignored if missing). */
  freshestAgeRatio?: number;
  /** Current confidence of the family's live state, 0..1 (0 when missing). */
  currentConfidence: number;
  /** Required confidence band for the family, 0..1 (default 0.65). */
  requiredConfidence?: number;
  /** Largest single contributor/venue/cohort share of the evidence, 0..1. */
  topContributorShare: number;
  claimFamily: string;
}

export interface CoverageBreakdown {
  score: number;
  demandWeight: number;
  freshnessGap: number;
  claimImportance: number;
  confidenceGap: number;
  sourceDiversityGap: number;
}

export function demandWeight(demandEvents: number): number {
  return clamp01(demandEvents / DEMAND_SATURATION);
}

export function freshnessGap(claimMissing: boolean, freshestAgeRatio = 0): number {
  return claimMissing ? 1 : clamp01(freshestAgeRatio);
}

export function confidenceGap(currentConfidence: number, requiredConfidence = 0.65): number {
  if (requiredConfidence <= 0) return 0;
  return clamp01((requiredConfidence - currentConfidence) / requiredConfidence);
}

/** Fully dominated by one source → maximal gap; perfectly diverse → 0. */
export function sourceDiversityGap(topContributorShare: number): number {
  return clamp01(topContributorShare);
}

/** Compute the coverage priority for one (zone, claim-family) cell. */
export function computeCoverageScore(input: CoverageInputs): CoverageBreakdown {
  const dw = demandWeight(input.demandEvents);
  const fg = freshnessGap(input.claimMissing, input.freshestAgeRatio);
  const ci = claimImportance(input.claimFamily);
  const cg = confidenceGap(input.currentConfidence, input.requiredConfidence);
  const sdg = sourceDiversityGap(input.topContributorShare);
  return {
    score: clamp01(dw * fg * ci * cg * sdg),
    demandWeight: dw,
    freshnessGap: fg,
    claimImportance: ci,
    confidenceGap: cg,
    sourceDiversityGap: sdg,
  };
}
