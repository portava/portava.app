/**
 * normalizedFeatures — §4.1's ON-DEVICE reduction, in full.
 *
 * The spec's §4.1 box lists RAW DEVICE INPUTS on one side of an arrow labelled
 * "ON DEVICE" and NORMALIZED SIGNAL FEATURES on the other. This module is that
 * arrow. It takes a window of raw samples and returns exactly the nine named
 * features, and nothing else:
 *
 *   spatial bucket / canonical-place candidate   spatial_bucket
 *   temporal bucket                              temporal_bucket
 *   movement_state                               movement_state
 *   motion_energy                                motion_energy
 *   periodicity                                  periodicity
 *   dwell_bucket                                 dwell_bucket
 *   arrival / departure transition               transition
 *   transport-mode likelihood                    transport_mode_likelihood
 *   confidence / sensor health                   sensor_health
 *
 * `SENSING_FEATURE_NAMES` is that list as data, and the returned object's keys
 * are asserted against it, so the set cannot drift by one field without a test
 * saying so.
 *
 * ── PURE, AND THAT IS THE POINT ──────────────────────────────────────────────
 * No clock, no I/O, no native module, no React. The window arrives as an
 * argument. That is what makes the reduction testable without a handset, and it
 * is also what lets `sensingCapture.ts` hold the raw samples for the length of
 * one window and then drop them: the reduction has no state to keep.
 *
 * ── ABSENT IS A FACT, NOT A ZERO (§20) ───────────────────────────────────────
 * Every feature is nullable and every "I could not tell" path returns null or
 * `unknown`. A window with no motion samples does not report motion_energy 0 —
 * zero energy is a claim that the device was still, which is different from not
 * having looked. The server's vibe engine depends on this: an unknown
 * periodicity makes dance_likelihood null, while a zero would make it a number.
 *
 * ── ONE DEVICE IS NOT A CROWD (§4.4) ─────────────────────────────────────────
 * `density` (below) is this device's OBSERVATION of movement impedance, not a
 * count of people, and it is stated as a bucket with an `unknown` rung that is
 * reached whenever this device has no standing to judge. Turning observations
 * into density is the server's cohort aggregation; this is one input to it.
 */
import {
  SENSING_SPATIAL_PRECISION,
  encodeSpatialBucket,
  metresBetween,
} from './spatialBucket.ts';

// ── The nine ─────────────────────────────────────────────────────────────────

/** §4.1's NORMALIZED SIGNAL FEATURES, in the spec's order. */
export const SENSING_FEATURE_NAMES = [
  'spatial_bucket',
  'temporal_bucket',
  'movement_state',
  'motion_energy',
  'periodicity',
  'dwell_bucket',
  'transition',
  'transport_mode_likelihood',
  'sensor_health',
] as const;

export type SensingFeatureName = (typeof SENSING_FEATURE_NAMES)[number];

export type MovementState = 'stationary' | 'pedestrian' | 'vehicular' | 'unknown';
export type TransitionKind = 'arrival' | 'departure' | 'none' | 'unknown';
export type TransportMode = 'stationary' | 'pedestrian' | 'cycling' | 'vehicular';
/** This device's movement-impedance observation. `unknown` when it cannot tell. */
export type DensityBucket = 'unknown' | 'sparse' | 'moderate' | 'busy' | 'packed';

export interface SpatialBucketFeature {
  /** Coarse zone label. Never a coordinate — see spatialBucket.ts. */
  zone: string | null;
  /** The precision the zone was cut at, so a consumer can size the cell. */
  precision: number;
  /** A canonical place the app already knew about, if any. Never derived here. */
  canonicalPlaceCandidate: string | null;
}

export interface SensorHealthFeature {
  /** 0..1 — how much of this window's evidence actually arrived. */
  confidence: number;
  /** COUNTS, not samples. The samples themselves never leave this module. */
  motionSampleCount: number;
  locationSampleCount: number;
  /** Named degradations, e.g. 'no_motion_samples', 'coarse_location_only'. */
  degraded: readonly string[];
}

/** Exactly the nine. Adding a tenth key here fails `normalizedFeatures.test.ts`. */
export interface NormalizedSignalFeatures {
  spatial_bucket: SpatialBucketFeature;
  temporal_bucket: string | null;
  movement_state: MovementState;
  motion_energy: number | null;
  periodicity: number | null;
  dwell_bucket: number | null;
  transition: TransitionKind;
  transport_mode_likelihood: Readonly<Record<TransportMode, number>> | null;
  sensor_health: SensorHealthFeature;
}

// ── Raw inputs. These types exist so they can be named in the test that proves
//    no value of them reaches the wire. Nothing outside this module and
//    `sensingCapture.ts` ever holds one. ──────────────────────────────────────

/** One accelerometer reading, in g, as expo-sensors' Accelerometer delivers it. */
export interface RawMotionSample {
  t: number;
  x: number;
  y: number;
  z: number;
}

/** One position fix, as expo-location's watchPositionAsync delivers it. */
export interface RawLocationSample {
  t: number;
  lat: number;
  lng: number;
  accuracyM: number | null;
  speedMps: number | null;
}

export interface RawSensingWindow {
  /** Window start and end, device clock, ms. */
  startedAtMs: number;
  endedAtMs: number;
  motion: readonly RawMotionSample[];
  location: readonly RawLocationSample[];
  /** The zone this device was in before the window opened, if known. */
  previousZone?: string | null;
  /** Unbroken ms already spent in `previousZone` when the window opened. */
  priorDwellMs?: number;
  /** A canonical place the app already resolved. Context, never derived here. */
  canonicalPlaceCandidate?: string | null;
}

export interface ReduceOptions {
  spatialPrecision?: number;
  /** Minutes per temporal bucket. Mirrors the server's PRIVACY_THRESHOLD_V1. */
  temporalBucketMinutes?: number;
}

// ── Thresholds. Named, so a test can move one and see a rung move. ───────────

/** Below this many accelerometer samples the motion features are unknown. */
export const MIN_MOTION_SAMPLES = 16;
/** Below this many fixes the spatial features are unknown. */
export const MIN_LOCATION_SAMPLES = 2;
/** RMS dynamic acceleration (g) that saturates motion_energy at 1. */
export const MOTION_ENERGY_SATURATION_G = 0.6;
/** Below this energy, "how periodic was it" has no subject — periodicity is unknown. */
export const MIN_ENERGY_FOR_PERIODICITY = 0.06;
/** Cadence band searched for rhythm, in Hz: walking through dancing. */
export const PERIODICITY_BAND_HZ = { min: 0.5, max: 4 } as const;
/** Speed (m/s) at or above which movement is vehicular rather than pedestrian. */
export const VEHICULAR_SPEED_MPS = 4.2;
/** Displacement (m) within a window under which movement counts as bounded. */
export const BOUNDED_MOVEMENT_METRES = 60;
/** Free-flowing walking speed (m/s). Impedance is measured against this. */
export const FREE_WALK_SPEED_MPS = 1.4;
/** dwell_bucket rung edges, minutes. Five rungs, 0..4, matching the store's ordinal. */
export const DWELL_BUCKET_EDGES_MINUTES = [2, 10, 30, 120] as const;
/** Density rung edges on 0..1 impedance. */
export const DENSITY_BUCKET_EDGES = [0.2, 0.45, 0.7] as const;

const DEFAULT_TEMPORAL_BUCKET_MINUTES = 30;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ── The reduction ────────────────────────────────────────────────────────────

/** Coarse time bucket. Same arithmetic as the server's `sensingTimeBucket`. */
export function temporalBucket(
  atMs: number,
  minutes: number = DEFAULT_TEMPORAL_BUCKET_MINUTES,
): string | null {
  if (!Number.isFinite(atMs) || !Number.isFinite(minutes) || minutes <= 0) return null;
  const width = minutes * 60_000;
  return new Date(Math.floor(atMs / width) * width).toISOString();
}

/** Dynamic (gravity-removed) magnitude series for a motion window. */
function dynamicMagnitudes(motion: readonly RawMotionSample[]): number[] {
  const mags = motion.map((s) => Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z));
  const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
  return mags.map((m) => m - mean);
}

/** 0..1 accelerometer-derived energy, or null when there is not enough to say. */
export function motionEnergy(motion: readonly RawMotionSample[]): number | null {
  if (motion.length < MIN_MOTION_SAMPLES) return null;
  const d = dynamicMagnitudes(motion);
  const rms = Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length);
  return clamp01(rms / MOTION_ENERGY_SATURATION_G);
}

/**
 * 0..1 rhythmic periodicity: the strongest normalised autocorrelation of the
 * dynamic magnitude series at a lag inside the human-cadence band.
 *
 * Returns null — not zero — when there are too few samples, when the sample
 * rate cannot be established, or when there is too little energy for the
 * question to mean anything. The server's vibe engine reads a null here as
 * "unknown" and refuses to produce a dance_likelihood at all, which is the
 * §5.2 invariant "rapid movement is not dancing" in its strongest form.
 */
export function periodicity(motion: readonly RawMotionSample[]): number | null {
  if (motion.length < MIN_MOTION_SAMPLES) return null;
  const spanMs = motion[motion.length - 1].t - motion[0].t;
  if (!Number.isFinite(spanMs) || spanMs <= 0) return null;
  const rateHz = (motion.length - 1) / (spanMs / 1000);
  if (!Number.isFinite(rateHz) || rateHz <= 0) return null;

  const d = dynamicMagnitudes(motion);
  const energy0 = d.reduce((a, v) => a + v * v, 0);
  if (energy0 <= 0) return null;
  const rms = Math.sqrt(energy0 / d.length);
  if (rms / MOTION_ENERGY_SATURATION_G < MIN_ENERGY_FOR_PERIODICITY) return null;

  const minLag = Math.max(1, Math.round(rateHz / PERIODICITY_BAND_HZ.max));
  const maxLag = Math.min(d.length - 2, Math.round(rateHz / PERIODICITY_BAND_HZ.min));
  if (maxLag <= minLag) return null;

  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let acc = 0;
    for (let i = 0; i + lag < d.length; i += 1) acc += d[i] * d[i + lag];
    const norm = acc / energy0;
    if (norm > best) best = norm;
  }
  return clamp01(best);
}

/** Median of a numeric list; NaN-safe, returns null for an empty list. */
function median(values: readonly number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Net path length (m) walked across the window's fixes. Device-local. */
function pathMetres(loc: readonly RawLocationSample[]): number | null {
  if (loc.length < MIN_LOCATION_SAMPLES) return null;
  let total = 0;
  for (let i = 1; i < loc.length; i += 1) {
    total += metresBetween(loc[i - 1].lat, loc[i - 1].lng, loc[i].lat, loc[i].lng);
  }
  return total;
}

/** Speeds (m/s): the OS value where present, else derived from consecutive fixes. */
function speeds(loc: readonly RawLocationSample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < loc.length; i += 1) {
    const reported = loc[i].speedMps;
    if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
      out.push(reported);
      continue;
    }
    const dt = (loc[i].t - loc[i - 1].t) / 1000;
    if (dt <= 0) continue;
    out.push(metresBetween(loc[i - 1].lat, loc[i - 1].lng, loc[i].lat, loc[i].lng) / dt);
  }
  return out;
}

/**
 * This device's DENSITY OBSERVATION — §5.2's `density` candidate signal, as the
 * only form of it a single handset can honestly produce.
 *
 * A crowd is not countable from one device. What IS observable from one device
 * is IMPEDANCE: a person walking through a packed room moves far slower than
 * free-walking pace while still spending effort, and stops and starts. So the
 * measure is `1 - medianSpeed / FREE_WALK_SPEED`, raised by the share of the
 * window spent near-stationary while motion energy says the body is working.
 *
 * It answers `unknown` — never `sparse` — whenever this device has no standing
 * to judge: not enough fixes, or movement that is not pedestrian. A stationary
 * device on a table and a device in a car both know nothing about how crowded
 * the room is, and saying `sparse` there would be exactly the §20 failure
 * "insufficient coverage is not quiet".
 */
export function densityObservation(
  loc: readonly RawLocationSample[],
  energy: number | null,
  state: MovementState,
): DensityBucket {
  if (state !== 'pedestrian') return 'unknown';
  if (loc.length < MIN_LOCATION_SAMPLES + 1) return 'unknown';
  const s = speeds(loc);
  const med = median(s);
  if (med === null) return 'unknown';

  const impedance = clamp01(1 - med / FREE_WALK_SPEED_MPS);
  // Stop-start: fixes where the body is working (energy present) but progress
  // is near zero. Crowds produce this; an open pavement does not.
  const stalled = s.filter((v) => v < 0.35).length / s.length;
  const working = energy !== null && energy > MIN_ENERGY_FOR_PERIODICITY ? stalled : 0;
  const score = clamp01(impedance * 0.7 + working * 0.3);

  const [a, b, c] = DENSITY_BUCKET_EDGES;
  if (score < a) return 'sparse';
  if (score < b) return 'moderate';
  if (score < c) return 'busy';
  return 'packed';
}

function classifyMovement(
  loc: readonly RawLocationSample[],
  energy: number | null,
): MovementState {
  if (loc.length < MIN_LOCATION_SAMPLES) {
    if (energy === null) return 'unknown';
    // Motion without position still distinguishes still from moving; it cannot
    // distinguish walking from riding, so it never claims vehicular.
    return energy < 0.05 ? 'stationary' : 'pedestrian';
  }
  const med = median(speeds(loc));
  if (med === null) return 'unknown';
  if (med >= VEHICULAR_SPEED_MPS) return 'vehicular';
  if (med < 0.25 && (energy === null || energy < 0.08)) return 'stationary';
  return 'pedestrian';
}

/** True when the window's whole path stays inside a small area. Null without fixes. */
export function boundedMovement(loc: readonly RawLocationSample[]): boolean | null {
  const path = pathMetres(loc);
  if (path === null) return null;
  return path <= BOUNDED_MOVEMENT_METRES;
}

/** 0..4 dwell ordinal from unbroken minutes in the current zone. Null when unknown. */
export function dwellBucket(dwellMs: number | null): number | null {
  if (dwellMs === null || !Number.isFinite(dwellMs) || dwellMs < 0) return null;
  const minutes = dwellMs / 60_000;
  let rung = 0;
  for (const edge of DWELL_BUCKET_EDGES_MINUTES) {
    if (minutes >= edge) rung += 1;
  }
  return rung;
}

function classifyTransition(
  previousZone: string | null | undefined,
  currentZone: string | null,
  state: MovementState,
): TransitionKind {
  if (currentZone === null) return 'unknown';
  if (previousZone === undefined || previousZone === null) return 'unknown';
  if (previousZone === currentZone) {
    // Same zone, but leaving it at speed is a departure in progress.
    return state === 'vehicular' ? 'departure' : 'none';
  }
  // The zone changed. Settling in the new one is an arrival; still moving is a
  // departure from the old one.
  return state === 'stationary' || state === 'pedestrian' ? 'arrival' : 'departure';
}

/**
 * Transport-mode likelihoods that sum to 1. Null when there is no evidence at
 * all — a flat 0.25 each would be a claim of uniform uncertainty rather than of
 * ignorance, and the two are not the same thing.
 */
export function transportModeLikelihood(
  loc: readonly RawLocationSample[],
  energy: number | null,
  period: number | null,
): Readonly<Record<TransportMode, number>> | null {
  const med = loc.length >= MIN_LOCATION_SAMPLES ? median(speeds(loc)) : null;
  if (med === null && energy === null) return null;

  const scores: Record<TransportMode, number> = {
    stationary: 0,
    pedestrian: 0,
    cycling: 0,
    vehicular: 0,
  };

  if (med !== null) {
    scores.stationary += med < 0.3 ? 1 : 0;
    scores.pedestrian += med >= 0.3 && med < 2.2 ? 1 : 0;
    scores.cycling += med >= 2.2 && med < VEHICULAR_SPEED_MPS ? 1 : 0;
    scores.vehicular += med >= VEHICULAR_SPEED_MPS ? 1 : 0;
  }
  if (energy !== null) {
    // A vehicle is smooth; a body is not. Periodic motion is a gait.
    scores.stationary += energy < 0.05 ? 0.6 : 0;
    scores.pedestrian += energy >= 0.05 && (period ?? 0) >= 0.3 ? 0.6 : 0;
    scores.cycling += energy >= 0.05 && (period ?? 0) < 0.3 ? 0.2 : 0;
    scores.vehicular += energy < 0.12 && (period === null || period < 0.3) ? 0.2 : 0;
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return Object.freeze({
    stationary: scores.stationary / total,
    pedestrian: scores.pedestrian / total,
    cycling: scores.cycling / total,
    vehicular: scores.vehicular / total,
  });
}

function sensorHealth(w: RawSensingWindow): SensorHealthFeature {
  const degraded: string[] = [];
  if (w.motion.length === 0) degraded.push('no_motion_samples');
  else if (w.motion.length < MIN_MOTION_SAMPLES) degraded.push('sparse_motion_samples');
  if (w.location.length === 0) degraded.push('no_location_fixes');
  else if (w.location.length < MIN_LOCATION_SAMPLES) degraded.push('sparse_location_fixes');

  const worstAccuracy = w.location.reduce<number | null>((acc, s) => {
    if (s.accuracyM === null || !Number.isFinite(s.accuracyM)) return acc;
    return acc === null ? s.accuracyM : Math.max(acc, s.accuracyM);
  }, null);
  if (worstAccuracy !== null && worstAccuracy > 200) degraded.push('coarse_location_only');

  const motionShare = Math.min(1, w.motion.length / MIN_MOTION_SAMPLES);
  const locationShare = Math.min(1, w.location.length / (MIN_LOCATION_SAMPLES + 1));
  const confidence = clamp01(motionShare * 0.5 + locationShare * 0.5);

  return {
    confidence,
    motionSampleCount: w.motion.length,
    locationSampleCount: w.location.length,
    degraded: Object.freeze(degraded),
  };
}

export interface ReducedWindow {
  features: NormalizedSignalFeatures;
  /** §5.2's `density` candidate signal, as this device can honestly observe it. */
  density: DensityBucket;
  /** §5.2's "bounded spatial movement" candidate. Derived, never a distance. */
  boundedMovement: boolean | null;
  /** Unbroken ms in the current zone at the window's end. Device-local state. */
  dwellMs: number | null;
}

/**
 * The whole §4.1 arrow: raw window in, the nine normalised features out, plus
 * the two further §5.2 candidates the same window supports (`density`,
 * `boundedMovement`) and the dwell the caller must carry into the next window.
 */
export function reduceSensingWindow(
  w: RawSensingWindow,
  opts: ReduceOptions = {},
): ReducedWindow {
  const precision = opts.spatialPrecision ?? SENSING_SPATIAL_PRECISION;
  const last = w.location.length > 0 ? w.location[w.location.length - 1] : null;
  const zone = last ? encodeSpatialBucket(last.lat, last.lng, precision) : null;

  const energy = motionEnergy(w.motion);
  const period = periodicity(w.motion);
  const state = classifyMovement(w.location, energy);
  const bounded = boundedMovement(w.location);

  const stayedPut = zone !== null && w.previousZone != null && w.previousZone === zone;
  const windowMs = Math.max(0, w.endedAtMs - w.startedAtMs);
  const dwellMs = zone === null ? null : stayedPut ? (w.priorDwellMs ?? 0) + windowMs : windowMs;

  return {
    features: {
      spatial_bucket: {
        zone,
        precision,
        canonicalPlaceCandidate: w.canonicalPlaceCandidate ?? null,
      },
      temporal_bucket: temporalBucket(w.endedAtMs, opts.temporalBucketMinutes),
      movement_state: state,
      motion_energy: energy,
      periodicity: period,
      dwell_bucket: dwellBucket(dwellMs),
      transition: classifyTransition(w.previousZone, zone, state),
      transport_mode_likelihood: transportModeLikelihood(w.location, energy, period),
      sensor_health: sensorHealth(w),
    },
    density: densityObservation(w.location, energy, state),
    boundedMovement: bounded,
    dwellMs,
  };
}
