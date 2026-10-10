/**
 * census G176 — the client half of §28 "Distance where permitted": the words for
 * a coarse band, and the location line they join. Pure.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - `distanceBandLabel`'s default returns `String(band)` instead of null →
 *     "a band this build cannot name renders nothing" red.
 *   - `rowSubtitle` drops the band → "the band joins the subtitle" red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceBandLabel, rowSubtitle } from '../suggestionBadges.ts';
import { distanceBucket } from '../../../../features/map/telemetry/mapTelemetry.ts';

test('every bucket the app uses for approximate distance has words', () => {
  for (const km of [0.1, 0.7, 2, 5, 20, 80]) {
    const band = distanceBucket(km);
    assert.ok(distanceBandLabel(band), `no words for ${band}`);
  }
  assert.equal(distanceBandLabel('<0.5km'), 'Under 500 m');
  assert.equal(distanceBandLabel('1-3km'), '1–3 km');
});

test('a band this build cannot name renders nothing (fail-closed)', () => {
  for (const v of ['unknown', '0.42 km', '1-2km', 3, null, undefined, '']) {
    assert.equal(distanceBandLabel(v), null, String(v));
  }
});

test('the band joins the subtitle, either alone, and an unknown band adds nothing', () => {
  assert.equal(rowSubtitle({ subtitle: 'Hoi An', distanceBand: '<0.5km' }), 'Hoi An · Under 500 m');
  assert.equal(rowSubtitle({ subtitle: undefined, distanceBand: '3-10km' }), '3–10 km');
  assert.equal(rowSubtitle({ subtitle: 'Hoi An', distanceBand: undefined }), 'Hoi An');
  assert.equal(rowSubtitle({ subtitle: 'Hoi An', distanceBand: '0.42 km' }), 'Hoi An');
  assert.equal(rowSubtitle({ subtitle: '  ', distanceBand: undefined }), null);
});
