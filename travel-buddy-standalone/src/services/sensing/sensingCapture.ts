/**
 * sensingCapture — the capture loop. §4.1's device sensing boundary, running.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────
 * Subscribes to a motion source and a location source, accumulates their raw
 * samples IN MEMORY for one window, reduces the window to §4.1's nine
 * normalised features (plus §5.2's `density` and bounded-movement), drops the
 * raw samples, builds the bucketed payload and hands it to `submit`. Then it
 * does it again.
 *
 * ── WHY EVERY DEPENDENCY IS INJECTED ─────────────────────────────────────────
 * Not for taste. The accelerometer, the GPS, the clock and the network are the
 * four things a test cannot have, and they are exactly the four things that
 * decide whether a coordinate leaves the handset. With them as parameters the
 * whole boundary is exercised in a unit test with real arithmetic and fake
 * hardware; `installSensingCapture.ts` is the thin file that supplies the real
 * ones. That file is also the only one that touches `expo-sensors` and
 * `expo-location`, so this loop runs identically on a device that has neither.
 *
 * ── THE RAW BUFFER IS THE WHOLE RISK, SO IT IS THE WHOLE INVARIANT ───────────
 * `_rawBufferSizes()` exists for one test: after a flush the buffers are empty.
 * Raw samples live for at most one window and are never handed to anything but
 * `reduceSensingWindow`, which returns buckets. There is no accessor that
 * returns them and no field on the payload that could carry them.
 */
import {
  reduceSensingWindow,
  type RawLocationSample,
  type RawMotionSample,
  type RawSensingWindow,
  type ReducedWindow,
} from '../../lib/sensing/normalizedFeatures.ts';
import {
  buildContributionPayload,
  type PayloadRefusal,
  type SensingContributionPayload,
} from '../../lib/sensing/contributionPayload.ts';
import {
  extractAcousticFeatures,
  type AcousticMeterSample,
} from '../../lib/sensing/acousticFeatures.ts';
import {
  acousticCaptureAllowed,
  type AcousticPermission,
} from '../../lib/sensing/acousticPermission.ts';

export type Unsubscribe = () => void;

/** The accelerometer, as a seam. expo-sensors' Accelerometer fits this shape. */
export interface MotionSource {
  subscribe(onSample: (s: RawMotionSample) => void): Unsubscribe;
}

/** The GPS, as a seam. expo-location's watchPositionAsync fits this shape. */
export interface LocationSource {
  subscribe(onSample: (s: RawLocationSample) => void): Unsubscribe;
}

/**
 * The audio METER, as a seam. Not a recorder: the only thing that crosses this
 * interface is a dBFS number. Present only when the separate acoustic
 * permission is held — see `acousticPermission.ts`.
 */
export interface AcousticMeterSource {
  subscribe(onSample: (s: AcousticMeterSample) => void): Unsubscribe;
}

export type CaptureRefusal = PayloadRefusal | 'no_window_evidence';

export interface SensingCaptureDeps {
  motion: MotionSource | null;
  location: LocationSource | null;
  /** Only ever supplied when `acousticPermission()` allows it. */
  acoustic?: AcousticMeterSource | null;
  /** Read fresh at every window: a revocation must take effect immediately. */
  acousticPermission?: () => AcousticPermission | null;
  now(): number;
  /** Schedule a repeating tick; returns its canceller. */
  schedule(fn: () => void, everyMs: number): Unsubscribe;
  submit(payload: SensingContributionPayload): void | Promise<void>;
  /** Window length. Default 5 minutes. */
  windowMs?: number;
  spatialPrecision?: number;
  temporalBucketMinutes?: number;
  /** Context the app already resolved. Never derived from a coordinate here. */
  canonicalPlaceCandidate?: () => string | null;
  /** Called instead of `submit` when a window produces nothing sendable. */
  onRefusal?: (reason: CaptureRefusal) => void;
}

export interface SensingCaptureHandle {
  /** Close the window now, reduce, submit, and start the next one. */
  flush(): Promise<void>;
  stop(): void;
  /**
   * The coarse zone label of the LAST REDUCED window — the same spatial bucket
   * stamped on the contribution that window produced — or null before the
   * first window closes or after stop(). Never a coordinate: it is the output
   * of `encodeSpatialBucket` at the capped precision and nothing finer exists
   * to return. Read by the Compass ask so a turn can name the zone its own
   * device is in (census-sensing §21.4 blocker #3).
   */
  currentZone(): string | null;
  /** TEST SEAM. How many raw samples are currently held. Never their values. */
  _rawBufferSizes(): { motion: number; location: number; acoustic: number };
}

/** Default window: long enough for a cadence estimate, short enough to be current. */
export const DEFAULT_SENSING_WINDOW_MS = 5 * 60_000;

/**
 * Hard cap on retained raw samples per window. A stuck sensor must not grow the
 * buffer without bound; oldest are dropped, which degrades the window's
 * `sensor_health` rather than the process.
 */
export const MAX_RAW_SAMPLES_PER_WINDOW = 4_000;

function push<T>(buf: T[], sample: T): void {
  buf.push(sample);
  if (buf.length > MAX_RAW_SAMPLES_PER_WINDOW) buf.shift();
}

export function startSensingCapture(deps: SensingCaptureDeps): SensingCaptureHandle {
  const windowMs = deps.windowMs ?? DEFAULT_SENSING_WINDOW_MS;

  // The raw buffers. Nothing outside this closure can read them.
  let motionBuf: RawMotionSample[] = [];
  let locationBuf: RawLocationSample[] = [];
  let acousticBuf: AcousticMeterSample[] = [];

  let windowStart = deps.now();
  let previousZone: string | null = null;
  let priorDwellMs = 0;
  let stopped = false;

  const unsubs: Unsubscribe[] = [];
  if (deps.motion) unsubs.push(deps.motion.subscribe((s) => push(motionBuf, s)));
  if (deps.location) unsubs.push(deps.location.subscribe((s) => push(locationBuf, s)));
  if (deps.acoustic) unsubs.push(deps.acoustic.subscribe((s) => push(acousticBuf, s)));

  async function closeWindow(): Promise<void> {
    if (stopped) return;
    const endedAtMs = deps.now();

    const window: RawSensingWindow = {
      startedAtMs: windowStart,
      endedAtMs,
      motion: motionBuf,
      location: locationBuf,
      previousZone,
      priorDwellMs,
      canonicalPlaceCandidate: deps.canonicalPlaceCandidate?.() ?? null,
    };

    const hadEvidence = motionBuf.length > 0 || locationBuf.length > 0;
    const acousticSamples = acousticBuf;

    // ── The raw samples end here. Everything below this line is buckets. ─────
    motionBuf = [];
    locationBuf = [];
    acousticBuf = [];
    windowStart = endedAtMs;

    if (!hadEvidence) {
      deps.onRefusal?.('no_window_evidence');
      return;
    }

    const reduced: ReducedWindow = reduceSensingWindow(window, {
      spatialPrecision: deps.spatialPrecision,
      temporalBucketMinutes: deps.temporalBucketMinutes,
    });
    previousZone = reduced.features.spatial_bucket.zone;
    priorDwellMs = reduced.dwellMs ?? 0;

    // Acoustic is re-gated per window, on the permission as it is NOW: a user
    // who revokes mid-window must not have that window's audio summarised.
    const permission = deps.acousticPermission?.() ?? null;
    let acoustic = null;
    if (acousticSamples.length > 0 && acousticCaptureAllowed(permission)) {
      const extracted = extractAcousticFeatures(permission, acousticSamples, acousticSamples.length);
      if (extracted.ok) acoustic = extracted.features;
    }

    const built = buildContributionPayload(reduced, { acoustic });
    if (!built.ok) {
      deps.onRefusal?.(built.reason);
      return;
    }
    await deps.submit(built.payload);
  }

  const cancelTick = deps.schedule(() => {
    void closeWindow();
  }, windowMs);

  return {
    currentZone: () => (stopped ? null : previousZone),
    flush: closeWindow,
    stop() {
      stopped = true;
      cancelTick();
      for (const u of unsubs) {
        try {
          u();
        } catch {
          // A source that throws on teardown must not strand the others.
        }
      }
      motionBuf = [];
      locationBuf = [];
      acousticBuf = [];
    },
    _rawBufferSizes() {
      return {
        motion: motionBuf.length,
        location: locationBuf.length,
        acoustic: acousticBuf.length,
      };
    },
  };
}
