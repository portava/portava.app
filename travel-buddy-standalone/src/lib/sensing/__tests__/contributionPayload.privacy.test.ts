/**
 * contributionPayload — census S21, the client half.
 *
 * ── THE ROW, VERBATIM ────────────────────────────────────────────────────────
 * "RED WHEN `travel-buddy-standalone/` reduces on device — bucketed features,
 * no coordinate leaving the handset — and a server path accepts them without
 * reading `location_snapshots` by `actor_id`."
 *
 * The second half is a server change and is not this file's business. The first
 * half is, and it is a NEGATIVE claim, which is the kind of claim that rots
 * silently: a reduction that is careful today stays correct only while
 * something fails when it stops being. That is what these tests are.
 *
 * ── HOW THE NEGATIVE IS PROVED ───────────────────────────────────────────────
 * The window is built from SENTINEL values — a latitude, a longitude, three
 * accelerometer axes, a speed, an accuracy and two precise instants, all chosen
 * so that no two are equal and none could arise by arithmetic accident. The
 * payload is then examined three ways:
 *
 *   1. serialised and searched for each sentinel as a STRING, which catches a
 *      coordinate nested at any depth under any key name;
 *   2. walked for every NUMBER it contains, none of which may equal any number
 *      that was in the raw window;
 *   3. walked for every KEY, none of which may be a coordinate-ish name — the
 *      same vocabulary the server's passportTelemetry scrubber already refuses
 *      (lat, lng, lon, coord, geometry, geohash, bbox, altitude).
 *
 * Plus the two subtler leaks a key-name scan alone would miss:
 *
 *   4. the zone is MANY-TO-ONE — two different coordinates inside one cell
 *      produce the identical label, so the original fix is not recoverable from
 *      what is sent; and
 *   5. `observed_at_ms` is the bucket START, not the instant of the reading,
 *      because a precise time beside a coarse zone is a trajectory.
 *
 * WATCHED IT FAIL: with `zone_id` replaced by the raw `lat,lng` pair, (1), (2)
 * and (4) all go red; with `observed_at_ms: Date.now()`, (5) goes red.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  reduceSensingWindow,
  type RawLocationSample,
  type RawMotionSample,
  type RawSensingWindow,
} from '../normalizedFeatures.ts';
import { buildContributionPayload, signalBucketFor } from '../contributionPayload.ts';
import {
  SENSING_SPATIAL_PRECISION_CEILING,
  encodeSpatialBucket,
} from '../spatialBucket.ts';

// ── Sentinels. Every one is distinctive enough that a substring hit is a leak,
//    not a coincidence. ──────────────────────────────────────────────────────

const SENTINEL = {
  lat: 51.5072531,
  lng: -0.1275921,
  ax: 0.1234567,
  ay: -0.7654321,
  az: 0.9876543,
  speedMps: 0.913577,
  accuracyM: 13.577531,
  firstFixT: 1758800000123,
  lastFixT: 1758800180456,
} as const;

function sentinelWindow(): RawSensingWindow {
  const motion: RawMotionSample[] = [];
  for (let i = 0; i < 200; i += 1) {
    const phase = Math.sin((2 * Math.PI * 2 * i) / 20);
    motion.push({
      t: SENTINEL.firstFixT + i * 50,
      // The exact sentinel axes appear in the first sample, so a payload that
      // copied "the first reading" would be caught.
      x: i === 0 ? SENTINEL.ax : SENTINEL.ax * phase,
      y: i === 0 ? SENTINEL.ay : SENTINEL.ay * phase,
      z: i === 0 ? SENTINEL.az : 1 + 0.4 * phase,
    });
  }
  const location: RawLocationSample[] = [
    {
      t: SENTINEL.firstFixT,
      lat: SENTINEL.lat,
      lng: SENTINEL.lng,
      accuracyM: SENTINEL.accuracyM,
      speedMps: SENTINEL.speedMps,
    },
    {
      t: SENTINEL.firstFixT + 30_000,
      lat: SENTINEL.lat + 0.00004,
      lng: SENTINEL.lng + 0.00006,
      accuracyM: SENTINEL.accuracyM,
      speedMps: SENTINEL.speedMps,
    },
    {
      t: SENTINEL.lastFixT,
      lat: SENTINEL.lat + 0.00009,
      lng: SENTINEL.lng + 0.00011,
      accuracyM: SENTINEL.accuracyM,
      speedMps: SENTINEL.speedMps,
    },
  ];
  return {
    startedAtMs: SENTINEL.firstFixT,
    endedAtMs: SENTINEL.lastFixT,
    motion,
    location,
    previousZone: null,
    priorDwellMs: 0,
    canonicalPlaceCandidate: null,
  };
}

function builtPayload() {
  const built = buildContributionPayload(reduceSensingWindow(sentinelWindow()));
  assert.ok(built.ok, `the fixture must produce a payload, got ${built.ok ? '' : built.reason}`);
  return built.payload;
}

/** Every number anywhere in a structure. */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) for (const v of value) numbersIn(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) numbersIn(v, out);
  return out;
}

/** Every key anywhere in a structure. */
function keysIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysIn(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysIn(v, out);
    }
  }
  return out;
}

describe('S21 — the device reduces, and no coordinate leaves the handset', () => {
  test('no sentinel value survives into the serialised payload', () => {
    const json = JSON.stringify(builtPayload());
    for (const [name, value] of Object.entries(SENTINEL)) {
      assert.ok(
        !json.includes(String(value)),
        `${name} (${value}) appears in the outbound payload: ${json}`,
      );
    }
    // And the shortened forms a rounding step might leave behind.
    for (const fragment of ['51.507', '-0.1275', '0.123456', '0.765432', '0.987654', '0.91357', '13.5775']) {
      assert.ok(!json.includes(fragment), `"${fragment}" appears in the outbound payload: ${json}`);
    }
  });

  test('no number in the payload equals any number that was in the raw window', () => {
    const payload = builtPayload();
    const w = sentinelWindow();
    const raw = new Set<number>();
    for (const s of w.motion) {
      raw.add(s.x);
      raw.add(s.y);
      raw.add(s.z);
      raw.add(s.t);
    }
    for (const s of w.location) {
      raw.add(s.lat);
      raw.add(s.lng);
      raw.add(s.t);
      if (s.accuracyM !== null) raw.add(s.accuracyM);
      if (s.speedMps !== null) raw.add(s.speedMps);
    }
    // Only the DISTINCTIVE raw values are searched for. A raw axis that happens
    // to be exactly 1 g collides with a confidence of 1 by coincidence, not by
    // leak, and a test that cannot tell the two apart is noise. Coordinates,
    // sentinel axes, speeds, accuracies and millisecond instants all survive
    // this filter; small round numbers do not.
    const distinctive = [...raw].filter((n) => !Number.isInteger(n) || Math.abs(n) >= 1000);
    assert.ok(distinctive.length > 100, 'the filter must not empty the haystack');
    const distinctiveSet = new Set(distinctive);
    for (const n of numbersIn(payload)) {
      assert.ok(!distinctiveSet.has(n), `the raw value ${n} reached the wire`);
    }
  });

  test('no key anywhere in the payload is a coordinate-ish name', () => {
    // The same vocabulary the server's passportTelemetry scrubber refuses.
    const forbidden = /(^|_)(lat|lng|lon|latitude|longitude|coord|coords|geometry|geohash|bbox|altitude|heading|accuracy)(_|$)/i;
    for (const key of keysIn(builtPayload())) {
      assert.doesNotMatch(key, forbidden, `payload key "${key}" names a coordinate`);
    }
  });

  test('the zone is MANY-TO-ONE: two fixes in one cell produce the identical label', () => {
    // If the label were invertible, "no coordinate left the handset" would be a
    // word game. Two points ~40 m apart must be indistinguishable in the output.
    const a = encodeSpatialBucket(SENTINEL.lat, SENTINEL.lng);
    const b = encodeSpatialBucket(SENTINEL.lat + 0.0003, SENTINEL.lng + 0.0004);
    assert.equal(a, b, 'the bucket must not distinguish two points inside one cell');
    assert.equal((a as string).length, SENSING_SPATIAL_PRECISION_CEILING);

    // And a caller cannot ask for a finer cut than the ceiling.
    const overreach = encodeSpatialBucket(SENTINEL.lat, SENTINEL.lng, 12);
    assert.equal(overreach, a, 'a request for finer precision must be clamped, not honoured');

    // A different city is a different label, so the reduction is not a constant.
    assert.notEqual(encodeSpatialBucket(48.8584, 2.2945), a);
  });

  test('observed_at_ms is the temporal bucket START, never the instant of the reading', () => {
    const payload = builtPayload();
    assert.equal(
      payload.observed_at_ms,
      Date.parse(payload.time_bucket),
      'observed_at_ms must be derived from the bucket, not from the clock',
    );
    assert.notEqual(payload.observed_at_ms, SENTINEL.lastFixT);
    assert.notEqual(payload.observed_at_ms, SENTINEL.firstFixT);
    assert.equal(payload.observed_at_ms % (30 * 60_000), 0, 'it must land on a bucket boundary');
  });

  test('what the payload DOES carry is the nine features, bucketed, plus density', () => {
    const payload = builtPayload();
    assert.equal(typeof payload.zone_id, 'string');
    assert.equal(payload.zone_precision, SENSING_SPATIAL_PRECISION_CEILING);
    assert.ok(typeof payload.time_bucket === 'string');
    assert.ok(['stationary', 'pedestrian', 'vehicular', 'unknown'].includes(payload.movement_state));
    assert.ok(payload.motion_energy === null || (payload.motion_energy >= 0 && payload.motion_energy <= 1));
    assert.ok(payload.periodicity === null || (payload.periodicity >= 0 && payload.periodicity <= 1));
    assert.ok(payload.dwell_bucket === null || (payload.dwell_bucket >= 0 && payload.dwell_bucket <= 4));
    assert.ok(['arrival', 'departure', 'none', 'unknown'].includes(payload.transition));
    assert.ok(payload.transport_mode_likelihood === null || typeof payload.transport_mode_likelihood === 'object');
    assert.equal(typeof payload.sensor_health.confidence, 'number');
    assert.equal(payload.sensor_health.motion_sample_count, 200, 'a COUNT of samples is not a sample');
    assert.ok(['unknown', 'sparse', 'moderate', 'busy', 'packed'].includes(payload.density));
    assert.ok(payload.signal_bucket >= 0 && payload.signal_bucket <= 4);
  });

  test('no account, device or installation identifier is representable in the payload', () => {
    // The server's store makes identity unrepresentable in its row type; the
    // client must not be the place one is added back.
    const forbidden = /(user|actor|account|profile|device|installation|session)_?id/i;
    for (const key of keysIn(builtPayload())) {
      assert.doesNotMatch(key, forbidden, `payload key "${key}" names an identity`);
    }
  });

  test('a window with no zone is DROPPED on the device, not sent with a null zone', () => {
    const noFixes = reduceSensingWindow({
      startedAtMs: SENTINEL.firstFixT,
      endedAtMs: SENTINEL.lastFixT,
      motion: sentinelWindow().motion,
      location: [],
    });
    const built = buildContributionPayload(noFixes);
    assert.equal(built.ok, false);
    assert.equal(built.ok === false && built.reason, 'no_zone');
  });

  test('signal_bucket stays inside the store’s 0..4 range for every energy', () => {
    for (const e of [null, 0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      const b = signalBucketFor(e);
      assert.ok(Number.isInteger(b) && b >= 0 && b <= 4, `energy ${e} produced ${b}`);
    }
  });
});
