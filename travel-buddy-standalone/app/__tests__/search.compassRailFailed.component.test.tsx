/**
 * census-discovery §104 (DV-83, D-W11X2-55) — search's Compass rail under a
 * zero-result search says a failed read; it is never the rail's absence.
 *
 * The rail reads GET /compass/recommendations?surface=search. Its failure arms used
 * to answer `{ recommendations: [] }`, and the screen set `[]` for a transport
 * failure too, so a failed read drew no rail: the same screen as "Compass has
 * nothing to suggest". The §103.11 verifier's V7-R1 showed the server half; this
 * pins the screen half.
 *
 *   CR1  the rail's read fails (transport) → the failed line, not the absence
 *   CR2  the rail's read is refused `nothing` → the failed line
 *   CR3  an older server's `error: "block_check_failed"` → the failed line
 *   CR4  a `partial` answer with rows → the rows AND the incomplete line
 *   CRc  CONTROL: an answered empty rail → no rail and no failed line, as before
 *   CRd  CONTROL: an answered rail with rows → the rows, no line
 *
 * Harness copied from search.refusal.component.test.tsx.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import SearchScreen from '../search.tsx';
import { searchUnified } from '../../src/services/discovery.ts';
import { fetchCompassRecommendations } from '../../src/services/compass';

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
  useSearchSuggestions: () => ({ groups: [], loading: false, refused: false }),
}));

// NOTE: intentionally exhaustive — services/compass.ts reaches the network. Each
// test sets what the Compass rail's read answers; the refusal predicate lives in
// its own module (services/compassRecommendationsRefusal.ts), so it stays real.
jest.mock('../../src/services/compass', () => ({
  fetchCompassRecommendations: jest.fn().mockResolvedValue({ ok: true, data: { recommendations: [] } }),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

const mockSearchUnified = searchUnified as jest.Mock;
const mockFetchCompass = fetchCompassRecommendations as jest.Mock;

const REC = { id: 'place:1', type: 'place', category: 'food', title: 'Le Place', reason: 'Near you' };

/** The screen debounces ~300ms before it searches. */
const PAST_DEBOUNCE = { timeout: 3000 };

async function zeroResultSearchWith(compass: unknown) {
  mockSearchUnified.mockResolvedValue({ ok: true, data: { results: [], nextCursor: null, timeLabel: null } });
  mockFetchCompass.mockResolvedValue(compass);
  const view = await render(<SearchScreen />);
  await waitFor(() => { expect(mockFetchCompass).toHaveBeenCalled(); }, PAST_DEBOUNCE);
  await act(async () => {});
  return view;
}

describe('SearchScreen — the Compass rail says a failed read (§104)', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('CR1 the rail read fails (transport) → the failed line, not the rail\'s absence', async () => {
    const v = await zeroResultSearchWith({ ok: false, error: 'http_503' });
    await waitFor(() => { expect(v.queryByTestId('compass-fallback-failed')).not.toBeNull(); }, PAST_DEBOUNCE);
  });

  it('CR2 the rail read is refused `nothing` → the failed line', async () => {
    const v = await zeroResultSearchWith({ ok: true, data: { recommendations: [], surface: 'search', refusal: { class: 'transient_db', code: 'compass_sources_unread', coverage: 'nothing', failedSources: ['posts'] } } });
    await waitFor(() => { expect(v.queryByTestId('compass-fallback-failed')).not.toBeNull(); }, PAST_DEBOUNCE);
  });

  it('CR3 an older server\'s `error` marker with no refusal → the failed line', async () => {
    const v = await zeroResultSearchWith({ ok: true, data: { recommendations: [], surface: 'search', error: 'block_check_failed' } });
    await waitFor(() => { expect(v.queryByTestId('compass-fallback-failed')).not.toBeNull(); }, PAST_DEBOUNCE);
  });

  it('CR4 a partial answer → its rows AND the incomplete line', async () => {
    const v = await zeroResultSearchWith({ ok: true, data: { recommendations: [REC], surface: 'search', refusal: { class: 'transient_db', code: 'compass_sources_unread', coverage: 'partial', failedSources: ['events'] } } });
    await waitFor(() => { expect(v.queryByText('Le Place')).not.toBeNull(); }, PAST_DEBOUNCE);
    expect(v.queryByTestId('compass-fallback-partial')).not.toBeNull();
    expect(v.queryByTestId('compass-fallback-failed')).toBeNull();
  });

  it('CRc CONTROL an answered empty rail → no rail, no line (unchanged)', async () => {
    const v = await zeroResultSearchWith({ ok: true, data: { recommendations: [], surface: 'search' } });
    expect(v.queryByText('Compass Suggestions')).toBeNull();
    expect(v.queryByTestId('compass-fallback-failed')).toBeNull();
    expect(v.queryByTestId('compass-fallback-partial')).toBeNull();
  });

  it('CRd CONTROL an answered rail with rows → the rows, no line', async () => {
    const v = await zeroResultSearchWith({ ok: true, data: { recommendations: [REC], surface: 'search' } });
    await waitFor(() => { expect(v.queryByText('Le Place')).not.toBeNull(); }, PAST_DEBOUNCE);
    expect(v.queryByTestId('compass-fallback-failed')).toBeNull();
    expect(v.queryByTestId('compass-fallback-partial')).toBeNull();
  });
});
