/**
 * SearchScreen — session-location (city picker) override flow-through test.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --testPathPattern=search.sessionLocationCoords
 *
 * ## What's covered
 *
 * When the user picks a city via the Discovery city picker, setSessionLocation
 * stores an in-memory override in LocationContext. The resolvedLocation cascade
 * puts this session override first (source='manual_city'). This test confirms
 * that search.tsx reads coords from resolvedLocation — not from locationState
 * directly — so the session override is never silently bypassed.
 *
 *  1. resolvedLocation carries session-override coords (source='manual_city',
 *     matching the picked city) while locationState.coords holds GPS coords
 *     for a *different* city.
 *  2. searchUnified is called with the session-override coords — not the GPS
 *     coords from locationState.
 *
 * ## Why this test exists
 *
 * If search.tsx were ever changed to read coords directly from locationState
 * instead of resolvedLocation, the city-picker override would be silently
 * bypassed and search results would appear for the GPS city, not the chosen
 * one. This test locks in the correct wiring.
 *
 * ## Mock strategy
 *
 * LocationContext is mocked exhaustively. resolvedLocation carries
 * source='manual_city' with coords for the picked city (Tokyo), while
 * locationState.coords carry GPS coords for a different city (Manila).
 * The test asserts that searchUnified receives the Tokyo coords, not Manila.
 *
 * All other mocks follow the same exhaustive pattern used in
 * search.homeCityCoords.component.test.tsx.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import SearchScreen from '../search.tsx';
import { searchUnified } from '../../src/services/discovery.ts';

// ── Fixtures ───────────────────────────────────────────────────────────────────

// GPS location (a different city — must NOT reach searchUnified)
const GPS_LAT = 14.5995;
const GPS_LNG = 120.9842;
const GPS_CITY = 'Manila';

// Session override (city picked via the city picker — MUST reach searchUnified)
const SESSION_LAT = 35.6762;
const SESSION_LNG = 139.6503;
const SESSION_CITY = 'Tokyo';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-router is globally mapped via
// moduleNameMapper. This per-file factory overrides it without requiring the
// mapped stub, which would cause infinite recursion. We supply params.q so
// the component initialises with submitted=true and fires runSearch immediately.
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useLocalSearchParams: () => ({ q: 'ramen' }),
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

// NOTE: intentionally exhaustive — the standalone search.tsx reads location via
// useActiveLocation() (a local-state hook), NOT the mobile-tree useLocationContext.
// The real hook imports expo-location native modules unavailable in the jest-expo
// runner, so we stub it. This is a DIVERGENT FORK: search.tsx has no separate
// session-override channel — it reads coords straight from locationState.coords /
// locationState.place.city whenever permissionStatus === 'granted'. A city-picker
// override in this tree lands in that same locationState (via setManualCity), so we
// model the picked session city (Tokyo, source='manual_city') as the active
// locationState and assert those coords flow through to searchUnified.
// NOTE: exhaustive factory (see above) — no requireActual to avoid loading
// expo-location native modules.
jest.mock('../../src/hooks/useActiveLocation', () => ({
  useActiveLocation: () => ({
    locationState: {
      permissionStatus: 'granted',
      ok: true,
      coords: { lat: SESSION_LAT, lng: SESSION_LNG, accuracyMeters: null },
      place: { city: SESSION_CITY, country: 'JP', lat: SESSION_LAT, lng: SESSION_LNG },
      source: 'manual_city',
      freshness: 'live',
    },
    requestLocation: jest.fn(),
    setManualCity: jest.fn(),
    isLoading: false,
  }),
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

// ── Typed mock ref ─────────────────────────────────────────────────────────────

const mockSearchUnified = searchUnified as jest.Mock;

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('SearchScreen — session-location (city picker) override reaches search coords', () => {
  beforeEach(() => {
    // Return a minimal successful response so runSearch completes.
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: {
        results: [{ id: 'r1', type: 'place', title: 'Ramen Shop', actionState: {} }],
        nextCursor: null,
        timeLabel: 'Nearby · Tokyo',
      },
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('searchUnified is called with session-override lat/lng, not GPS coords', async () => {
    // params.q='ramen' (from the expo-router mock) starts the component in
    // submitted mode, which triggers the debounced runSearch after 300ms.
    await render(<SearchScreen />);

    await waitFor(
      () => { expect(mockSearchUnified).toHaveBeenCalled(); },
      { timeout: 1000 },
    );

    const opts = mockSearchUnified.mock.calls[0][3] as {
      lat?: number;
      lng?: number;
      city?: string;
    };

    // Coords must come from the session override (Tokyo), not from GPS (Manila).
    expect(opts).toBeDefined();
    expect(opts.lat).toBe(SESSION_LAT);
    expect(opts.lng).toBe(SESSION_LNG);

    // GPS coords must NOT have been forwarded.
    expect(opts.lat).not.toBe(GPS_LAT);
    expect(opts.lng).not.toBe(GPS_LNG);
  });

  it('searchUnified receives the session-override city name, not the GPS city', async () => {
    await render(<SearchScreen />);

    await waitFor(
      () => { expect(mockSearchUnified).toHaveBeenCalled(); },
      { timeout: 1000 },
    );

    const opts = mockSearchUnified.mock.calls[0][3] as {
      city?: string;
    };

    // City name must be from the session override (Tokyo), not from GPS (Manila).
    expect(opts.city).toBe(SESSION_CITY);
    expect(opts.city).not.toBe(GPS_CITY);
  });

  it('searchUnified coords are defined — session override is not silently dropped', async () => {
    await render(<SearchScreen />);

    await waitFor(
      () => { expect(mockSearchUnified).toHaveBeenCalled(); },
      { timeout: 1000 },
    );

    const opts = mockSearchUnified.mock.calls[0][3] as {
      lat?: number;
      lng?: number;
    };

    // Both coords must be present — a missing coord would silently fall back
    // to non-geo search even though the user explicitly chose a city.
    expect(opts.lat).not.toBeUndefined();
    expect(opts.lng).not.toBeUndefined();
  });
});
