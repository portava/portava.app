/**
 * contributionPayload — the wire shape, and the one place the device decides
 * what is allowed to leave it.
 *
 * ── CENSUS S21, RESTATED AS CODE ─────────────────────────────────────────────
 * "`travel-buddy-standalone/` reduces on device — bucketed features, no
 * coordinate leaving the handset". `buildContributionPayload` takes a
 * `ReducedWindow` (already bucketed) and returns a flat object of buckets,
 * ordinals and enum strings. It NEVER takes a `RawSensingWindow`, so there is
 * no code path by which a coordinate or an accelerometer sample could reach the
 * wire, and `contributionPayload.privacy.test.ts` walks the serialised result
 * for the sentinel values of both to prove it.
 *
 * Three properties the tests pin, each one a way this could have gone wrong:
 *
 *   1. NO COORDINATE.  Latitude and longitude appear nowhere, under any key
 *      name, at any nesting depth, including as a substring of a serialised
 *      number.
 *   2. NO RAW SAMPLE.  Accelerometer x/y/z, per-fix speeds and accuracies do
 *      not appear. `sensor_health` carries COUNTS of samples, which is how many
 *      arrived, not what they said.
 *   3. NO PRECISE INSTANT.  `observed_at_ms` is the START of the temporal
 *      bucket, not the moment of the reading — `observed_at_ms ===
 *      Date.parse(temporal_bucket)` is asserted, so a future edit that passes
 *      `Date.now()` through fails. Precise time plus a coarse zone is a
 *      trajectory; the bucket is what breaks that.
 *
 * ── WHY IT LOOKS LIKE THE SERVER'S STORE ─────────────────────────────────────
 * `zone_id`, `time_bucket`, `signal_bucket`, `reduction_version` are the names
 * `artifacts/api-server/src/lib/sensingAnonStore.ts` already uses, so an ingest
 * route can map this without a translation layer. The nine §4.1 features and
 * `density` are additions to that shape, not replacements for it. Note what is
 * absent and, per that store's own comment, must stay absent: any account,
 * device or installation identifier. This builder has no parameter for one.
 */
import type {
  DensityBucket,
  MovementState,
  ReducedWindow,
  TransitionKind,
  TransportMode,
} from './normalizedFeatures.ts';
import type { AcousticFeatures } from './acousticFeatures.ts';

/** Mirrors the server's SENSING_REDUCTION_VERSION. Bump both together. */
export const SENSING_CLIENT_REDUCTION_VERSION = 1;

/** The 0..4 ordinal the anonymous store takes (SENSING_BUCKET_MIN/MAX). */
export const SIGNAL_BUCKET_MIN = 0;
export const SIGNAL_BUCKET_MAX = 4;

export interface SensingContributionPayload {
  /** What the client's reduction means. The server refuses versions it lacks. */
  reduction_version: number;

  // ── §4.1's nine, flattened for the wire ────────────────────────────────────
  /** spatial bucket. A coarse zone label; never a coordinate. */
  zone_id: string;
  /** The precision the zone was cut at, so the server can size the cell. */
  zone_precision: number;
  /** canonical-place candidate: an id the app already held, or null. */
  canonical_place_candidate: string | null;
  /** temporal bucket, ISO, bucket START. */
  time_bucket: string;
  movement_state: MovementState;
  motion_energy: number | null;
  periodicity: number | null;
  dwell_bucket: number | null;
  transition: TransitionKind;
  transport_mode_likelihood: Readonly<Record<TransportMode, number>> | null;
  sensor_health: {
    confidence: number;
    motion_sample_count: number;
    location_sample_count: number;
    degraded: readonly string[];
  };

  // ── §5.2 candidates the same window supports ───────────────────────────────
  /** §5.2's `density`. A BUCKET, and this one device's observation of it. */
  density: DensityBucket;
  /** §5.2's "bounded spatial movement". */
  bounded_movement: boolean | null;

  // ── What the existing anonymous store needs ────────────────────────────────
  /** 0..4, derived from motion_energy. Unitless; meaning pinned by the version. */
  signal_bucket: number;
  /** The bucket start as ms. Equal to Date.parse(time_bucket), by construction. */
  observed_at_ms: number;

  /** §4.1's optional acoustic pair. Present ONLY with the separate permission. */
  acoustic?: {
    scope: string;
    energy_bucket: number;
    rhythm_bucket: string;
    confidence: number;
  };
}

export type PayloadRefusal =
  | 'no_zone'
  | 'no_temporal_bucket'
  | 'acoustic_without_permission';

export type PayloadResult =
  | { ok: true; payload: SensingContributionPayload }
  | { ok: false; reason: PayloadRefusal };

/**
 * The 0..4 ordinal from 0..1 energy. A window with unknown energy is rung 0 —
 * the store has no "unknown" rung, so the nine features carry the real answer
 * (`motion_energy: null`) and this ordinal is the lossy legacy companion. It is
 * never the only thing sent.
 */
export function signalBucketFor(energy: number | null): number {
  if (energy === null || !Number.isFinite(energy)) return SIGNAL_BUCKET_MIN;
  const rung = Math.floor(Math.min(1, Math.max(0, energy)) * 5);
  return Math.min(SIGNAL_BUCKET_MAX, Math.max(SIGNAL_BUCKET_MIN, rung));
}

export interface BuildPayloadOptions {
  /** Present only when the separate acoustic permission produced them. */
  acoustic?: AcousticFeatures | null;
}

/**
 * Build the outbound payload from an already-reduced window.
 *
 * Refuses rather than invents. No zone means there is nothing to contribute to
 * a cohort, so the window is dropped on the device — it does not become a
 * contribution with a null zone that the server has to reason about.
 */
export function buildContributionPayload(
  reduced: ReducedWindow,
  opts: BuildPayloadOptions = {},
): PayloadResult {
  const f = reduced.features;
  if (f.spatial_bucket.zone === null) return { ok: false, reason: 'no_zone' };
  if (f.temporal_bucket === null) return { ok: false, reason: 'no_temporal_bucket' };

  const observedAtMs = Date.parse(f.temporal_bucket);
  if (!Number.isFinite(observedAtMs)) return { ok: false, reason: 'no_temporal_bucket' };

  const payload: SensingContributionPayload = {
    reduction_version: SENSING_CLIENT_REDUCTION_VERSION,
    zone_id: f.spatial_bucket.zone,
    zone_precision: f.spatial_bucket.precision,
    canonical_place_candidate: f.spatial_bucket.canonicalPlaceCandidate,
    time_bucket: f.temporal_bucket,
    movement_state: f.movement_state,
    motion_energy: f.motion_energy,
    periodicity: f.periodicity,
    dwell_bucket: f.dwell_bucket,
    transition: f.transition,
    transport_mode_likelihood: f.transport_mode_likelihood,
    sensor_health: {
      confidence: f.sensor_health.confidence,
      motion_sample_count: f.sensor_health.motionSampleCount,
      location_sample_count: f.sensor_health.locationSampleCount,
      degraded: f.sensor_health.degraded,
    },
    density: reduced.density,
    bounded_movement: reduced.boundedMovement,
    signal_bucket: signalBucketFor(f.motion_energy),
    // Deliberately derived FROM the bucket, not from the instant that produced
    // it. Test: observed_at_ms === Date.parse(time_bucket).
    observed_at_ms: observedAtMs,
  };

  if (opts.acoustic) {
    // Belt and braces: `extractAcousticFeatures` already refused without the
    // permission, and it stamps the scope it was authorised under. A features
    // object carrying any other scope is refused here rather than attached.
    if (opts.acoustic.scope !== 'sensing.acoustic.energy') {
      return { ok: false, reason: 'acoustic_without_permission' };
    }
    payload.acoustic = {
      scope: opts.acoustic.scope,
      energy_bucket: opts.acoustic.energyBucket,
      rhythm_bucket: opts.acoustic.rhythmBucket,
      confidence: opts.acoustic.confidence,
    };
  }

  return { ok: true, payload };
}
