/**
 * sensingCapture + sensingTransport — the loop, end to end, with fake hardware.
 *
 * The reduction is proved next door in `src/lib/sensing/__tests__`. What is
 * proved HERE is the thing a pure-function test cannot reach: that the running
 * loop — subscribing to a live accelerometer and a live GPS, accumulating,
 * closing a window, submitting — carries buckets and drops the raw samples.
 *
 * ── THE THREE THINGS THIS FILE EXISTS FOR ────────────────────────────────────
 *   1. S28, as behaviour: a subscribed motion source and location source
 *      produce a submitted payload carrying the nine named features.
 *   2. S21, at the only place it can really be checked: what `submit` RECEIVES.
 *      The sources emit sentinel coordinates and sentinel accelerometer axes,
 *      and none of them may appear in the submitted object.
 *   3. The raw buffer is emptied when the window closes, so a captured sample's
 *      lifetime is one window and not the process.
 *
 * And for the transport: the ingest request carries the opaque credential and
 * NOT the account token (§3's split between eligibility and ingest).
 *
 * WATCHED IT FAIL: with the two `motionBuf = []` / `locationBuf = []` lines
 * removed from `closeWindow`, the buffer test goes red; with `submit` handed
 * `window` instead of `built.payload`, the sentinel test goes red; with an
 * `Authorization` header added to the ingest request, the transport test does.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  startSensingCapture,
  type AcousticMeterSource,
  type LocationSource,
  type MotionSource,
  type SensingCaptureDeps,
} from '../sensingCapture.ts';
import { SENSING_FEATURE_NAMES } from '../../../lib/sensing/normalizedFeatures.ts';
import type { SensingContributionPayload } from '../../../lib/sensing/contributionPayload.ts';
import {
  ACOUSTIC_SENSING_SCOPE,
  type AcousticPermission,
} from '../../../lib/sensing/acousticPermission.ts';
import {
  SENSING_CREDENTIAL_HEADER,
  createSensingTransport,
} from '../sensingTransport.ts';

// ── Sentinels the fake hardware emits ────────────────────────────────────────

const LAT = 40.7484405;
const LNG = -73.9856644;
const AX = 0.2468013;
const T_START = 1790000000000;

/** A fake accelerometer whose samples the test drives by hand. */
function fakeMotion(): MotionSource & { emit(n: number): void } {
  let cb: ((s: { t: number; x: number; y: number; z: number }) => void) | null = null;
  return {
    subscribe(on) {
      cb = on;
      return () => {
        cb = null;
      };
    },
    emit(n) {
      for (let i = 0; i < n; i += 1) {
        const phase = Math.sin((2 * Math.PI * 2 * i) / 20);
        cb?.({ t: T_START + i * 50, x: i === 0 ? AX : AX * phase, y: 0, z: 1 + 0.45 * phase });
      }
    },
  };
}

/** A fake GPS walking east at 0.8 m/s from the sentinel fix. */
function fakeLocation(): LocationSource & { emit(n: number): void } {
  let cb: ((s: {
    t: number;
    lat: number;
    lng: number;
    accuracyM: number | null;
    speedMps: number | null;
  }) => void) | null = null;
  const metresPerDegLng = 111_320 * Math.cos((LAT * Math.PI) / 180);
  return {
    subscribe(on) {
      cb = on;
      return () => {
        cb = null;
      };
    },
    emit(n) {
      for (let i = 0; i < n; i += 1) {
        cb?.({
          t: T_START + i * 30_000,
          lat: LAT,
          lng: LNG + (i * 0.8 * 30) / metresPerDegLng,
          accuracyM: 11,
          speedMps: 0.8,
        });
      }
    },
  };
}

function fakeAcoustic(): AcousticMeterSource & { emit(n: number): void } {
  let cb: ((s: { t: number; dbfs: number }) => void) | null = null;
  return {
    subscribe(on) {
      cb = on;
      return () => {
        cb = null;
      };
    },
    emit(n) {
      for (let i = 0; i < n; i += 1) {
        cb?.({ t: T_START + i * 250, dbfs: -24 + 8 * Math.sin((2 * Math.PI * i) / 8) });
      }
    },
  };
}

interface Harness {
  submitted: SensingContributionPayload[];
  refusals: string[];
  motion: ReturnType<typeof fakeMotion>;
  location: ReturnType<typeof fakeLocation>;
  acoustic: ReturnType<typeof fakeAcoustic>;
  handle: ReturnType<typeof startSensingCapture>;
}

function harness(overrides: Partial<SensingCaptureDeps> = {}): Harness {
  const submitted: SensingContributionPayload[] = [];
  const refusals: string[] = [];
  const motion = fakeMotion();
  const location = fakeLocation();
  const acoustic = fakeAcoustic();
  let clock = T_START;

  const handle = startSensingCapture({
    motion,
    location,
    acoustic: null,
    now: () => {
      clock += 5 * 60_000;
      return clock;
    },
    // No timer in the test: windows are closed with flush(), deterministically.
    schedule: () => () => undefined,
    submit: (p) => {
      submitted.push(p);
    },
    onRefusal: (r) => {
      refusals.push(r);
    },
    ...overrides,
  });

  return { submitted, refusals, motion, location, acoustic, handle };
}

describe('S28 — the running loop produces the nine features', () => {
  test('a window of real samples is submitted as the nine named features', async () => {
    const h = harness();
    h.motion.emit(200);
    h.location.emit(5);
    await h.handle.flush();
    h.handle.stop();

    assert.equal(h.submitted.length, 1, `expected one submission, got ${h.submitted.length}`);
    const p = h.submitted[0];
    // Every one of the nine is present on the wire shape, under the flattened
    // names contributionPayload.ts documents.
    const wireNames: Record<string, unknown> = {
      spatial_bucket: p.zone_id,
      temporal_bucket: p.time_bucket,
      movement_state: p.movement_state,
      motion_energy: p.motion_energy,
      periodicity: p.periodicity,
      dwell_bucket: p.dwell_bucket,
      transition: p.transition,
      transport_mode_likelihood: p.transport_mode_likelihood,
      sensor_health: p.sensor_health,
    };
    assert.deepEqual(Object.keys(wireNames).sort(), [...SENSING_FEATURE_NAMES].sort());
    for (const [name, value] of Object.entries(wireNames)) {
      assert.notEqual(value, undefined, `${name} is undefined on the submitted payload`);
    }
    assert.equal(typeof p.zone_id, 'string');
    assert.ok(p.motion_energy !== null && p.motion_energy > 0, 'a moving device has energy');
    assert.ok(p.periodicity !== null && p.periodicity > 0.5, 'a 2 Hz cadence is periodic');
    assert.equal(p.sensor_health.motion_sample_count, 200);
    assert.ok(['unknown', 'sparse', 'moderate', 'busy', 'packed'].includes(p.density));
  });

  test('successive windows carry the dwell forward while the zone is unchanged', async () => {
    const h = harness();
    h.motion.emit(200);
    h.location.emit(5);
    await h.handle.flush();
    h.motion.emit(200);
    h.location.emit(5);
    await h.handle.flush();
    h.handle.stop();

    assert.equal(h.submitted.length, 2);
    const [first, second] = h.submitted;
    assert.equal(first.zone_id, second.zone_id, 'the fixture does not leave the cell');
    assert.ok(
      (second.dwell_bucket ?? 0) >= (first.dwell_bucket ?? 0),
      'dwell must accumulate, not reset, inside one zone',
    );
    assert.equal(second.transition, 'none', 'staying put is not an arrival');
  });

  test('a window with no evidence is refused, not submitted as an empty world (§20)', async () => {
    const h = harness();
    await h.handle.flush();
    h.handle.stop();
    assert.equal(h.submitted.length, 0);
    assert.deepEqual(h.refusals, ['no_window_evidence']);
  });
});

describe('S21 — what `submit` receives is buckets, and the raw buffer is emptied', () => {
  test('no sentinel coordinate or accelerometer axis reaches `submit`', async () => {
    const h = harness();
    h.motion.emit(200);
    h.location.emit(5);
    await h.handle.flush();
    h.handle.stop();

    const json = JSON.stringify(h.submitted[0]);
    for (const [name, value] of Object.entries({ LAT, LNG, AX, T_START })) {
      assert.ok(!json.includes(String(value)), `${name} (${value}) reached the transport: ${json}`);
    }
    for (const fragment of ['40.748', '-73.985', '0.246801']) {
      assert.ok(!json.includes(fragment), `"${fragment}" reached the transport: ${json}`);
    }
  });

  test('the raw buffers are empty the moment the window closes', async () => {
    const h = harness();
    h.motion.emit(200);
    h.location.emit(5);
    assert.deepEqual(h.handle._rawBufferSizes(), { motion: 200, location: 5, acoustic: 0 });

    await h.handle.flush();
    assert.deepEqual(
      h.handle._rawBufferSizes(),
      { motion: 0, location: 0, acoustic: 0 },
      'raw samples must live for one window, not for the process',
    );
    h.handle.stop();
  });

  test('stop() unsubscribes, so a source that keeps firing fills nothing', async () => {
    const h = harness();
    h.motion.emit(50);
    h.handle.stop();
    h.motion.emit(200);
    assert.equal(h.handle._rawBufferSizes().motion, 0);
    await h.handle.flush();
    assert.equal(h.submitted.length, 0, 'a stopped loop submits nothing');
  });
});

describe('S29 — acoustic is attached only under the separate permission', () => {
  const granted: AcousticPermission = {
    scope: ACOUSTIC_SENSING_SCOPE,
    granted: true,
    grantedAt: '2026-09-25T10:00:00.000Z',
    revokedAt: null,
    osMicrophoneGranted: true,
  };

  test('with the grant, the window carries a coarse acoustic pair', async () => {
    const acoustic = fakeAcoustic();
    const h = harness({ acoustic, acousticPermission: () => granted });
    h.motion.emit(200);
    h.location.emit(5);
    acoustic.emit(48);
    await h.handle.flush();
    h.handle.stop();

    const p = h.submitted[0];
    assert.ok(p.acoustic, 'the acoustic pair must be present when permitted');
    assert.equal(p.acoustic?.scope, ACOUSTIC_SENSING_SCOPE);
    assert.ok(Number.isInteger(p.acoustic?.energy_bucket));
    assert.ok(!JSON.stringify(p.acoustic).includes('dbfs'));
  });

  test('a revocation between windows drops the acoustic pair from the very next one', async () => {
    const acoustic = fakeAcoustic();
    let permission: AcousticPermission = granted;
    const h = harness({ acoustic, acousticPermission: () => permission });

    h.motion.emit(200);
    h.location.emit(5);
    acoustic.emit(48);
    await h.handle.flush();
    assert.ok(h.submitted[0].acoustic);

    permission = { ...granted, granted: false, revokedAt: '2026-09-25T11:00:00.000Z' };
    h.motion.emit(200);
    h.location.emit(5);
    acoustic.emit(48);
    await h.handle.flush();
    h.handle.stop();

    assert.equal(h.submitted.length, 2);
    assert.equal(h.submitted[1].acoustic, undefined, 'a revoked grant must take effect immediately');
  });

  test('without any acoustic permission the pair is simply absent', async () => {
    const acoustic = fakeAcoustic();
    const h = harness({ acoustic, acousticPermission: () => null });
    h.motion.emit(200);
    h.location.emit(5);
    acoustic.emit(48);
    await h.handle.flush();
    h.handle.stop();
    assert.equal(h.submitted[0].acoustic, undefined);
  });
});

describe('§3 — eligibility carries the identity; ingest carries the credential', () => {
  interface Call {
    url: string;
    headers: Record<string, string>;
    body: string;
  }

  function transportHarness() {
    const calls: Call[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) }, body: String(init?.body ?? '') });
      if (String(url).endsWith('/session')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            credential: 'opaque-abc',
            rotationEpoch: 7,
            expiresAt: new Date(T_START + 3_600_000).toISOString(),
          }),
        } as any;
      }
      return { ok: true, status: 201, json: async () => ({}) } as any;
    }) as unknown as typeof fetch;

    const transport = createSensingTransport({
      baseUrl: 'https://api.example.test',
      getEligibilityToken: async () => 'account-token-xyz',
      fetchImpl,
      now: () => T_START,
    });
    return { calls, transport };
  }

  const payload = { zone_id: 'dr5ru7', signal_bucket: 2 } as unknown as SensingContributionPayload;

  test('the ingest request carries the opaque credential and NO Authorization header', async () => {
    const { calls, transport } = transportHarness();
    const out = await transport.submit(payload);
    assert.equal(out.ok, true);
    assert.equal(calls.length, 2, 'eligibility, then ingest');

    const [eligibility, ingest] = calls;
    assert.ok(eligibility.url.endsWith('/api/v1/sensing/session'));
    assert.equal(eligibility.headers.Authorization, 'Bearer account-token-xyz');

    assert.ok(ingest.url.endsWith('/api/v1/sensing/contributions'));
    assert.equal(
      ingest.headers.Authorization,
      undefined,
      'the ingest request must not carry the account token — that rejoins the two branches §3 separates',
    );
    assert.equal(ingest.headers[SENSING_CREDENTIAL_HEADER], 'opaque-abc');
    assert.ok(!ingest.body.includes('account-token-xyz'));
  });

  test('the credential is minted once and reused while it is fresh', async () => {
    const { calls, transport } = transportHarness();
    await transport.submit(payload);
    await transport.submit(payload);
    assert.equal(calls.filter((c) => c.url.endsWith('/session')).length, 1);
    assert.equal(calls.filter((c) => c.url.endsWith('/contributions')).length, 2);
  });

  test('a missing ingest route is a NAMED refusal, never a silent success (§20)', async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) }, body: String(init?.body ?? '') });
      if (String(url).endsWith('/session')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ credential: 'c', rotationEpoch: 1, expiresAt: new Date(T_START + 1000).toISOString() }),
        } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }) as unknown as typeof fetch;

    const transport = createSensingTransport({
      baseUrl: 'https://api.example.test',
      getEligibilityToken: async () => 'tok',
      fetchImpl,
      now: () => T_START,
    });
    const out = await transport.submit(payload);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, 'route_unavailable');
  });

  test('no eligibility token means no credential and no contribution', async () => {
    const transport = createSensingTransport({
      baseUrl: 'https://api.example.test',
      getEligibilityToken: async () => null,
      fetchImpl: (async () => {
        throw new Error('the transport must not reach the network without eligibility');
      }) as unknown as typeof fetch,
      now: () => T_START,
    });
    const out = await transport.submit(payload);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, 'no_credential');
  });
});
