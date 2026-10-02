/**
 * acousticFeatures — the coarse energy/rhythm extractor §4.1 permits, and the
 * gate it is only permitted behind.
 *
 * ── WHAT IT TAKES, AND WHAT IT CANNOT TAKE ───────────────────────────────────
 * The input is a list of METER READINGS — one dBFS number per tick, the value
 * an OS audio meter reports. There is no waveform, no buffer, no file and no
 * transcript anywhere in this module's types, so "the audio" is not a thing
 * that exists to be leaked. `acousticMeterSource.ts` is what makes that true at
 * runtime: it reads the recorder's metering field and discards the recording.
 *
 * ── WHAT IT RETURNS ──────────────────────────────────────────────────────────
 * Two ordinals, never the numbers it saw:
 *   energyBucket  0..4  how loud, coarsely
 *   rhythmBucket  none | irregular | steady | strong
 * A bucket cannot be inverted back into a room's sound, which is the whole
 * reason this is the only acoustic thing the device is allowed to say.
 *
 * ── THE GATE REFUSES; IT DOES NOT IGNORE ─────────────────────────────────────
 * Without the separate acoustic permission this returns
 * `{ ok: false, reason: 'permission_not_granted' }`. It does not quietly return
 * nulls. The server's vibeInference takes the same line for the same reason —
 * "an acoustic feature presented without that flag is REFUSED outright, not
 * ignored, because ignoring it would let a client learn the permission is not
 * enforced".
 */
import {
  acousticCaptureAllowed,
  ACOUSTIC_SENSING_SCOPE,
  type AcousticPermission,
} from './acousticPermission.ts';

/** One meter reading. dBFS: 0 is full scale, −160 is silence. No audio. */
export interface AcousticMeterSample {
  t: number;
  dbfs: number;
}

export type AcousticRhythmBucket = 'none' | 'irregular' | 'steady' | 'strong';

export interface AcousticFeatures {
  /** The scope that authorised this, carried so a consumer can re-check it. */
  scope: string;
  /** 0..4 loudness ordinal. */
  energyBucket: number;
  /** Coarse rhythm class. */
  rhythmBucket: AcousticRhythmBucket;
  /** 0..1 how much of the requested window actually metered. */
  confidence: number;
}

export type AcousticRefusal =
  | 'permission_not_granted'
  | 'insufficient_samples';

export type AcousticExtraction =
  | { ok: true; features: AcousticFeatures }
  | { ok: false; reason: AcousticRefusal };

/** Below this many meter ticks there is no rhythm question to answer. */
export const MIN_ACOUSTIC_SAMPLES = 12;
/** dBFS mapped onto the 0..4 ordinal: quieter than this is rung 0. */
export const ACOUSTIC_FLOOR_DBFS = -60;
/** …and louder than this is rung 4. */
export const ACOUSTIC_CEILING_DBFS = -12;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function energyOrdinal(meanDbfs: number): number {
  const span = ACOUSTIC_CEILING_DBFS - ACOUSTIC_FLOOR_DBFS;
  const unit = clamp01((meanDbfs - ACOUSTIC_FLOOR_DBFS) / span);
  return Math.min(4, Math.floor(unit * 5));
}

/**
 * Rhythm from the meter envelope alone: how regularly loudness rises and falls.
 * Autocorrelation of the mean-removed envelope over a musical-tempo lag band,
 * bucketed. A steady hum has high energy and no rhythm; a room with a beat has
 * a peak.
 */
function rhythmOrdinal(samples: readonly AcousticMeterSample[]): AcousticRhythmBucket {
  const v = samples.map((s) => s.dbfs);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const d = v.map((x) => x - mean);
  const e0 = d.reduce((a, x) => a + x * x, 0);
  if (e0 <= 0) return 'none';

  const maxLag = Math.min(d.length - 2, Math.floor(d.length / 2));
  let best = 0;
  for (let lag = 2; lag <= maxLag; lag += 1) {
    let acc = 0;
    for (let i = 0; i + lag < d.length; i += 1) acc += d[i] * d[i + lag];
    const norm = acc / e0;
    if (norm > best) best = norm;
  }
  if (best < 0.15) return 'none';
  if (best < 0.35) return 'irregular';
  if (best < 0.6) return 'steady';
  return 'strong';
}

/**
 * Reduce a window of meter readings to the two ordinals — but only with the
 * separate acoustic permission (§4.1). `expectedSamples` is what the caller
 * asked the meter for, so a half-delivered window reports lower confidence
 * instead of pretending it was complete.
 */
export function extractAcousticFeatures(
  permission: AcousticPermission | null | undefined,
  samples: readonly AcousticMeterSample[],
  expectedSamples: number = MIN_ACOUSTIC_SAMPLES,
): AcousticExtraction {
  if (!acousticCaptureAllowed(permission)) {
    return { ok: false, reason: 'permission_not_granted' };
  }
  const usable = samples.filter((s) => Number.isFinite(s.dbfs));
  if (usable.length < MIN_ACOUSTIC_SAMPLES) {
    return { ok: false, reason: 'insufficient_samples' };
  }
  const mean = usable.reduce((a, s) => a + s.dbfs, 0) / usable.length;
  return {
    ok: true,
    features: {
      scope: ACOUSTIC_SENSING_SCOPE,
      energyBucket: energyOrdinal(mean),
      rhythmBucket: rhythmOrdinal(usable),
      confidence: clamp01(usable.length / Math.max(1, expectedSamples)),
    },
  };
}
