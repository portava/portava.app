/**
 * Tests for the useUniversalLocation().setLocation(place) contract:
 * setting a place must (a) persist the FULL place to the API payload and
 * (b) expose the same place back via `location`.
 *
 * Run:
 *   node --import tsx/esm --test src/hooks/__tests__/universalLocation.setLocation.test.ts
 *
 * setLocation → setManualCity → buildManualCityState + buildManualCityPayload
 * (pure, extracted to activeLocation.state.ts), and `location` is
 * deriveUniversalLocation(locationState). Exercising those pure functions
 * covers the full data path without a React renderer.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManualCityState,
  buildManualCityPayload,
  deriveUniversalLocation,
} from '../activeLocation.state.ts';
import type { ActiveLocationState } from '../useActiveLocation.ts';
import type { Place } from '../../lib/location/placeTypes.ts';

const EMPTY_PLACE: Place = {
  id: '', type: 'city', name: '', displayName: '',
  country: null, countryCode: null, region: null, city: null, district: null,
  lat: null, lng: null, timezone: null, source: 'manual',
};

const INITIAL: ActiveLocationState = {
  ok: false,
  permissionStatus: 'denied',
  source: 'none',
  freshness: 'unavailable',
  coords: null,
  place: EMPTY_PLACE,
  lastUpdatedAt: null,
  userMessage: null,
};

const PICKED: Place = {
  id: 'nominatim-999',
  type: 'city',
  name: 'Kyoto',
  displayName: 'Kyoto, Japan',
  country: 'Japan',
  countryCode: 'JP',
  region: 'Kansai',
  city: 'Kyoto',
  district: null,
  lat: 35.0116,
  lng: 135.7681,
  timezone: 'Asia/Tokyo',
  source: 'nominatim',
  canonicalId: 'canon-kyoto',
  address: null,
  postalCode: null,
  formattedAddress: 'Kyoto, Japan',
};

const NOW = '2026-07-15T12:00:00.000Z';

describe('setLocation(place) — state transition', () => {
  test('persists the exact Place and exposes it via location', () => {
    const next = buildManualCityState(INITIAL, PICKED, NOW);

    assert.equal(next.ok, true);
    assert.equal(next.source, 'manual_city');
    assert.equal(next.freshness, 'live');
    assert.equal(next.lastUpdatedAt, NOW);
    // The place must be stored whole — no field dropped in the transition.
    assert.deepEqual(next.place, PICKED);
    // Coords are lifted from the place.
    assert.deepEqual(next.coords, { lat: 35.0116, lng: 135.7681, accuracyMeters: null });

    // useUniversalLocation exposes it back via `location`.
    const location = deriveUniversalLocation(next);
    assert.deepEqual(location, PICKED);
  });

  test('place without coords keeps previous GPS coords instead of wiping them', () => {
    const prev: ActiveLocationState = {
      ...INITIAL,
      ok: true,
      coords: { lat: 1.23, lng: 4.56, accuracyMeters: 30 },
    };
    const coordless: Place = { ...PICKED, lat: null, lng: null };
    const next = buildManualCityState(prev, coordless, NOW);

    assert.deepEqual(next.coords, { lat: 1.23, lng: 4.56, accuracyMeters: 30 });
    assert.deepEqual(next.place, coordless);
    assert.deepEqual(deriveUniversalLocation(next), coordless);
  });

  test('permissionStatus is preserved from the previous state', () => {
    const next = buildManualCityState({ ...INITIAL, permissionStatus: 'granted' }, PICKED, NOW);
    assert.equal(next.permissionStatus, 'granted');
  });

  test('deriveUniversalLocation returns null before any location is set', () => {
    assert.equal(deriveUniversalLocation(INITIAL), null);
  });
});

describe('setLocation(place) — API persistence payload', () => {
  test('payload carries the full place plus legacy city/country columns', () => {
    const payload = buildManualCityPayload(PICKED);
    assert.equal(payload.source, 'manual_city');
    assert.equal(payload.manualCity, 'Kyoto');
    assert.equal(payload.manualCountry, 'Japan');
    assert.deepEqual(payload.place, PICKED);
  });

  test('city-less place falls back to name for manualCity — never null city AND null name', () => {
    const payload = buildManualCityPayload({ ...PICKED, city: null });
    assert.equal(payload.manualCity, 'Kyoto'); // falls back to place.name
    assert.equal(payload.manualCountry, 'Japan');
  });
});
