/**
 * SearchScreen — GPS coords reach search after source switches mid-session.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --testPathPattern=search.sourceSwitchCoords
 *
 * ## What's covered
 *
 * When the active location source switches mid-session (e.g. a session
 * override is cleared and GPS resumes), resolvedLocation changes and the
 * userCoords memo in search.tsx must re-derive from the new resolvedLocation
 * value. This test confirms that after a source transition
 * (manual_city → gps) the subsequent searchUnified call receives the fresh
 * GPS coords — not the previously-cached session-override coords.
 *
 *  1. First render: resolvedLocation carries source='manual_city' (Tokyo).
 *     searchUnified is first called with Tokyo coords.
 *  2. Re-render with resolvedLocation carrying source='gps' (Sydney).
 *     The component must re-derive userCoords and fire a new search with
 *     Sydney coords — not remain frozen on Tokyo.
 *
 * ## Why this test exists
 *
 * If the userCoords useMemo had a stale closure or missing dependency on
 * resolvedLocation, a mid-session source switch would leave the memo frozen
 * on the old coords. searchUnified would silently receive wrong coords for
 * every subsequent search until the screen unmounts and remounts.
 *
 * ## Mock strategy
 *
 * useLocationContext is set up as a jest.fn() so its return value can be
 * swapped between renders to simulate the source transition. All other
 * mocks follow the same exhaustive pattern used in
 * search.sessionLocationCoords.component.test.tsx.
 */

import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import SearchScreen from '../search.tsx';
import { searchUnified } from '../../src/services/discovery.ts';

// ── Fixtures ───────────────────────────────────────────────────────────────────

// Initial location: session override (city picker → Tokyo, source='manual_city')
const MANUAL_LAT  = 35.6762;
const MANUAL_LNG  = 139.6503;
const MANUAL_CITY = 'Tokyo';

// Post-switch location: GPS resumes (Sydney, source='gps')
const GPS_LAT  = -33.8688;
const GPS_LNG  = 151.2093;
const GPS_CITY = 'Sydney';

// ── Mutable context factory ────────────────────────────────────────────────────

// Holds a reference the test can swap between renders.
let resolvedLocationOverride = {
  place:   { city: MANUAL_CITY, country: 'JP', lat: MANUAL_LAT, lng: MANUAL_LNG },
  coords:  { lat: MANUAL_LAT, lng: MANUAL_LNG, accuracyMeters: null as number | null },
  source:  'manual_city' as const,
  freshness: 'live' as const,
};

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-router is globally mapped via
// moduleNameMapper. This per-file factory overrides it without requiring the
// mapped stub (which would cause infinite recursion). params.q starts the
// component with submitted=true so runSearch fires immediately on mount.
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useLocalSearchParams: () => ({ q: 'coffee' }),
    router: {
      push:      jest.fn(),
      replace:   jest.fn(),
      back:      jest.fn(),
      navigate:  jest.fn(),
      dismiss:   jest.fn(),
      setParams: jest.fn(),
    },
    useRouter: () => ({
      push:      jest.fn(),
      replace:   jest.fn(),
      back:      jest.fn(),
      navigate:  jest.fn(),
      setParams: jest.fn(),
    }),
    useFocusEffect: (cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    useNavigation: () => ({
      navigate:    jest.fn(),
      goBack:      jest.fn(),
      setOptions:  jest.fn(),
      addListener: jest.fn(() => jest.fn()),
    }),
    Link:     ({ children }: { children: React.ReactNode }) => children,
    Redirect: () => null,
    Stack:    { Screen: () => null },
    Tabs:     { Screen: () => null },
  };
});

// NOTE: intentionally exhaustive — LocationContext pulls in useActiveLocation
// which imports expo-location native modules. We expose useLocationContext as
// a jest.fn() so we can change the returned resolvedLocation between renders.
const mockUseLocationContext = jest.fn();
jest.mock('../../src/context/LocationContext', () => ({
  useLocationContext: (...args: unknown[]) => mockUseLocationContext(...args),
}));

// NOTE: intentionally exhaustive — SessionContext pulls in Supabase client
// initialisation that requires network/env unavailable under Jest.
jest.mock('../../src/context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, userId: 'user-1' }),
}));

// NOTE: intentionally exhaustive — discovery.ts imports apiBase() and
// freshToken() which require network/env vars unavailable under Jest.
jest.mock('../../src/services/discovery', () => ({
  searchUnified:      jest.fn(),
  getSearchHistory:   jest.fn().mockResolvedValue([]),
  saveSearchHistory:  jest.fn().mockResolvedValue('history-id-1'),
  clearSearchHistory: jest.fn().mockResolvedValue(undefined),
}));

// NOTE: intentionally exhaustive — ScreenHeader uses expo-router internals and
// safe-area hooks.
jest.mock('../../src/components/ScreenHeader', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { ScreenHeader: () => React.createElement(View, { testID: 'screen-header' }) };
});

// NOTE: intentionally exhaustive — SearchResultCard renders avatars, maps, and
// native image modules not safe under Jest.
jest.mock('../../src/components/search/SearchResultCard', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  return {
    SearchResultCard: ({ result }: { result: { id: string } }) =>
      React.createElement(View, { testID: `result-${result.id}` },
        React.createElement(Text, null, result.id),
      ),
  };
});

// NOTE: intentionally exhaustive — SearchSuggestionsPanel pulls in icon,
// avatar, and map components that require native modules.
jest.mock('../../src/components/search/SearchSuggestionsPanel', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SearchSuggestionsPanel: () => React.createElement(View, { testID: 'suggestions-panel' }),
  };
});

// NOTE: intentionally exhaustive — CompassTravelerRow pulls in reanimated and
// avatar components not safe under Jest.
jest.mock('../../src/components/compass/CompassTravelerRow', () => ({
  CompassTravelerRow: () => null,
}));

// NOTE: intentionally exhaustive — KeyboardSafeScrollView imports
// react-native-keyboard-controller which requires native bridging unavailable
// under jest-expo.
jest.mock('../../src/components/ui/KeyboardSafeView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeScrollView: ({ children, style }: { children: React.ReactNode; style?: unknown }) =>
      React.createElement(View, { style }, children),
  };
});

// NOTE: intentionally exhaustive — useNavBarCollapse calls makeMutable() at
// module scope (outside React) which is not supported under Jest.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => undefined,
  NavBarFiller: () => null,
}));

// NOTE: intentionally exhaustive — useSearchSuggestions makes live API calls;
// stub with empty groups so the component stays in results mode after submit.
jest.mock('../../src/hooks/useSearchSuggestions', () => ({
  useSearchSuggestions: () => ({ groups: [], loading: false }),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeLocationContext(override: typeof resolvedLocationOverride) {
  return {
    locationState: {
      permissionStatus: 'granted',
      ok: true,
      // locationState always carries the raw GPS coords regardless of the
      // resolved source — the component must read from resolvedLocation.
      coords: { lat: GPS_LAT, lng: GPS_LNG, accuracyMeters: 20 },
      place:  { city: GPS_CITY, country: 'AU', lat: GPS_LAT, lng: GPS_LNG },
      source: 'gps',
      freshness: 'live',
    },
    requestLocation:          jest.fn(),
    setManualCity:            jest.fn(),
    showPermissionPrompt:     false,
    showCityPicker:           false,
    requireLocation:          jest.fn(),
    dismissPermissionPrompt:  jest.fn(),
    openCityPicker:           jest.fn(),
    closeCityPicker:          jest.fn(),
    locationPrefs:            {},
    locationPrefsLoading:     false,
    refreshLocationPrefs:     jest.fn(),
    setSessionLocation:       jest.fn(),
    clearSessionLocation:     jest.fn(),
    resolvedLocation:         override,
  };
}

// ── Typed mock ref ─────────────────────────────────────────────────────────────

const mockSearchUnified = searchUnified as jest.Mock;

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('SearchScreen — GPS coords reach search after source switches mid-session', () => {
  beforeEach(() => {
    // Reset resolvedLocation to the initial manual_city state before each test.
    resolvedLocationOverride = {
      place:     { city: MANUAL_CITY, country: 'JP', lat: MANUAL_LAT, lng: MANUAL_LNG },
      coords:    { lat: MANUAL_LAT, lng: MANUAL_LNG, accuracyMeters: null },
      source:    'manual_city',
      freshness: 'live',
    };

    // Return the current resolvedLocationOverride on every call so the
    // test can swap it between render and rerender.
    mockUseLocationContext.mockImplementation(() =>
      makeLocationContext(resolvedLocationOverride),
    );

    // Successful response so runSearch completes on every call.
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: {
        results: [{ id: 'r1', type: 'place', title: 'Café', actionState: {} }],
        nextCursor: null,
        timeLabel: 'Nearby',
      },
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('second searchUnified call receives GPS coords after source switches from manual_city to gps', async () => {
    // ── Phase 1: initial render with session override (manual_city → Tokyo) ──
    const { rerender } = await render(<SearchScreen />);

    // Wait for the first search to fire (debounced 300 ms).
    await waitFor(
      () => { expect(mockSearchUnified).toHaveBeenCalledTimes(1); },
      { timeout: 1000 },
    );

    // First call must carry Tokyo (manual_city) coords.
    const firstOpts = mockSearchUnified.mock.calls[0][3] as {
      lat?: number; lng?: number; city?: string;
    };
    expect(firstOpts.lat).toBe(MANUAL_LAT);
    expect(firstOpts.lng).toBe(MANUAL_LNG);

    // ── Phase 2: source switches to gps — resolvedLocation now carries Sydney ──
    resolvedLocationOverride = {
      place:     { city: GPS_CITY, country: 'AU', lat: GPS_LAT, lng: GPS_LNG },
      coords:    { lat: GPS_LAT, lng: GPS_LNG, accuracyMeters: 15 },
      source:    'gps',
      freshness: 'live',
    };

    // Rerender to propagate the new context value into the component.
    await act(async () => {
      rerender(<SearchScreen />);
    });

    // The userCoords memo must re-derive and the debounced effect must re-fire.
    await waitFor(
      () => { expect(mockSearchUnified).toHaveBeenCalledTimes(2); },
      { timeout: 1000 },
    );

    // Second call must carry Sydney (gps) coords — not the frozen Tokyo values.
    const secondOpts = mockSearchUnified.mock.calls[1][3] as {
      lat?: number; lng?: number; city?: string;
    };
    expect(secondOpts.lat).toBe(GPS_LAT);
    expect(secondOpts.lng).toBe(GPS_LNG);

    // The old manual_city coords must not appear in the second call.
    expect(secondOpts.lat).not.toBe(MANUAL_LAT);
    expect(secondOpts.lng).not.toBe(MANUAL_LNG);
  });

  it('second searchUnified call receives the GPS city name after the source switch', async () => {
    const { rerender } = await render(<SearchScreen />);

    await waitFor(
      () => { expect(mockSearchUnified).toHaveBeenCalledTimes(1); },
      { timeout: 1000 },
    );

    // Verify first call used Tokyo.
    const firstOpts = mockSearchUnified.mock.calls[0][3] as { city?: string };
    expect(firstOpts.city).toBe(MANUAL_CITY);

    // Switch source to GPS (Sydney).
    resolvedLocationOverride = {
      place:     { city: GPS_CITY, country: 'AU', lat: GPS_LAT, lng: GPS_LNG },
      coords:    { lat: GPS_LAT, lng: GPS_LNG, accuracyMeters: 15 },
      source:    'gps',
      freshness: 'live',
    };

    await act(async () => {
      rerender(<SearchScreen />);
    });

    await waitFor(
      () => { expect(mockSearchUnified).toHaveBeenCalledTimes(2); },
      { timeout: 1000 },
    );

    const secondOpts = mockSearchUnified.mock.calls[1][3] as { city?: string };
    // City name must be updated to Sydney after the source switch.
    expect(secondOpts.city).toBe(GPS_CITY);
    expect(secondOpts.city).not.toBe(MANUAL_CITY);
  });

  it('GPS coords are defined and non-zero after the source switch — not silently dropped', async () => {
    const { rerender } = await render(<SearchScreen />);

    await waitFor(
      () => { expect(mockSearchUnified).toHaveBeenCalledTimes(1); },
      { timeout: 1000 },
    );

    // Switch source to GPS (Sydney).
    resolvedLocationOverride = {
      place:     { city: GPS_CITY, country: 'AU', lat: GPS_LAT, lng: GPS_LNG },
      coords:    { lat: GPS_LAT, lng: GPS_LNG, accuracyMeters: 15 },
      source:    'gps',
      freshness: 'live',
    };

    await act(async () => {
      rerender(<SearchScreen />);
    });

    await waitFor(
      () => { expect(mockSearchUnified).toHaveBeenCalledTimes(2); },
      { timeout: 1000 },
    );

    const opts = mockSearchUnified.mock.calls[1][3] as {
      lat?: number; lng?: number;
    };
    // Both lat and lng must be present — dropping either would silently fall
    // back to a non-geo search even though GPS is active.
    expect(opts.lat).not.toBeUndefined();
    expect(opts.lng).not.toBeUndefined();
    expect(opts.lat).not.toBe(0);
    expect(opts.lng).not.toBe(0);
  });
});
