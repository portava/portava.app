import type {
  JourneySegmentRevision,
  JourneySegmentState,
} from "./JourneySegmenter.js";

// ── Input types ──────────────────────────────────────────────────────────────

export interface JourneyShadowCase {
  condition: string;
  expectedStop: boolean;
  expectedDwell: boolean;
  revisions: JourneySegmentRevision[];
}

/**
 * Internal aggregate observation evidence for a single fixture session.
 * Never contains raw coordinates, IDs, or per-row data.
 * Optional: fixtures without evidence still produce all other metrics.
 */
export interface JourneyObservationEvidence {
  /**
   * Ordered observation timestamps (ISO strings) from accepted observations
   * for this session — used to compute sampling gaps and jitter.
   * No coordinates or IDs.
   */
  orderedTimestampsMs: number[];
  /**
   * Consecutive haversine distances in metres between ordered observations
   * (length = orderedTimestampsMs.length - 1, or 0 if < 2 observations).
   */
  consecutiveDistancesM: number[];
  /** quality_reasons arrays for each observation (for impossible_speed count). */
  qualityReasonSets: string[][];
}

/**
 * Ground-truth fixture for authorized comparison. Contains only aggregate
 * timing labels — no IDs, coordinates, or user data.
 */
export interface JourneyGroundTruthFixture {
  /** Condition label for grouping. */
  condition: string;
  /** True arrival time as ISO string (if a stop/dwell was expected). */
  expectedArrivalAt: string | null;
  /** True departure time as ISO string (if a dwell was expected). */
  expectedDepartureAt: string | null;
  /** Expected dwell duration in seconds (null = no dwell expected). */
  expectedDwellS: number | null;
  /** True canonical placeId UUID, or null if none. */
  expectedPlaceId: string | null;
  /** True category identifier, or null if none. */
  expectedCategoryId: string | null;
  /** Revisions produced by the segmenter for this fixture. */
  revisions: JourneySegmentRevision[];
  /**
   * Optional internal observation evidence for jitter/gap/impossible-speed
   * metrics. When absent, those aggregate fields default to empty/zero.
   * Backward-compatible: existing tests that omit this field still pass.
   */
  observationEvidence?: JourneyObservationEvidence | null;
}

// ── Output types ─────────────────────────────────────────────────────────────

export interface JourneyShadowRate {
  falseCount: number;
  eligibleCount: number;
  rate: number;
}

/**
 * Distribution summary: no raw values, only aggregate statistics.
 */
export interface JourneyDistributionSummary {
  count: number;
  minS: number | null;
  maxS: number | null;
  medianS: number | null;
  p90S: number | null;
}

/**
 * Metre-based distribution summary (for jitter/displacement).
 */
export interface JourneyDistributionSummaryM {
  count: number;
  minM: number | null;
  maxM: number | null;
  medianM: number | null;
  p90M: number | null;
}

export interface JourneyShadowMetrics {
  cases: number;
  falseStop: JourneyShadowRate;
  falseDwell: JourneyShadowRate;
  byCondition: Record<string, {
    cases: number;
    falseStops: number;
    falseDwells: number;
  }>;
}

/**
 * Extended metrics comparing revisions against authorized ground truth.
 * All output is aggregate-only: no IDs, coordinates, or raw per-case values.
 */
export interface JourneyGroundTruthMetrics {
  /** Total fixtures evaluated. */
  fixtures: number;

  /** Arrival timing error distribution in seconds (|estimated - truth|). */
  arrivalErrorDist: JourneyDistributionSummary;

  /** Departure timing error distribution in seconds (|estimated - truth|). */
  departureErrorDist: JourneyDistributionSummary;

  /** Dwell duration error distribution in seconds (|estimated - truth|). */
  dwellErrorDist: JourneyDistributionSummary;

  /** False-stop rate (predicted stop when no stop expected). */
  falseStop: JourneyShadowRate;

  /** False-dwell rate (predicted dwell when no dwell expected). */
  falseDwell: JourneyShadowRate;

  /** Place match/unknown summary. */
  placeMatch: {
    /** Fixtures where a canonical placeId was expected. */
    expectedCount: number;
    /** Of those, how many the segmenter resolved to "resolved". */
    resolvedCount: number;
    /** Of those resolved, how many matched the expected placeId. */
    matchedCount: number;
    /** Fixtures where place was expected but reported "unknown". */
    unknownCount: number;
  };

  /** Category match/unknown summary. */
  categoryMatch: {
    expectedCount: number;
    resolvedCount: number;
    matchedCount: number;
    unknownCount: number;
  };

  /** Confidence calibration: average uncertainty score per state bucket. */
  confidenceCalibration: Record<JourneySegmentState, {
    count: number;
    meanUncertaintyScore: number;
  }>;

  /**
   * Jitter/displacement distribution: consecutive haversine distances in metres
   * between accepted observations, derived from internal observation evidence.
   * Aggregate only — no raw coordinates or observation IDs exposed.
   */
  jitterDistM: JourneyDistributionSummaryM;

  /** Observation sampling-gap distribution in seconds (derived from evidence). */
  samplingGapDist: JourneyDistributionSummary;

  /**
   * Count of impossible-speed events: observations with quality_reasons
   * containing "impossible_speed" or speeds > 340 m/s detected via
   * consecutive distances / elapsed time from evidence.
   */
  impossibleSpeedEvents: number;

  /** Aggregate by condition. */
  byCondition: Record<string, {
    fixtures: number;
    falseStops: number;
    falseDwells: number;
  }>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function currentRevisions(revisions: JourneySegmentRevision[]): JourneySegmentRevision[] {
  const current = new Map<string, JourneySegmentRevision>();
  for (const revision of revisions) {
    const prior = current.get(revision.segmentKey);
    if (!prior || revision.revisionIndex > prior.revisionIndex) {
      current.set(revision.segmentKey, revision);
    }
  }
  return [...current.values()];
}

function sortedNumbers(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function percentileOf(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    Math.ceil((p / 100) * sorted.length) - 1,
    sorted.length - 1,
  );
  return sorted[idx]!;
}

function distSummary(values: number[]): JourneyDistributionSummary {
  if (values.length === 0) {
    return { count: 0, minS: null, maxS: null, medianS: null, p90S: null };
  }
  const sorted = sortedNumbers(values);
  return {
    count: sorted.length,
    minS: sorted[0]!,
    maxS: sorted[sorted.length - 1]!,
    medianS: medianOf(sorted),
    p90S: percentileOf(sorted, 90),
  };
}

function distSummaryM(values: number[]): JourneyDistributionSummaryM {
  if (values.length === 0) {
    return { count: 0, minM: null, maxM: null, medianM: null, p90M: null };
  }
  const sorted = sortedNumbers(values);
  return {
    count: sorted.length,
    minM: sorted[0]!,
    maxM: sorted[sorted.length - 1]!,
    medianM: medianOf(sorted),
    p90M: percentileOf(sorted, 90),
  };
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function absErrorS(a: string | null, b: string | null): number | null {
  const am = parseMs(a);
  const bm = parseMs(b);
  if (am == null || bm == null) return null;
  return Math.abs(am - bm) / 1_000;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Measures false classifications against labelled shadow fixtures. Metrics are
 * aggregate-only: they retain no user, session, coordinate, or observation ID.
 */
export function measureJourneyShadowQuality(
  cases: JourneyShadowCase[],
): JourneyShadowMetrics {
  let falseStops = 0;
  let falseDwells = 0;
  let stopNegativeCases = 0;
  let dwellNegativeCases = 0;
  const byCondition: JourneyShadowMetrics["byCondition"] = {};

  for (const sample of cases) {
    const current = currentRevisions(sample.revisions);
    const predictedStop = current.some(
      (revision) =>
        revision.state === "candidate_stop" ||
        revision.state === "dwelling" ||
        revision.state === "departed",
    );
    const predictedDwell = sample.revisions.some(
      (revision) => revision.state === "dwelling",
    );
    const falseStop = !sample.expectedStop && predictedStop;
    const falseDwell = !sample.expectedDwell && predictedDwell;

    if (!sample.expectedStop) stopNegativeCases += 1;
    if (!sample.expectedDwell) dwellNegativeCases += 1;
    if (falseStop) falseStops += 1;
    if (falseDwell) falseDwells += 1;

    const condition = byCondition[sample.condition] ?? {
      cases: 0,
      falseStops: 0,
      falseDwells: 0,
    };
    condition.cases += 1;
    if (falseStop) condition.falseStops += 1;
    if (falseDwell) condition.falseDwells += 1;
    byCondition[sample.condition] = condition;
  }

  return {
    cases: cases.length,
    falseStop: {
      falseCount: falseStops,
      eligibleCount: stopNegativeCases,
      rate: stopNegativeCases === 0 ? 0 : falseStops / stopNegativeCases,
    },
    falseDwell: {
      falseCount: falseDwells,
      eligibleCount: dwellNegativeCases,
      rate: dwellNegativeCases === 0 ? 0 : falseDwells / dwellNegativeCases,
    },
    byCondition,
  };
}

/**
 * Compare revisions against authorized ground-truth fixtures.
 *
 * Returns aggregate-only metrics: no IDs, coordinates, or raw per-case data.
 * Backward-compatible: fixtures without observationEvidence still produce all
 * metrics except jitter/gap/impossible (which default to empty/zero).
 */
export function measureJourneyGroundTruth(
  fixtures: JourneyGroundTruthFixture[],
): JourneyGroundTruthMetrics {
  const arrivalErrors: number[] = [];
  const departureErrors: number[] = [];
  const dwellErrors: number[] = [];
  const samplingGaps: number[] = [];
  const jitterDistances: number[] = [];

  let falseStops = 0;
  let falseDwells = 0;
  let stopNegatives = 0;
  let dwellNegatives = 0;

  const placeMatch = { expectedCount: 0, resolvedCount: 0, matchedCount: 0, unknownCount: 0 };
  const categoryMatch = { expectedCount: 0, resolvedCount: 0, matchedCount: 0, unknownCount: 0 };

  // Confidence calibration: accumulate per-state
  const stateAccum: Partial<Record<JourneySegmentState, { sum: number; count: number }>> = {};
  let impossibleSpeedEvents = 0;

  const byCondition: JourneyGroundTruthMetrics["byCondition"] = {};

  for (const fixture of fixtures) {
    const current = currentRevisions(fixture.revisions);

    // ── False stop / false dwell ─────────────────────────────────────────────
    const expectedStop = fixture.expectedArrivalAt != null;
    const expectedDwell = fixture.expectedDwellS != null;

    const predictedStop = current.some(
      (r) =>
        r.state === "candidate_stop" ||
        r.state === "dwelling" ||
        r.state === "departed",
    );
    const predictedDwell = fixture.revisions.some((r) => r.state === "dwelling");

    if (!expectedStop) stopNegatives += 1;
    if (!expectedDwell) dwellNegatives += 1;
    if (!expectedStop && predictedStop) falseStops += 1;
    if (!expectedDwell && predictedDwell) falseDwells += 1;

    // ── Arrival timing error ─────────────────────────────────────────────────
    if (fixture.expectedArrivalAt) {
      const arrivalRevision = current.find(
        (r) => r.state === "dwelling" || r.state === "candidate_stop" || r.state === "departed",
      );
      if (arrivalRevision) {
        const err = absErrorS(fixture.expectedArrivalAt, arrivalRevision.startedAt);
        if (err != null) arrivalErrors.push(err);
      }
    }

    // ── Departure timing error ───────────────────────────────────────────────
    if (fixture.expectedDepartureAt) {
      const departureRevision = current.find((r) => r.state === "departed");
      if (departureRevision) {
        const err = absErrorS(fixture.expectedDepartureAt, departureRevision.endedAt);
        if (err != null) departureErrors.push(err);
      }
    }

    // ── Dwell duration error ─────────────────────────────────────────────────
    if (fixture.expectedDwellS != null) {
      const dwellRevision = fixture.revisions.find((r) => r.state === "dwelling" && r.durationS != null);
      if (dwellRevision?.durationS != null) {
        dwellErrors.push(Math.abs(dwellRevision.durationS - fixture.expectedDwellS));
      }
    }

    // ── Place match ──────────────────────────────────────────────────────────
    if (fixture.expectedPlaceId) {
      placeMatch.expectedCount += 1;
      const placeRevision = current.find(
        (r) => r.placeProvenance.placeConfidence === "resolved",
      );
      if (placeRevision) {
        placeMatch.resolvedCount += 1;
        // We don't store the exact placeId in revisions (privacy), but we can
        // check if worldRef.placeId matches
        if (placeRevision.worldRef.placeId === fixture.expectedPlaceId) {
          placeMatch.matchedCount += 1;
        }
      } else {
        placeMatch.unknownCount += 1;
      }
    }

    // ── Category match ───────────────────────────────────────────────────────
    if (fixture.expectedCategoryId) {
      categoryMatch.expectedCount += 1;
      const catRevision = current.find(
        (r) => r.placeProvenance.categoryConfidence === "resolved",
      );
      if (catRevision) {
        categoryMatch.resolvedCount += 1;
        // Category is expressed via districtId/cityId canonical refs
        const catRef = catRevision.worldRef.districtId ?? catRevision.worldRef.cityId;
        if (catRef === fixture.expectedCategoryId) {
          categoryMatch.matchedCount += 1;
        }
      } else {
        categoryMatch.unknownCount += 1;
      }
    }

    // ── Confidence calibration ───────────────────────────────────────────────
    for (const revision of current) {
      const entry = stateAccum[revision.state] ?? { sum: 0, count: 0 };
      entry.sum += revision.uncertainty.score;
      entry.count += 1;
      stateAccum[revision.state] = entry;
    }

    // ── Internal observation evidence: jitter / gap / impossible speed ────────
    // Derived from optional observationEvidence. No raw coordinates or IDs
    // are stored — only computed aggregate values (distances, gaps, counts).
    const evidence = fixture.observationEvidence ?? null;
    if (evidence) {
      const { orderedTimestampsMs, consecutiveDistancesM, qualityReasonSets } = evidence;

      // Jitter / displacement distribution (metres)
      for (const dist of consecutiveDistancesM) {
        jitterDistances.push(dist);
      }

      // Sampling gap distribution (seconds) from ordered timestamps
      for (let i = 1; i < orderedTimestampsMs.length; i++) {
        const gapMs = orderedTimestampsMs[i]! - orderedTimestampsMs[i - 1]!;
        if (gapMs >= 0) samplingGaps.push(gapMs / 1_000);
      }

      // Impossible speed: quality_reasons containing "impossible_speed"
      for (const reasons of qualityReasonSets) {
        if (reasons.some((r) => r.includes("impossible_speed"))) {
          impossibleSpeedEvents += 1;
        }
      }

      // Also detect from consecutive distances / elapsed time (> 340 m/s)
      for (let i = 0; i < consecutiveDistancesM.length; i++) {
        const distM = consecutiveDistancesM[i]!;
        const elapsedMs =
          i + 1 < orderedTimestampsMs.length
            ? orderedTimestampsMs[i + 1]! - orderedTimestampsMs[i]!
            : null;
        if (elapsedMs != null && elapsedMs > 0) {
          const speedMps = (distM / elapsedMs) * 1_000;
          if (speedMps > 340) {
            impossibleSpeedEvents += 1;
          }
        }
      }
    } else {
      // Fallback: derive sampling gaps from revision evidence when no
      // observation evidence is provided (preserves backward compatibility).
      for (const revision of current) {
        if (revision.evidence.maxGapSeconds != null) {
          samplingGaps.push(revision.evidence.maxGapSeconds);
        }
      }

      // Impossible speed from revision uncertainty reasons (backward compat)
      for (const revision of fixture.revisions) {
        if (revision.uncertainty.reasons.includes("impossible_speed_filtered")) {
          impossibleSpeedEvents += 1;
        }
      }
    }

    // ── By condition ─────────────────────────────────────────────────────────
    const cond = byCondition[fixture.condition] ?? {
      fixtures: 0,
      falseStops: 0,
      falseDwells: 0,
    };
    cond.fixtures += 1;
    if (!expectedStop && predictedStop) cond.falseStops += 1;
    if (!expectedDwell && predictedDwell) cond.falseDwells += 1;
    byCondition[fixture.condition] = cond;
  }

  // Build confidence calibration output
  const confidenceCalibration: JourneyGroundTruthMetrics["confidenceCalibration"] = {
    moving: { count: 0, meanUncertaintyScore: 0 },
    candidate_stop: { count: 0, meanUncertaintyScore: 0 },
    dwelling: { count: 0, meanUncertaintyScore: 0 },
    departed: { count: 0, meanUncertaintyScore: 0 },
    discarded: { count: 0, meanUncertaintyScore: 0 },
  };
  for (const [state, entry] of Object.entries(stateAccum)) {
    if (entry && entry.count > 0) {
      confidenceCalibration[state as JourneySegmentState] = {
        count: entry.count,
        meanUncertaintyScore: Math.round((entry.sum / entry.count) * 1_000) / 1_000,
      };
    }
  }

  return {
    fixtures: fixtures.length,
    arrivalErrorDist: distSummary(arrivalErrors),
    departureErrorDist: distSummary(departureErrors),
    dwellErrorDist: distSummary(dwellErrors),
    falseStop: {
      falseCount: falseStops,
      eligibleCount: stopNegatives,
      rate: stopNegatives === 0 ? 0 : falseStops / stopNegatives,
    },
    falseDwell: {
      falseCount: falseDwells,
      eligibleCount: dwellNegatives,
      rate: dwellNegatives === 0 ? 0 : falseDwells / dwellNegatives,
    },
    placeMatch,
    categoryMatch,
    confidenceCalibration,
    jitterDistM: distSummaryM(jitterDistances),
    samplingGapDist: distSummary(samplingGaps),
    impossibleSpeedEvents,
    byCondition,
  };
}
