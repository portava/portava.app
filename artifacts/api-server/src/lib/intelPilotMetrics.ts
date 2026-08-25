/**
 * Intelligence Gathering — pilot metrics (IG-09, spec §26 density gate).
 *
 * The two non-trivial density-gate inputs, computed from shadow-test data:
 *   • crowd-state calibration accuracy — directional/ordinal, not exact-match
 *   • expiry correctness — the share of Live labels that were NOT shown stale
 * Plus a thin assembler that shapes raw counts into PilotDensityMetrics. Pure.
 *
 * RUNTIME EFFECT: NONE on its own.
 */
import type { PilotDensityMetrics } from "./intelLiveScope.js";

/** Ordinal crowd scale (spec §Appendix) — calibration is judged by ordinal distance. */
export const CROWD_ORDER = ["dead", "quiet", "moderate", "busy", "packed"] as const;
export type CrowdOrdinal = (typeof CROWD_ORDER)[number];

export interface CalibrationPair {
  predicted: string; // the shadow projection's crowd level
  actual: string;    // the manual after-proof
}

/**
 * Directional/ordinal accuracy: a prediction counts as correct when it lands
 * within `tolerance` ordinal steps of the after-proof (default 1 step — the
 * spec asks for "directional/ordinal accuracy", not exact-bucket match). Pairs
 * whose labels are off the ordinal scale are counted as incorrect (fail-closed).
 * Returns 1.0 for an empty set — no evidence of miscalibration is not the same
 * as passing the gate, which also requires the count-based thresholds.
 */
export function computeCrowdCalibrationAccuracy(pairs: readonly CalibrationPair[], tolerance = 1): number {
  if (pairs.length === 0) return 1;
  let correct = 0;
  for (const p of pairs) {
    const pi = CROWD_ORDER.indexOf(p.predicted as CrowdOrdinal);
    const ai = CROWD_ORDER.indexOf(p.actual as CrowdOrdinal);
    if (pi < 0 || ai < 0) continue; // off-scale → not correct
    if (Math.abs(pi - ai) <= tolerance) correct++;
  }
  return correct / pairs.length;
}

export interface LiveLabelExpirySample {
  shownAfterExpiry: boolean; // a Live label rendered past its valid_until + SLA
}

/** Share of Live labels that were NOT shown stale. 1.0 when there were none. */
export function computeExpiryCorrectness(samples: readonly LiveLabelExpirySample[]): number {
  if (samples.length === 0) return 1;
  const stale = samples.filter((s) => s.shownAfterExpiry).length;
  return (samples.length - stale) / samples.length;
}

export interface RawPilotCounts {
  activeReliableContributorsCitywide: number;
  contributorsPerCluster: readonly number[];        // one count per key cluster
  qualifyingWeeklyObservations: number;
  independentSourcesPerKeyVenueNight: readonly number[]; // one count per key venue/night
  outcomeConfirmations: number;
  calibrationPairs: readonly CalibrationPair[];
  expirySamples: readonly LiveLabelExpirySample[];
  criticalPrivacyIncidents: number;
}

/** Shape raw pilot counts into the density-gate metrics (weakest-link on clusters). */
export function assemblePilotMetrics(raw: RawPilotCounts): PilotDensityMetrics {
  return {
    activeReliableContributorsCitywide: raw.activeReliableContributorsCitywide,
    minContributorsPerCluster: raw.contributorsPerCluster.length ? Math.min(...raw.contributorsPerCluster) : 0,
    qualifyingWeeklyObservations: raw.qualifyingWeeklyObservations,
    minIndependentSourcesPerKeyVenueNight: raw.independentSourcesPerKeyVenueNight.length ? Math.min(...raw.independentSourcesPerKeyVenueNight) : 0,
    outcomeConfirmations: raw.outcomeConfirmations,
    crowdCalibrationAccuracy: computeCrowdCalibrationAccuracy(raw.calibrationPairs),
    expiryCorrectness: computeExpiryCorrectness(raw.expirySamples),
    criticalPrivacyIncidents: raw.criticalPrivacyIncidents,
  };
}
