/**
 * Phase 2 (Geographic Core) — canonical binding capture (§17, §53).
 *
 * Pure logic — no React/network — runs under the node:test runner
 * (auto-discovered via src/ ** /*.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  captureCanonicalBinding,
  bindingToSessionContext,
  placeNeedsCanonicalResolution,
  entityTypeForPlace,
} from '../canonicalBinding.ts';
import type { Place } from '../../../../lib/location/placeTypes.ts';

function place(over: Partial<Place> = {}): Place {
  return {
    id: 'p1',
    type: 'city',
    name: 'Da Nang',
    displayName: 'Da Nang, Vietnam',
    country: 'Vietnam',
    countryCode: 'VN',
    region: null,
    city: 'Da Nang',
    district: null,
    lat: 16.0544,
    lng: 108.2022,
    timezone: 'Asia/Ho_Chi_Minh',
    source: 'canonical',
    ...over,
  } as Place;
}

test('captureCanonicalBinding captures the §17 city id + country + timezone + coords', () => {
  const b = captureCanonicalBinding(place({ canonicalId: 'city_da_nang' }));
  assert.equal(b.entityType, 'city');
  assert.equal(b.entityId, 'city_da_nang'); // canonicalId preferred over provider id
  assert.equal(b.canonicalId, 'city_da_nang');
  assert.equal(b.city, 'Da Nang');
  assert.equal(b.country, 'Vietnam');
  assert.equal(b.countryCode, 'VN');
  assert.equal(b.timezone, 'Asia/Ho_Chi_Minh');
  assert.deepEqual([b.lat, b.lng], [16.0544, 108.2022]);
  assert.equal(b.resolved, true);
});

test('captureCanonicalBinding: unresolved place still yields a usable binding (resolved=false)', () => {
  // The trip-edit hydration placeholder: real id, no canonicalId, no coords.
  const b = captureCanonicalBinding(place({ id: 'legacy-da-nang', canonicalId: null, lat: null, lng: null, timezone: null }));
  assert.equal(b.resolved, false);
  assert.equal(b.canonicalId, null);
  assert.equal(b.entityId, 'legacy-da-nang'); // falls back to provider id
  assert.equal(b.city, 'Da Nang');
  assert.equal(b.lat, null);
});

test('captureCanonicalBinding: city falls back to name, never displayName (no country suffix)', () => {
  const b = captureCanonicalBinding(place({ city: null, name: 'Gili Air', displayName: 'Gili Air, Indonesia' }));
  assert.equal(b.city, 'Gili Air');
  assert.notEqual(b.city, 'Gili Air, Indonesia');
});

test('captureCanonicalBinding: preserves a genuine zero coordinate (Null Island)', () => {
  const b = captureCanonicalBinding(place({ lat: 0, lng: 0 }));
  assert.deepEqual([b.lat, b.lng], [0, 0]);
});

test('captureCanonicalBinding: NaN coordinates become null', () => {
  const b = captureCanonicalBinding(place({ lat: NaN as unknown as number, lng: 5 }));
  assert.equal(b.lat, null);
  assert.equal(b.lng, 5);
});

test('bindingToSessionContext projects the §53 bounded task context', () => {
  const b = captureCanonicalBinding(place({ canonicalId: 'city_da_nang' }));
  const ctx = bindingToSessionContext(b);
  assert.equal(ctx.cityId, 'city_da_nang');
  assert.equal(ctx.tz, 'Asia/Ho_Chi_Minh');
  assert.deepEqual([ctx.lat, ctx.lng], [16.0544, 108.2022]);
  // Must NOT invent persistent-preference keys.
  assert.ok(!('surface' in ctx));
});

test('bindingToSessionContext: partial binding never emits null keys', () => {
  const b = captureCanonicalBinding(place({ canonicalId: null, lat: null, lng: null, timezone: null }));
  const ctx = bindingToSessionContext(b);
  // No coords / tz → those keys are simply absent, not set to null.
  assert.ok(!('lat' in ctx));
  assert.ok(!('tz' in ctx));
});

test('bindingToSessionContext: a country-only binding contributes no cityId anchor', () => {
  const b = captureCanonicalBinding(place({ type: 'country', name: 'Vietnam', city: null, canonicalId: 'country_vn' }));
  assert.equal(b.entityType, 'country');
  const ctx = bindingToSessionContext(b);
  assert.ok(!('cityId' in ctx));
});

test('bindingToSessionContext(null) is an empty object', () => {
  assert.deepEqual(bindingToSessionContext(null), {});
});

test('placeNeedsCanonicalResolution: true without a canonicalId, false with one', () => {
  assert.equal(placeNeedsCanonicalResolution(place({ canonicalId: null })), true);
  assert.equal(placeNeedsCanonicalResolution(place({ canonicalId: '   ' })), true); // blank id does not count
  assert.equal(placeNeedsCanonicalResolution(place({ canonicalId: 'city_da_nang' })), false);
  assert.equal(placeNeedsCanonicalResolution(null), false);
});

test('entityTypeForPlace maps provider place types to canonical entity classes', () => {
  assert.equal(entityTypeForPlace('country'), 'country');
  assert.equal(entityTypeForPlace('city'), 'city');
  assert.equal(entityTypeForPlace('town'), 'city');
  assert.equal(entityTypeForPlace('region'), 'city');
  assert.equal(entityTypeForPlace('neighborhood'), 'neighborhood');
  assert.equal(entityTypeForPlace('district'), 'neighborhood');
  assert.equal(entityTypeForPlace('landmark'), 'place');
  assert.equal(entityTypeForPlace('airport'), 'place');
});
