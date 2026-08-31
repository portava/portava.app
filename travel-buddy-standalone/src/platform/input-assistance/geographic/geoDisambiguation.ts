/**
 * Global Input Intelligence — Phase 2 (Geographic Core): §19 progressive
 * disambiguation for geographic selections.
 *
 * "Ambiguity must result in clarification choices, not silent guesses." (§19)
 *
 *   HIGH confidence   → direct entity suggestion (safe to bind/auto-fill)
 *   MEDIUM confidence → multiple ranked choices (show the DisambiguationSheet)
 *   LOW confidence    → raw search stays prominent (offer, never auto-replace)
 *   VERY LOW          → do not auto-replace at all
 *
 * This module turns a ranked candidate list (e.g. Paris, France · Paris, Texas ·
 * Paris saved collection) into the tier that decides which §27 affordance the
 * SmartInput shows. Pure — no React — so the policy is unit-testable.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';

export type GeoConfidenceTier = 'high' | 'medium' | 'low' | 'very_low';

export interface GeoDisambiguation {
  tier: GeoConfidenceTier;
  /** The top candidate, or null when there are none. */
  top: InputSuggestion | null;
  /** Candidates sorted by confidence, highest first. */
  candidates: InputSuggestion[];
  /** True only for the HIGH tier — the one case a caller may auto-bind (§19). */
  autoSelect: boolean;
}

export interface GeoDisambiguationThresholds {
  /** Top confidence to treat a lone/clear winner as HIGH. */
  high: number;
  /** Top confidence floor for MEDIUM (multiple viable choices). */
  medium: number;
  /** Below this the top is too weak to auto-replace anything (VERY LOW). */
  veryLowFloor: number;
  /** Minimum lead over the runner-up for a HIGH direct suggestion. */
  margin: number;
}

export const DEFAULT_GEO_THRESHOLDS: GeoDisambiguationThresholds = {
  high: 0.85,
  medium: 0.5,
  veryLowFloor: 0.3,
  margin: 0.2,
};

function conf(s: InputSuggestion): number {
  return typeof s.confidence === 'number' && Number.isFinite(s.confidence) ? s.confidence : 0;
}

/**
 * Classify a ranked candidate list into a §19 confidence tier.
 *
 * Rules (with the default thresholds):
 *   - no candidates                                   → very_low
 *   - top < veryLowFloor                              → very_low (never auto-replace)
 *   - top ≥ high AND (only one OR lead ≥ margin)      → high  (direct, autoSelect)
 *   - ≥2 candidates AND top ≥ medium                  → medium (disambiguate)
 *   - otherwise                                       → low   (offer, keep raw)
 */
export function classifyGeoDisambiguation(
  candidates: InputSuggestion[],
  thresholds: GeoDisambiguationThresholds = DEFAULT_GEO_THRESHOLDS,
): GeoDisambiguation {
  const sorted = [...candidates].sort((a, b) => conf(b) - conf(a));
  if (sorted.length === 0) {
    return { tier: 'very_low', top: null, candidates: sorted, autoSelect: false };
  }

  const top = sorted[0];
  const topConf = conf(top);
  const runnerUp = sorted.length > 1 ? conf(sorted[1]) : 0;
  const lead = topConf - runnerUp;

  let tier: GeoConfidenceTier;
  if (topConf < thresholds.veryLowFloor) {
    tier = 'very_low';
  } else if (topConf >= thresholds.high && (sorted.length === 1 || lead >= thresholds.margin)) {
    tier = 'high';
  } else if (sorted.length >= 2 && topConf >= thresholds.medium) {
    tier = 'medium';
  } else {
    tier = 'low';
  }

  return { tier, top, candidates: sorted, autoSelect: tier === 'high' };
}
