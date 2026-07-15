/**
 * Unit tests for reverseGeocodeToPlaceCore — the three-stage reverse-geocode
 * fallback chain behind reverseGeocodeToPlace().
 *
 * Run:
 *   node --import tsx/esm --test src/services/__tests__/reverseGeocodePlace.test.ts
 *
 * Guards the "location data loss" regression class: every stage must return a
 * complete Place (never null, never partial), and a failure in one stage must
 * fall through to the next instead of throwing or silently returning nulls
 * when better data was available.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reverseGeocodeToPlaceCore,
  type ReverseGeocodeDeps,
  type ExpoGeocodeAddress,
} from '../reverseGeocodePlace.core.ts';
import type { Place } from '../../lib/location/placeTypes.ts';

const LAT = 10.3157;
const LNG = 123.8854;

const API_PLACE = {
  id: 'nominatim-12345',
  type: 'city',
  name: 'Cebu City',
  displayName: 'Cebu City, Philippines',
  country: 'Philippines',
  countryCode: 'PH',
  region: 'Central Visayas',
  city: 'Cebu City',
  district: null,
  lat: 10.3,
  lng: 123.88,
  timezone: 'Asia/Manila',
  source: 'nominatim',
};

function okFetch(body: unknown): ReverseGeocodeDeps['fetchFn'] {
  return async () => ({ ok: true, json: async () => body });
}
const failingFetch: ReverseGeocodeDeps['fetchFn'] = async () => {
  throw new Error('network down');
};
const notOkFetch: ReverseGeocodeDeps['fetchFn'] = async () => ({
  ok: false,
  json: async () => ({}),
});
const failingExpo: ReverseGeocodeDeps['expoReverseGeocode'] = async () => {
  throw new Error('geocoder unavailable');
};
const emptyExpo: ReverseGeocodeDeps['expoReverseGeocode'] = async () => [];

/** Assert every Place field required by the universal location system exists. */
function assertFullPlace(place: Place) {
  for (const key of [
    'id', 'type', 'name', 'displayName', 'country', 'countryCode',
    'region', 'city', 'district', 'lat', 'lng', 'timezone', 'source',
  ] as const) {
    assert.ok(key in place, `Place is missing field "${key}"`);
    assert.notEqual(place[key], undefined, `Place field "${key}" is undefined`);
  }
  assert.ok(place.id.length > 0, 'Place.id must be non-empty');
  assert.ok(place.displayName.length > 0, 'Place.displayName must be non-empty');
}

describe('reverseGeocodeToPlaceCore — stage 1 (backend API)', () => {
  test('happy path: returns the API place with lat/lng overlaid and source gps', async () => {
    let requestedUrl = '';
    const deps: ReverseGeocodeDeps = {
      apiBase: 'https://api.example.com',
      fetchFn: async (url) => {
        requestedUrl = url;
        return { ok: true, json: async () => ({ place: API_PLACE }) };
      },
      expoReverseGeocode: failingExpo, // must not be reached
    };

    const place = await reverseGeocodeToPlaceCore(deps, LAT, LNG);

    assert.equal(requestedUrl, `https://api.example.com/api/places/reverse?lat=${LAT}&lng=${LNG}`);
    assertFullPlace(place);
    assert.equal(place.city, 'Cebu City');
    assert.equal(place.country, 'Philippines');
    assert.equal(place.countryCode, 'PH');
    // lat/lng must be the GPS coordinates, not the API's canonical centroid.
    assert.equal(place.lat, LAT);
    assert.equal(place.lng, LNG);
    assert.equal(place.source, 'gps');
  });

  test('API place without an id is rejected and falls through to expo geocoder', async () => {
    const deps: ReverseGeocodeDeps = {
      apiBase: '',
      fetchFn: okFetch({ place: { name: 'no-id place' } }),
      expoReverseGeocode: async () => [{ city: 'Osaka', country: 'Japan', isoCountryCode: 'JP' }],
    };
    const place = await reverseGeocodeToPlaceCore(deps, LAT, LNG);
    assert.equal(place.city, 'Osaka');
    assert.equal(place.country, 'Japan');
  });
});

describe('reverseGeocodeToPlaceCore — stage 2 (expo geocoder fallback)', () => {
  const expoResult: ExpoGeocodeAddress = {
    city: 'Cebu City',
    district: 'Lahug',
    subregion: 'Cebu',
    region: 'Central Visayas',
    country: 'Philippines',
    isoCountryCode: 'PH',
    name: '123',
    street: 'Salinas Drive',
    postalCode: '6000',
  };

  for (const [label, fetchFn] of [
    ['network failure', failingFetch],
    ['non-ok response', notOkFetch],
    ['empty body', okFetch({})],
  ] as const) {
    test(`falls back to expo geocoder on API ${label} and returns a full Place`, async () => {
      const place = await reverseGeocodeToPlaceCore(
        { apiBase: '', fetchFn, expoReverseGeocode: async () => [expoResult] },
        LAT, LNG,
      );
      assertFullPlace(place);
      assert.equal(place.city, 'Cebu City');
      assert.equal(place.country, 'Philippines');
      assert.equal(place.countryCode, 'PH');
      assert.equal(place.region, 'Central Visayas');
      assert.equal(place.lat, LAT);
      assert.equal(place.lng, LNG);
      assert.equal(place.source, 'gps');
      assert.equal(place.type, 'city');
      assert.equal(place.displayName, 'Cebu City, Philippines');
      assert.equal(place.address, '123 Salinas Drive');
      assert.equal(place.postalCode, '6000');
      assert.equal(place.formattedAddress, '123 Salinas Drive, Cebu City, Philippines');
    });
  }

  test('city-less expo result still yields non-empty name/displayName from coordinates', async () => {
    const place = await reverseGeocodeToPlaceCore(
      { apiBase: '', fetchFn: failingFetch, expoReverseGeocode: async () => [{ country: null }] },
      LAT, LNG,
    );
    assertFullPlace(place);
    assert.equal(place.city, null);
    assert.equal(place.displayName, `${LAT.toFixed(4)}, ${LNG.toFixed(4)}`);
  });
});

describe('reverseGeocodeToPlaceCore — stage 3 (coordinate-only stub)', () => {
  for (const [label, expo] of [
    ['expo geocoder throws', failingExpo],
    ['expo geocoder returns no results', emptyExpo],
  ] as const) {
    test(`both sources fail (${label}): returns coordinate stub, never throws/returns null`, async () => {
      const place = await reverseGeocodeToPlaceCore(
        { apiBase: '', fetchFn: failingFetch, expoReverseGeocode: expo },
        LAT, LNG,
      );
      assertFullPlace(place);
      assert.equal(place.name, 'Current Location');
      assert.equal(place.displayName, `${LAT.toFixed(4)}, ${LNG.toFixed(4)}`);
      assert.equal(place.lat, LAT);
      assert.equal(place.lng, LNG);
      assert.equal(place.city, null);
      assert.equal(place.country, null);
      assert.equal(place.source, 'gps');
    });
  }
});
