/**
 * PassportSettingsSheet (identity edit screen) — GPS error wiring test.
 *
 * The identity edit screen calls runIdentityGpsFill (extracted from the inline
 * handlers in app/profile/edit/identity.tsx) with an onGpsOrGeocodeFailed
 * callback that opens the city picker. These tests guard that contract: when
 * GPS acquisition or reverse-geocoding fails, onGpsOrGeocodeFailed is called
 * so the screen can offer the city-picker fallback instead of staying silent.
 *
 * Because the test imports runIdentityGpsFill — the same function identity.tsx
 * calls — any future removal of onGpsOrGeocodeFailed from that module will
 * break these tests immediately.
 *
 * This is a pure logic test — no React, no native modules, no Expo.
 *
 * Run with:
 *   node --import tsx/esm --test src/services/__tests__/passportSettings.gpsError.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runIdentityGpsFill,
  type IdentityGpsFillDeps,
} from '../identityGpsFill.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

type GpsResult = { granted: boolean; lat: number | null; lng: number | null };
type GeocodeResult = { city?: string | null; country?: string | null };

function grantedGps(lat = 48.8584, lng = 2.2945): () => Promise<GpsResult> {
  return () => Promise.resolve({ granted: true, lat, lng });
}

function deniedGps(): () => Promise<GpsResult> {
  return () => Promise.resolve({ granted: false, lat: null, lng: null });
}

function geocode(result: GeocodeResult): (lat: number, lng: number) => Promise<GeocodeResult> {
  return () => Promise.resolve(result);
}

interface SetterSpy {
  successCities: Array<string | null>;
  successCountries: Array<string | null>;
  loadingStates: boolean[];
}

function makeSetterSpy(): { spy: SetterSpy; partialDeps: Pick<IdentityGpsFillDeps, 'onSuccess' | 'setLoading'> } {
  const spy: SetterSpy = { successCities: [], successCountries: [], loadingStates: [] };
  return {
    spy,
    partialDeps: {
      onSuccess: (city, country) => { spy.successCities.push(city); spy.successCountries.push(country); },
      setLoading: (l) => spy.loadingStates.push(l),
    },
  };
}

/**
 * Build the deps object exactly as identity.tsx wires it for the home-city
 * GPS button. onGpsOrGeocodeFailed opens the city picker (here, a spy).
 */
function makeIdentityScreenDeps(overrides?: Partial<IdentityGpsFillDeps>): {
  deps: IdentityGpsFillDeps;
  cityPickerOpenCount: () => number;
} {
  let count = 0;
  const deps: IdentityGpsFillDeps = {
    getCurrentGps: grantedGps(),
    reverseGeocode: geocode({ city: 'Paris', country: 'France' }),
    onPermissionDenied: () => {},
    onGpsOrGeocodeFailed: () => { count++; },
    onSuccess: () => {},
    setLoading: () => {},
    ...overrides,
  };
  return { deps, cityPickerOpenCount: () => count };
}

// ── Suite: geocode failure → city picker offered ──────────────────────────────
//
// This is the core regression guard: when reverseGeocode throws (network error,
// server down, etc.), onGpsOrGeocodeFailed must fire so the user is offered
// "Choose from list" rather than seeing no feedback.

describe('identity screen GPS wiring — reverseGeocode fails → city picker offered', () => {
  it('calls onGpsOrGeocodeFailed when reverseGeocode throws a network error', async () => {
    const { spy, partialDeps } = makeSetterSpy();
    const { deps, cityPickerOpenCount } = makeIdentityScreenDeps({
      reverseGeocode: () => Promise.reject(new Error('network_error')),
      ...partialDeps,
    });

    await assert.doesNotReject(async () => {
      await runIdentityGpsFill(deps);
    });

    assert.equal(cityPickerOpenCount(), 1, 'onGpsOrGeocodeFailed must be called once — city picker must be offered');
    assert.equal(spy.successCities.length, 0, 'onSuccess must not fire when geocoding fails');
  });

  it('calls onGpsOrGeocodeFailed when reverseGeocode rejects with a timeout', async () => {
    const { deps, cityPickerOpenCount } = makeIdentityScreenDeps({
      reverseGeocode: () => Promise.reject(new Error('geocode_timeout')),
    });

    await runIdentityGpsFill(deps);

    assert.equal(cityPickerOpenCount(), 1, 'city picker must be offered on geocode timeout');
  });

  it('clears loading after a geocode failure', async () => {
    const { spy, partialDeps } = makeSetterSpy();
    const { deps } = makeIdentityScreenDeps({
      reverseGeocode: () => Promise.reject(new Error('geocode_failed')),
      ...partialDeps,
    });

    await runIdentityGpsFill(deps);

    assert.equal(spy.loadingStates[0], true,  'loading must start true');
    assert.equal(spy.loadingStates[spy.loadingStates.length - 1], false, 'loading must be cleared after failure');
  });

  it('does not call onSuccess when geocoding fails', async () => {
    const { spy, partialDeps } = makeSetterSpy();
    const { deps } = makeIdentityScreenDeps({
      reverseGeocode: () => Promise.reject(new Error('geocode_failed')),
      ...partialDeps,
    });

    await runIdentityGpsFill(deps);

    assert.equal(spy.successCities.length,    0, 'onSuccess must not be called');
    assert.equal(spy.successCountries.length, 0, 'onSuccess must not be called');
  });
});

// ── Suite: GPS acquisition failure → city picker offered ──────────────────────

describe('identity screen GPS wiring — getCurrentGps throws → city picker offered', () => {
  it('calls onGpsOrGeocodeFailed when getCurrentGps rejects with a hardware error', async () => {
    const { deps, cityPickerOpenCount } = makeIdentityScreenDeps({
      getCurrentGps: () => Promise.reject(new Error('gps_hardware_unavailable')),
    });

    await assert.doesNotReject(async () => {
      await runIdentityGpsFill(deps);
    });

    assert.equal(cityPickerOpenCount(), 1, 'city picker must be offered after a GPS hardware error');
  });

  it('clears loading after getCurrentGps throws', async () => {
    const { spy, partialDeps } = makeSetterSpy();
    const { deps } = makeIdentityScreenDeps({
      getCurrentGps: () => Promise.reject(new Error('gps_provider_error')),
      ...partialDeps,
    });

    await runIdentityGpsFill(deps);

    assert.equal(spy.loadingStates[0], true,  'loading must start true');
    assert.equal(spy.loadingStates[spy.loadingStates.length - 1], false, 'loading must be cleared');
  });

  it('does not set city or country when GPS acquisition throws', async () => {
    const { spy, partialDeps } = makeSetterSpy();
    const { deps } = makeIdentityScreenDeps({
      getCurrentGps: () => Promise.reject(new Error('gps_unavailable')),
      ...partialDeps,
    });

    await runIdentityGpsFill(deps);

    assert.equal(spy.successCities.length,    0, 'onSuccess must not be called when GPS fails');
    assert.equal(spy.successCountries.length, 0, 'onSuccess must not be called when GPS fails');
  });
});

// ── Suite: GPS permission denied → permission alert, not city-picker alert ────

describe('identity screen GPS wiring — GPS denied → onPermissionDenied, not onGpsOrGeocodeFailed', () => {
  it('calls onPermissionDenied (not onGpsOrGeocodeFailed) when GPS is denied', async () => {
    let deniedCount = 0;
    const { deps, cityPickerOpenCount } = makeIdentityScreenDeps({
      getCurrentGps: deniedGps(),
      onPermissionDenied: () => { deniedCount++; },
    });

    await runIdentityGpsFill(deps);

    assert.equal(deniedCount,            1, 'onPermissionDenied must be called once');
    assert.equal(cityPickerOpenCount(),  0, 'onGpsOrGeocodeFailed must NOT be called on permission denial');
  });
});

// ── Suite: GPS denial alert wiring — both handlers are reachable ──────────────
//
// Regression guard for the onPermissionDenied refactor: the handler no longer
// receives PermissionDeniedOpts — instead, the caller (identity screen) wires
// its own "Open Settings" and "Choose from list" closures. These tests confirm
// that both closures are correctly constructed and independently reachable when
// GPS permission is denied.
//
// Because Alert.alert is a native module, we inject a mock alertFn that
// captures the buttons array, then invoke each button's onPress directly.
// No React, no Expo, no native modules needed.

type AlertButton = { text: string; onPress?: () => void; style?: string };

/**
 * Build an onPermissionDenied closure that mirrors identity.tsx's wiring,
 * but with injectable side-effect spies instead of Linking.openSettings /
 * React setState calls.
 */
function buildDenialHandler(opts: {
  alertFn: (title: string, message: string, buttons: AlertButton[]) => void;
  openSettings: () => void;
  setShowPicker: (val: boolean) => void;
}): () => void {
  return () =>
    opts.alertFn(
      'Location permission is off',
      'Enable it in settings or choose a city/place from search.',
      [
        { text: 'Open Settings',    onPress: () => opts.openSettings() },
        { text: 'Choose from list', onPress: () => opts.setShowPicker(true) },
        { text: 'Cancel',           style: 'cancel' },
      ],
    );
}

describe('identity screen GPS denial wiring — Open Settings and city picker are both reachable', () => {
  it('"Open Settings" button reaches Linking.openSettings when GPS is denied', async () => {
    let capturedButtons: AlertButton[] = [];
    let openSettingsCalled = false;

    const onPermissionDenied = buildDenialHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      openSettings:  () => { openSettingsCalled = true; },
      setShowPicker: () => {},
    });

    await runIdentityGpsFill({
      getCurrentGps:      deniedGps(),
      reverseGeocode:     geocode({ city: null, country: null }),
      onPermissionDenied,
      onGpsOrGeocodeFailed: () => {},
      onSuccess:          () => {},
      setLoading:         () => {},
    });

    assert.ok(capturedButtons.length > 0, 'alert must have been shown on GPS denial');

    const btn = capturedButtons.find((b) => b.text === 'Open Settings');
    assert.ok(btn, '"Open Settings" button must be present in the denial alert');
    btn!.onPress?.();
    assert.equal(openSettingsCalled, true, '"Open Settings" onPress must reach Linking.openSettings');
  });

  it('"Choose from list" button reaches setShowHomePicker when GPS is denied', async () => {
    let capturedButtons: AlertButton[] = [];
    let pickerShown = false;

    const onPermissionDenied = buildDenialHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      openSettings:  () => {},
      setShowPicker: (val) => { pickerShown = val; },
    });

    await runIdentityGpsFill({
      getCurrentGps:      deniedGps(),
      reverseGeocode:     geocode({ city: null, country: null }),
      onPermissionDenied,
      onGpsOrGeocodeFailed: () => {},
      onSuccess:          () => {},
      setLoading:         () => {},
    });

    const btn = capturedButtons.find((b) => b.text === 'Choose from list');
    assert.ok(btn, '"Choose from list" button must be present in the denial alert');
    btn!.onPress?.();
    assert.equal(pickerShown, true, '"Choose from list" onPress must call setShowHomePicker(true)');
  });

  it('both Open Settings and Choose from list are independently reachable in the same denial', async () => {
    let capturedButtons: AlertButton[] = [];
    let openSettingsCount = 0;
    let pickerCount = 0;

    const onPermissionDenied = buildDenialHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      openSettings:  () => { openSettingsCount++; },
      setShowPicker: () => { pickerCount++; },
    });

    await runIdentityGpsFill({
      getCurrentGps:      deniedGps(),
      reverseGeocode:     geocode({ city: null, country: null }),
      onPermissionDenied,
      onGpsOrGeocodeFailed: () => {},
      onSuccess:          () => {},
      setLoading:         () => {},
    });

    capturedButtons.find((b) => b.text === 'Open Settings')?.onPress?.();
    capturedButtons.find((b) => b.text === 'Choose from list')?.onPress?.();

    assert.equal(openSettingsCount, 1, '"Open Settings" handler must be independently callable');
    assert.equal(pickerCount,       1, '"Choose from list" handler must be independently callable');
  });

  it('neither Open Settings nor city picker fires on a successful GPS fill (no false positives)', async () => {
    let capturedButtons: AlertButton[] = [];
    let openSettingsCalled = false;
    let pickerShown = false;

    const { deps } = makeIdentityScreenDeps({
      onPermissionDenied: buildDenialHandler({
        alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
        openSettings:  () => { openSettingsCalled = true; },
        setShowPicker: () => { pickerShown = true; },
      }),
    });

    // GPS is granted (default in makeIdentityScreenDeps) — denial handler must not fire
    await runIdentityGpsFill(deps);

    assert.equal(capturedButtons.length, 0, 'alert must NOT be shown when GPS is granted');
    assert.equal(openSettingsCalled,  false, 'Linking.openSettings must NOT be called on success');
    assert.equal(pickerShown,         false, 'setShowHomePicker must NOT be called on success');
  });
});

// ── Suite: success path — city picker not offered ─────────────────────────────

describe('identity screen GPS wiring — success path', () => {
  it('calls onSuccess with city and country on a clean result', async () => {
    const { spy, partialDeps } = makeSetterSpy();
    const { deps, cityPickerOpenCount } = makeIdentityScreenDeps({
      ...partialDeps,
    });

    await runIdentityGpsFill(deps);

    assert.equal(cityPickerOpenCount(),    0,       'city picker must NOT be offered on success');
    assert.equal(spy.successCities[0],    'Paris',  'city must be passed to onSuccess');
    assert.equal(spy.successCountries[0], 'France', 'country must be passed to onSuccess');
  });

  it('clears loading after a successful fill', async () => {
    const { spy, partialDeps } = makeSetterSpy();
    const { deps } = makeIdentityScreenDeps({ ...partialDeps });

    await runIdentityGpsFill(deps);

    assert.equal(spy.loadingStates[0], true,  'loading must start true');
    assert.equal(spy.loadingStates[spy.loadingStates.length - 1], false, 'loading must be cleared after success');
  });
});
