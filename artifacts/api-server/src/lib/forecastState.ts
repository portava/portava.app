/**
 * forecastState — Sensing §5's FORECAST engine, as the object its table names:
 *
 *   Owns:          future state with calibration
 *   Must not claim: observed current fact
 *   Primary output: ForecastState
 *
 * Census S45 found the must-not half enforced and the engine thin: "no horizon
 * field, no calibration attached to a forecast, and no `ForecastState`". This
 * is the object, with both.
 *
 * ── WHAT A FORECAST IS HERE ──────────────────────────────────────────────────
 * One honest extrapolation, and no more: the crowd's INTENSITY axis
 * (`crowd.trajectory`) stepped ONE rung along the density ladder over a named
 * horizon. Not a curve, not a time series, not a headcount. The engine refuses
 * rather than invents:
 *
 *   no trajectory evidence          → NO forecast (`no_trajectory_evidence`).
 *                                     Silence is not "steady" (§20).
 *   the current level is a SAFETY   → NO forecast (`safety_level_not_forecastable`).
 *   claim (`unsafe_density`)          A safety reading is a specialist's, and a
 *                                     trajectory does not predict one.
 *   horizon past the evidence's      → NO forecast (`horizon_exceeds_evidence`).
 *   usable life                       A three-minute-old tap does not describe
 *                                     tomorrow.
 *
 * ── PREDICTION IS NEVER OBSERVATION (§5.1, §20) ──────────────────────────────
 * Three separate mechanisms, because this is the row's whole point:
 *   1. `truth.truthClass` is ALWAYS `predicted`. It is assigned, never
 *      inherited from the evidence — an observed input does not make an
 *      observed output.
 *   2. The §18.2 envelope carries `predictedFor`, and lib/experienceTruth's
 *      `temporalIncoherence` enforces predicted_for ⟺ predicted class. Every
 *      forecast this module returns satisfies it (asserted in the suite).
 *   3. The confidence band can only fall: it is the weakest of the evidence's
 *      own band and the band the CALIBRATION supports, and an UNCALIBRATED
 *      forecast is capped strictly below `MIN_BAND_FOR_LIVE_STATE` so it can
 *      never be rendered in a Live slot.
 *
 * ── CALIBRATION ──────────────────────────────────────────────────────────────
 * §5's Forecast row says "future state WITH calibration" and §19's ForecastState
 * says "future state + horizon/calibration". Calibration is a measured record
 * INJECTED by the caller (lib/intelCalibrationScheduler's daily report is the
 * tree's only producer today, and it is a read-only report): method, sample
 * size, measured accuracy and when. It is never manufactured here — absent
 * calibration is `null` and `calibrated: false`, which is a fact about the
 * forecast, not a defect to be papered over with a default accuracy.
 *
 * PURE. No I/O, no clock of its own (`nowMs` is injected), no identity.
 */
import {
  CONFIDENCE_BANDS,
  MIN_BAND_FOR_LIVE_STATE,
  SPECIALIST_ONLY_CROWD_LEVELS,
  confidenceBand,
  type ConfidenceBand,
  type Trajectory,
} from "./intelContracts.js";
import { DENSITY_LADDER, type CrowdDensity, type CrowdState } from "./crowdState.js";
import type { TemporalEnvelope, TruthMetadata } from "./experienceTruth.js";

/** Directions a forecast may assert. Never a rate, never a count. */
export const FORECAST_DIRECTIONS = ["rising", "steady", "falling"] as const;
export type ForecastDirection = (typeof FORECAST_DIRECTIONS)[number];

/** trajectory → what it says about the NEXT rung. `null` ⇒ the axis says nothing about direction. */
export const DIRECTION_OF_TRAJECTORY: Readonly<Record<Trajectory, ForecastDirection | null>> = Object.freeze({
  emerging: "rising",
  building: "rising",
  // At the apex the only honest statement is "no further rise is claimed": the
  // evidence says the peak is NOW, and nothing in it says how fast a decay
  // would be. `falling` would be an inference the contributor never made.
  peaking: "steady",
  stable: "steady",
  fragmenting: "falling",
  relocating: "falling",
  declining: "falling",
  ending: "falling",
});

/**
 * How far past the newest supporting observation a forecast may reach. Beyond
 * this the evidence is not describing the horizon at all. A tunable knob, not
 * an owner ruling; the SHAPE (a bounded horizon, refused past the bound) is the
 * requirement.
 */
export const MAX_FORECAST_HORIZON_MINUTES = 180;

/** The band ceiling for a forecast with no measured calibration: strictly below the Live floor. */
export const UNCALIBRATED_BAND_CEILING: ConfidenceBand = "provisional";

export type ForecastRefusal =
  | "no_trajectory_evidence"
  | "safety_level_not_forecastable"
  | "horizon_exceeds_evidence"
  | "invalid_horizon"
  | "no_observation_time";

/** A MEASURED calibration record. Never manufactured by this module. */
export interface ForecastCalibration {
  /** What was measured, e.g. "intel_calibration_daily". */
  method: string;
  /** Number of graded forecasts behind `accuracy`. */
  sampleSize: number;
  /** Measured hit rate 0..1, or null when the report produced none. */
  accuracy: number | null;
  /** When the measurement was taken (ISO). */
  measuredAt: string;
}

/** Sensing §5 / §19 `ForecastState`: future state + horizon + calibration. */
export interface ForecastState {
  basis: "trajectory_extrapolation";
  /** The named horizon, in minutes from `now`. */
  horizonMinutes: number;
  /** The instant this state is about (ISO). Always set — a forecast without one is not a forecast. */
  predictedFor: string;
  /** The density expected at the horizon, or null when the current level is unknown. */
  expectedDensity: CrowdDensity | null;
  /** Which way it is expected to move. Null when the trajectory implies nothing. */
  direction: ForecastDirection | null;
  /** The trajectory the extrapolation rests on, verbatim. */
  fromTrajectory: Trajectory;
  /** The density it was stepped from, or null when unknown. */
  fromDensity: CrowdDensity | null;
  /** truthClass is ALWAYS `predicted`; the band can only fall (see the header). */
  truth: TruthMetadata;
  temporal: TemporalEnvelope;
  calibration: ForecastCalibration | null;
  calibrated: boolean;
  /** Snapshot ids that fed the extrapolation. Opaque; never a contributor. */
  claimRefs: string[];
}

export interface ForecastRefused {
  refusal: ForecastRefusal;
  horizonMinutes: number;
}

export type ForecastResult = { forecast: ForecastState; refused: null } | { forecast: null; refused: ForecastRefused };

function bandRank(b: ConfidenceBand): number {
  const i = (CONFIDENCE_BANDS as readonly string[]).indexOf(b);
  return i < 0 ? 0 : i;
}

function weaker(a: ConfidenceBand, b: ConfidenceBand): ConfidenceBand {
  return bandRank(a) <= bandRank(b) ? a : b;
}

/** A calibration is MEASURED when it has a finite accuracy over a non-empty sample. */
export function isMeasuredCalibration(c: ForecastCalibration | null | undefined): c is ForecastCalibration {
  if (!c || typeof c.accuracy !== "number" || !Number.isFinite(c.accuracy)) return false;
  return Number.isFinite(c.sampleSize) && c.sampleSize > 0;
}

/**
 * The band a calibration supports. No calibration, no sample or no measured
 * accuracy ⇒ the uncalibrated ceiling; otherwise the accuracy's own band
 * (lib/intelContracts' table, not a new one), still never above it when the
 * sample is empty.
 */
export function bandFromCalibration(c: ForecastCalibration | null | undefined): ConfidenceBand {
  if (!isMeasuredCalibration(c)) return UNCALIBRATED_BAND_CEILING;
  return confidenceBand(c.accuracy);
}

/** One rung along the ladder. Never off either end, never onto the safety level. */
export function stepDensity(from: CrowdDensity, direction: ForecastDirection): CrowdDensity {
  const i = DENSITY_LADDER.indexOf(from);
  if (i < 0) return from;
  if (direction === "steady") return from;
  const j = direction === "rising" ? Math.min(i + 1, DENSITY_LADDER.length - 1) : Math.max(i - 1, 0);
  return DENSITY_LADDER[j] as CrowdDensity;
}

export interface BuildForecastInput {
  /** The CURRENT state, from lib/crowdState — the forecast's only evidence. */
  crowd: CrowdState;
  /** Horizon in minutes from `now`. */
  horizonMinutes: number;
  /** A MEASURED calibration record, or null when none exists. */
  calibration?: ForecastCalibration | null;
}

/**
 * Extrapolate one subject's current crowd state to a horizon. Returns either a
 * forecast or a NAMED refusal — never an empty-looking forecast, because "we
 * did not forecast" and "we forecast nothing much" are different answers (§20
 * "Schema/permission/infrastructure failure ≠ no activity").
 */
export function buildForecastState(input: BuildForecastInput, nowMs: number): ForecastResult {
  const { crowd, horizonMinutes } = input;
  const refuse = (refusal: ForecastRefusal): ForecastResult => ({ forecast: null, refused: { refusal, horizonMinutes } });

  if (!Number.isFinite(horizonMinutes) || horizonMinutes <= 0 || horizonMinutes > MAX_FORECAST_HORIZON_MINUTES) {
    return refuse("invalid_horizon");
  }
  // A safety reading is not a forecastable density, and its presence poisons
  // the whole forecast for this subject: predicting "packed" beside a live
  // unsafe-density claim would advertise the place (§2 "Crowded ≠ unsafe").
  if (crowd.refusals.includes("unsafe_density_is_a_safety_claim")) return refuse("safety_level_not_forecastable");
  if (crowd.momentum === null) return refuse("no_trajectory_evidence");

  const observedAt = crowd.temporal.observedAt;
  const observedMs = observedAt === null ? NaN : Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return refuse("no_observation_time");

  const predictedForMs = nowMs + horizonMinutes * 60_000;
  if (predictedForMs - observedMs > MAX_FORECAST_HORIZON_MINUTES * 60_000) return refuse("horizon_exceeds_evidence");

  const direction = DIRECTION_OF_TRAJECTORY[crowd.momentum];
  const fromDensity = crowd.density;
  const expectedDensity = fromDensity !== null && direction !== null ? stepDensity(fromDensity, direction) : fromDensity;
  // Belt and braces: the ladder cannot reach the safety level, and this asserts
  // it rather than trusting the ladder's construction.
  const safeExpected =
    expectedDensity !== null && (SPECIALIST_ONLY_CROWD_LEVELS as readonly string[]).includes(expectedDensity)
      ? null
      : expectedDensity;

  const calibration = input.calibration ?? null;
  const calibrated = isMeasuredCalibration(calibration);
  // The band is the WEAKER of the evidence's own and the band the calibration
  // supports — and an UNCALIBRATED forecast's calibration band IS
  // UNCALIBRATED_BAND_CEILING, strictly below the Live floor. One rule, so
  // there is no second place to forget it: a forecast can never occupy a Live
  // slot on calibration it does not have.
  const band = weaker(crowd.truth.confidence, bandFromCalibration(calibration));

  const predictedFor = new Date(predictedForMs).toISOString();
  const truth: TruthMetadata = {
    // ASSIGNED, never inherited. The evidence may be `observed`; the forecast is not.
    truthClass: "predicted",
    confidence: band,
    freshness: crowd.temporal.freshness,
    coverage: crowd.truth.coverage,
    provenance: Array.from(new Set([...crowd.truth.provenance, "portava_prediction"])).sort(),
  };
  const temporal: TemporalEnvelope = {
    observedAt,
    // The window a forecast describes starts when the evidence stops and ends
    // at the instant it is about.
    effectiveFrom: crowd.temporal.effectiveUntil ?? new Date(nowMs).toISOString(),
    effectiveUntil: predictedFor,
    expiresAt: predictedFor,
    freshness: crowd.temporal.freshness,
    predictedFor,
  };

  return {
    forecast: {
      basis: "trajectory_extrapolation",
      horizonMinutes,
      predictedFor,
      expectedDensity: safeExpected,
      direction,
      fromTrajectory: crowd.momentum,
      fromDensity,
      truth,
      temporal,
      calibration,
      calibrated,
      claimRefs: [...crowd.claimRefs],
    },
    refused: null,
  };
}

/**
 * True when a forecast's band reaches the Live floor. False for every
 * UNCALIBRATED forecast by the cap above — and no producer in this tree
 * supplies a measured calibration today, so false in practice, measurably
 * rather than by assertion.
 */
export function forecastMayRenderAsLive(f: ForecastState): boolean {
  return bandRank(f.truth.confidence) >= bandRank(MIN_BAND_FOR_LIVE_STATE);
}
