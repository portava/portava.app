/**
 * Pure, versioned observation quality scorer for Journey observations.
 *
 * PRIVACY BOUNDARY:
 * - Accepts only the fields needed for mechanical quality assessment.
 * - Returns no coordinates, IDs, or user-identifiable data.
 * - All scoring is deterministic given the same inputs.
 */

export const OBSERVATION_QUALITY_SCORER_VERSION = "journey-observation-quality-v1";

/** Penalty thresholds */
const STALE_HARD_LIMIT_MS = 10 * 60 * 1_000;   // 10 minutes -> unusable
const FUTURE_SOFT_LIMIT_MS = 0;                  // any future -> deduction
const FUTURE_HARD_LIMIT_MS = 5 * 60 * 1_000;    // 5 min future -> unusable
const ACCURACY_HARD_LIMIT_M = 100;               // > 100 m -> unusable
const IMPOSSIBLE_SPEED_MPS = 340;                // > 340 m/s (> ~1224 km/h) -> unusable

export type ObservationQualityClass = "high" | "usable" | "degraded" | "unusable";

/** Minimal shape accepted by the scorer; mirrors the GPS branch of JourneyObservationInput. */
export interface ObservationQualityInput {
  observedAt: string;
  source: "foreground_gps" | "background_gps" | "plan_checkin" | "manual";
  /** Only present for GPS sources. */
  accuracyM?: number | null;
  /** Only present for GPS sources. */
  speedMps?: number | null;
}

export interface ObservationQualityResult {
  /** Scorer version for revision tracking. */
  version: string;
  /** 0..1 quality score; higher is better. */
  score: number;
  /** Semantic class derived from score and hard limits. */
  qualityClass: ObservationQualityClass;
  /** Sorted, stable reason codes explaining the score. */
  reasons: string[];
  /**
   * Whether this observation is GPS-segmentable. Manual/coarse sources and
   * any unusable observation may never enter GPS segmentation.
   */
  gpsSegmentable: boolean;
}

function clampScore(raw: number): number {
  return Math.round(Math.max(0, Math.min(1, raw)) * 1_000) / 1_000;
}

function qualityClassFor(score: number, hardUnusable: boolean): ObservationQualityClass {
  if (hardUnusable || score < 0.25) return "unusable";
  if (score < 0.5) return "degraded";
  if (score < 0.8) return "usable";
  return "high";
}

/**
 * Score a single observation deterministically.
 *
 * Hard-unusable conditions:
 * - Age > 10 minutes (stale)
 * - Future timestamp > 5 minutes
 * - accuracyM > 100 m (GPS sources)
 * - speedMps > 340 m/s (impossible speed)
 *
 * Coarse/manual sources (plan_checkin, manual) can produce a score but are
 * never GPS-segmentable.
 */
export function scoreObservationQuality(
  input: ObservationQualityInput,
  receivedAt: Date,
): ObservationQualityResult {
  const reasons: string[] = [];
  let score = 1.0;
  let hardUnusable = false;

  const observedMs = Date.parse(input.observedAt);
  const receivedMs = receivedAt.getTime();

  // ── Timestamp validity ──────────────────────────────────────────────────────
  if (!Number.isFinite(observedMs)) {
    reasons.push("invalid_timestamp");
    hardUnusable = true;
    score = 0;
  } else {
    const ageMs = receivedMs - observedMs;
    const futureMs = observedMs - receivedMs; // positive when observation is in the future

    if (futureMs > FUTURE_HARD_LIMIT_MS) {
      // More than 5 min in the future — hard unusable
      reasons.push("future_timestamp");
      hardUnusable = true;
      score = 0;
    } else if (futureMs > FUTURE_SOFT_LIMIT_MS) {
      // Mildly future (clock skew)
      reasons.push("slight_future_timestamp");
      score -= 0.15;
    } else if (ageMs > STALE_HARD_LIMIT_MS) {
      // Older than 10 minutes — hard unusable
      reasons.push("stale");
      hardUnusable = true;
      score = 0;
    } else if (ageMs > 5 * 60 * 1_000) {
      // 5–10 min old — significant penalty
      reasons.push("aging");
      score -= 0.3;
    } else if (ageMs > 2 * 60 * 1_000) {
      // 2–5 min old — mild penalty
      reasons.push("slightly_aged");
      score -= 0.1;
    }
  }

  // ── Source classification ────────────────────────────────────────────────────
  const isGpsSource =
    input.source === "foreground_gps" || input.source === "background_gps";
  const isCoarseSource =
    input.source === "plan_checkin" || input.source === "manual";

  if (input.source === "foreground_gps") {
    // Foreground GPS: no source penalty
    reasons.push("source_foreground_gps");
  } else if (input.source === "background_gps") {
    reasons.push("source_background_gps");
    score -= 0.05;
  } else if (input.source === "plan_checkin") {
    reasons.push("source_coarse_checkin");
    score -= 0.2;
  } else if (input.source === "manual") {
    reasons.push("source_manual");
    score -= 0.3;
  }

  // ── GPS-specific checks ──────────────────────────────────────────────────────
  if (isGpsSource && !hardUnusable) {
    const accuracyM = input.accuracyM;

    if (accuracyM == null || !Number.isFinite(accuracyM) || accuracyM <= 0) {
      reasons.push("missing_accuracy");
      score -= 0.2;
    } else if (accuracyM > ACCURACY_HARD_LIMIT_M) {
      reasons.push("poor_accuracy");
      hardUnusable = true;
      score = 0;
    } else if (accuracyM > 50) {
      reasons.push("moderate_accuracy");
      score -= 0.15;
    } else if (accuracyM > 20) {
      reasons.push("acceptable_accuracy");
      score -= 0.05;
    } else {
      reasons.push("good_accuracy");
    }

    const speedMps = input.speedMps;
    if (speedMps == null) {
      reasons.push("missing_speed");
      score -= 0.05;
    } else if (!Number.isFinite(speedMps) || speedMps < 0) {
      reasons.push("invalid_speed");
      score -= 0.1;
    } else if (speedMps > IMPOSSIBLE_SPEED_MPS) {
      reasons.push("impossible_speed");
      hardUnusable = true;
      score = 0;
    }
  }

  const finalScore = clampScore(hardUnusable ? 0 : score);
  const qualityClass = qualityClassFor(finalScore, hardUnusable);

  // GPS-segmentable only if GPS source AND not unusable
  const gpsSegmentable = isGpsSource && qualityClass !== "unusable" && !isCoarseSource;

  return {
    version: OBSERVATION_QUALITY_SCORER_VERSION,
    score: finalScore,
    qualityClass,
    reasons: [...new Set(reasons)].sort(),
    gpsSegmentable,
  };
}
