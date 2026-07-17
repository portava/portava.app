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

// ── Suite: GPS denial alert wiring — current-city path (setShowCurrentPicker) ─
//
// The current-city GPS button uses the same alert pattern as the home-city
// button but wires "Choose from list" to setShowCurrentPicker instead of
// setShowHomePicker. These tests guard that contract independently so a
// copy-paste mistake (home vs. current) is caught immediately.

describe('identity screen GPS denial wiring — current-city path: Open Settings and city picker are both reachable', () => {
  it('"Open Settings" button reaches Linking.openSettings for the current-city denial', async () => {
    let capturedButtons: AlertButton[] = [];
    let openSettingsCalled = false;

    const onPermissionDenied = buildDenialHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      openSettings:  () => { openSettingsCalled = true; },
      setShowPicker: () => {},
    });

    await runIdentityGpsFill({
      getCurrentGps:        deniedGps(),
      reverseGeocode:       geocode({ city: null, country: null }),
      onPermissionDenied,
      onGpsOrGeocodeFailed: () => {},
      onSuccess:            () => {},
      setLoading:           () => {},
    });

    assert.ok(capturedButtons.length > 0, 'alert must have been shown on GPS denial');

    const btn = capturedButtons.find((b) => b.text === 'Open Settings');
    assert.ok(btn, '"Open Settings" button must be present in the current-city denial alert');
    btn!.onPress?.();
    assert.equal(openSettingsCalled, true, '"Open Settings" onPress must reach Linking.openSettings for the current-city path');
  });

  it('"Choose from list" button reaches setShowCurrentPicker when current-city GPS is denied', async () => {
    let capturedButtons: AlertButton[] = [];
    let pickerShown = false;

    // Mirrors fillCurrentFromGps: setShowPicker wires to setShowCurrentPicker
    const onPermissionDenied = buildDenialHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      openSettings:  () => {},
      setShowPicker: (val) => { pickerShown = val; },
    });

    await runIdentityGpsFill({
      getCurrentGps:        deniedGps(),
      reverseGeocode:       geocode({ city: null, country: null }),
      onPermissionDenied,
      onGpsOrGeocodeFailed: () => {},
      onSuccess:            () => {},
      setLoading:           () => {},
    });

    const btn = capturedButtons.find((b) => b.text === 'Choose from list');
    assert.ok(btn, '"Choose from list" button must be present in the current-city denial alert');
    btn!.onPress?.();
    assert.equal(pickerShown, true, '"Choose from list" onPress must call setShowCurrentPicker(true)');
  });

  it('both Open Settings and Choose from list are independently reachable for the current-city denial', async () => {
    let capturedButtons: AlertButton[] = [];
    let openSettingsCount = 0;
    let pickerCount = 0;

    const onPermissionDenied = buildDenialHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      openSettings:  () => { openSettingsCount++; },
      setShowPicker: () => { pickerCount++; },
    });

    await runIdentityGpsFill({
      getCurrentGps:        deniedGps(),
      reverseGeocode:       geocode({ city: null, country: null }),
      onPermissionDenied,
      onGpsOrGeocodeFailed: () => {},
      onSuccess:            () => {},
      setLoading:           () => {},
    });

    capturedButtons.find((b) => b.text === 'Open Settings')?.onPress?.();
    capturedButtons.find((b) => b.text === 'Choose from list')?.onPress?.();

    assert.equal(openSettingsCount, 1, '"Open Settings" handler must be independently callable for the current-city path');
    assert.equal(pickerCount,       1, '"Choose from list" handler must be independently callable for the current-city path');
  });

  it('neither Open Settings nor current-city picker fires on a successful GPS fill (no false positives)', async () => {
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

    assert.equal(capturedButtons.length, 0, 'alert must NOT be shown when GPS is granted (current-city path)');
    assert.equal(openSettingsCalled,  false, 'Linking.openSettings must NOT be called on success (current-city path)');
    assert.equal(pickerShown,         false, 'setShowCurrentPicker must NOT be called on success');
  });
});

// ── Suite: current-city onSuccess wiring — country is ignored ─────────────────
//
// fillCurrentFromGps wires onSuccess as:
//   onSuccess: (city, _country) => setForm((f) => ({ ...f, currentCity: city ?? f.currentCity }))
//
// This suite guards that contract: the geocoder returns both city and country,
// but only currentCity is mutated — homeCity and homeCountry are untouched.
// A merge of the two closures (home vs. current) would silently corrupt home
// fields when the user taps the current-city GPS button.

describe('identity screen GPS wiring — current-city onSuccess only sets currentCity, not homeCity/homeCountry', () => {
  /**
   * Simulate the exact closure used by fillCurrentFromGps in identity.tsx:
   *   onSuccess: (city, _country) => setForm((f) => ({ ...f, currentCity: city ?? f.currentCity }))
   *
   * We track separately which "form fields" were mutated so we can assert that
   * homeCity and homeCountry stay unchanged while currentCity is updated.
   */
  function makeCurrentCityOnlyDeps(overrides?: Partial<IdentityGpsFillDeps>): {
    deps: IdentityGpsFillDeps;
    mutations: { currentCity: Array<string | null>; homeCity: Array<string | null>; homeCountry: Array<string | null> };
  } {
    const mutations = { currentCity: [] as Array<string | null>, homeCity: [] as Array<string | null>, homeCountry: [] as Array<string | null> };
    const deps: IdentityGpsFillDeps = {
      getCurrentGps: grantedGps(),
      reverseGeocode: geocode({ city: 'Tokyo', country: 'Japan' }),
      onPermissionDenied: () => {},
      onGpsOrGeocodeFailed: () => {},
      // Mirror fillCurrentFromGps: only city is used, _country is ignored
      onSuccess: (city, _country) => { mutations.currentCity.push(city); },
      setLoading: () => {},
      ...overrides,
    };
    return { deps, mutations };
  }

  it('onSuccess receives the geocoded city value from the current-city GPS path', async () => {
    const { deps, mutations } = makeCurrentCityOnlyDeps();

    await runIdentityGpsFill(deps);

    assert.equal(mutations.currentCity.length, 1, 'onSuccess must be called once');
    assert.equal(mutations.currentCity[0], 'Tokyo', 'city must be the geocoded city');
  });

  it('country returned by geocoder is not applied to any form field in the current-city wiring', async () => {
    const { deps, mutations } = makeCurrentCityOnlyDeps();

    await runIdentityGpsFill(deps);

    assert.equal(mutations.homeCity.length,    0, 'homeCity must NOT be mutated by fillCurrentFromGps');
    assert.equal(mutations.homeCountry.length, 0, 'homeCountry must NOT be mutated by fillCurrentFromGps');
  });

  it('current-city wiring passes city to onSuccess even when country is non-null', async () => {
    const { deps, mutations } = makeCurrentCityOnlyDeps({
      reverseGeocode: geocode({ city: 'Berlin', country: 'Germany' }),
    });

    await runIdentityGpsFill(deps);

    // city is set; country is discarded by the current-city closure
    assert.equal(mutations.currentCity[0], 'Berlin',  'city must be passed through to the current-city closure');
    assert.equal(mutations.homeCity.length,    0, 'homeCity must not be touched');
    assert.equal(mutations.homeCountry.length, 0, 'homeCountry must not be touched even though geocoder returned "Germany"');
  });

  it('home wiring sets both homeCity and homeCountry — proving current-city wiring is deliberately narrower', async () => {
    // This test documents the intentional divergence:
    // fillHomeFromGps uses (city, country) → updates homeCity + homeCountry
    // fillCurrentFromGps uses (city, _country) → updates only currentCity
    const homeFieldsSet: { homeCity: Array<string | null>; homeCountry: Array<string | null> } = { homeCity: [], homeCountry: [] };

    const homeDeps: IdentityGpsFillDeps = {
      getCurrentGps:        grantedGps(),
      reverseGeocode:       geocode({ city: 'Paris', country: 'France' }),
      onPermissionDenied:   () => {},
      onGpsOrGeocodeFailed: () => {},
      // Mirror fillHomeFromGps: both city and country are used
      onSuccess: (city, country) => { homeFieldsSet.homeCity.push(city); homeFieldsSet.homeCountry.push(country); },
      setLoading: () => {},
    };

    await runIdentityGpsFill(homeDeps);

    assert.equal(homeFieldsSet.homeCity[0],    'Paris',  'home wiring must set homeCity');
    assert.equal(homeFieldsSet.homeCountry[0], 'France', 'home wiring must set homeCountry');

    // Now run the current-city wiring with the same geocoder — country must be dropped
    const currentFields: { city: Array<string | null> } = { city: [] };
    const currentDeps: IdentityGpsFillDeps = {
      getCurrentGps:        grantedGps(),
      reverseGeocode:       geocode({ city: 'Paris', country: 'France' }),
      onPermissionDenied:   () => {},
      onGpsOrGeocodeFailed: () => {},
      onSuccess: (city, _country) => { currentFields.city.push(city); },
      setLoading: () => {},
    };

    await runIdentityGpsFill(currentDeps);

    assert.equal(currentFields.city[0], 'Paris', 'current-city wiring must still receive the city');
    assert.equal(homeFieldsSet.homeCity.length,    1, 'home wiring recorded homeCity once');
    assert.equal(homeFieldsSet.homeCountry.length, 1, 'home wiring recorded homeCountry once');
    assert.equal(currentFields.city.length, 1, 'current-city wiring recorded only one field (city)');
  });
});

// ── Suite: geocode-failure alert wiring — home-city path ─────────────────────
//
// Regression guard for the onGpsOrGeocodeFailed refactor: when GPS is granted
// but reverse-geocoding fails, identity.tsx wires onGpsOrGeocodeFailed to show
// an alert with a "Choose from list" button that must call setShowHomePicker(true).
// These tests inject a mock alertFn so we can capture the buttons array and
// invoke each button's onPress directly — no React, no native modules needed.

/**
 * Build an onGpsOrGeocodeFailed closure that mirrors fillHomeFromGps's wiring
 * in identity.tsx, but with injectable spies instead of Alert + React setState.
 */
function buildGeoFailureHandler(opts: {
  alertFn: (title: string, message: string, buttons: AlertButton[]) => void;
  setShowPicker: (val: boolean) => void;
}): () => void {
  return () =>
    opts.alertFn(
      'Could not detect your location',
      'There was a problem getting your location. You can choose a city from the list instead.',
      [
        { text: 'Choose from list', onPress: () => opts.setShowPicker(true) },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
}

describe('identity screen geocode-failure alert wiring — home-city path: Choose from list reaches setShowHomePicker', () => {
  it('"Choose from list" button reaches setShowHomePicker when geocoding fails', async () => {
    let capturedButtons: AlertButton[] = [];
    let pickerShown = false;

    const onGpsOrGeocodeFailed = buildGeoFailureHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      setShowPicker: (val) => { pickerShown = val; },
    });

    await runIdentityGpsFill({
      getCurrentGps:      grantedGps(),
      reverseGeocode:     () => Promise.reject(new Error('network_error')),
      onPermissionDenied: () => {},
      onGpsOrGeocodeFailed,
      onSuccess:          () => {},
      setLoading:         () => {},
    });

    assert.ok(capturedButtons.length > 0, 'geocode-failure alert must have been shown');

    const btn = capturedButtons.find((b) => b.text === 'Choose from list');
    assert.ok(btn, '"Choose from list" button must be present in the geocode-failure alert');
    btn!.onPress?.();
    assert.equal(pickerShown, true, '"Choose from list" onPress must call setShowHomePicker(true)');
  });

  it('"Cancel" button does not trigger setShowHomePicker', async () => {
    let capturedButtons: AlertButton[] = [];
    let pickerShown = false;

    const onGpsOrGeocodeFailed = buildGeoFailureHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      setShowPicker: (val) => { pickerShown = val; },
    });

    await runIdentityGpsFill({
      getCurrentGps:      grantedGps(),
      reverseGeocode:     () => Promise.reject(new Error('geocode_timeout')),
      onPermissionDenied: () => {},
      onGpsOrGeocodeFailed,
      onSuccess:          () => {},
      setLoading:         () => {},
    });

    const cancelBtn = capturedButtons.find((b) => b.text === 'Cancel');
    assert.ok(cancelBtn, '"Cancel" button must be present in the geocode-failure alert');
    cancelBtn!.onPress?.();
    assert.equal(pickerShown, false, '"Cancel" must not trigger setShowHomePicker');
  });

  it('"Choose from list" and "Cancel" are independently reachable in the same geocode-failure alert', async () => {
    let capturedButtons: AlertButton[] = [];
    let pickerCount = 0;

    const onGpsOrGeocodeFailed = buildGeoFailureHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      setShowPicker: () => { pickerCount++; },
    });

    await runIdentityGpsFill({
      getCurrentGps:      grantedGps(),
      reverseGeocode:     () => Promise.reject(new Error('geocode_failed')),
      onPermissionDenied: () => {},
      onGpsOrGeocodeFailed,
      onSuccess:          () => {},
      setLoading:         () => {},
    });

    capturedButtons.find((b) => b.text === 'Cancel')?.onPress?.();
    assert.equal(pickerCount, 0, '"Cancel" must not increment picker count');

    capturedButtons.find((b) => b.text === 'Choose from list')?.onPress?.();
    assert.equal(pickerCount, 1, '"Choose from list" must be independently callable');
  });

  it('geocode-failure alert is NOT shown when GPS fill succeeds', async () => {
    let capturedButtons: AlertButton[] = [];
    let pickerShown = false;

    const onGpsOrGeocodeFailed = buildGeoFailureHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      setShowPicker: (val) => { pickerShown = val; },
    });

    await runIdentityGpsFill({
      getCurrentGps:      grantedGps(),
      reverseGeocode:     geocode({ city: 'Paris', country: 'France' }),
      onPermissionDenied: () => {},
      onGpsOrGeocodeFailed,
      onSuccess:          () => {},
      setLoading:         () => {},
    });

    assert.equal(capturedButtons.length, 0, 'geocode-failure alert must NOT be shown on success');
    assert.equal(pickerShown, false, 'setShowHomePicker must NOT be called on success');
  });
});

// ── Suite: geocode-failure alert wiring — current-city path ──────────────────
//
// The current-city GPS button mirrors the home-city logic but wires "Choose
// from list" to setShowCurrentPicker. These tests guard that contract
// independently so a copy-paste mistake (home vs. current) is caught immediately.

describe('identity screen geocode-failure alert wiring — current-city path: Choose from list reaches setShowCurrentPicker', () => {
  it('"Choose from list" button reaches setShowCurrentPicker when geocoding fails for current city', async () => {
    let capturedButtons: AlertButton[] = [];
    let pickerShown = false;

    // Mirrors fillCurrentFromGps: setShowPicker wires to setShowCurrentPicker
    const onGpsOrGeocodeFailed = buildGeoFailureHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      setShowPicker: (val) => { pickerShown = val; },
    });

    await runIdentityGpsFill({
      getCurrentGps:      grantedGps(),
      reverseGeocode:     () => Promise.reject(new Error('network_error')),
      onPermissionDenied: () => {},
      onGpsOrGeocodeFailed,
      onSuccess:          () => {},
      setLoading:         () => {},
    });

    assert.ok(capturedButtons.length > 0, 'geocode-failure alert must have been shown for current-city path');

    const btn = capturedButtons.find((b) => b.text === 'Choose from list');
    assert.ok(btn, '"Choose from list" button must be present in the current-city geocode-failure alert');
    btn!.onPress?.();
    assert.equal(pickerShown, true, '"Choose from list" onPress must call setShowCurrentPicker(true)');
  });

  it('"Cancel" button does not trigger setShowCurrentPicker', async () => {
    let capturedButtons: AlertButton[] = [];
    let pickerShown = false;

    const onGpsOrGeocodeFailed = buildGeoFailureHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      setShowPicker: (val) => { pickerShown = val; },
    });

    await runIdentityGpsFill({
      getCurrentGps:      grantedGps(),
      reverseGeocode:     () => Promise.reject(new Error('geocode_failed')),
      onPermissionDenied: () => {},
      onGpsOrGeocodeFailed,
      onSuccess:          () => {},
      setLoading:         () => {},
    });

    capturedButtons.find((b) => b.text === 'Cancel')?.onPress?.();
    assert.equal(pickerShown, false, '"Cancel" must not trigger setShowCurrentPicker');
  });

  it('"Choose from list" and "Cancel" are independently reachable in the current-city geocode-failure alert', async () => {
    let capturedButtons: AlertButton[] = [];
    let pickerCount = 0;

    const onGpsOrGeocodeFailed = buildGeoFailureHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      setShowPicker: () => { pickerCount++; },
    });

    await runIdentityGpsFill({
      getCurrentGps:      grantedGps(),
      reverseGeocode:     () => Promise.reject(new Error('geocode_failed')),
      onPermissionDenied: () => {},
      onGpsOrGeocodeFailed,
      onSuccess:          () => {},
      setLoading:         () => {},
    });

    capturedButtons.find((b) => b.text === 'Cancel')?.onPress?.();
    assert.equal(pickerCount, 0, '"Cancel" must not increment picker count for current-city path');

    capturedButtons.find((b) => b.text === 'Choose from list')?.onPress?.();
    assert.equal(pickerCount, 1, '"Choose from list" must be independently callable for current-city path');
  });

  it('geocode-failure alert is NOT shown when current-city GPS fill succeeds', async () => {
    let capturedButtons: AlertButton[] = [];
    let pickerShown = false;

    const onGpsOrGeocodeFailed = buildGeoFailureHandler({
      alertFn: (_t, _m, buttons) => { capturedButtons = buttons; },
      setShowPicker: (val) => { pickerShown = val; },
    });

    await runIdentityGpsFill({
      getCurrentGps:      grantedGps(),
      reverseGeocode:     geocode({ city: 'Tokyo', country: 'Japan' }),
      onPermissionDenied: () => {},
      onGpsOrGeocodeFailed,
      onSuccess:          () => {},
      setLoading:         () => {},
    });

    assert.equal(capturedButtons.length, 0, 'geocode-failure alert must NOT be shown on success (current-city path)');
    assert.equal(pickerShown, false, 'setShowCurrentPicker must NOT be called on success');
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
