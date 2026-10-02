/**
 * acousticPermission + acousticFeatures — census S29.
 *
 * ── THE ROW, VERBATIM ────────────────────────────────────────────────────────
 * "RED WHEN a separate, explicit microphone permission exists and gates a
 * coarse energy/rhythm extractor — separate being the requirement, so reusing a
 * video permission would not close it."
 *
 * So there are two claims to pin, and the second is the one with teeth:
 *   1. a coarse energy/rhythm extractor exists;
 *   2. it is gated on a permission that is SEPARATE from the microphone
 *      Portava already holds for LiveKit calls and expo-av video.
 *
 * Claim 2 cannot be proved by "an OS microphone permission exists" — one
 * already did, in `app.json`, before any of this, and a user who took a video
 * call had already granted it. So the tests below hand the gate each of those
 * existing grants by name and require it to refuse, and require the OS
 * permission on its own to buy nothing.
 *
 * WATCHED IT FAIL: with the scope check removed from `acousticCaptureAllowed`,
 * "a call microphone grant does not satisfy" and "the OS permission alone
 * grants nothing" both go red; with the gate removed from
 * `extractAcousticFeatures`, "the extractor refuses" goes red.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACOUSTIC_PERMISSION_DENIED,
  ACOUSTIC_PERMISSION_STORAGE_KEY,
  ACOUSTIC_SENSING_SCOPE,
  MICROPHONE_GRANTS_THAT_DO_NOT_SATISFY,
  acousticCaptureAllowed,
  grantAcousticPermission,
  loadAcousticPermission,
  revokeAcousticPermission,
  type AcousticPermission,
  type StorageLike,
} from '../acousticPermission.ts';
import {
  MIN_ACOUSTIC_SAMPLES,
  extractAcousticFeatures,
  type AcousticMeterSample,
} from '../acousticFeatures.ts';

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async getItem(k) {
      return map.get(k) ?? null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
    async removeItem(k) {
      map.delete(k);
    },
  };
}

const GRANTED: AcousticPermission = {
  scope: ACOUSTIC_SENSING_SCOPE,
  granted: true,
  grantedAt: '2026-09-25T10:00:00.000Z',
  revokedAt: null,
  osMicrophoneGranted: true,
};

/** A metered room with a beat: level rises and falls on a steady period. */
function beatSamples(count: number): AcousticMeterSample[] {
  const out: AcousticMeterSample[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ t: 1_000 + i * 250, dbfs: -30 + 9 * Math.sin((2 * Math.PI * i) / 8) });
  }
  return out;
}

/** A metered room with no beat: a flat hum. */
function humSamples(count: number): AcousticMeterSample[] {
  const out: AcousticMeterSample[] = [];
  for (let i = 0; i < count; i += 1) out.push({ t: 1_000 + i * 250, dbfs: -46 });
  return out;
}

describe('S29 — the acoustic permission is SEPARATE from the call/video microphone', () => {
  test('it has its own scope and its own storage key', () => {
    assert.equal(ACOUSTIC_SENSING_SCOPE, 'sensing.acoustic.energy');
    assert.equal(ACOUSTIC_PERMISSION_STORAGE_KEY, 'sensing_acoustic_permission_v1');
    assert.notEqual(ACOUSTIC_SENSING_SCOPE, 'call.microphone');
  });

  test('a call or video microphone grant does not satisfy it — each one, by name', () => {
    for (const other of MICROPHONE_GRANTS_THAT_DO_NOT_SATISFY) {
      const reused: AcousticPermission = {
        scope: other,
        granted: true,
        grantedAt: '2026-09-25T10:00:00.000Z',
        revokedAt: null,
        osMicrophoneGranted: true,
      };
      assert.equal(
        acousticCaptureAllowed(reused),
        false,
        `"${other}" must not open the acoustic gate — that is the whole requirement`,
      );
    }
  });

  test('the OS microphone permission alone grants nothing', () => {
    // The state of a user who has taken one video call and never opted into
    // acoustic sensing. Both switches exist; only one is theirs to this purpose.
    assert.equal(
      acousticCaptureAllowed({ ...ACOUSTIC_PERMISSION_DENIED, osMicrophoneGranted: true }),
      false,
    );
  });

  test('and the purpose-scoped grant alone is not enough either — both are required', () => {
    assert.equal(acousticCaptureAllowed({ ...GRANTED, osMicrophoneGranted: false }), false);
    assert.equal(acousticCaptureAllowed(GRANTED), true);
  });

  test('default is DENIED, and an unreadable or foreign record reads as denied', async () => {
    const storage = memoryStorage();
    assert.equal(acousticCaptureAllowed(await loadAcousticPermission(storage)), false);

    storage.map.set(ACOUSTIC_PERMISSION_STORAGE_KEY, 'not json');
    assert.equal((await loadAcousticPermission(storage)).granted, false);

    // A record written under some other microphone scope must not be adopted.
    storage.map.set(
      ACOUSTIC_PERMISSION_STORAGE_KEY,
      JSON.stringify({ scope: 'call.microphone', granted: true }),
    );
    assert.equal((await loadAcousticPermission(storage)).granted, false);
  });

  test('grant then revoke, and the OS answer is never trusted from storage', async () => {
    const storage = memoryStorage();
    const granted = await grantAcousticPermission(storage, Date.parse('2026-09-25T10:00:00.000Z'), true);
    assert.equal(acousticCaptureAllowed(granted), true);

    // Reloaded from disk the OS half is false again: the user can revoke the
    // microphone in Settings while the app is not running, so the stored answer
    // is never authoritative.
    const reloaded = await loadAcousticPermission(storage);
    assert.equal(reloaded.granted, true);
    assert.equal(reloaded.osMicrophoneGranted, false);
    assert.equal(acousticCaptureAllowed(reloaded), false);

    const revoked = await revokeAcousticPermission(storage, Date.parse('2026-09-25T11:00:00.000Z'));
    assert.equal(acousticCaptureAllowed(revoked), false);
    assert.equal(acousticCaptureAllowed(await loadAcousticPermission(storage)), false);
  });
});

describe('S29 — the coarse energy/rhythm extractor, and its gate', () => {
  test('without the separate permission it REFUSES — it does not quietly return nulls', () => {
    const out = extractAcousticFeatures(ACOUSTIC_PERMISSION_DENIED, beatSamples(40));
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, 'permission_not_granted');

    // Same refusal for the reused call grant, so a caller cannot learn that the
    // permission is unenforced by watching which inputs produce output.
    const reused = extractAcousticFeatures(
      { scope: 'call.microphone', granted: true, grantedAt: null, revokedAt: null, osMicrophoneGranted: true },
      beatSamples(40),
    );
    assert.equal(reused.ok, false);
    assert.equal(reused.ok === false && reused.reason, 'permission_not_granted');
  });

  test('with it, the extractor produces a coarse ENERGY ordinal that tracks loudness', () => {
    const loud = extractAcousticFeatures(GRANTED, beatSamples(40).map((s) => ({ ...s, dbfs: -16 })));
    const quiet = extractAcousticFeatures(GRANTED, beatSamples(40).map((s) => ({ ...s, dbfs: -58 })));
    assert.ok(loud.ok && quiet.ok);
    assert.ok(loud.features.energyBucket > quiet.features.energyBucket);
    for (const r of [loud, quiet]) {
      assert.ok(
        Number.isInteger(r.features.energyBucket) &&
          r.features.energyBucket >= 0 &&
          r.features.energyBucket <= 4,
        'energy must be a 0..4 ordinal, never a level',
      );
    }
  });

  test('and a coarse RHYTHM class that separates a beat from a hum', () => {
    const beat = extractAcousticFeatures(GRANTED, beatSamples(48));
    const hum = extractAcousticFeatures(GRANTED, humSamples(48));
    assert.ok(beat.ok && hum.ok);
    assert.ok(['steady', 'strong'].includes(beat.features.rhythmBucket), beat.features.rhythmBucket);
    assert.equal(hum.features.rhythmBucket, 'none', 'a flat level has no rhythm');
  });

  test('the output carries NO level, no timestamp and no audio — only buckets', () => {
    const out = extractAcousticFeatures(GRANTED, beatSamples(48));
    assert.ok(out.ok);
    assert.deepEqual(
      Object.keys(out.features).sort(),
      ['confidence', 'energyBucket', 'rhythmBucket', 'scope'],
    );
    const json = JSON.stringify(out.features);
    assert.ok(!json.includes('-30'), 'a dBFS level must not survive the reduction');
    assert.ok(!json.includes('dbfs'));
  });

  test('too few meter ticks is a named refusal, not a fabricated silence', () => {
    const out = extractAcousticFeatures(GRANTED, beatSamples(MIN_ACOUSTIC_SAMPLES - 1));
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, 'insufficient_samples');
  });
});
