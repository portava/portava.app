/**
 * Unit tests for runFillHomeFromGps() — the shared GPS → homeCity / homeCountry
 * state machine used by onboarding.tsx and PassportSettingsSheet.tsx.
 *
 * Covers three required scenarios:
 *  1. Full geocode result { city, country } → both homeCity and homeCountry are set.
 *  2. Partial result { city, country: null } → only homeCity is set; homeCountry is untouched.
 *  3. GPS permission denied → onPermissionDenied is called with onOpenSettings and
 *     onPickFromList callbacks; neither callback throws; homeCity / homeCountry are never set.
 *
 * Run with:
 *   node --import tsx/esm --test src/services/__tests__/fillHomeFromGps.test.ts
 *
 * No React, no native modules, no expo-location — the machine is pure TypeScript.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runFillHomeFromGps,
  type FillHomeDeps,
  type FillHomeSetters,
  type GpsFillResult,
  type PlaceFillResult,
  type PermissionDeniedOpts,
} from '../fillHomeFromGps.machine.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function grantedGps(lat = 48.8584, lng = 2.2945): () => Promise<GpsFillResult> {
  return () => Promise.resolve({ granted: true, lat, lng });
}

function deniedGps(): () => Promise<GpsFillResult> {
  return () => Promise.resolve({ granted: false, lat: null, lng: null });
}

function nullCoordsGps(): () => Promise<GpsFillResult> {
  return () => Promise.resolve({ granted: true, lat: null, lng: null });
}

function geocode(result: PlaceFillResult): (lat: number, lng: number) => Promise<PlaceFillResult> {
  return () => Promise.resolve(result);
}

interface SetterSpy {
  cities: string[];
  countries: string[];
  loadingStates: boolean[];
  setters: FillHomeSetters;
}

function makeSetterSpy(): SetterSpy {
  const cities: string[] = [];
  const countries: string[] = [];
  const loadingStates: boolean[] = [];
  return {
    cities,
    countries,
    loadingStates,
    setters: {
      setHomeCity:   (c) => cities.push(c),
      setHomeCountry:(c) => countries.push(c),
      setGpsLoading: (l) => loadingStates.push(l),
    },
  };
}

function neverCalled(): FillHomeDeps['onPermissionDenied'] {
  return () => {
    assert.fail('onPermissionDenied must not be called on the success path');
  };
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('runFillHomeFromGps — full geocode result', () => {
  it('sets homeCity and homeCountry when reverseGeocodeDetailed returns { city, country }', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: grantedGps(),
        reverseGeocodeDetailed: geocode({ city: 'Paris', country: 'France' }),
        onPermissionDenied: neverCalled(),
      },
      spy.setters,
    );

    assert.equal(spy.cities.length, 1, 'setHomeCity must be called exactly once');
    assert.equal(spy.cities[0], 'Paris');
    assert.equal(spy.countries.length, 1, 'setHomeCountry must be called exactly once');
    assert.equal(spy.countries[0], 'France');
  });

  it('sets loading to true at start and false at end (success path)', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: grantedGps(),
        reverseGeocodeDetailed: geocode({ city: 'Tokyo', country: 'Japan' }),
        onPermissionDenied: neverCalled(),
      },
      spy.setters,
    );

    assert.equal(spy.loadingStates[0], true,  'first loading state must be true');
    assert.equal(spy.loadingStates[spy.loadingStates.length - 1], false, 'last loading state must be false');
  });
});

describe('runFillHomeFromGps — partial geocode result (city only)', () => {
  it('sets homeCity but does NOT set homeCountry when country is null', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: grantedGps(),
        reverseGeocodeDetailed: geocode({ city: 'Cebu City', country: null }),
        onPermissionDenied: neverCalled(),
      },
      spy.setters,
    );

    assert.equal(spy.cities.length, 1, 'setHomeCity must be called once');
    assert.equal(spy.cities[0], 'Cebu City');
    assert.equal(spy.countries.length, 0, 'setHomeCountry must NOT be called when country is null');
  });

  it('does NOT set homeCity when city is null (country-only result)', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: grantedGps(),
        reverseGeocodeDetailed: geocode({ city: null, country: 'Philippines' }),
        onPermissionDenied: neverCalled(),
      },
      spy.setters,
    );

    assert.equal(spy.cities.length, 0, 'setHomeCity must NOT be called when city is null');
    assert.equal(spy.countries.length, 1, 'setHomeCountry must be called when country is present');
    assert.equal(spy.countries[0], 'Philippines');
  });

  it('sets neither setter when both city and country are null', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: grantedGps(),
        reverseGeocodeDetailed: geocode({ city: null, country: null }),
        onPermissionDenied: neverCalled(),
      },
      spy.setters,
    );

    assert.equal(spy.cities.length,   0, 'setHomeCity must not be called');
    assert.equal(spy.countries.length, 0, 'setHomeCountry must not be called');
  });
});

describe('runFillHomeFromGps — GPS permission denied', () => {
  it('calls onPermissionDenied and does not set homeCity or homeCountry', async () => {
    const spy = makeSetterSpy();
    let deniedCallCount = 0;
    let capturedOpts: PermissionDeniedOpts | null = null;

    await runFillHomeFromGps(
      {
        getCurrentGps: deniedGps(),
        reverseGeocodeDetailed: geocode({ city: 'ShouldNotReach', country: 'ShouldNotReach' }),
        onPermissionDenied: (opts) => {
          deniedCallCount++;
          capturedOpts = opts;
        },
      },
      spy.setters,
    );

    assert.equal(deniedCallCount, 1, 'onPermissionDenied must be called exactly once when GPS is denied');
    assert.equal(spy.cities.length,   0, 'setHomeCity must NOT be called on the denied path');
    assert.equal(spy.countries.length, 0, 'setHomeCountry must NOT be called on the denied path');
  });

  it('onPermissionDenied receives an onOpenSettings callback that does not throw', async () => {
    let capturedOpts: PermissionDeniedOpts | null = null;

    await runFillHomeFromGps(
      {
        getCurrentGps: deniedGps(),
        reverseGeocodeDetailed: geocode({ city: null, country: null }),
        onPermissionDenied: (opts) => { capturedOpts = opts; },
      },
      makeSetterSpy().setters,
    );

    assert.ok(capturedOpts !== null, 'opts must be provided to onPermissionDenied');
    assert.equal(typeof capturedOpts!.onOpenSettings, 'function', 'onOpenSettings must be a function');
    await assert.doesNotReject(
      async () => capturedOpts!.onOpenSettings(),
      'onOpenSettings callback must not throw',
    );
  });

  it('onPermissionDenied receives an onPickFromList callback that does not throw', async () => {
    let capturedOpts: PermissionDeniedOpts | null = null;

    await runFillHomeFromGps(
      {
        getCurrentGps: deniedGps(),
        reverseGeocodeDetailed: geocode({ city: null, country: null }),
        onPermissionDenied: (opts) => { capturedOpts = opts; },
      },
      makeSetterSpy().setters,
    );

    assert.ok(capturedOpts !== null, 'opts must be provided to onPermissionDenied');
    assert.equal(typeof capturedOpts!.onPickFromList, 'function', 'onPickFromList must be a function');
    await assert.doesNotReject(
      async () => capturedOpts!.onPickFromList(),
      'onPickFromList callback must not throw',
    );
  });

  it('sets loading to true at start and false at end (denied path)', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: deniedGps(),
        reverseGeocodeDetailed: geocode({ city: null, country: null }),
        onPermissionDenied: () => {},
      },
      spy.setters,
    );

    assert.equal(spy.loadingStates[0], true,  'first loading state must be true');
    assert.equal(spy.loadingStates[spy.loadingStates.length - 1], false, 'last loading state must be false');
  });
});

describe('runFillHomeFromGps — granted GPS with null coordinates', () => {
  it('does not call setHomeCity, setHomeCountry, or onPermissionDenied when lat/lng are null', async () => {
    const spy = makeSetterSpy();
    let deniedCallCount = 0;

    await runFillHomeFromGps(
      {
        getCurrentGps: nullCoordsGps(),
        reverseGeocodeDetailed: geocode({ city: 'ShouldNotReach', country: 'ShouldNotReach' }),
        onPermissionDenied: () => { deniedCallCount++; },
      },
      spy.setters,
    );

    assert.equal(deniedCallCount,      0, 'onPermissionDenied must not be called for null-coords result');
    assert.equal(spy.cities.length,    0, 'setHomeCity must not be called');
    assert.equal(spy.countries.length, 0, 'setHomeCountry must not be called');
  });
});

describe('runFillHomeFromGps — geocode error is swallowed', () => {
  it('does not throw and clears loading when reverseGeocodeDetailed rejects', async () => {
    const spy = makeSetterSpy();

    await assert.doesNotReject(async () => {
      await runFillHomeFromGps(
        {
          getCurrentGps: grantedGps(),
          reverseGeocodeDetailed: () => Promise.reject(new Error('geocode_failed')),
          onPermissionDenied: neverCalled(),
        },
        spy.setters,
      );
    });

    assert.equal(
      spy.loadingStates[spy.loadingStates.length - 1],
      false,
      'loading must be cleared even when geocoding throws',
    );
  });
});

// ── GPS timeout guard ─────────────────────────────────────────────────────────

/**
 * A getCurrentGps that never settles — simulates the OS permission dialog
 * left open (or the device hanging indefinitely on location acquisition).
 */
function hangingGps(): () => Promise<GpsFillResult> {
  return () => new Promise<GpsFillResult>(() => { /* never resolves */ });
}

describe('runFillHomeFromGps — maxLoadingMs timeout guard', () => {
  it('clears loading when getCurrentGps hangs past maxLoadingMs', async () => {
    const spy = makeSetterSpy();

    await assert.doesNotReject(async () => {
      await runFillHomeFromGps(
        {
          getCurrentGps: hangingGps(),
          reverseGeocodeDetailed: geocode({ city: 'ShouldNotReach', country: 'ShouldNotReach' }),
          onPermissionDenied: neverCalled(),
          maxLoadingMs: 50,
        },
        spy.setters,
      );
    });

    assert.equal(spy.loadingStates[0], true,  'loading must be set true at start');
    assert.equal(
      spy.loadingStates[spy.loadingStates.length - 1],
      false,
      'loading must be cleared after the timeout fires',
    );
  });

  it('does not set homeCity or homeCountry when GPS times out', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: hangingGps(),
        reverseGeocodeDetailed: geocode({ city: 'ShouldNotReach', country: 'ShouldNotReach' }),
        onPermissionDenied: () => {},
        maxLoadingMs: 50,
      },
      spy.setters,
    );

    assert.equal(spy.cities.length,    0, 'setHomeCity must not be called on timeout');
    assert.equal(spy.countries.length, 0, 'setHomeCountry must not be called on timeout');
  });

  it('does not call onPermissionDenied when GPS times out', async () => {
    const spy = makeSetterSpy();
    let deniedCount = 0;

    await runFillHomeFromGps(
      {
        getCurrentGps: hangingGps(),
        reverseGeocodeDetailed: geocode({ city: null, country: null }),
        onPermissionDenied: () => { deniedCount++; },
        maxLoadingMs: 50,
      },
      spy.setters,
    );

    assert.equal(deniedCount, 0, 'onPermissionDenied must not be called when GPS times out');
  });

  it('completes successfully before the timeout when GPS resolves quickly', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: grantedGps(48.8584, 2.2945),
        reverseGeocodeDetailed: geocode({ city: 'Paris', country: 'France' }),
        onPermissionDenied: neverCalled(),
        maxLoadingMs: 5_000,
      },
      spy.setters,
    );

    assert.equal(spy.cities[0],    'Paris',  'city must be set when GPS resolves before timeout');
    assert.equal(spy.countries[0], 'France', 'country must be set when GPS resolves before timeout');
    assert.equal(
      spy.loadingStates[spy.loadingStates.length - 1],
      false,
      'loading must be cleared on success path with generous timeout',
    );
  });
});

// ── GPS / geocode error → city-picker alert path ──────────────────────────────
//
// Regression guard for task #185: when getCurrentGps() *throws* or
// reverseGeocodeDetailed throws, the onboarding screen wires
// onGpsOrGeocodeFailed to show an Alert with a "Choose from list" button.
// These tests confirm the machine calls that hook on the error path and does
// NOT call it on the internal timeout (which is a silent abort).

describe('runFillHomeFromGps — getCurrentGps throws → onGpsOrGeocodeFailed', () => {
  it('calls onGpsOrGeocodeFailed when getCurrentGps rejects', async () => {
    const spy = makeSetterSpy();
    let failedCount = 0;

    await assert.doesNotReject(async () => {
      await runFillHomeFromGps(
        {
          getCurrentGps: () => Promise.reject(new Error('gps_hardware_error')),
          reverseGeocodeDetailed: geocode({ city: 'ShouldNotReach', country: 'ShouldNotReach' }),
          onPermissionDenied: neverCalled(),
          onGpsOrGeocodeFailed: () => { failedCount++; },
        },
        spy.setters,
      );
    });

    assert.equal(failedCount, 1, 'onGpsOrGeocodeFailed must be called exactly once');
    assert.equal(spy.cities.length,    0, 'setHomeCity must not be called on the error path');
    assert.equal(spy.countries.length, 0, 'setHomeCountry must not be called on the error path');
  });

  it('clears loading after getCurrentGps throws', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: () => Promise.reject(new Error('gps_error')),
        reverseGeocodeDetailed: geocode({ city: null, country: null }),
        onPermissionDenied: neverCalled(),
        onGpsOrGeocodeFailed: () => {},
      },
      spy.setters,
    );

    assert.equal(spy.loadingStates[0], true,  'first loading state must be true');
    assert.equal(spy.loadingStates[spy.loadingStates.length - 1], false, 'last loading state must be false');
  });
});

describe('runFillHomeFromGps — reverseGeocodeDetailed throws → onGpsOrGeocodeFailed', () => {
  it('calls onGpsOrGeocodeFailed when reverseGeocodeDetailed rejects', async () => {
    const spy = makeSetterSpy();
    let failedCount = 0;

    await assert.doesNotReject(async () => {
      await runFillHomeFromGps(
        {
          getCurrentGps: grantedGps(),
          reverseGeocodeDetailed: () => Promise.reject(new Error('network_error')),
          onPermissionDenied: neverCalled(),
          onGpsOrGeocodeFailed: () => { failedCount++; },
        },
        spy.setters,
      );
    });

    assert.equal(failedCount, 1, 'onGpsOrGeocodeFailed must be called exactly once on geocode failure');
    assert.equal(spy.cities.length,    0, 'setHomeCity must not be called when geocode fails');
    assert.equal(spy.countries.length, 0, 'setHomeCountry must not be called when geocode fails');
  });

  it('clears loading after reverseGeocodeDetailed throws', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: grantedGps(),
        reverseGeocodeDetailed: () => Promise.reject(new Error('geocode_failed')),
        onPermissionDenied: neverCalled(),
        onGpsOrGeocodeFailed: () => {},
      },
      spy.setters,
    );

    assert.equal(
      spy.loadingStates[spy.loadingStates.length - 1],
      false,
      'loading must be cleared even when geocoding throws',
    );
  });

  it('does not crash when onGpsOrGeocodeFailed is omitted (backward-compat)', async () => {
    await assert.doesNotReject(async () => {
      await runFillHomeFromGps(
        {
          getCurrentGps: grantedGps(),
          reverseGeocodeDetailed: () => Promise.reject(new Error('geocode_failed')),
          onPermissionDenied: () => {},
          // onGpsOrGeocodeFailed intentionally omitted
        },
        makeSetterSpy().setters,
      );
    });
  });
});

describe('runFillHomeFromGps — internal maxLoadingMs timeout does NOT trigger onGpsOrGeocodeFailed', () => {
  it('does NOT call onGpsOrGeocodeFailed when the internal timeout fires', async () => {
    let failedCount = 0;

    await assert.doesNotReject(async () => {
      await runFillHomeFromGps(
        {
          getCurrentGps: hangingGps(),
          reverseGeocodeDetailed: geocode({ city: 'ShouldNotReach', country: 'ShouldNotReach' }),
          onPermissionDenied: () => {},
          onGpsOrGeocodeFailed: () => { failedCount++; },
          maxLoadingMs: 50,
        },
        makeSetterSpy().setters,
      );
    });

    assert.equal(failedCount, 0, 'onGpsOrGeocodeFailed must NOT be called on the internal timeout path');
  });
});
