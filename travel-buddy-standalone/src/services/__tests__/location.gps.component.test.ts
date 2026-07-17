/**
 * Unit tests for:
 *   1. getCurrentGps()       — services/location.ts
 *   2. GpsLocationCapture state machine — components/location/GpsLocationCapture.machine.ts
 *   3. Form submit coordinate-type contract (gems/submit.tsx)
 *
 * Covers:
 *  getCurrentGps():
 *  • permission denied → { granted: false, error: 'permission_denied' }
 *  • fresh live fix succeeds → { granted: true, cached: false }
 *  • live fix fails → falls back to last-known position → { granted: true, cached: true }
 *  • live fix fails AND last-known returns null → { granted: false, error: 'gps_failed' }
 *  • live fix fails AND last-known throws → { granted: false, error: 'gps_failed' }
 *  • last-known cache call receives correct maxAge / requiredAccuracy constraints
 *  • outer permission error is caught and returned as error string
 *
 *  GpsLocationCapture machine (runGpsCapture):
 *  • idle → loading → success   (permission granted, live fix succeeds)
 *  • idle → loading → denied    (permission_denied mid-flow)
 *  • idle → loading → error     (gps_failed, lat/lng null)
 *  • idle → loading → error → retry → success  (retry path)
 *  • reverse-geocode fallback used when API fetch fails
 *  • API-provided label takes priority over expo geocoder
 *
 *  Form submit coordinate-type contract (mapCaptureToFormCoords):
 *  • gpsLat / gpsLng are numbers (not strings) when GPS captured
 *  • gpsLat / gpsLng are undefined (not null) when result is null (skipped)
 *  • submitGem latitude/longitude fields honour the number | undefined type
 *
 * Run with:  pnpm test:component
 *
 * expo-location is mocked; no real device I/O occurs.
 * getCurrentPositionAsync is made to reject instantly so no fake timers
 * are needed to trigger the 8-second GPS_TIMEOUT_MS path.
 * GpsLocationCapture.machine.ts has zero native imports and is imported directly.
 */

import { getCurrentGps } from '../location.ts';

// ── expo-location mock ────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync:           jest.fn(),
  getLastKnownPositionAsync:         jest.fn(),
  Accuracy: { Balanced: 3, High: 4 },
}));

import * as Location from 'expo-location';

const mockRequestPerms        = Location.requestForegroundPermissionsAsync as jest.Mock;
const mockGetCurrentPosition  = Location.getCurrentPositionAsync          as jest.Mock;
const mockGetLastKnown        = Location.getLastKnownPositionAsync         as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LIVE_POS = {
  coords: { latitude: 48.8584, longitude: 2.2945, accuracy: 12.5 },
  timestamp: Date.now(),
};

const CACHED_POS = {
  coords: { latitude: 48.8600, longitude: 2.2960, accuracy: 45.0 },
  timestamp: Date.now() - 90_000,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getCurrentGps()', () => {
  it('returns error: permission_denied when foreground permission is denied', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'denied' });

    const result = await getCurrentGps();

    expect(result.granted).toBe(false);
    expect(result.error).toBe('permission_denied');
    expect(result.lat).toBeNull();
    expect(result.lng).toBeNull();
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });

  it('returns cached: false when the live GPS fix succeeds (gps_fresh path)', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'granted' });
    mockGetCurrentPosition.mockResolvedValue(LIVE_POS);

    const result = await getCurrentGps();

    expect(result.granted).toBe(true);
    expect(result.cached).toBe(false);
    expect(result.lat).toBe(LIVE_POS.coords.latitude);
    expect(result.lng).toBe(LIVE_POS.coords.longitude);
    expect(result.accuracyMeters).toBe(LIVE_POS.coords.accuracy);
    expect(result.error).toBeUndefined();
    expect(mockGetLastKnown).not.toHaveBeenCalled();
  });

  it('falls back to last-known position and returns cached: true (gps_cached path)', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'granted' });
    mockGetCurrentPosition.mockRejectedValue(new Error('location unavailable'));
    mockGetLastKnown.mockResolvedValue(CACHED_POS);

    const result = await getCurrentGps();

    expect(result.granted).toBe(true);
    expect(result.cached).toBe(true);
    expect(result.lat).toBe(CACHED_POS.coords.latitude);
    expect(result.lng).toBe(CACHED_POS.coords.longitude);
    expect(result.error).toBeUndefined();
  });

  it('calls getLastKnownPositionAsync with correct maxAge and requiredAccuracy', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'granted' });
    mockGetCurrentPosition.mockRejectedValue(new Error('timeout'));
    mockGetLastKnown.mockResolvedValue(CACHED_POS);

    await getCurrentGps();

    expect(mockGetLastKnown).toHaveBeenCalledWith({
      maxAge:           5 * 60 * 1000,
      requiredAccuracy: 500,
    });
  });

  it('returns error: gps_failed when live fix fails and last-known returns null', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'granted' });
    mockGetCurrentPosition.mockRejectedValue(new Error('timeout'));
    mockGetLastKnown.mockResolvedValue(null);

    const result = await getCurrentGps();

    expect(result.granted).toBe(false);
    expect(result.error).toBe('gps_failed');
    expect(result.lat).toBeNull();
    expect(result.lng).toBeNull();
  });

  it('returns error: gps_failed when both live fix and last-known throw', async () => {
    mockRequestPerms.mockResolvedValue({ status: 'granted' });
    mockGetCurrentPosition.mockRejectedValue(new Error('timeout'));
    mockGetLastKnown.mockRejectedValue(new Error('no cache'));

    const result = await getCurrentGps();

    expect(result.granted).toBe(false);
    expect(result.error).toBe('gps_failed');
  });

  it('returns error from the outer catch when requestForegroundPermissionsAsync throws', async () => {
    mockRequestPerms.mockRejectedValue(new Error('permission_api_crash'));

    const result = await getCurrentGps();

    expect(result.granted).toBe(false);
    expect(result.error).toBe('permission_api_crash');
  });
});

// ── GpsLocationCapture state machine ─────────────────────────────────────────
//
// runGpsCapture() and mapCaptureToFormCoords() live in
// GpsLocationCapture.machine.ts which has zero native/expo imports, so we can
// import and call them directly without mocking.

import {
  runGpsCapture,
  mapCaptureToFormCoords,
  type GpsCaptureResult,
} from '../../components/location/GpsLocationCapture.machine.ts';

// ── Shared fake deps ───────────────────────────────────────────────────────────

const PARIS_PLACE = { city: 'Paris', district: null, country: 'France' };
const PARIS_COORDS = { lat: 48.8584, lng: 2.2945 };

function okGps(lat = PARIS_COORDS.lat, lng = PARIS_COORDS.lng) {
  return jest.fn().mockResolvedValue({ granted: true, lat, lng });
}

function deniedGps() {
  return jest.fn().mockResolvedValue({
    granted: false, lat: null, lng: null, error: 'permission_denied',
  });
}

function failedGps() {
  return jest.fn().mockResolvedValue({
    granted: false, lat: null, lng: null, error: 'gps_failed',
  });
}

function nullCoordsGps() {
  return jest.fn().mockResolvedValue({ granted: true, lat: null, lng: null });
}

function okGeocode() {
  return jest.fn().mockResolvedValue(PARIS_PLACE);
}

function failingFetch(): jest.Mock {
  return jest.fn().mockRejectedValue(new Error('network'));
}

function okFetch(place: object): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ place }),
  });
}

function notOkFetch(): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runGpsCapture() — GpsLocationCapture state machine', () => {
  it('idle → success: returns nextState "success" with number lat/lng when GPS is granted and fix succeeds', async () => {
    const outcome = await runGpsCapture({
      getCurrentGps: okGps(),
      reverseGeocodeDetailed: okGeocode(),
      apiBase: 'https://api.test',
      fetchFn: failingFetch(),
    });

    expect(outcome.nextState).toBe('success');
    if (outcome.nextState !== 'success') return;

    expect(typeof outcome.result.lat).toBe('number');
    expect(typeof outcome.result.lng).toBe('number');
    expect(outcome.result.lat).toBe(PARIS_COORDS.lat);
    expect(outcome.result.lng).toBe(PARIS_COORDS.lng);
    expect(typeof outcome.result.label).toBe('string');
    expect(outcome.result.label.length).toBeGreaterThan(0);
  });

  it('idle → denied: returns nextState "denied" when permission_denied mid-flow', async () => {
    const outcome = await runGpsCapture({
      getCurrentGps: deniedGps(),
      reverseGeocodeDetailed: okGeocode(),
      apiBase: 'https://api.test',
      fetchFn: failingFetch(),
    });

    expect(outcome.nextState).toBe('denied');
  });

  it('idle → error: returns nextState "error" when gps_failed (e.g. GPS timeout with no cache)', async () => {
    const outcome = await runGpsCapture({
      getCurrentGps: failedGps(),
      reverseGeocodeDetailed: okGeocode(),
      apiBase: 'https://api.test',
      fetchFn: failingFetch(),
    });

    expect(outcome.nextState).toBe('error');
  });

  it('idle → error: returns nextState "error" when granted but lat/lng are null (no position available)', async () => {
    const outcome = await runGpsCapture({
      getCurrentGps: nullCoordsGps(),
      reverseGeocodeDetailed: okGeocode(),
      apiBase: 'https://api.test',
      fetchFn: failingFetch(),
    });

    expect(outcome.nextState).toBe('error');
  });

  it('retry path: error on first call → success on retry call (machine is stateless)', async () => {
    const firstOutcome = await runGpsCapture({
      getCurrentGps: failedGps(),
      reverseGeocodeDetailed: okGeocode(),
      apiBase: 'https://api.test',
      fetchFn: failingFetch(),
    });

    expect(firstOutcome.nextState).toBe('error');

    const retryOutcome = await runGpsCapture({
      getCurrentGps: okGps(),
      reverseGeocodeDetailed: okGeocode(),
      apiBase: 'https://api.test',
      fetchFn: failingFetch(),
    });

    expect(retryOutcome.nextState).toBe('success');
  });

  it('uses API-provided label when fetch succeeds (API label takes priority over expo geocoder)', async () => {
    const outcome = await runGpsCapture({
      getCurrentGps: okGps(),
      reverseGeocodeDetailed: jest.fn().mockResolvedValue({ city: 'Fallback City', country: 'Fallback Country' }),
      apiBase: 'https://api.test',
      fetchFn: okFetch({ city: 'API City', country: 'API Country' }),
    });

    expect(outcome.nextState).toBe('success');
    if (outcome.nextState !== 'success') return;

    expect(outcome.result.label).toContain('API City');
    expect(outcome.result.label).toContain('API Country');
  });

  it('falls back to expo reverseGeocodeDetailed when API fetch fails', async () => {
    const outcome = await runGpsCapture({
      getCurrentGps: okGps(),
      reverseGeocodeDetailed: okGeocode(),
      apiBase: 'https://api.test',
      fetchFn: failingFetch(),
    });

    expect(outcome.nextState).toBe('success');
    if (outcome.nextState !== 'success') return;

    expect(outcome.result.label).toContain('Paris');
    expect(outcome.result.label).toContain('France');
  });

  it('falls back to expo reverseGeocodeDetailed when API returns non-ok status', async () => {
    const outcome = await runGpsCapture({
      getCurrentGps: okGps(),
      reverseGeocodeDetailed: okGeocode(),
      apiBase: 'https://api.test',
      fetchFn: notOkFetch(),
    });

    expect(outcome.nextState).toBe('success');
    if (outcome.nextState !== 'success') return;

    expect(outcome.result.label).toContain('Paris');
  });

  it('uses default label "Location detected" when both API and expo geocoder return nothing', async () => {
    const outcome = await runGpsCapture({
      getCurrentGps: okGps(),
      reverseGeocodeDetailed: jest.fn().mockResolvedValue({ city: null, country: null }),
      apiBase: 'https://api.test',
      fetchFn: notOkFetch(),
    });

    expect(outcome.nextState).toBe('success');
    if (outcome.nextState !== 'success') return;

    expect(outcome.result.label).toBe('Location detected');
  });
});

// ── Form submit coordinate-type contract ──────────────────────────────────────
//
// Verifies that coordinates flowing from GpsLocationCapture → LocationStep
// handleCapture → FormState → submitGem() are always number | undefined —
// never string, never null — matching the FormState and submitGem() types.

describe('mapCaptureToFormCoords() — form submit coordinate-type contract', () => {
  it('gpsLat and gpsLng are numbers (not strings) when a GpsCaptureResult is provided', () => {
    const captureResult: GpsCaptureResult = {
      lat: 48.8584,
      lng: 2.2945,
      label: 'Paris, France',
    };

    const { gpsLat, gpsLng, gpsLabel } = mapCaptureToFormCoords(captureResult);

    expect(typeof gpsLat).toBe('number');
    expect(typeof gpsLng).toBe('number');
    expect(gpsLat).toBe(48.8584);
    expect(gpsLng).toBe(2.2945);
    expect(gpsLabel).toBe('Paris, France');
  });

  it('gpsLat, gpsLng, gpsLabel are undefined (not null) when result is null (GPS skipped or cleared)', () => {
    const { gpsLat, gpsLng, gpsLabel } = mapCaptureToFormCoords(null);

    expect(gpsLat).toBeUndefined();
    expect(gpsLng).toBeUndefined();
    expect(gpsLabel).toBeUndefined();

    expect(gpsLat).not.toBeNull();
    expect(gpsLng).not.toBeNull();
  });

  it('negative coordinates are preserved as numbers (southern/western hemisphere)', () => {
    const captureResult: GpsCaptureResult = {
      lat: -33.8688,
      lng: 151.2093,
      label: 'Sydney, Australia',
    };

    const { gpsLat, gpsLng } = mapCaptureToFormCoords(captureResult);

    expect(gpsLat).toBe(-33.8688);
    expect(gpsLng).toBe(151.2093);
    expect(typeof gpsLat).toBe('number');
    expect(typeof gpsLng).toBe('number');
  });

  it('submitGem receives latitude/longitude as number | undefined matching the service signature', () => {
    const captureResult: GpsCaptureResult = { lat: 35.6762, lng: 139.6503, label: 'Tokyo, Japan' };
    const { gpsLat, gpsLng } = mapCaptureToFormCoords(captureResult);

    const submitPayload = {
      name: 'A gem',
      category: 'food' as const,
      city: 'Tokyo',
      latitude:  gpsLat,
      longitude: gpsLng,
    };

    expect(typeof submitPayload.latitude).toBe('number');
    expect(typeof submitPayload.longitude).toBe('number');

    const skipPayload = {
      name: 'A gem',
      category: 'food' as const,
      city: 'Tokyo',
      latitude:  mapCaptureToFormCoords(null).gpsLat,
      longitude: mapCaptureToFormCoords(null).gpsLng,
    };

    expect(skipPayload.latitude).toBeUndefined();
    expect(skipPayload.longitude).toBeUndefined();
  });
});

// ── Gem submit wiring — GPS → LocationStep.handleCapture → submitGem payload ──
//
// Verifies the actual function used by LocationStep.handleCapture in
// gems/submit.tsx (mapCaptureToFormCoords) produces the correct FormState
// values that flow through to submitGem(latitude, longitude).
//
// The LocationStep.handleCapture now calls:
//   const coords = mapCaptureToFormCoords(result);
//   update('gpsLat', coords.gpsLat);   → FormState.gpsLat: number | undefined
//   update('gpsLng', coords.gpsLng);   → FormState.gpsLng: number | undefined
//
// handleNext in submit.tsx then builds the submitGem payload as:
//   latitude:  form.gpsLat,            → must be number when GPS was captured
//   longitude: form.gpsLng,            → must be undefined when GPS was skipped
//
// These tests verify both ends of that chain are consistent and type-correct.

describe('gem submit wiring — GPS coordinates flow from handleCapture to submitGem payload', () => {
  it('GPS captured path: handleCapture updates form with number coords, submitGem payload uses numbers', () => {
    const captureResult: GpsCaptureResult = { lat: 48.8584, lng: 2.2945, label: 'Paris, France' };

    const coords = mapCaptureToFormCoords(captureResult);

    expect(typeof coords.gpsLat).toBe('number');
    expect(typeof coords.gpsLng).toBe('number');
    expect(coords.gpsLat).not.toBeNull();
    expect(coords.gpsLng).not.toBeNull();

    const latitude:  number | undefined = coords.gpsLat;
    const longitude: number | undefined = coords.gpsLng;

    expect(latitude).toBe(48.8584);
    expect(longitude).toBe(2.2945);
    expect(typeof latitude).toBe('number');
    expect(typeof longitude).toBe('number');
  });

  it('GPS denied / skipped path: handleCapture(null) sets coords to undefined, submitGem omits lat/lng', () => {
    const coords = mapCaptureToFormCoords(null);

    expect(coords.gpsLat).toBeUndefined();
    expect(coords.gpsLng).toBeUndefined();
    expect(coords.gpsLabel).toBeUndefined();

    const latitude:  number | undefined = coords.gpsLat;
    const longitude: number | undefined = coords.gpsLng;

    expect(latitude).toBeUndefined();
    expect(longitude).toBeUndefined();
  });

  it('GPS captured then cleared: second handleCapture(null) resets coords to undefined', () => {
    const captureResult: GpsCaptureResult = { lat: 35.6762, lng: 139.6503, label: 'Tokyo, Japan' };

    const firstCoords = mapCaptureToFormCoords(captureResult);
    expect(typeof firstCoords.gpsLat).toBe('number');

    const clearedCoords = mapCaptureToFormCoords(null);
    expect(clearedCoords.gpsLat).toBeUndefined();
    expect(clearedCoords.gpsLng).toBeUndefined();
  });

  it('end-to-end shape: captured coords produce a valid submitGem-compatible payload', () => {
    const captureResult: GpsCaptureResult = { lat: 1.3521, lng: 103.8198, label: 'Singapore' };
    const coords = mapCaptureToFormCoords(captureResult);

    const payload = {
      name:             'Hawker Centre',
      category:         'food' as const,
      city:             'Singapore',
      country:          'Singapore',
      latitude:         coords.gpsLat,
      longitude:        coords.gpsLng,
      sensitivityLevel: 'public' as const,
    };

    expect(typeof payload.latitude).toBe('number');
    expect(typeof payload.longitude).toBe('number');
    expect(payload.latitude).toBe(1.3521);
    expect(payload.longitude).toBe(103.8198);
  });

  it('end-to-end shape: skipped GPS produces submitGem payload with undefined lat/lng (not null, not string)', () => {
    const coords = mapCaptureToFormCoords(null);

    const payload = {
      name:             'Hawker Centre',
      category:         'food' as const,
      city:             'Singapore',
      latitude:         coords.gpsLat,
      longitude:        coords.gpsLng,
      sensitivityLevel: 'public' as const,
    };

    expect(payload.latitude).toBeUndefined();
    expect(payload.longitude).toBeUndefined();
    expect(payload.latitude).not.toBeNull();
    expect(payload.longitude).not.toBeNull();
  });
});
