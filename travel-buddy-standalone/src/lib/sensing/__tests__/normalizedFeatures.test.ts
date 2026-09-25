/**
 * normalizedFeatures — census S28, and the half of S51 the client owns.
 *
 * ── WHAT S28 ASKS FOR, VERBATIM ──────────────────────────────────────────────
 * "RED WHEN a client capture module produces the nine named features." The nine
 * are §4.1's NORMALIZED SIGNAL FEATURES box: spatial bucket / canonical-place
 * candidate, temporal bucket, movement_state, motion_energy, periodicity,
 * dwell_bucket, arrival/departure transition, transport-mode likelihood,
 * confidence / sensor health.
 *
 * The first test pins the SET — exactly nine, exactly those names — because a
 * module that produced eight of them, or nine of its own choosing, would look
 * built and would not be. The rest pin that each one is actually COMPUTED:
 * every feature is asserted against a neighbouring window that should move it,
 * so a reduction that returned a constant fails.
 *
 * ── S51's CLIENT HALF ────────────────────────────────────────────────────────
 * "RED WHEN S28 exists AND a density input joins VibeFeatureInput." The server
 * field is another lane's; what is proved here is that this device emits a
 * signal literally named `density` carrying a BUCKET, and — the part that
 * matters more — that it answers `unknown` rather than `sparse` whenever this
 * device has no standing to judge. §4.4: one device never becomes a crowd.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DENSITY_BUCKET_EDGES,
  MIN_MOTION_SAMPLES,
  SENSING_FEATURE_NAMES,
  boundedMovement,
  densityObservation,
  dwellBucket,
  motionEnergy,
  periodicity,
  reduceSensingWindow,
  transportModeLikelihood,
  type RawLocationSample,
  type RawMotionSample,
  type RawSensingWindow,
} from '../normalizedFeatures.ts';
import { encodeSpatialBucket, SENSING_SPATIAL_PRECISION } from '../spatialBucket.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-09-25T21:14:37.412Z');

/** 20 Hz accelerometer, `seconds` long, a sinusoid at `hz` with amplitude `amp` g. */
function periodicMotion(seconds: number, hz: number, amp: number): RawMotionSample[] {
  const out: RawMotionSample[] = [];
  const n = seconds * 20;
  for (let i = 0; i < n; i += 1) {
    const t = i / 20;
    out.push({ t: T0 + i * 50, x: 0, y: 0, z: 1 + amp * Math.sin(2 * Math.PI * hz * t) });
  }
  return out;
}

/** 20 Hz accelerometer with no rhythm: a deterministic pseudo-random walk. */
function noisyMotion(seconds: number, amp: number): RawMotionSample[] {
  const out: RawMotionSample[] = [];
  const n = seconds * 20;
  let seed = 7;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const r = seed / 2147483648 - 0.5;
    out.push({ t: T0 + i * 50, x: 0, y: 0, z: 1 + amp * r * 2 });
  }
  return out;
}

/** Fixes 30 s apart at a fixed speed, walking due east from a start point. */
function fixes(count: number, speedMps: number, lat = 51.5072531, lng = -0.1275921): RawLocationSample[] {
  const out: RawLocationSample[] = [];
  const metresPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < count; i += 1) {
    out.push({
      t: T0 + i * 30_000,
      lat,
      lng: lng + (i * speedMps * 30) / metresPerDegLng,
      accuracyM: 12,
      speedMps,
    });
  }
  return out;
}

function windowOf(partial: Partial<RawSensingWindow>): RawSensingWindow {
  return {
    startedAtMs: T0,
    endedAtMs: T0 + 5 * 60_000,
    motion: [],
    location: [],
    ...partial,
  };
}

// ── S28: the set ─────────────────────────────────────────────────────────────

describe('S28 — the nine named §4.1 features', () => {
  test('SENSING_FEATURE_NAMES is exactly the nine the spec names, in its order', () => {
    assert.deepEqual([...SENSING_FEATURE_NAMES], [
      'spatial_bucket',
      'temporal_bucket',
      'movement_state',
      'motion_energy',
      'periodicity',
      'dwell_bucket',
      'transition',
      'transport_mode_likelihood',
      'sensor_health',
    ]);
    assert.equal(SENSING_FEATURE_NAMES.length, 9, 'nine, not eight and not ten');
  });

  test('a real window produces every one of the nine — no missing key, no extra key', () => {
    const reduced = reduceSensingWindow(
      windowOf({ motion: periodicMotion(10, 2, 0.5), location: fixes(6, 0.9) }),
    );
    assert.deepEqual(
      Object.keys(reduced.features).sort(),
      [...SENSING_FEATURE_NAMES].sort(),
      'the reduction must produce exactly the nine named features',
    );
    for (const name of SENSING_FEATURE_NAMES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(reduced.features, name),
        `${name} is missing from the reduction`,
      );
    }
  });

  test('spatial_bucket carries a zone, its precision and a canonical-place candidate', () => {
    const reduced = reduceSensingWindow(
      windowOf({
        motion: periodicMotion(10, 2, 0.4),
        location: fixes(4, 0.8),
        canonicalPlaceCandidate: 'place-abc',
      }),
    );
    const sb = reduced.features.spatial_bucket;
    assert.equal(typeof sb.zone, 'string');
    assert.equal(sb.precision, SENSING_SPATIAL_PRECISION);
    assert.equal(sb.canonicalPlaceCandidate, 'place-abc');
    // The zone is a label, not a pair of numbers — the server refuses those.
    assert.doesNotMatch(sb.zone as string, /[-+]?\d+(\.\d+)?\s*,\s*[-+]?\d+(\.\d+)?/);
  });

  test('temporal_bucket is a coarse bucket START, not the instant of the reading', () => {
    const reduced = reduceSensingWindow(
      windowOf({ endedAtMs: T0 + 5 * 60_000, motion: periodicMotion(5, 2, 0.4) }),
    );
    const bucket = reduced.features.temporal_bucket as string;
    assert.ok(bucket.endsWith(':00.000Z'), `${bucket} still carries seconds`);
    const parsed = Date.parse(bucket);
    assert.equal(parsed % (30 * 60_000), 0, 'bucket must land on a 30-minute boundary');
    assert.notEqual(parsed, T0 + 5 * 60_000, 'the bucket must not be the raw instant');
  });

  test('movement_state separates stationary, pedestrian and vehicular', () => {
    const still = reduceSensingWindow(
      windowOf({ motion: noisyMotion(10, 0.01), location: fixes(4, 0) }),
    );
    const walking = reduceSensingWindow(
      windowOf({ motion: periodicMotion(10, 1.9, 0.45), location: fixes(4, 1.2) }),
    );
    const riding = reduceSensingWindow(
      windowOf({ motion: noisyMotion(10, 0.02), location: fixes(4, 14) }),
    );
    assert.equal(still.features.movement_state, 'stationary');
    assert.equal(walking.features.movement_state, 'pedestrian');
    assert.equal(riding.features.movement_state, 'vehicular');
  });

  test('motion_energy is 0..1, rises with amplitude, and is NULL — not 0 — without samples', () => {
    const low = motionEnergy(periodicMotion(10, 2, 0.05));
    const high = motionEnergy(periodicMotion(10, 2, 0.6));
    assert.ok(low !== null && high !== null);
    assert.ok(low >= 0 && high <= 1, 'energy must stay inside 0..1');
    assert.ok(high > low + 0.2, `amplitude must move energy (${low} -> ${high})`);
    assert.equal(motionEnergy([]), null, 'no samples is unknown, never zero');
    assert.equal(
      motionEnergy(periodicMotion(10, 2, 0.5).slice(0, MIN_MOTION_SAMPLES - 1)),
      null,
      'below the sample floor is unknown, never zero',
    );
  });

  test('periodicity separates rhythm from noise, and is NULL when there is no motion to judge', () => {
    const rhythmic = periodicity(periodicMotion(10, 2, 0.5));
    const noisy = periodicity(noisyMotion(10, 0.5));
    assert.ok(rhythmic !== null, 'a 2 Hz sinusoid has a periodicity');
    assert.ok(rhythmic > 0.7, `a clean cadence should score high, got ${rhythmic}`);
    assert.ok(noisy === null || noisy < rhythmic - 0.3, `noise must not look rhythmic (${noisy})`);
    // THE INVARIANT vibeInference depends on: unknown periodicity is null, so
    // dance_likelihood becomes null rather than a number. A still device has no
    // rhythm to report, and reporting 0 would be a claim it stood still.
    assert.equal(periodicity(noisyMotion(10, 0.001)), null, 'too little energy is unknown');
    assert.equal(periodicity([]), null);
  });

  test('dwell_bucket is the 0..4 ordinal and climbs with time in one zone', () => {
    assert.equal(dwellBucket(60_000), 0);
    assert.equal(dwellBucket(5 * 60_000), 1);
    assert.equal(dwellBucket(20 * 60_000), 2);
    assert.equal(dwellBucket(60 * 60_000), 3);
    assert.equal(dwellBucket(180 * 60_000), 4);
    assert.equal(dwellBucket(null), null, 'unknown dwell is null, not rung 0');
  });

  test('dwell accumulates across windows only while the zone is unchanged', () => {
    const loc = fixes(4, 0.3);
    const zone = encodeSpatialBucket(loc[loc.length - 1].lat, loc[loc.length - 1].lng);
    const stayed = reduceSensingWindow(
      windowOf({ motion: periodicMotion(10, 2, 0.3), location: loc, previousZone: zone, priorDwellMs: 25 * 60_000 }),
    );
    assert.equal(stayed.dwellMs, 25 * 60_000 + 5 * 60_000);
    assert.equal(stayed.features.dwell_bucket, 3, '30 minutes is rung 3');

    const moved = reduceSensingWindow(
      windowOf({ motion: periodicMotion(10, 2, 0.3), location: loc, previousZone: 'u10hz0', priorDwellMs: 25 * 60_000 }),
    );
    assert.equal(moved.dwellMs, 5 * 60_000, 'a new zone restarts the dwell clock');
  });

  test('transition names arrival, departure and none — and unknown without a prior zone', () => {
    const loc = fixes(4, 0.4);
    const zone = encodeSpatialBucket(loc[loc.length - 1].lat, loc[loc.length - 1].lng) as string;

    const settled = reduceSensingWindow(
      windowOf({ motion: periodicMotion(10, 2, 0.3), location: loc, previousZone: 'u10hz0' }),
    );
    assert.equal(settled.features.transition, 'arrival');

    const stable = reduceSensingWindow(
      windowOf({ motion: periodicMotion(10, 2, 0.3), location: loc, previousZone: zone }),
    );
    assert.equal(stable.features.transition, 'none');

    const leaving = reduceSensingWindow(
      windowOf({ motion: noisyMotion(10, 0.02), location: fixes(4, 16), previousZone: zone }),
    );
    assert.equal(leaving.features.transition, 'departure');

    const firstEver = reduceSensingWindow(windowOf({ motion: periodicMotion(10, 2, 0.3), location: loc }));
    assert.equal(firstEver.features.transition, 'unknown', 'no prior zone is unknown, not "none"');
  });

  test('transport_mode_likelihood is a distribution over the four modes, or NULL', () => {
    const riding = transportModeLikelihood(fixes(4, 16), 0.03, null);
    assert.ok(riding !== null);
    assert.deepEqual(Object.keys(riding).sort(), ['cycling', 'pedestrian', 'stationary', 'vehicular']);
    const total = Object.values(riding).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `must sum to 1, got ${total}`);
    assert.ok(riding.vehicular > riding.pedestrian, 'a 16 m/s median is not walking');

    const walking = transportModeLikelihood(fixes(4, 1.3), 0.5, 0.8);
    assert.ok(walking !== null && walking.pedestrian > walking.vehicular);

    assert.equal(transportModeLikelihood([], null, null), null, 'no evidence is null, not a flat 0.25');
  });

  test('sensor_health reports counts and names its degradations', () => {
    const healthy = reduceSensingWindow(
      windowOf({ motion: periodicMotion(10, 2, 0.4), location: fixes(5, 1) }),
    ).features.sensor_health;
    assert.equal(healthy.motionSampleCount, 200);
    assert.equal(healthy.locationSampleCount, 5);
    assert.deepEqual([...healthy.degraded], []);
    assert.equal(healthy.confidence, 1);

    const blind = reduceSensingWindow(windowOf({ location: fixes(1, 0) })).features.sensor_health;
    assert.ok(blind.degraded.includes('no_motion_samples'));
    assert.ok(blind.degraded.includes('sparse_location_fixes'));
    assert.ok(blind.confidence < 0.5, 'a window that saw almost nothing must say so');

    const coarse = reduceSensingWindow(
      windowOf({
        motion: periodicMotion(10, 2, 0.4),
        location: fixes(4, 1).map((f) => ({ ...f, accuracyM: 900 })),
      }),
    ).features.sensor_health;
    assert.ok(coarse.degraded.includes('coarse_location_only'));
  });
});

// ── S51's client half: a bucketed `density` ──────────────────────────────────

describe('S51 (client half) — a bucketed `density` signal', () => {
  test('the reduction emits a field literally named `density`', () => {
    const reduced = reduceSensingWindow(
      windowOf({ motion: periodicMotion(10, 2, 0.4), location: fixes(5, 0.9) }),
    );
    assert.ok(Object.prototype.hasOwnProperty.call(reduced, 'density'), 'the field must be named density');
    assert.ok(
      ['unknown', 'sparse', 'moderate', 'busy', 'packed'].includes(reduced.density),
      `density must be one of the five buckets, got ${reduced.density}`,
    );
  });

  test('free-flowing walking reads sparse; heavily impeded walking reads packed', () => {
    const free = densityObservation(fixes(6, 1.4), 0.4, 'pedestrian');
    const packed = densityObservation(fixes(6, 0.28), 0.4, 'pedestrian');
    assert.equal(free, 'sparse');
    assert.equal(packed, 'packed');
    assert.ok(DENSITY_BUCKET_EDGES.length === 3, 'three edges, four judged rungs plus unknown');
  });

  test('a device with no standing to judge answers `unknown`, never `sparse` (§20)', () => {
    // Insufficient coverage is not quiet. A phone on a table and a phone in a
    // taxi both know nothing about how crowded the room is.
    assert.equal(densityObservation(fixes(6, 0), 0.01, 'stationary'), 'unknown');
    assert.equal(densityObservation(fixes(6, 16), 0.02, 'vehicular'), 'unknown');
    assert.equal(densityObservation([], null, 'unknown'), 'unknown');
    assert.equal(densityObservation(fixes(1, 1), 0.4, 'pedestrian'), 'unknown', 'one fix is not a judgement');
  });
});

// ── §5.2's other client-side candidate ───────────────────────────────────────

describe('bounded spatial movement (§5.2 candidate)', () => {
  test('true when the whole window stays put, false when it travels, null without fixes', () => {
    assert.equal(boundedMovement(fixes(4, 0.1)), true);
    assert.equal(boundedMovement(fixes(4, 12)), false);
    assert.equal(boundedMovement([]), null, 'unknown is null, not false');
  });
});
