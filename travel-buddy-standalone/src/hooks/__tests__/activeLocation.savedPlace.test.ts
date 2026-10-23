/**
 * savedPlaceFromApi — a city found by GPS survives a relaunch.
 *
 * GET /api/me/location-state returns the saved place without an id
 * (`{ city, district, country, countryCode, formatted }`, artifacts/api-server/src/routes/location.ts). The restore in
 * useActiveLocation required `d.place.id`, so it fell back to an empty place while `ok` stayed true: home asked
 * "Tell us your city" again on every launch (owner's iPhone, 2026-10-22). Only a manual city, which has its own
 * field, survived — which is why typing the city by hand "stuck".
 *
 * Run: node --import tsx/esm --test src/hooks/__tests__/activeLocation.savedPlace.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { savedPlaceFromApi } from '../activeLocation.state.ts';

describe('savedPlaceFromApi', () => {
  it("restores GET /me/location-state's id-less place as a real city", () => {
    const place = savedPlaceFromApi(
      { city: 'Miami', district: null, country: 'United States', countryCode: 'US', formatted: 'Miami, Florida, United States' },
      { lat: 25.7617, lng: -80.1918 },
    );
    assert.equal(place.city, 'Miami');
    assert.equal(place.name, 'Miami');
    assert.equal(place.country, 'United States');
    assert.equal(place.countryCode, 'US');
    assert.equal(place.displayName, 'Miami, Florida, United States');
    assert.ok(place.id, 'a restored place has an id, so screens that key on it treat it as a place');
    assert.equal(place.id, 'last-miami');
    assert.deepEqual([place.lat, place.lng], [25.7617, -80.1918]);
    assert.equal(place.source, 'recent');
    assert.ok(!('formatted' in place), 'the API-only field does not leak into the Place');
  });

  it('without a formatted line, the display name is "city, country"', () => {
    const place = savedPlaceFromApi({ city: 'Da Nang', country: 'Vietnam', countryCode: 'VN' }, { lat: 16.05, lng: 108.2 });
    assert.equal(place.displayName, 'Da Nang, Vietnam');
  });

  it('a country-only place still restores (named by its country)', () => {
    const place = savedPlaceFromApi({ city: null, country: 'Japan', countryCode: 'JP' }, null);
    assert.equal(place.name, 'Japan');
    assert.equal(place.id, 'last-japan');
    assert.equal(place.lat, null);
  });

  it('a full saved Place keeps everything it carries', () => {
    const full = {
      id: 'p-manila', type: 'city' as const, name: 'Manila', displayName: 'Manila, Philippines', country: 'Philippines',
      countryCode: 'PH', region: 'Metro Manila', city: 'Manila', district: 'Quiapo', lat: 14.5995, lng: 120.9842,
      timezone: 'Asia/Manila', source: 'gps' as const,
    };
    const place = savedPlaceFromApi(full, { lat: 0, lng: 0 });
    assert.deepEqual({ ...place, source: full.source }, full);
    assert.equal(place.source, 'recent');
  });
});

import { buildGpsSavePayload } from '../activeLocation.state.ts';

describe('buildGpsSavePayload — a GPS fix replaces a manual city on the server too', () => {
  it('clears manualCity / manualCountry explicitly (the server now writes only the fields a request sends)', () => {
    const p = buildGpsSavePayload({ source: 'gps_fresh', place: { city: 'Da Nang' } }, { lat: 16.05, lng: 108.2, accuracyMeters: 12 });
    assert.equal(p.manualCity, null);
    assert.equal(p.manualCountry, null);
    assert.ok('manualCity' in p && 'manualCountry' in p, 'the keys are present, so a presence-based server clears them');
    assert.deepEqual(p.coords, { lat: 16.05, lng: 108.2, accuracyMeters: 12 });
    assert.equal(p.permissionStatus, 'granted');
  });
});
