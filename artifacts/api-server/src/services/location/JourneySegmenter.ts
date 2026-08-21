/**
 * Deterministic, shadow-only movement/stop/dwell segmentation.
 *
 * PRIVACY BOUNDARY:
 * - Exact coordinates are accepted only as restricted in-memory evidence.
 * - Returned revisions contain no coordinates or observation identifiers.
 * - Revisions are mechanical states, never sensitive place/person inferences.
 * - This module has no Compass, Sense, Autopilot, Outcome, Social, or Graph
 *   imports. Consumers must not be added until a later privacy/quality gate.
 */
import { createHash } from "node:crypto";
import {
  scoreObservationQuality,
  type ObservationQualityResult,
} from "../journey/JourneyObservationQuality.js";

export const JOURNEY_SEGMENT_ALGORITHM_VERSION = "journey-stop-dwell-v1";
export const JOURNEY_SEGMENT_RETENTION_DAYS = 30;

/**
 * Configurable validated thresholds. Defaults preserve original behaviour.
 * Consumers may supply overrides via SegmentJourneyInput.thresholds.
 */
export interface JourneySegmentThresholds {
  candidateMinSeconds: number;
  dwellMinSeconds: number;
  stopRadiusM: number;
  maxAccuracyM: number;
  maxGapSeconds: number;
}

export const JOURNEY_SEGMENT_THRESHOLDS: Readonly<JourneySegmentThresholds> = Object.freeze({
  candidateMinSeconds: 60,
  dwellMinSeconds: 10 * 60,
  stopRadiusM: 60,
  maxAccuracyM: 100,
  maxGapSeconds: 10 * 60,
});

function validateThresholds(
  overrides: Partial<JourneySegmentThresholds> | null | undefined,
): JourneySegmentThresholds {
  const base = { ...JOURNEY_SEGMENT_THRESHOLDS };
  if (!overrides || typeof overrides !== "object") return base;
  const candidate = { ...base };
  if (
    typeof overrides.candidateMinSeconds === "number" &&
    Number.isFinite(overrides.candidateMinSeconds) &&
    overrides.candidateMinSeconds > 0
  ) {
    candidate.candidateMinSeconds = overrides.candidateMinSeconds;
  }
  if (
    typeof overrides.dwellMinSeconds === "number" &&
    Number.isFinite(overrides.dwellMinSeconds) &&
    overrides.dwellMinSeconds > 0
  ) {
    candidate.dwellMinSeconds = overrides.dwellMinSeconds;
  }
  if (
    typeof overrides.stopRadiusM === "number" &&
    Number.isFinite(overrides.stopRadiusM) &&
    overrides.stopRadiusM > 0
  ) {
    candidate.stopRadiusM = overrides.stopRadiusM;
  }
  if (
    typeof overrides.maxAccuracyM === "number" &&
    Number.isFinite(overrides.maxAccuracyM) &&
    overrides.maxAccuracyM > 0
  ) {
    candidate.maxAccuracyM = overrides.maxAccuracyM;
  }
  if (
    typeof overrides.maxGapSeconds === "number" &&
    Number.isFinite(overrides.maxGapSeconds) &&
    overrides.maxGapSeconds > 0
  ) {
    candidate.maxGapSeconds = overrides.maxGapSeconds;
  }
  return candidate;
}

export type JourneySegmentState =
  | "moving"
  | "candidate_stop"
  | "dwelling"
  | "departed"
  | "discarded";

export type JourneyMovementClass =
  | "unknown"
  | "walking"
  | "vehicle"
  | "transit";

export interface JourneyWorldRef {
  countryCode: string | null;
  regionId: string | null;
  cityId: string | null;
  districtId: string | null;
  placeId: string | null;
}

/**
 * Quality fields persisted alongside each restricted observation.
 * The scorer result is attached at normalisation time and re-used
 * throughout the pipeline.
 */
export interface JourneyObservationQualityFields {
  qualityVersion: string;
  qualityScore: number;
  qualityClass: "high" | "usable" | "degraded" | "unusable";
  qualityReasons: string[];
  gpsSegmentable: boolean;
}

export interface RestrictedJourneyObservation {
  /** Used only to deduplicate retries in memory; never copied into a revision. */
  id: string;
  observedAt: string;
  source: "foreground_gps" | "background_gps";
  lat: number;
  lng: number;
  accuracyM: number;
  speedMps?: number | null;
  /**
   * Optional result of a separately approved coarse resolver. The segmenter
   * validates its shape and never derives or stores a precise place itself.
   */
  worldRef?: Partial<JourneyWorldRef> | null;
  /**
   * Pre-scored quality fields. If absent the segmenter will score internally
   * using receivedAt = observedAt (conservative — no staleness penalty).
   */
  quality?: JourneyObservationQualityFields | null;
}

export interface JourneySegmentUncertainty {
  /** Confidence in the mechanical state conclusion, 0..1. */
  score: number;
  tier: "low" | "medium" | "high";
  reasons: string[];
  algorithmVersion: string;
  computedAt: string;
}

export interface JourneySegmentEvidence {
  observationCount: number;
  medianAccuracyM: number | null;
  maxGapSeconds: number | null;
  stopRadiusM: number;
  reasonCodes: string[];
}

/**
 * Arrival/departure uncertainty window in seconds, representing a symmetric
 * ± range around the reported transition timestamp.
 */
export interface JourneyTimingUncertaintyRange {
  /** Estimated seconds the true arrival could differ from startedAt. */
  arrivalUncertaintyS: number | null;
  /** Estimated seconds the true departure could differ from endedAt. */
  departureUncertaintyS: number | null;
}

/** Aggregate quality summary for the observations backing a revision. */
export interface JourneyQualitySummary {
  totalObservations: number;
  usableObservations: number;
  excludedObservations: number;
  medianQualityScore: number | null;
  /** True when all usable evidence came from GPS sources. */
  gpsOnly: boolean;
  /** Scorer version that produced these results. */
  scorerVersion: string;
}

/**
 * Place/category provenance — explicit unknown unless a consistent canonical
 * UUID reference is supplied by enough usable GPS evidence.
 */
export interface JourneyPlaceProvenance {
  /**
   * "resolved" only when at least PLACE_EVIDENCE_MIN_USABLE usable GPS
   * observations independently agree on the same canonical placeId UUID.
   * Otherwise always "unknown".
   */
  placeConfidence: "resolved" | "unknown";
  /** "resolved" only when placeConfidence === "resolved" and category is known. */
  categoryConfidence: "resolved" | "unknown";
  /** Source of provenance. */
  provenance: "world_ref" | "none";
}

export interface JourneySegmentRevision {
  revisionId: string;
  segmentKey: string;
  supersedesRevisionId: string | null;
  revisionIndex: number;
  userId: string;
  locationSessionId: string;
  state: JourneySegmentState;
  startedAt: string;
  endedAt: string | null;
  durationS: number | null;
  worldRef: JourneyWorldRef;
  movementClass: JourneyMovementClass;
  uncertainty: JourneySegmentUncertainty;
  evidence: JourneySegmentEvidence;
  timingUncertainty: JourneyTimingUncertaintyRange;
  qualitySummary: JourneyQualitySummary;
  placeProvenance: JourneyPlaceProvenance;
  algorithmVersion: string;
  expiresAt: string;
}

export interface SegmentJourneyInput {
  userId: string;
  locationSessionId: string;
  observations: RestrictedJourneyObservation[];
  /** If supplied, deterministically closes/discards the open state. */
  sessionEndedAt?: string | null;
  algorithmVersion?: string;
  /**
   * Overrides for thresholds. Any field that is missing or invalid falls back
   * to the corresponding JOURNEY_SEGMENT_THRESHOLDS default.
   */
  thresholds?: Partial<JourneySegmentThresholds> | null;
  /**
   * When supplied, used as the receivedAt time for quality scoring of any
   * observation that does not carry pre-scored quality fields.
   */
  receivedAt?: Date | null;
}

/**
 * Minimum number of usable GPS observations that must independently reference
 * the same canonical placeId UUID before place is reported as "resolved".
 */
const PLACE_EVIDENCE_MIN_USABLE = 3;

interface InternalPoint extends RestrictedJourneyObservation {
  timeMs: number;
  scored: ObservationQualityResult;
}

interface ActiveEvidence {
  points: InternalPoint[];
  anchorLat: number;
  anchorLng: number;
}

const EMPTY_WORLD_REF: JourneyWorldRef = Object.freeze({
  countryCode: null,
  regionId: null,
  cityId: null,
  districtId: null,
  placeId: null,
});

const WORLD_REF_KEYS = new Set<keyof JourneyWorldRef>([
  "countryCode",
  "regionId",
  "cityId",
  "districtId",
  "placeId",
]);

function deterministicUuid(parts: Array<string | number | null>): string {
  const hex = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function haversineM(a: InternalPoint, b: Pick<InternalPoint, "lat" | "lng">): number {
  const radiusM = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return radiusM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function secondsBetween(a: InternalPoint, b: InternalPoint): number {
  return Math.max(0, (b.timeMs - a.timeMs) / 1_000);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function sanitizeWorldRef(input: Partial<JourneyWorldRef> | null | undefined): JourneyWorldRef {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...EMPTY_WORLD_REF };
  for (const key of Object.keys(input)) {
    if (!WORLD_REF_KEYS.has(key as keyof JourneyWorldRef)) return { ...EMPTY_WORLD_REF };
  }
  const value = (key: keyof JourneyWorldRef): string | null => {
    const candidate = input[key];
    if (typeof candidate !== "string") return null;
    const trimmed = candidate.trim();
    if (key === "countryCode") {
      return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
    }
    // Canonical location IDs only. Requiring UUID shape prevents a geohash,
    // coordinate pair, address, or provider payload from being smuggled
    // through an allowed world-reference key.
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)
      ? trimmed
      : null;
  };
  return {
    countryCode: value("countryCode"),
    regionId: value("regionId"),
    cityId: value("cityId"),
    districtId: value("districtId"),
    placeId: value("placeId"),
  };
}

/**
 * Score a raw observation, reusing pre-scored quality if available.
 *
 * When receivedAt is null (batch has no explicit wall-clock reference), each
 * observation is scored as received at its own observedAt time — this means
 * no staleness or future-timestamp penalty is applied, preserving backward
 * compatibility for callers that don't supply a receivedAt.
 */
function scorePoint(
  observation: RestrictedJourneyObservation,
  receivedAt: Date | null,
): ObservationQualityResult {
  if (
    observation.quality &&
    typeof observation.quality.qualityScore === "number" &&
    observation.quality.qualityClass
  ) {
    return {
      version: observation.quality.qualityVersion,
      score: observation.quality.qualityScore,
      qualityClass: observation.quality.qualityClass,
      reasons: [...observation.quality.qualityReasons],
      gpsSegmentable: observation.quality.gpsSegmentable,
    };
  }
  // When receivedAt is not supplied, use the observation's own timestamp so
  // no staleness or future-timestamp deductions apply.
  const effectiveReceivedAt = receivedAt ?? new Date(Date.parse(observation.observedAt));
  return scoreObservationQuality(
    {
      observedAt: observation.observedAt,
      source: observation.source,
      accuracyM: observation.accuracyM,
      speedMps: observation.speedMps ?? null,
    },
    effectiveReceivedAt,
  );
}

interface NormalizeResult {
  points: InternalPoint[];
  /** Count of unique (deduplicated) observations that passed basic validity checks. */
  totalUniqueObservations: number;
}

/**
 * Normalise, deduplicate, and sort observations — then filter out any that
 * are unusable or stale (GPS-unsegmentable). Each surviving point carries
 * its quality score for downstream use.
 *
 * receivedAt may be null when the caller has no wall-clock reference; in that
 * case each observation is scored against its own timestamp (no staleness
 * penalty), preserving backward compatibility.
 */
function normalizedPoints(
  observations: RestrictedJourneyObservation[],
  receivedAt: Date | null,
  thresholds: JourneySegmentThresholds,
): NormalizeResult {
  const validById = new Map<string, { observation: RestrictedJourneyObservation; timeMs: number }>();
  for (const observation of observations) {
    const timeMs = Date.parse(observation.observedAt);
    if (
      !observation.id ||
      !Number.isFinite(timeMs) ||
      !Number.isFinite(observation.lat) ||
      !Number.isFinite(observation.lng) ||
      observation.lat < -90 ||
      observation.lat > 90 ||
      observation.lng < -180 ||
      observation.lng > 180 ||
      !Number.isFinite(observation.accuracyM) ||
      observation.accuracyM <= 0
    ) {
      continue;
    }
    if (!validById.has(observation.id)) {
      validById.set(observation.id, { observation, timeMs });
    }
  }

  const totalUniqueObservations = validById.size;

  const points: InternalPoint[] = [];
  for (const { observation, timeMs } of validById.values()) {
    const scored = scorePoint(observation, receivedAt);
    // Filter: unusable or not GPS-segmentable observations are excluded before
    // any segmentation begins.
    if (!scored.gpsSegmentable) continue;
    points.push({ ...observation, timeMs, scored });
  }
  points.sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));

  return { points, totalUniqueObservations };
}

/**
 * Deterministic centroid smoothing over a cluster of reliable GPS points.
 * Returns the arithmetic mean lat/lng of reliable points (accuracyM <= threshold).
 */
function smoothedCentroid(
  points: InternalPoint[],
  maxAccuracyM: number,
): { lat: number; lng: number } | null {
  const reliable = points.filter((p) => p.accuracyM <= maxAccuracyM);
  if (reliable.length === 0) return null;
  const lat = reliable.reduce((s, p) => s + p.lat, 0) / reliable.length;
  const lng = reliable.reduce((s, p) => s + p.lng, 0) / reliable.length;
  return { lat, lng };
}

function evidenceFor(
  points: InternalPoint[],
  reasonCodes: string[],
  thresholds: JourneySegmentThresholds,
): JourneySegmentEvidence {
  let maxGapSeconds: number | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const gap = secondsBetween(points[index - 1]!, points[index]!);
    maxGapSeconds = Math.max(maxGapSeconds ?? 0, gap);
  }
  return {
    observationCount: points.length,
    medianAccuracyM: median(points.map((point) => point.accuracyM)),
    maxGapSeconds,
    stopRadiusM: thresholds.stopRadiusM,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}

function uncertaintyFor(
  evidence: JourneySegmentEvidence,
  state: JourneySegmentState,
  computedAt: string,
  algorithmVersion: string,
  thresholds: JourneySegmentThresholds,
): JourneySegmentUncertainty {
  const reasons = [...evidence.reasonCodes];
  let score = 0.25;

  if (evidence.observationCount >= 5) {
    score += 0.25;
    reasons.push("enough_samples");
  } else if (evidence.observationCount >= 2) {
    score += 0.12;
    reasons.push("limited_samples");
  } else {
    reasons.push("single_sample");
  }

  if (evidence.medianAccuracyM != null && evidence.medianAccuracyM <= 30) {
    score += 0.25;
    reasons.push("good_accuracy");
  } else if (
    evidence.medianAccuracyM != null &&
    evidence.medianAccuracyM <= thresholds.maxAccuracyM
  ) {
    score += 0.12;
    reasons.push("moderate_accuracy");
  } else {
    reasons.push("low_accuracy");
  }

  if (
    evidence.maxGapSeconds == null ||
    evidence.maxGapSeconds <= thresholds.maxGapSeconds / 2
  ) {
    score += 0.2;
    reasons.push("continuous_sampling");
  } else {
    reasons.push("sparse_sampling");
  }

  if (state === "discarded") {
    score = Math.min(score, 0.35);
    reasons.push("discarded_evidence");
  } else if (state === "candidate_stop") {
    score = Math.min(score, 0.69);
    reasons.push("candidate_not_confirmed");
  }

  const bounded = Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
  return {
    score: bounded,
    tier: bounded >= 0.75 ? "high" : bounded >= 0.45 ? "medium" : "low",
    reasons: [...new Set(reasons)].sort(),
    algorithmVersion,
    computedAt,
  };
}

/**
 * Compute arrival/departure uncertainty window from the sampling density
 * and accuracy of evidence points around the transition boundary.
 *
 * The range is the larger of half the max observed gap and the median accuracy
 * in seconds (accuracy-as-time proxy: accuracy in metres / 1 m/s walking).
 *
 * departureUncertaintyS is only set when the segment has an endedAt (i.e. the
 * departure has actually been observed). Open revisions get null.
 */
function timingUncertaintyFor(
  points: InternalPoint[],
  state: JourneySegmentState,
  endedAt: string | null,
  thresholds: JourneySegmentThresholds,
): JourneyTimingUncertaintyRange {
  if (points.length === 0) {
    return { arrivalUncertaintyS: null, departureUncertaintyS: null };
  }

  let maxGapS = 0;
  for (let i = 1; i < points.length; i += 1) {
    const gap = secondsBetween(points[i - 1]!, points[i]!);
    if (gap > maxGapS) maxGapS = gap;
  }

  const medAcc = median(points.map((p) => p.accuracyM)) ?? thresholds.maxAccuracyM;
  // Combine gap-based and accuracy-based uncertainty
  const baseUncertaintyS = Math.round(Math.max(maxGapS / 2, Math.min(medAcc, 60)));

  // departureUncertaintyS only applies when a departure has been recorded
  const hasDeparture = endedAt != null;

  return {
    arrivalUncertaintyS: baseUncertaintyS,
    departureUncertaintyS: hasDeparture ? baseUncertaintyS : null,
  };
}

/**
 * Build quality summary using session-level counters.
 *
 * - totalUniqueObservations: unique valid observations after dedup, before quality filter.
 * - sessionUsableCount: all points that passed quality filtering for this session.
 * - evidencePoints: points belonging to this specific revision's evidence window
 *   (used for medianQualityScore and gpsOnly).
 *
 * usableObservations and excludedObservations are session-level so the counts
 * are consistent across every revision in the same run, regardless of how many
 * points happen to be in a revision's local evidence window.
 */
function qualitySummaryFor(
  evidencePoints: InternalPoint[],
  totalUniqueObservations: number,
  sessionUsableCount: number,
  scorerVersion: string,
): JourneyQualitySummary {
  const excludedObservations = Math.max(0, totalUniqueObservations - sessionUsableCount);
  const qualityScores = evidencePoints.map((p) => p.scored.score);
  const medianQualityScore = median(qualityScores);
  const gpsOnly = evidencePoints.every(
    (p) =>
      p.source === "foreground_gps" || p.source === "background_gps",
  );
  return {
    totalObservations: totalUniqueObservations,
    usableObservations: sessionUsableCount,
    excludedObservations,
    medianQualityScore,
    gpsOnly,
    scorerVersion,
  };
}

/**
 * Resolve place/category provenance from the evidence points.
 *
 * Place is "resolved" only when PLACE_EVIDENCE_MIN_USABLE or more usable GPS
 * observations independently reference the same canonical placeId UUID.
 * Otherwise both place and category remain "unknown".
 * Never infers from coordinates.
 */
function placeProvenanceFor(points: InternalPoint[]): JourneyPlaceProvenance {
  const placeIdCounts = new Map<string, number>();

  for (const point of points) {
    if (!point.scored.gpsSegmentable) continue;
    const worldRef = sanitizeWorldRef(point.worldRef);
    if (worldRef.placeId) {
      placeIdCounts.set(worldRef.placeId, (placeIdCounts.get(worldRef.placeId) ?? 0) + 1);
    }
  }

  // Find a placeId that meets the evidence threshold
  let resolvedPlaceId: string | null = null;
  for (const [placeId, count] of placeIdCounts) {
    if (count >= PLACE_EVIDENCE_MIN_USABLE) {
      resolvedPlaceId = placeId;
      break;
    }
  }

  if (!resolvedPlaceId) {
    return {
      placeConfidence: "unknown",
      categoryConfidence: "unknown",
      provenance: "none",
    };
  }

  // Category: check if any of those points also carries a districtId/cityId
  // that corroborates category — we don't infer category from coords, only
  // from explicit canonical world refs.
  const consistentCategory = points.some(
    (p) => {
      if (!p.scored.gpsSegmentable) return false;
      const worldRef = sanitizeWorldRef(p.worldRef);
      return worldRef.placeId === resolvedPlaceId && (worldRef.districtId !== null || worldRef.cityId !== null);
    },
  );

  return {
    placeConfidence: "resolved",
    categoryConfidence: consistentCategory ? "resolved" : "unknown",
    provenance: "world_ref",
  };
}

function movementClassFor(points: InternalPoint[]): JourneyMovementClass {
  const measuredSpeeds: number[] = [];
  for (const point of points) {
    if (point.speedMps != null && Number.isFinite(point.speedMps) && point.speedMps >= 0) {
      measuredSpeeds.push(point.speedMps);
    }
  }
  if (measuredSpeeds.length === 0) {
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]!;
      const current = points[index]!;
      const elapsed = secondsBetween(previous, current);
      if (elapsed > 0) measuredSpeeds.push(haversineM(previous, current) / elapsed);
    }
  }
  const speed = median(measuredSpeeds);
  if (speed == null || speed < 0.5) return "unknown";
  if (speed < 3) return "walking";
  if (speed < 12) return "vehicle";
  return "transit";
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 24 * 60 * 60 * 1_000).toISOString();
}

/**
 * Pure deterministic segmenter. Sorting, deduplication, IDs, uncertainty, and
 * expiry all derive from the supplied observations/session boundary.
 *
 * Unusable/stale observations (as classified by JourneyObservationQuality) are
 * filtered before any segmentation begins and are never used as evidence.
 */
export function segmentJourney(input: SegmentJourneyInput): JourneySegmentRevision[] {
  const algorithmVersion = input.algorithmVersion ?? JOURNEY_SEGMENT_ALGORITHM_VERSION;
  const thresholds = validateThresholds(input.thresholds);

  // receivedAt is used for staleness/future-timestamp scoring. When not
  // explicitly supplied, each observation is scored as received at its own
  // observedAt time (no staleness penalty within a self-consistent batch).
  // Callers that have a real wall-clock receivedAt should always pass it.
  const explicitReceivedAt = input.receivedAt instanceof Date ? input.receivedAt : null;

  const { points, totalUniqueObservations } = normalizedPoints(
    input.observations,
    explicitReceivedAt,
    thresholds,
  );
  if (points.length === 0) return [];

  // Scorer version from the first scored point (or fallback)
  const scorerVersion =
    points[0]?.scored.version ?? "journey-quality-scorer-v1";

  // Place/category provenance is evaluated once over ALL session-level usable
  // points rather than per-revision evidence windows. This is correct because
  // the place evidence question is "did enough GPS observations in this session
  // corroborate the same canonical place?" — not "did the evidence window for
  // this revision alone reach threshold?".
  const sessionPlaceProvenance = placeProvenanceFor(points);

  const revisions: JourneySegmentRevision[] = [];
  let segmentOrdinal = 0;
  let revisionIndex = 0;
  let segmentKey = deterministicUuid([
    input.userId,
    input.locationSessionId,
    algorithmVersion,
    segmentOrdinal,
  ]);
  let priorRevisionId: string | null = null;
  const state: { current: JourneySegmentState } = { current: "moving" };
  let movingPoints: InternalPoint[] = [points[0]!];
  let active: ActiveEvidence | null = null;

  const append = (
    nextState: JourneySegmentState,
    evidencePoints: InternalPoint[],
    startedAt: string,
    endedAt: string | null,
    reasonCodes: string[],
  ): void => {
    const computedAt = endedAt ?? evidencePoints.at(-1)?.observedAt ?? startedAt;
    const evidence = evidenceFor(evidencePoints, reasonCodes, thresholds);
    const durationS = endedAt == null
      ? null
      : Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1_000));
    const revisionId = deterministicUuid([
      segmentKey,
      algorithmVersion,
      revisionIndex,
      nextState,
      startedAt,
      endedAt,
    ]);
    revisions.push({
      revisionId,
      segmentKey,
      supersedesRevisionId: priorRevisionId,
      revisionIndex,
      userId: input.userId,
      locationSessionId: input.locationSessionId,
      state: nextState,
      startedAt,
      endedAt,
      durationS,
      worldRef: sanitizeWorldRef(
        [...evidencePoints].reverse().find((point) => point.worldRef)?.worldRef,
      ),
      movementClass: movementClassFor(evidencePoints),
      uncertainty: uncertaintyFor(evidence, nextState, computedAt, algorithmVersion, thresholds),
      evidence,
      timingUncertainty: timingUncertaintyFor(evidencePoints, nextState, endedAt, thresholds),
      qualitySummary: qualitySummaryFor(evidencePoints, totalUniqueObservations, points.length, scorerVersion),
      placeProvenance: sessionPlaceProvenance,
      algorithmVersion,
      expiresAt: addDays(computedAt, JOURNEY_SEGMENT_RETENTION_DAYS),
    });
    state.current = nextState;
    priorRevisionId = revisionId;
    revisionIndex += 1;
  };

  const beginMovingSegment = (point: InternalPoint): void => {
    segmentOrdinal += 1;
    revisionIndex = 0;
    segmentKey = deterministicUuid([
      input.userId,
      input.locationSessionId,
      algorithmVersion,
      segmentOrdinal,
    ]);
    priorRevisionId = null;
    active = null;
    movingPoints = [point];
    append("moving", movingPoints, point.observedAt, null, ["movement_observed"]);
  };

  append("moving", movingPoints, points[0]!.observedAt, null, ["movement_observed"]);

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const gapSeconds = secondsBetween(previous, point);
    const reliable = point.accuracyM <= thresholds.maxAccuracyM;

    if (gapSeconds > thresholds.maxGapSeconds) {
      const evidencePoints = active?.points ?? movingPoints;
      if (state.current === "dwelling") {
        append(
          "dwelling",
          evidencePoints,
          evidencePoints[0]!.observedAt,
          previous.observedAt,
          ["long_gap", "dwell_closed_before_gap"],
        );
      } else {
        append(
          "discarded",
          evidencePoints,
          evidencePoints[0]!.observedAt,
          previous.observedAt,
          ["long_gap", "insufficient_continuity"],
        );
      }
      beginMovingSegment(point);
      continue;
    }

    if (!reliable) {
      if (active) {
        active.points.push(point);
      } else {
        movingPoints.push(point);
      }
      continue;
    }

    if (active) {
      const distanceFromAnchor = haversineM(point, {
        lat: active.anchorLat,
        lng: active.anchorLng,
      });
      const departureRadius =
        thresholds.stopRadiusM +
        Math.min(point.accuracyM, thresholds.maxAccuracyM);

      if (distanceFromAnchor <= departureRadius) {
        active.points.push(point);
        const reliablePoints = active.points.filter(
          (candidate) => candidate.accuracyM <= thresholds.maxAccuracyM,
        );
        // Deterministic centroid smoothing
        const centroid = smoothedCentroid(reliablePoints, thresholds.maxAccuracyM);
        if (centroid) {
          active.anchorLat = centroid.lat;
          active.anchorLng = centroid.lng;
        }
        const stationarySeconds =
          (point.timeMs - active.points[0]!.timeMs) / 1_000;
        if (
          state.current === "candidate_stop" &&
          stationarySeconds >= thresholds.dwellMinSeconds &&
          reliablePoints.length >= 4
        ) {
          append(
            "dwelling",
            active.points,
            active.points[0]!.observedAt,
            null,
            ["within_stop_radius", "dwell_threshold_met"],
          );
        }
        continue;
      }

      active.points.push(point);
      if (state.current === "dwelling") {
        append(
          "departed",
          active.points,
          active.points[0]!.observedAt,
          point.observedAt,
          ["outside_departure_radius", "confirmed_dwell_departure"],
        );
      } else {
        append(
          "discarded",
          active.points,
          active.points[0]!.observedAt,
          point.observedAt,
          ["short_pause", "outside_departure_radius"],
        );
      }
      beginMovingSegment(point);
      continue;
    }

    movingPoints.push(point);
    const previousReliable = [...movingPoints]
      .slice(0, -1)
      .reverse()
      .find((candidate) => candidate.accuracyM <= thresholds.maxAccuracyM);
    if (!previousReliable) continue;

    const stationaryDistance = haversineM(previousReliable, point);
    const stationarySeconds = secondsBetween(previousReliable, point);
    const stationaryRadius =
      thresholds.stopRadiusM +
      Math.min(
        Math.max(previousReliable.accuracyM, point.accuracyM),
        thresholds.maxAccuracyM,
      );

    if (
      stationaryDistance <= stationaryRadius &&
      stationarySeconds >= thresholds.candidateMinSeconds
    ) {
      active = {
        points: [previousReliable, point],
        anchorLat: (previousReliable.lat + point.lat) / 2,
        anchorLng: (previousReliable.lng + point.lng) / 2,
      };
      append(
        "candidate_stop",
        active.points,
        previousReliable.observedAt,
        null,
        ["within_stop_radius", "candidate_threshold_met"],
      );
    }
  }

  if (input.sessionEndedAt) {
    const sessionEndMs = Date.parse(input.sessionEndedAt);
    const lastPoint = points.at(-1)!;
    const safeEndedAt =
      Number.isFinite(sessionEndMs) && sessionEndMs >= lastPoint.timeMs
        ? new Date(sessionEndMs).toISOString()
        : lastPoint.observedAt;
    const evidencePoints = active?.points ?? movingPoints;
    if (state.current === "candidate_stop") {
      append(
        "discarded",
        evidencePoints,
        evidencePoints[0]!.observedAt,
        safeEndedAt,
        ["session_ended", "candidate_not_confirmed"],
      );
    } else {
      append(
        state.current,
        evidencePoints,
        evidencePoints[0]!.observedAt,
        safeEndedAt,
        ["session_ended", "segment_closed"],
      );
    }
  }

  return revisions;
}
