/**
 * wireContribution — the ONE mapping from the device's reduced payload to the
 * body the server's ingest route accepts.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * census-sensing §26 measured the client and the server disagreeing about the
 * wire: the client posted `buildContributionPayload`'s snake_case object with
 * a `rotationEpoch` spread in, and the server's `contributionSchema` is
 * `.strict()`, camelCase, and REQUIRES a `commitment` the client never sent.
 * Every real submission would have been refused `invalid_payload` — a client
 * that reduces perfectly and a server that accepts nothing it sends. Two
 * suites, both green, no contribution.
 *
 * The fix is a contract with a fixture both sides read:
 * `docs/contracts/sensing-contribution-wire-v1.json`. This mapper must produce
 * that fixture's `body` from its `payload` (asserted here); the server's
 * schema must accept that `body` verbatim (asserted there). Change the
 * fixture and one side goes red until the other follows.
 *
 * ── WHAT IS COARSENED ON THE WAY OUT ─────────────────────────────────────────
 * The reduced payload carries a few 0..1 floats. They leave as CENTI-ordinals
 * (0..100 integers): a device that emitted `motion_energy: 0.3471` sends `35`.
 * Two devices in one cohort with slightly different arithmetic then send the
 * same number, and no float precision rides out that could carry anything
 * the bucket does not. `transport_mode_likelihood` leaves as the arg-max mode
 * and its centi — one class, one confidence — rather than a distribution.
 * `time_bucket` does not leave at all: the server derives the bucket from
 * `observedAtMs` (which IS the bucket start) with its own width, so sending
 * both would let them disagree.
 *
 * ── WHAT NEVER LEAVES ────────────────────────────────────────────────────────
 * No coordinate (the payload never had one — `contributionPayload.privacy.
 * test.ts`), no `time_bucket`, no sample counts (only the health centi), no
 * account/device/installation/session identifier. The commitment is the
 * device's per-epoch hash commitment (`commitment.ts`), not an identity.
 */
import type { SensingContributionPayload } from './contributionPayload.ts';
import type { TransportMode } from './normalizedFeatures.ts';

export const SENSING_WIRE_VERSION = 1;

export interface WireIdentity {
  /** `deviceCommitment(deviceSecret, rotationEpoch)` — see commitment.ts. */
  commitment: string;
  rotationEpoch: number;
}

export interface WireAcoustic {
  energyBucket: number;
  rhythmBucket: string;
  confidenceCenti: number;
}

export interface WireFeatures {
  zonePrecision: number;
  placeCandidate: string | null;
  movementState: string;
  motionEnergyCenti: number | null;
  periodicityCenti: number | null;
  dwellBucket: number | null;
  transition: string;
  transportMode: TransportMode | null;
  transportModeCenti: number | null;
  density: string;
  boundedMovement: boolean | null;
  sensorHealthCenti: number;
  acoustic?: WireAcoustic;
}

/** Exactly the keys the server's `contributionSchema` admits, in its spelling. */
export interface WireContribution {
  commitment: string;
  rotationEpoch: number;
  zoneId: string;
  observedAtMs: number;
  signalBucket: number;
  reductionVersion: number;
  features: WireFeatures;
}

/** 0..1 → 0..100 integer; null/non-finite stays null. Clamped, never wrapped. */
export function centi(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.round(Math.min(1, Math.max(0, v)) * 100);
}

function argmaxMode(
  likelihood: Readonly<Record<TransportMode, number>> | null,
): { mode: TransportMode | null; centi: number | null } {
  if (!likelihood) return { mode: null, centi: null };
  let best: TransportMode | null = null;
  let bestV = -1;
  for (const mode of ['stationary', 'pedestrian', 'cycling', 'vehicular'] as const) {
    const v = likelihood[mode];
    if (typeof v === 'number' && Number.isFinite(v) && v > bestV) {
      best = mode;
      bestV = v;
    }
  }
  return best === null ? { mode: null, centi: null } : { mode: best, centi: centi(bestV) };
}

export function toWireContribution(
  payload: SensingContributionPayload,
  identity: WireIdentity,
): WireContribution {
  if (!identity || typeof identity.commitment !== 'string' || identity.commitment.length < 16) {
    throw new Error('toWireContribution: a commitment is required');
  }
  if (!Number.isInteger(identity.rotationEpoch) || identity.rotationEpoch < 0) {
    throw new Error('toWireContribution: rotationEpoch must be a non-negative integer');
  }
  const mode = argmaxMode(payload.transport_mode_likelihood);
  const features: WireFeatures = {
    zonePrecision: payload.zone_precision,
    placeCandidate: payload.canonical_place_candidate ?? null,
    movementState: payload.movement_state,
    motionEnergyCenti: centi(payload.motion_energy),
    periodicityCenti: centi(payload.periodicity),
    dwellBucket: payload.dwell_bucket ?? null,
    transition: payload.transition,
    transportMode: mode.mode,
    transportModeCenti: mode.centi,
    density: payload.density,
    boundedMovement: payload.bounded_movement ?? null,
    sensorHealthCenti: centi(payload.sensor_health?.confidence) ?? 0,
  };
  if (payload.acoustic) {
    features.acoustic = {
      energyBucket: payload.acoustic.energy_bucket,
      rhythmBucket: payload.acoustic.rhythm_bucket,
      confidenceCenti: centi(payload.acoustic.confidence) ?? 0,
    };
  }
  return {
    commitment: identity.commitment,
    rotationEpoch: identity.rotationEpoch,
    zoneId: payload.zone_id,
    observedAtMs: payload.observed_at_ms,
    signalBucket: payload.signal_bucket,
    reductionVersion: payload.reduction_version,
    features,
  };
}
