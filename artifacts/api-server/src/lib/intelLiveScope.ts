/**
 * Intelligence Gathering — Limited-Live gating (IG-09, spec §26 cold-start /
 * density gate, §26 "global emergency switch").
 *
 * "Expose Live labels only after calibration and minimum density gates pass."
 * This module is the PROMOTION CRITERION: a pure evaluation of whether a pilot
 * scope (city × zone × claim family × cohort) has earned public Live labels.
 * Promotion is a human-review decision (spec §24 "model/threshold promotion
 * requires human review") — an operator evaluates the gate and, only when it is
 * met, flips the `intel_limited_live` capability flag for that scope. The read
 * path (lib/liveClaimRead.ts) then honors that flag plus the emergency stop.
 *
 * RUNTIME EFFECT: NONE on its own — pure declarations + pure functions.
 */

// ── §26 Density gate v1 (minimums before public Live) ─────────────────────────
export const DENSITY_GATE_V1 = {
  activeReliableContributorsCitywide: 20,     // "20 citywide"
  activeReliableContributorsPerCluster: 3,    // "≥3 per key cluster"
  qualifyingWeeklyObservations: 250,          // "250 across pilot zones"
  independentSourcesPerKeyVenueNight: 3,      // "3 when showing consensus"
  outcomeConfirmations: 100,                  // "100 pilot total"
  crowdCalibrationAccuracy: 0.75,             // "≥75% directional/ordinal accuracy"
  expiryCorrectness: 0.999,                   // "≥99.9% no stale Live labels beyond SLA"
  maxCriticalPrivacyIncidents: 0,             // "0 critical"
} as const;

export interface PilotDensityMetrics {
  activeReliableContributorsCitywide: number;
  minContributorsPerCluster: number;           // the WEAKEST key cluster's count
  qualifyingWeeklyObservations: number;
  minIndependentSourcesPerKeyVenueNight: number; // the WEAKEST key venue/night
  outcomeConfirmations: number;
  crowdCalibrationAccuracy: number;            // 0..1
  expiryCorrectness: number;                   // 0..1
  criticalPrivacyIncidents: number;
}

export interface DensityGateResult {
  met: boolean;
  failures: string[]; // the specific thresholds not yet cleared
}

/** Evaluate every density-gate threshold; a scope is eligible only if all pass. */
export function evaluateDensityGate(m: PilotDensityMetrics): DensityGateResult {
  const failures: string[] = [];
  const g = DENSITY_GATE_V1;
  if (m.activeReliableContributorsCitywide < g.activeReliableContributorsCitywide) failures.push("contributors_citywide");
  if (m.minContributorsPerCluster < g.activeReliableContributorsPerCluster) failures.push("contributors_per_cluster");
  if (m.qualifyingWeeklyObservations < g.qualifyingWeeklyObservations) failures.push("weekly_observations");
  if (m.minIndependentSourcesPerKeyVenueNight < g.independentSourcesPerKeyVenueNight) failures.push("independent_sources");
  if (m.outcomeConfirmations < g.outcomeConfirmations) failures.push("outcome_confirmations");
  if (m.crowdCalibrationAccuracy < g.crowdCalibrationAccuracy) failures.push("calibration_accuracy");
  if (m.expiryCorrectness < g.expiryCorrectness) failures.push("expiry_correctness");
  if (m.criticalPrivacyIncidents > g.maxCriticalPrivacyIncidents) failures.push("privacy_incidents");
  return { met: failures.length === 0, failures };
}

export function densityGateMet(m: PilotDensityMetrics): boolean {
  return evaluateDensityGate(m).met;
}

// ── Live scope (spec §26 "per environment, city, zone, claim family and cohort")─
export interface LiveScope {
  city: string;
  zone: string | null;
  claimFamily: string;
  cohort?: string | null;
}

export function scopeKey(s: LiveScope): string {
  return JSON.stringify([s.city, s.zone ?? "", s.claimFamily, s.cohort ?? ""]);
}

/**
 * The full promotion decision: expose Live for a scope ONLY when the pilot is
 * enabled for it, the emergency stop is clear, and the density gate is met.
 * Fail-closed on every axis.
 */
export function mayExposeLive(
  m: PilotDensityMetrics,
  opts: { pilotEnabled: boolean; emergencyStopEngaged: boolean },
): boolean {
  if (opts.emergencyStopEngaged) return false; // global kill wins
  if (!opts.pilotEnabled) return false;        // scope not promoted
  return densityGateMet(m);
}
