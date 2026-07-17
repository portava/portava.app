/**
 * placeToLocationFields — the shared Place → API location-field mapping used
 * by BOTH the Memory composer and the Postcard composer. node:test only.
 * Run: node --import tsx/esm --test src/lib/location/locationPayload.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeToLocationFields } from './locationPayload.ts';
import type { Place } from './placeTypes.ts';

const LISBON: Place = {
  id: 'nominatim:123',
  type: 'city',
  name: 'Lisbon',
  displayName: 'Lisbon, Portugal',
  country: 'Portugal',
  countryCode: 'PT',
  region: null,
  city: 'Lisbon',
  district: null,
  lat: 38.716,
  lng: -9.139,
  timezone: 'Europe/Lisbon',
  source: 'nominatim',
  canonicalId: '5b2a8a1e-9c7d-4a53-9a70-000000000001',
};

test('full Place maps to all normalized location fields', () => {
  assert.deepEqual(placeToLocationFields(LISBON), {
    locationCity: 'Lisbon',
    locationCountry: 'Portugal',
    locationLat: 38.716,
    locationLng: -9.139,
    placeId: 'nominatim:123',
    canonicalLocationId: '5b2a8a1e-9c7d-4a53-9a70-000000000001',
  });
});

test('venue without city falls back to name for locationCity', () => {
  const venue: Place = { ...LISBON, id: 'fsq:9', type: 'landmark', name: 'Eiffel Tower', displayName: 'Eiffel Tower, Paris', city: null };
  assert.equal(placeToLocationFields(venue).locationCity, 'Eiffel Tower');
});

test('manual free-text place (no coords, unresolved) sends only labels + placeId', () => {
  const manual: Place = {
    ...LISBON,
    id: 'manual-somewhere',
    name: 'Somewhere',
    displayName: 'Somewhere',
    city: 'Somewhere',
    country: null,
    lat: null,
    lng: null,
    source: 'manual',
    canonicalId: null,
  };
  assert.deepEqual(placeToLocationFields(manual), {
    locationCity: 'Somewhere',
    locationCountry: undefined,
    locationLat: undefined,
    locationLng: undefined,
    placeId: 'manual-somewhere',
    canonicalLocationId: undefined,
  });
});

test('null place yields an empty object (no location keys at all)', () => {
  assert.deepEqual(placeToLocationFields(null), {});
  assert.deepEqual(placeToLocationFields(undefined), {});
});

test('never emits server-owned keys', () => {
  const payload = placeToLocationFields(LISBON) as Record<string, unknown>;
  for (const k of ['location_verified', 'stamp_eligible', 'locationVerified', 'stampEligible']) {
    assert.equal(k in payload, false);
  }
});
