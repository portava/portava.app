/**
 * Unit tests for runFillHomeFromGps() — the shared GPS → homeCity / homeCountry
 * state machine used by onboarding.tsx and PassportSettingsSheet.tsx.
 *
 * Covers:
 *  1. Full geocode result { city, country } → both setters called.
 *  2. Partial result { city, country: null } → only homeCity is set.
 *  3. GPS permission denied → onPermissionDenied called; no setters.
 *  4. getCurrentGps throws → onGpsOrGeocodeFailed called (city-picker path).
 *  5. reverseGeocodeDetailed throws → onGpsOrGeocodeFailed called (city-picker path).
 *  6. Internal maxLoadingMs timeout fires → onGpsOrGeocodeFailed NOT called (silent abort).
 *  7. Loading state bookends are always true→false.
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
} from '../fillHomeFromGps.machine.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function grantedGps(lat = 48.8584, lng = 2.2945): () => Promise<GpsFillResult> {
  return () => Promise.resolve({ granted: true, lat, lng });
}

function deniedGps(): () => Promise<GpsFillResult> {
  return () => Promise.resolve({ granted: false, lat: null, lng: null });
}

function throwingGps(msg = 'gps_error'): () => Promise<GpsFillResult> {
  return () => Promise.reject(new Error(msg));
}

function hangingGps(): () => Promise<GpsFillResult> {
  return () => new Promise<GpsFillResult>(() => { /* never resolves */ });
}

function geocode(result: PlaceFillResult): (lat: number, lng: number) => Promise<PlaceFillResult> {
  return () => Promise.resolve(result);
}

function throwingGeocode(msg = 'geocode_failed'): (lat: number, lng: number) => Promise<PlaceFillResult> {
  return () => Promise.reject(new Error(msg));
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
      setHomeCity:    (c) => cities.push(c),
      setHomeCountry: (c) => countries.push(c),
      setGpsLoading:  (l) => loadingStates.push(l),
    },
  };
}

function neverCalled(label: string): FillHomeDeps['onPermissionDenied'] {
  return () => { assert.fail(`${label} must not be called on this path`); };
}

// ── Suite 1: success path ──────────────────────────────────────────────────────

describe('runFillHomeFromGps — full geocode result', () => {
  it('sets homeCity and homeCountry when reverseGeocodeDetailed returns { city, country }', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: grantedGps(),
        reverseGeocodeDetailed: geocode({ city: 'Paris', country: 'France' }),
        onPermissionDenied: neverCalled('onPermissionDenied'),
      },
      spy.setters,
    );

    assert.equal(spy.cities.length, 1);
    assert.equal(spy.cities[0], 'Paris');
    assert.equal(spy.countries.length, 1);
    assert.equal(spy.countries[0], 'France');
  });

  it('loading state is true at start and false at end (success path)', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: grantedGps(),
        reverseGeocodeDetailed: geocode({ city: 'Tokyo', country: 'Japan' }),
        onPermissionDenied: neverCalled('onPermissionDenied'),
      },
      spy.setters,
    );

    assert.equal(spy.loadingStates[0], true,  'first state must be true');
    assert.equal(spy.loadingStates[spy.loadingStates.length - 1], false, 'last state must be false');
  });
});

describe('runFillHomeFromGps — partial geocode result', () => {
  it('sets homeCity only when country is null', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: grantedGps(),
        reverseGeocodeDetailed: geocode({ city: 'Cebu City', country: null }),
        onPermissionDenied: neverCalled('onPermissionDenied'),
      },
      spy.setters,
    );

    assert.equal(spy.cities.length, 1);
    assert.equal(spy.cities[0], 'Cebu City');
    assert.equal(spy.countries.length, 0, 'setHomeCountry must not be called when country is null');
  });
});

// ── Suite 2: permission denied ─────────────────────────────────────────────────

describe('runFillHomeFromGps — GPS permission denied', () => {
  it('calls onPermissionDenied and does not set homeCity or homeCountry', async () => {
    const spy = makeSetterSpy();
    let deniedCount = 0;

    await runFillHomeFromGps(
      {
        getCurrentGps: deniedGps(),
        reverseGeocodeDetailed: geocode({ city: 'ShouldNotReach', country: 'ShouldNotReach' }),
        onPermissionDenied: () => { deniedCount++; },
      },
      spy.setters,
    );

    assert.equal(deniedCount, 1, 'onPermissionDenied must be called exactly once');
    assert.equal(spy.cities.length, 0, 'setHomeCity must not be called');
    assert.equal(spy.countries.length, 0, 'setHomeCountry must not be called');
  });

});

// ── Suite 3: GPS error → city-picker alert path ───────────────────────────────
//
// This is the regression guard for task #185: when getCurrentGps() *throws*
// (not just denies permission), the onboarding screen must offer the city
// picker via an alert. The machine surfaces this through onGpsOrGeocodeFailed.

describe('runFillHomeFromGps — getCurrentGps throws → onGpsOrGeocodeFailed', () => {
  it('calls onGpsOrGeocodeFailed when getCurrentGps rejects', async () => {
    const spy = makeSetterSpy();
    let failedCount = 0;

    await assert.doesNotReject(async () => {
      await runFillHomeFromGps(
        {
          getCurrentGps: throwingGps('gps_hardware_error'),
          reverseGeocodeDetailed: geocode({ city: 'ShouldNotReach', country: 'ShouldNotReach' }),
          onPermissionDenied: neverCalled('onPermissionDenied'),
          onGpsOrGeocodeFailed: () => { failedCount++; },
        },
        spy.setters,
      );
    });

    assert.equal(failedCount, 1, 'onGpsOrGeocodeFailed must be called exactly once');
    assert.equal(spy.cities.length, 0, 'setHomeCity must not be called on the error path');
    assert.equal(spy.countries.length, 0, 'setHomeCountry must not be called on the error path');
  });

  it('clears loading after getCurrentGps throws', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: throwingGps(),
        reverseGeocodeDetailed: geocode({ city: null, country: null }),
        onPermissionDenied: neverCalled('onPermissionDenied'),
        onGpsOrGeocodeFailed: () => {},
      },
      spy.setters,
    );

    assert.equal(spy.loadingStates[0], true,  'first loading state must be true');
    assert.equal(spy.loadingStates[spy.loadingStates.length - 1], false, 'last loading state must be false');
  });
});

// ── Suite 4: geocode error → city-picker alert path ───────────────────────────

describe('runFillHomeFromGps — reverseGeocodeDetailed throws → onGpsOrGeocodeFailed', () => {
  it('calls onGpsOrGeocodeFailed when reverseGeocodeDetailed rejects', async () => {
    const spy = makeSetterSpy();
    let failedCount = 0;

    await assert.doesNotReject(async () => {
      await runFillHomeFromGps(
        {
          getCurrentGps: grantedGps(),
          reverseGeocodeDetailed: throwingGeocode('network_error'),
          onPermissionDenied: neverCalled('onPermissionDenied'),
          onGpsOrGeocodeFailed: () => { failedCount++; },
        },
        spy.setters,
      );
    });

    assert.equal(failedCount, 1, 'onGpsOrGeocodeFailed must be called exactly once on geocode failure');
    assert.equal(spy.cities.length, 0, 'setHomeCity must not be called when geocode fails');
    assert.equal(spy.countries.length, 0, 'setHomeCountry must not be called when geocode fails');
  });

  it('clears loading after reverseGeocodeDetailed throws', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: grantedGps(),
        reverseGeocodeDetailed: throwingGeocode(),
        onPermissionDenied: neverCalled('onPermissionDenied'),
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

  it('does not call onGpsOrGeocodeFailed when omitted (backward-compat)', async () => {
    // Callers that have not yet wired onGpsOrGeocodeFailed must not crash.
    await assert.doesNotReject(async () => {
      await runFillHomeFromGps(
        {
          getCurrentGps: grantedGps(),
          reverseGeocodeDetailed: throwingGeocode(),
          onPermissionDenied: () => {},
          // onGpsOrGeocodeFailed intentionally omitted
        },
        makeSetterSpy().setters,
      );
    });
  });
});

// ── Suite 5: internal timeout is silent (NOT the city-picker alert path) ───────
//
// The maxLoadingMs timeout is an internal guard, not a GPS failure. It must
// NOT trigger onGpsOrGeocodeFailed — a timeout means the user waited long
// enough and can move on; showing an error alert on top would be confusing.

describe('runFillHomeFromGps — internal maxLoadingMs timeout is silent', () => {
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

    assert.equal(failedCount, 0, 'onGpsOrGeocodeFailed must NOT be called on internal timeout');
  });

  it('clears loading after the internal timeout fires', async () => {
    const spy = makeSetterSpy();

    await runFillHomeFromGps(
      {
        getCurrentGps: hangingGps(),
        reverseGeocodeDetailed: geocode({ city: null, country: null }),
        onPermissionDenied: () => {},
        onGpsOrGeocodeFailed: () => {},
        maxLoadingMs: 50,
      },
      spy.setters,
    );

    assert.equal(spy.loadingStates[0], true,  'loading must start true');
    assert.equal(spy.loadingStates[spy.loadingStates.length - 1], false, 'loading must clear after timeout');
  });
});
