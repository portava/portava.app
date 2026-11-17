import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryOpenNow, refreshDiscoveryHours } from '../lib/discoveryOpeningHours.js';
const at = (hours: string | null, date: string, lat = 40.7128, lng = -74.006) => discoveryOpenNow(hours, lat, lng, Date.parse(date));
test('uses the venue zone and DST, not server or phone time', () => {
  assert.equal(at('Mo-Fr 09:00-17:00', '2026-07-06T13:00:00Z'), true);
  assert.equal(at('Mo-Fr 09:00-17:00', '2026-11-09T13:00:00Z'), false);
  assert.equal(at('Mo-Fr 09:00-17:00', '2026-11-09T14:00:00Z'), true);
  assert.equal(at('Mo-Fr 09:00-17:00', '2026-11-09T22:00:00Z'), false);
});
test('supports fractional offsets and weekday ranges', () => {
  assert.equal(at('Mo-Fr 09:00-17:00', '2026-11-09T03:30:00Z', 28.6139, 77.209), true);
  assert.equal(at('Mo-Fr 09:00-17:00', '2026-11-08T10:00:00Z'), false);
});
test('overnight spans belong to the day they start', () => {
  assert.equal(at('Fr 22:00-02:00', '2026-11-14T06:59:00Z'), true);
  assert.equal(at('Fr 22:00-02:00', '2026-11-14T07:00:00Z'), false);
  assert.equal(at('Fr 22:00-02:00', '2026-11-13T06:00:00Z'), false);
});
test('handles split shifts and explicit weekly closure', () => {
  assert.equal(at('Mo-Fr 09:00-12:00,13:00-17:00; Sa 10:00-14:00; Su off', '2026-11-09T17:30:00Z'), false);
  assert.equal(at('Mo-Fr 09:00-12:00,13:00-17:00; Sa 10:00-14:00; Su off', '2026-11-09T18:00:00Z'), true);
  assert.equal(at('Mo-Fr 09:00-17:00; Su off', '2026-11-08T16:00:00Z'), false);
});
test('unsupported or malformed schedules remain unknown', () => {
  for(const hours of [null, 'PH off', 'sunrise-sunset', 'Mo-Fr 09:99-17:00', 'Mo-Fr 09:00-25:00', 'Mo-Fr 09:00-09:00', 'Mo-Fr 09:00-17:00; Mo off', '09:00-17:00 "by appointment"']) assert.equal(at(hours, '2026-11-09T16:00:00Z'), null, String(hours));
  assert.equal(discoveryOpenNow('09:00-17:00', null, null), null);
  assert.equal(discoveryOpenNow('24/7', null, null), true);
});
test('re-evaluates cached answers and never invents hours for old provider booleans', () => {
  const p = { openingHours: 'Mo-Fr 09:00-17:00', lat: 40.7128, lng: -74.006, isOpenNow: true };
  assert.equal(refreshDiscoveryHours(p, Date.parse('2026-11-09T22:00:00Z')).isOpenNow, false);
  assert.equal(p.isOpenNow, true);
  assert.equal(refreshDiscoveryHours({ ...p, openingHours: null }).isOpenNow, null);
});
