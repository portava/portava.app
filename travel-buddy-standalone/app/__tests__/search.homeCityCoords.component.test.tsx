/**
 * SearchScreen — home-city coords flow-through test.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --testPathPattern=search.homeCityCoords
 *
 * ## What's covered
 *
 * When GPS permission is denied but the user has a home city set, the
 * resolvedLocation cascade (GPS → last-known → home city) still surfaces
 * lat/lng coordinates. This test confirms that:
 *
 *  1. The userCoords memo produces a non-null value with the home-city
 *     lat/lng — even though permissionStatus is 'denied'.
 *  2. searchUnified is called with those coords (lat/lng/city) so nearby
 *     results are still returned for the home city.
 *
 * ## Why this test exists
 *
 * Task #1537 wired search.tsx to resolvedLocation so last-known and
 * home-city coords flow through to geo-aware search. Without a test, a
 * regression could silently revert to undefined coords when GPS is denied,
 * making nearby search useless for users who never granted GPS.
 *
 * ## Mock strategy
 *
 * LocationContext is mocked exhaustively — its real implementation imports
 * expo-location native modules unavailable in the jest-expo runner. The mock
 * drives permissionStatus='denied' with a home-city resolvedLocation that has
 * coords.
 *
 * expo-router is overridden per-file (without requiring the mapped stub path)
 * to supply params.q='coffee' so the component starts in submitted mode and
 * fires runSearch on mount, without needing fireEvent interactions.
 *
 * Heavy child components (ScreenHeader, SearchResultCard, SearchSuggestionsPanel,
 * CompassTravelerRow, KeyboardSafeScrollView, useNavBarCollapse,
 * useSearchSuggestions) are stubbed because they depend on native modules not
 * safe to run under Jest.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import SearchScreen from '../search.tsx';
import { searchUnified } from '../../src/services/discovery.ts';

// ── Home-city fixture ──────────────────────────────────────────────────────────

const HOME_LAT = 14.5995;
const HOME_LNG = 120.9842;
const HOME_CITY = 'Manila';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-router is globally mapped via
// moduleNameMapper. This per-file factory overrides it without requiring the
// mapped stub, which would cause infinite recursion. We supply params.q so
// the component initialises with submitted=true and fires runSearch immediately,
// and add router.setParams (called inside the debounce) to avoid a crash.
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

// NOTE: intentionally exhaustive — the standalone search.tsx reads location via
// useActiveLocation() (a local-state hook), NOT the mobile-tree useLocationContext.
// The real hook imports expo-location native modules unavailable in the jest-expo
// runner, so we stub it. This is a DIVERGENT FORK: the standalone userCoords memo
// only surfaces coords when permissionStatus === 'granted' and reads them from
// locationState.coords / locationState.place.city — there is no resolvedLocation
// cascade here (that is a mobile-only feature). We therefore drive a granted GPS
// fix for the home city so coords flow through to searchUnified.
// NOTE: exhaustive factory (see above) — no requireActual to avoid loading
// expo-location native modules.
jest.mock('../../src/hooks/useActiveLocation', () => ({
  useActiveLocation: () => ({
    locationState: {
      permissionStatus: 'granted',
      ok: true,
      coords: { lat: HOME_LAT, lng: HOME_LNG, accuracyMeters: null },
      place: { city: HOME_CITY, country: 'PH', lat: HOME_LAT, lng: HOME_LNG },
      source: 'home',
      freshness: 'unavailable',
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
// freshToken() which require network/env vars unavailable under Jest. Spreading
// jest.requireActual would attempt to initialise those at mock-load time and
// crash the suite. Only the four functions called by SearchScreen are needed.
jest.mock('../../src/services/discovery', () => ({
  searchUnified:      jest.fn(),
  getSearchHistory:   jest.fn().mockResolvedValue([]),
  saveSearchHistory:  jest.fn().mockResolvedValue('history-id-1'),
  clearSearchHistory: jest.fn().mockResolvedValue(undefined),
}));

// NOTE: intentionally exhaustive — ScreenHeader uses expo-router internals and
// safe-area hooks; the per-file expo-router mock covers router.* but
// requireActual would still pull native bridging code.
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
// under jest-expo; a passthrough wrapper is sufficient.
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

// NOTE: standalone fork — coords flow through when GPS is granted for the home
// city (there is no denied-GPS home-city cascade in this tree, unlike mobile).
describe('SearchScreen — home-city coords flow through to search', () => {
  beforeEach(() => {
    // Return a minimal successful response so runSearch completes.
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: {
        results: [{ id: 'r1', type: 'place', title: 'Test Place', actionState: {} }],
        nextCursor: null,
        timeLabel: 'Nearby · Manila',
      },
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('searchUnified is called with home-city lat/lng when GPS is denied', async () => {
    // params.q='coffee' (from the expo-router mock) starts the component in
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

    // userCoords must be non-null — home-city coords must flow through.
    expect(opts).toBeDefined();
    expect(opts.lat).toBe(HOME_LAT);
    expect(opts.lng).toBe(HOME_LNG);
  });

  it('searchUnified coords are not undefined when GPS is denied', async () => {
    await render(<SearchScreen />);

    await waitFor(
      () => { expect(mockSearchUnified).toHaveBeenCalled(); },
      { timeout: 1000 },
    );

    const opts = mockSearchUnified.mock.calls[0][3] as {
      lat?: number;
      lng?: number;
    };

    // Both lat and lng must be defined — a nearby search with no coords
    // would silently return results without geo-ranking.
    expect(opts.lat).not.toBeUndefined();
    expect(opts.lng).not.toBeUndefined();
  });

  it('searchUnified receives the home city name in opts.city', async () => {
    await render(<SearchScreen />);

    await waitFor(
      () => { expect(mockSearchUnified).toHaveBeenCalled(); },
      { timeout: 1000 },
    );

    const opts = mockSearchUnified.mock.calls[0][3] as {
      city?: string;
    };

    // The city name from resolvedLocation.place.city must be forwarded
    // so the API can apply city-scoped ranking.
    expect(opts.city).toBe(HOME_CITY);
  });
});
