/**
 * Composer logic tests — node:test + node:assert only. Verifies the pure
 * submit/passport/location rules the composer relies on.
 * Run: node --import tsx/esm --test src/lib/composerLogic.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canSubmit,
  defaultPassportToggle,
  buildLocationPayload,
  payloadHasForbiddenKeys,
} from './composerLogic.ts';

test('1. media required before submit', () => {
  assert.equal(canSubmit({ hasMedia: false, submitting: false }), false);
  assert.equal(canSubmit({ hasMedia: true, submitting: false }), true);
});

test('2. cannot submit while submitting', () => {
  assert.equal(canSubmit({ hasMedia: true, submitting: true }), false);
});

test('3. passport toggle defaults ON with media', () => {
  assert.equal(defaultPassportToggle(true), true);
  assert.equal(defaultPassportToggle(false), false);
});

test('4. GPS selection sends gps source + both tagged and userGps coords', () => {
  const p = buildLocationPayload({ source: 'gps', lat: 10.32, lng: 123.9, name: 'IT Park', city: 'Cebu', country: 'PH' });
  assert.equal(p.locationSource, 'gps');
  assert.equal(p.locationLat, 10.32);
  assert.equal(p.userGpsLat, 10.32);
  assert.equal(p.userGpsLng, 123.9);
  assert.equal(p.locationCity, 'Cebu');
});

test('5. manual selection sends manual source + NO coordinates', () => {
  const p = buildLocationPayload({ source: 'manual', name: 'Some Cafe' });
  assert.equal(p.locationSource, 'manual');
  assert.equal(p.locationName, 'Some Cafe');
  assert.equal('locationLat' in p, false);
  assert.equal('userGpsLat' in p, false);
});

test('6. empty manual name falls back to none', () => {
  const p = buildLocationPayload({ source: 'manual', name: '   ' });
  assert.equal(p.locationSource, 'none');
});

test('7. gps without coords falls back to none', () => {
  const p = buildLocationPayload({ source: 'gps', lat: null, lng: null });
  assert.equal(p.locationSource, 'none');
});

test('8. no location -> none', () => {
  const p = buildLocationPayload({ source: 'none' });
  assert.equal(p.locationSource, 'none');
});

test('9. frontend payload NEVER includes a trusted location_verified/stamp_eligible', () => {
  const gps = buildLocationPayload({ source: 'gps', lat: 1, lng: 2 });
  const manual = buildLocationPayload({ source: 'manual', name: 'X' });
  const none = buildLocationPayload({ source: 'none' });
  for (const p of [gps, manual, none]) {
    assert.equal(payloadHasForbiddenKeys(p), false);
  }
});

test('10. forbidden-key detector catches a spoofed flag', () => {
  assert.equal(payloadHasForbiddenKeys({ locationSource: 'manual', location_verified: true }), true);
  assert.equal(payloadHasForbiddenKeys({ locationSource: 'manual', stampEligible: true }), true);
});
