/**
 * Integration-style tests for the GPS-capture and map-pick flows.
 *
 * Run:
 *   node --import tsx/esm --test src/components/location/__tests__/locationCaptureFlow.test.ts
 *
 * GpsLocationCapture.tsx and MapLocationPicker.tsx delegate their async flows
 * to runPlaceCapture / confirmMapCenterAsPlace (the component files cannot be
 * mounted here — no RN renderer). These tests exercise those flows end-to-end
 * with fake GPS/geocode deps and assert the onCapture/onConfirm callbacks
 * receive a FULL canonical Place — the exact regression this guards against
 * is a callback firing with a partial place (null city/country lost in a
 * conversion) or firing at all on a failure path.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlaceCapture } from '../GpsLocationCapture.machine.ts';
import { confirmMapCenterAsPlace } from '../MapLocationPicker.machine.ts';
import type { Place } from '../../../lib/location/placeTypes.ts';

const FULL_PLACE: Place = {
  id: 'nominatim-777',
  type: 'city',
  name: 'Lisbon',
  displayName: 'Lisbon, Portugal',
  country: 'Portugal',
  countryCode: 'PT',
  region: 'Lisboa',
  city: 'Lisbon',
  district: null,
  lat: 38.7223,
  lng: -9.1393,
  timezone: 'Europe/Lisbon',
  source: 'gps',
  address: null,
  postalCode: null,
  formattedAddress: 'Lisbon, Portugal',
};

function assertFullPlace(place: Place) {
  for (const key of [
    'id', 'type', 'name', 'displayName', 'country', 'countryCode',
    'region', 'city', 'district', 'lat', 'lng', 'timezone', 'source',
  ] as const) {
    assert.notEqual(place[key], undefined, `Place field "${key}" is undefined`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GpsLocationCapture — runPlaceCapture
// ═══════════════════════════════════════════════════════════════════════════════

describe('GpsLocationCapture flow (runPlaceCapture)', () => {
  test('success: onCapture receives the full Place from reverseGeocodeToPlace', async () => {
    const captured: Place[] = [];
    const outcome = await runPlaceCapture({
      getCurrentGps: async () => ({ granted: true, lat: 38.7223, lng: -9.1393 }),
      reverseGeocodeToPlace: async (lat, lng) => {
        assert.equal(lat, 38.7223);
        assert.equal(lng, -9.1393);
        return FULL_PLACE;
      },
      onCapture: (p) => captured.push(p),
    });

    assert.equal(outcome.nextState, 'success');
    assert.equal(captured.length, 1);
    assertFullPlace(captured[0]);
    assert.deepEqual(captured[0], FULL_PLACE);
  });

  test('permission denied: state=denied and onCapture is NOT called', async () => {
    const captured: Place[] = [];
    const outcome = await runPlaceCapture({
      getCurrentGps: async () => ({ granted: false, lat: null, lng: null, error: 'permission_denied' }),
      reverseGeocodeToPlace: async () => FULL_PLACE,
      onCapture: (p) => captured.push(p),
    });
    assert.equal(outcome.nextState, 'denied');
    assert.equal(captured.length, 0);
  });

  test('GPS failed: state=error and onCapture is NOT called', async () => {
    const captured: Place[] = [];
    const outcome = await runPlaceCapture({
      getCurrentGps: async () => ({ granted: false, lat: null, lng: null, error: 'gps_failed' }),
      reverseGeocodeToPlace: async () => FULL_PLACE,
      onCapture: (p) => captured.push(p),
    });
    assert.equal(outcome.nextState, 'error');
    assert.equal(captured.length, 0);
  });

  test('granted but null coords: state=error and onCapture is NOT called', async () => {
    const captured: Place[] = [];
    const outcome = await runPlaceCapture({
      getCurrentGps: async () => ({ granted: true, lat: null, lng: null }),
      reverseGeocodeToPlace: async () => FULL_PLACE,
      onCapture: (p) => captured.push(p),
    });
    assert.equal(outcome.nextState, 'error');
    assert.equal(captured.length, 0);
  });

  test('geocode throws: state=error, never a silent capture with a partial place', async () => {
    const captured: Place[] = [];
    const outcome = await runPlaceCapture({
      getCurrentGps: async () => ({ granted: true, lat: 1, lng: 2 }),
      reverseGeocodeToPlace: async () => { throw new Error('geocode blew up'); },
      onCapture: (p) => captured.push(p),
    });
    assert.equal(outcome.nextState, 'error');
    assert.equal(captured.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MapLocationPicker — confirmMapCenterAsPlace
// ═══════════════════════════════════════════════════════════════════════════════

describe('MapLocationPicker flow (confirmMapCenterAsPlace)', () => {
  test('confirm: swaps MapLibre [lng, lat] to (lat, lng) and onConfirm gets a full Place', async () => {
    const confirmed: Place[] = [];
    let geocodedWith: [number, number] | null = null;

    const place = await confirmMapCenterAsPlace({
      center: [-9.1393, 38.7223], // MapLibre [lng, lat]
      reverseGeocodeToPlace: async (lat, lng) => {
        geocodedWith = [lat, lng];
        return FULL_PLACE;
      },
      onConfirm: (p) => confirmed.push(p),
    });

    // Coordinate-order contract: lat first after the swap.
    assert.deepEqual(geocodedWith, [38.7223, -9.1393]);
    assert.equal(confirmed.length, 1);
    assertFullPlace(confirmed[0]);
    assert.deepEqual(confirmed[0], FULL_PLACE);
    assert.deepEqual(place, FULL_PLACE);
  });

  test('geocode failure propagates (component shows error) and onConfirm is NOT called', async () => {
    const confirmed: Place[] = [];
    await assert.rejects(
      confirmMapCenterAsPlace({
        center: [0, 0],
        reverseGeocodeToPlace: async () => { throw new Error('geocode failed'); },
        onConfirm: (p) => confirmed.push(p),
      }),
      /geocode failed/,
    );
    assert.equal(confirmed.length, 0);
  });
});
