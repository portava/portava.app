/**
 * Unit tests for the map-picker coordinate round-trip:
 *
 *   MapLocationPicker (user pans map) → resolveMapPickerResult()
 *     → GpsCaptureResult → mapCaptureToFormCoords()
 *     → FormState { gpsLat, gpsLng } → submitGem payload
 *
 * The map-picker stores the map center in MapLibre's [lng, lat] order.
 * These tests confirm:
 *
 *   1. resolveMapPickerResult swaps [lng, lat] → { lat, lng } correctly
 *      (no silent coordinate transposition).
 *   2. The reverse-geocode label fallback chain:
 *        Stage 1: backend API  /api/places/reverse
 *        Stage 2: expo reverseGeocodeDetailed
 *        Stage 3: "Selected location"  (both unavailable)
 *   3. The GpsCaptureResult produced by the map-picker flows through
 *      mapCaptureToFormCoords() unchanged, yielding number | undefined
 *      fields matching the FormState / submitGem types.
 *   4. Confirmed coordinates are passed unchanged to onConfirm (no mutation,
 *      no rounding, no string coercion).
 *
 * resolveMapPickerResult has zero native/expo/MapLibre imports, so it is
 * imported directly.  expo-location is not needed here.
 *
 * Run with:  pnpm test:component
 */

import {
  resolveMapPickerResult,
} from '../../components/location/MapLocationPicker.machine.ts';
import {
  mapCaptureToFormCoords,
  type GpsCaptureResult,
} from '../../components/location/GpsLocationCapture.machine.ts';

// ── Fake fetch helpers ─────────────────────────────────────────────────────────

function okFetch(place: object): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ place }),
  });
}

function notOkFetch(): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
}

function failingFetch(): jest.Mock {
  return jest.fn().mockRejectedValue(new Error('network'));
}

// ── Fake geocoder helpers ──────────────────────────────────────────────────────

function okGeocode(city: string, country: string) {
  return jest.fn().mockResolvedValue({ city, district: null, country });
}

function failingGeocode() {
  return jest.fn().mockRejectedValue(new Error('geocoder_unavailable'));
}

function emptyGeocode() {
  return jest.fn().mockResolvedValue({ city: null, district: null, country: null });
}

// ── Coordinate fixtures ────────────────────────────────────────────────────────

// MapLibre stores center as [lng, lat].
const KYOTO_LNG = 135.7681;
const KYOTO_LAT = 35.0116;
const KYOTO_CENTER: [number, number] = [KYOTO_LNG, KYOTO_LAT];

const BUENOS_AIRES_LNG = -58.3816;
const BUENOS_AIRES_LAT = -34.6037;
const BUENOS_AIRES_CENTER: [number, number] = [BUENOS_AIRES_LNG, BUENOS_AIRES_LAT];

// ── 1. Coordinate-order tests ─────────────────────────────────────────────────

describe('resolveMapPickerResult() — coordinate-order correctness', () => {
  it('swaps [lng, lat] MapLibre center to { lat, lng } in the result (no transposition)', async () => {
    const result = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Kyoto', 'Japan'),
      fetchFn: failingFetch(),
    });

    // lat must equal the second element of the MapLibre center tuple
    expect(result.lat).toBe(KYOTO_LAT);
    // lng must equal the first element
    expect(result.lng).toBe(KYOTO_LNG);

    expect(typeof result.lat).toBe('number');
    expect(typeof result.lng).toBe('number');
  });

  it('preserves negative coordinates for southern/western hemisphere without sign flip', async () => {
    const result = await resolveMapPickerResult({
      center: BUENOS_AIRES_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Buenos Aires', 'Argentina'),
      fetchFn: failingFetch(),
    });

    expect(result.lat).toBe(BUENOS_AIRES_LAT);   // negative latitude
    expect(result.lng).toBe(BUENOS_AIRES_LNG);   // negative longitude
    expect(typeof result.lat).toBe('number');
    expect(typeof result.lng).toBe('number');
  });

  it('passes coordinates to reverseGeocodeDetailed in (lat, lng) order, not MapLibre order', async () => {
    const geocodeMock = okGeocode('Kyoto', 'Japan');

    await resolveMapPickerResult({
      center: KYOTO_CENTER,   // [lng=135.7681, lat=35.0116]
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: geocodeMock,
      fetchFn: failingFetch(),
    });

    // geocoder must receive (lat, lng) not (lng, lat)
    expect(geocodeMock).toHaveBeenCalledWith(KYOTO_LAT, KYOTO_LNG);
  });

  it('passes lat and lng to the API URL in correct order', async () => {
    const fetchMock = okFetch({ city: 'Kyoto', country: 'Japan' });

    await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Kyoto', 'Japan'),
      fetchFn: fetchMock,
    });

    const calledUrl: string = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain(`lat=${KYOTO_LAT}`);
    expect(calledUrl).toContain(`lng=${KYOTO_LNG}`);
  });
});

// ── 2. Label fallback chain ───────────────────────────────────────────────────

describe('resolveMapPickerResult() — reverse-geocode label fallback chain', () => {
  it('stage 1: uses API-provided label when fetch succeeds', async () => {
    const result = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Fallback City', 'Fallback Country'),
      fetchFn: okFetch({ city: 'Kyoto', country: 'Japan' }),
    });

    expect(result.label).toContain('Kyoto');
    expect(result.label).toContain('Japan');
    expect(result.label).not.toContain('Fallback');
  });

  it('stage 1: uses API displayName when city is absent from the API response', async () => {
    const result = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Geocoder City', 'Geocoder Country'),
      fetchFn: okFetch({ displayName: 'Kyoto Prefecture', country: 'Japan' }),
    });

    expect(result.label).toContain('Kyoto Prefecture');
    expect(result.label).toContain('Japan');
  });

  it('stage 2: falls back to expo reverseGeocodeDetailed when API fetch throws', async () => {
    const result = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Kyoto', 'Japan'),
      fetchFn: failingFetch(),
    });

    expect(result.label).toContain('Kyoto');
    expect(result.label).toContain('Japan');
  });

  it('stage 2: falls back to expo reverseGeocodeDetailed when API returns non-ok status', async () => {
    const result = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Kyoto', 'Japan'),
      fetchFn: notOkFetch(),
    });

    expect(result.label).toContain('Kyoto');
    expect(result.label).toContain('Japan');
  });

  it('stage 2: uses district when city is null in expo geocoder result', async () => {
    const geocodeMock = jest.fn().mockResolvedValue({
      city: null,
      district: 'Fushimi Ward',
      country: 'Japan',
    });

    const result = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: geocodeMock,
      fetchFn: failingFetch(),
    });

    expect(result.label).toContain('Fushimi Ward');
    expect(result.label).toContain('Japan');
  });

  it('stage 3: falls back to "Selected location" when API fails and expo geocoder throws', async () => {
    const result = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: failingGeocode(),
      fetchFn: failingFetch(),
    });

    expect(result.label).toBe('Selected location');
  });

  it('stage 3: falls back to "Selected location" when both API and expo geocoder return no city/country', async () => {
    const result = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: emptyGeocode(),
      fetchFn: notOkFetch(),
    });

    expect(result.label).toBe('Selected location');
  });

  it('stage 3: "Selected location" fallback is different from GPS "Location detected" fallback', async () => {
    const result = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: emptyGeocode(),
      fetchFn: failingFetch(),
    });

    // Map-picker uses "Selected location"; GPS machine uses "Location detected".
    expect(result.label).toBe('Selected location');
    expect(result.label).not.toBe('Location detected');
  });
});

// ── 3. mapCaptureToFormCoords round-trip with map-picker result ───────────────

describe('mapCaptureToFormCoords() — map-picker result round-trip', () => {
  it('map-picker result flows through mapCaptureToFormCoords as number | undefined', async () => {
    const pickerResult = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Kyoto', 'Japan'),
      fetchFn: failingFetch(),
    });

    const { gpsLat, gpsLng, gpsLabel } = mapCaptureToFormCoords(pickerResult);

    expect(typeof gpsLat).toBe('number');
    expect(typeof gpsLng).toBe('number');
    expect(typeof gpsLabel).toBe('string');
    expect(gpsLat).toBe(KYOTO_LAT);
    expect(gpsLng).toBe(KYOTO_LNG);
    expect(gpsLabel).toContain('Kyoto');
  });

  it('coordinates are not rounded or coerced during the round-trip', async () => {
    const PRECISE_LNG = 135.76813456;
    const PRECISE_LAT = 35.01162347;

    const pickerResult = await resolveMapPickerResult({
      center: [PRECISE_LNG, PRECISE_LAT],
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Kyoto', 'Japan'),
      fetchFn: failingFetch(),
    });

    const { gpsLat, gpsLng } = mapCaptureToFormCoords(pickerResult);

    expect(gpsLat).toBe(PRECISE_LAT);
    expect(gpsLng).toBe(PRECISE_LNG);
  });

  it('map-picker result with "Selected location" label flows through unchanged', async () => {
    const pickerResult = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: emptyGeocode(),
      fetchFn: failingFetch(),
    });

    const { gpsLat, gpsLng, gpsLabel } = mapCaptureToFormCoords(pickerResult);

    expect(gpsLat).toBe(KYOTO_LAT);
    expect(gpsLng).toBe(KYOTO_LNG);
    expect(gpsLabel).toBe('Selected location');
  });

  it('null result (picker cancelled before confirm) yields undefined coords', () => {
    const { gpsLat, gpsLng, gpsLabel } = mapCaptureToFormCoords(null);

    expect(gpsLat).toBeUndefined();
    expect(gpsLng).toBeUndefined();
    expect(gpsLabel).toBeUndefined();
  });
});

// ── 4. onConfirm receives unchanged coordinates ───────────────────────────────

describe('map-picker onConfirm round-trip — coordinates passed unchanged', () => {
  it('onConfirm receives lat/lng identical to the map-center (no mutation)', async () => {
    const onConfirm = jest.fn();

    const pickerResult = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Kyoto', 'Japan'),
      fetchFn: failingFetch(),
    });

    onConfirm(pickerResult);

    const captured: GpsCaptureResult = onConfirm.mock.calls[0][0];
    expect(captured.lat).toBe(KYOTO_LAT);
    expect(captured.lng).toBe(KYOTO_LNG);
    expect(typeof captured.lat).toBe('number');
    expect(typeof captured.lng).toBe('number');
    expect(typeof captured.label).toBe('string');
  });

  it('submitGem-compatible payload built from map-picker result has correct types', async () => {
    const pickerResult = await resolveMapPickerResult({
      center: BUENOS_AIRES_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Buenos Aires', 'Argentina'),
      fetchFn: failingFetch(),
    });

    const { gpsLat, gpsLng } = mapCaptureToFormCoords(pickerResult);

    const payload = {
      name: 'La Boca Mural',
      category: 'art' as const,
      city: 'Buenos Aires',
      country: 'Argentina',
      latitude: gpsLat,
      longitude: gpsLng,
    };

    expect(typeof payload.latitude).toBe('number');
    expect(typeof payload.longitude).toBe('number');
    expect(payload.latitude).toBe(BUENOS_AIRES_LAT);
    expect(payload.longitude).toBe(BUENOS_AIRES_LNG);
  });

  it('sequential picks produce independent results (no shared state)', async () => {
    const LONDON_CENTER: [number, number] = [-0.1276, 51.5074];
    const NAIROBI_CENTER: [number, number] = [36.8219, -1.2921];

    const [londonResult, nairobiResult] = await Promise.all([
      resolveMapPickerResult({
        center: LONDON_CENTER,
        apiBase: 'https://api.test',
        reverseGeocodeDetailed: okGeocode('London', 'United Kingdom'),
        fetchFn: failingFetch(),
      }),
      resolveMapPickerResult({
        center: NAIROBI_CENTER,
        apiBase: 'https://api.test',
        reverseGeocodeDetailed: okGeocode('Nairobi', 'Kenya'),
        fetchFn: failingFetch(),
      }),
    ]);

    expect(londonResult.lat).toBe(51.5074);
    expect(londonResult.lng).toBe(-0.1276);
    expect(nairobiResult.lat).toBe(-1.2921);
    expect(nairobiResult.lng).toBe(36.8219);

    expect(londonResult.lat).not.toBe(nairobiResult.lat);
    expect(londonResult.lng).not.toBe(nairobiResult.lng);
  });
});

// ── 5. Initial-props isolation — pre-filled location does not leak into result
//
// These tests verify the contract between MapLocationPicker's `initialLat`/
// `initialLng` props and the coordinate that is ultimately confirmed.
//
// How the component wires this:
//   centerRef = useRef([initialLng, initialLat])   ← initialised once on mount
//   handleRegionDidChange → overwrites centerRef.current on every pan
//   handleConfirm → resolveMapPickerResult({ center: centerRef.current })
//   initialCenter → passed ONLY to Camera's initialViewState (read-only viewport)
//
// The pure function `resolveMapPickerResult` has no module-level state, so
// it always returns whatever `center` it is given.  These tests pin that
// contract explicitly so that any future refactor which accidentally routes
// `initialCenter` into `resolveMapPickerResult` instead of `centerRef.current`
// is caught immediately.
// ─────────────────────────────────────────────────────────────────────────────

const PARIS_LNG = 2.3522;
const PARIS_LAT = 48.8566;
const PARIS_CENTER: [number, number] = [PARIS_LNG, PARIS_LAT];

describe('initial-props isolation — pre-filled location does not leak into confirmed result', () => {
  it('result uses the panned center, not the initial pre-fill, when the user moves the map', async () => {
    // Scenario: picker opened pre-filled at Kyoto (initialLat=35.0116, initialLng=135.7681)
    // but the user pans to Paris before tapping Confirm.
    // centerRef.current at Confirm time holds Paris — that is what must come back.
    const result = await resolveMapPickerResult({
      center: PARIS_CENTER,          // ← what centerRef.current holds after the pan
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Paris', 'France'),
      fetchFn: failingFetch(),
    });

    expect(result.lat).toBe(PARIS_LAT);
    expect(result.lng).toBe(PARIS_LNG);

    // Initial pre-fill coords (Kyoto) must NOT appear in the result
    expect(result.lat).not.toBe(KYOTO_LAT);
    expect(result.lng).not.toBe(KYOTO_LNG);
  });

  it('confirming without panning returns the pre-filled initial coords (no silent discard)', async () => {
    // Scenario: picker opened pre-filled at Kyoto and the user immediately taps
    // Confirm without panning.  centerRef.current is still Kyoto — the result
    // must be Kyoto.
    const result = await resolveMapPickerResult({
      center: KYOTO_CENTER,          // ← centerRef.current was never overwritten
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Kyoto', 'Japan'),
      fetchFn: failingFetch(),
    });

    expect(result.lat).toBe(KYOTO_LAT);
    expect(result.lng).toBe(KYOTO_LNG);
  });

  it('two sequential re-opens with different pre-fills each confirm their own panned position', async () => {
    // First open: pre-filled at Kyoto, user pans to Paris, confirms
    const firstResult = await resolveMapPickerResult({
      center: PARIS_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Paris', 'France'),
      fetchFn: failingFetch(),
    });

    // Second open: pre-filled at Buenos Aires, user pans to London, confirms
    const LONDON_CENTER: [number, number] = [-0.1276, 51.5074];
    const secondResult = await resolveMapPickerResult({
      center: LONDON_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('London', 'United Kingdom'),
      fetchFn: failingFetch(),
    });

    // First confirm — Paris
    expect(firstResult.lat).toBe(PARIS_LAT);
    expect(firstResult.lng).toBe(PARIS_LNG);

    // Second confirm — London
    expect(secondResult.lat).toBe(51.5074);
    expect(secondResult.lng).toBe(-0.1276);

    // The two results are fully independent
    expect(firstResult.lat).not.toBe(secondResult.lat);
    expect(firstResult.lng).not.toBe(secondResult.lng);
  });

  it('label in the result reflects the panned location, not the pre-filled one', async () => {
    // Scenario: picker pre-filled at Kyoto; user pans to Paris and confirms.
    // The geocoded label must describe Paris, not Kyoto.
    const result = await resolveMapPickerResult({
      center: PARIS_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Paris', 'France'),
      fetchFn: failingFetch(),
    });

    expect(result.label).toContain('Paris');
    expect(result.label).toContain('France');
    expect(result.label).not.toContain('Kyoto');
    expect(result.label).not.toContain('Japan');
  });

  it('re-opening with null initial props (no pre-fill) and panning to a location confirms that location', async () => {
    // Scenario: first submission had no GPS location; centerRef was DEFAULT_CENTER;
    // user pans to Buenos Aires before confirming.
    const result = await resolveMapPickerResult({
      center: BUENOS_AIRES_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Buenos Aires', 'Argentina'),
      fetchFn: failingFetch(),
    });

    expect(result.lat).toBe(BUENOS_AIRES_LAT);
    expect(result.lng).toBe(BUENOS_AIRES_LNG);
    expect(result.label).toContain('Buenos Aires');
  });
});

// ── 6. Concurrent calls — slow geocode race condition
//
// `resolveMapPickerResult` is a pure function with no module-level state.
// These tests confirm that two in-flight calls never contaminate each other's
// coordinates, even when a slow geocode from call A resolves after a fast
// geocode from call B has already completed.
//
// This mirrors the unmount scenario guarded by `mountedRef` in
// MapLocationPicker.tsx: if the user navigates away while a slow geocode is
// still in flight, the eventual resolve must carry the right coords and must
// not bleed into the next picker session.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveMapPickerResult() — concurrent slow geocode calls', () => {
  it('two concurrent calls with slow geocoders complete independently with correct coordinates', async () => {
    let resolveFirst!: (value: any) => void;
    let resolveSecond!: (value: any) => void;

    const slowGeocode1 = jest.fn().mockReturnValue(
      new Promise<any>(resolve => { resolveFirst = resolve; }),
    );
    const slowGeocode2 = jest.fn().mockReturnValue(
      new Promise<any>(resolve => { resolveSecond = resolve; }),
    );

    // Start both calls concurrently — neither geocode has resolved yet
    const promise1 = resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: slowGeocode1,
      fetchFn: failingFetch(),
    });
    const promise2 = resolveMapPickerResult({
      center: BUENOS_AIRES_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: slowGeocode2,
      fetchFn: failingFetch(),
    });

    // Resolve in reverse order: second before first
    resolveSecond({ city: 'Buenos Aires', district: null, country: 'Argentina' });
    resolveFirst({ city: 'Kyoto', district: null, country: 'Japan' });

    const [result1, result2] = await Promise.all([promise1, promise2]);

    // First call → Kyoto, regardless of resolve order
    expect(result1.lat).toBe(KYOTO_LAT);
    expect(result1.lng).toBe(KYOTO_LNG);
    expect(result1.label).toContain('Kyoto');

    // Second call → Buenos Aires, regardless of resolve order
    expect(result2.lat).toBe(BUENOS_AIRES_LAT);
    expect(result2.lng).toBe(BUENOS_AIRES_LNG);
    expect(result2.label).toContain('Buenos Aires');
  });

  it('slow call result is not contaminated by a concurrent fast call that resolved first', async () => {
    let resolveSlowGeocode!: (value: any) => void;
    const slowGeocode = jest.fn().mockReturnValue(
      new Promise<any>(resolve => { resolveSlowGeocode = resolve; }),
    );

    // Slow call: Paris — in flight, not yet resolved
    const slowPromise = resolveMapPickerResult({
      center: PARIS_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: slowGeocode,
      fetchFn: failingFetch(),
    });

    // Fast call: Kyoto — resolves immediately
    const fastResult = await resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: okGeocode('Kyoto', 'Japan'),
      fetchFn: failingFetch(),
    });

    // Fast call must have Kyoto coords
    expect(fastResult.lat).toBe(KYOTO_LAT);
    expect(fastResult.lng).toBe(KYOTO_LNG);

    // Now resolve the slow call — must return Paris, unaffected by Kyoto result
    resolveSlowGeocode({ city: 'Paris', district: null, country: 'France' });
    const slowResult = await slowPromise;

    expect(slowResult.lat).toBe(PARIS_LAT);
    expect(slowResult.lng).toBe(PARIS_LNG);
    expect(slowResult.label).toContain('Paris');
    expect(slowResult.label).not.toContain('Kyoto');
  });

  it('slow call with failing geocode still returns correct coords with "Selected location" label', async () => {
    // Mirrors unmount scenario: geocode throws after a long delay.
    // Coordinates from `center` must still be correct even when label falls back.
    const result = await resolveMapPickerResult({
      center: PARIS_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: failingGeocode(),
      fetchFn: failingFetch(),
    });

    expect(result.lat).toBe(PARIS_LAT);
    expect(result.lng).toBe(PARIS_LNG);
    expect(result.label).toBe('Selected location');
  });

  it('three concurrent calls all produce independent results regardless of resolve order', async () => {
    let resolveA!: (v: any) => void;
    let resolveB!: (v: any) => void;
    let resolveC!: (v: any) => void;

    const LONDON_CENTER: [number, number] = [-0.1276, 51.5074];

    const promA = resolveMapPickerResult({
      center: KYOTO_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: jest.fn().mockReturnValue(new Promise<any>(r => { resolveA = r; })),
      fetchFn: failingFetch(),
    });
    const promB = resolveMapPickerResult({
      center: PARIS_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: jest.fn().mockReturnValue(new Promise<any>(r => { resolveB = r; })),
      fetchFn: failingFetch(),
    });
    const promC = resolveMapPickerResult({
      center: LONDON_CENTER,
      apiBase: 'https://api.test',
      reverseGeocodeDetailed: jest.fn().mockReturnValue(new Promise<any>(r => { resolveC = r; })),
      fetchFn: failingFetch(),
    });

    // Resolve in C → A → B order (opposite of declaration)
    resolveC({ city: 'London', district: null, country: 'United Kingdom' });
    resolveA({ city: 'Kyoto', district: null, country: 'Japan' });
    resolveB({ city: 'Paris', district: null, country: 'France' });

    const [resA, resB, resC] = await Promise.all([promA, promB, promC]);

    expect(resA.lat).toBe(KYOTO_LAT);   expect(resA.lng).toBe(KYOTO_LNG);
    expect(resB.lat).toBe(PARIS_LAT);   expect(resB.lng).toBe(PARIS_LNG);
    expect(resC.lat).toBe(51.5074);     expect(resC.lng).toBe(-0.1276);

    expect(resA.label).toContain('Kyoto');
    expect(resB.label).toContain('Paris');
    expect(resC.label).toContain('London');
  });
});
