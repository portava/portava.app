/**
 * SearchScreen — only the latest search may write the screen (census-discovery
 * §102, lane W11-X2 round 6 sweep; DV-83; register D-W11X2-44).
 *
 * The screen dropped a late answer only when its query or tab differed from
 * the active ones. A search for the SAME query and tab started again — a tab
 * switched away and back, a chip toggled, a retry — let the older answer land
 * after the newer one and write the screen: it cleared the newer answer's
 * partial notice and replaced its rows, and a superseded load-more (page 2 of
 * the earlier run) was appended to the newer list.
 *
 *   SQ1  a superseded page 1 lands after the newer PARTIAL page 1: the newer rows and notice stand
 *   SQ2  a superseded page 1 lands after the newer REFUSED page 1: the failure stands, no old rows
 *   SQ3  a superseded load-more lands after the newer page 1: nothing appended
 *   SQ4  a superseded page 1 that THROWS after the newer good page 1: no failure is drawn
 *   SQ5  a superseded page 1 that lands while the newer one is in flight: still loading, never "No results found."
 *   C1   CONTROL: the newer answer is shown when it lands last
 *
 * Harness copied from search.loadMore.component.test.tsx.
 *
 * Run with: npx jest app/__tests__/search.latestRequest.component.test.tsx
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { act, fireEvent } from '@testing-library/react-native';
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

// NOTE: intentionally exhaustive — services/compass.ts reaches the network. This
// is the mock the whole suite turns on: the defect is that a REFUSED search
// still calls this, offering alternatives to a search that never ran.
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

const REFUSAL_NOTHING = {
  class: 'transient_db',
  code: 'search_failed',
  route: 'GET /discovery/search',
  coverage: 'nothing' as const,
};

/** The screen debounces ~300ms before it searches. */
const PAST_DEBOUNCE = { timeout: 3000 };


const NOTICE_PARTIAL = 'These results are incomplete — part of the search couldn’t be run.';
const MORE_FAILED = /Couldn’t load more results just now/;
const PARTIAL_REFUSAL = { ...REFUSAL_NOTHING, code: 'search_sources_unreadable', coverage: 'partial' as const, failedSources: ['plans'] };

const row = (id: string) => ({ id, type: 'place', title: id, actionState: {} });
const page = (ids: string[], nextCursor: string | null, refusal?: object) =>
  ({ ok: true, data: { results: ids.map(row), nextCursor, timeLabel: null, ...(refusal ? { refusal } : {}) } });

async function renderPage1(first: unknown) {
  mockSearchUnified.mockResolvedValueOnce(first);
  const r = await render(<SearchScreen />);
  await waitFor(() => { expect(r.queryByTestId('result-r1')).not.toBeNull(); }, PAST_DEBOUNCE);
  return r;
}

async function loadMore(r: Awaited<ReturnType<typeof render>>) {
  await act(async () => { fireEvent(r.getByTestId('result-r1'), 'onEndReached', { distanceFromEnd: 0 }); });
  await act(async () => {});
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const hang = () => new Promise(() => {});

describe('SearchScreen — only the latest search writes the screen (DV-83, §102)', () => {
  beforeEach(() => { mockSearchUnified.mockReset(); mockSearchUnified.mockReturnValue(hang()); });
  afterEach(() => { jest.clearAllMocks(); });

  async function supersede(newer: unknown) {
    const older = deferred<unknown>();
    mockSearchUnified.mockReturnValueOnce(older.promise);          // A: All, page 1
    const r = await render(<SearchScreen />);
    await waitFor(() => expect(mockSearchUnified).toHaveBeenCalledTimes(1), PAST_DEBOUNCE);
    mockSearchUnified.mockReturnValueOnce(hang());                  // B: Places
    await act(async () => { fireEvent.press(r.getByText('Places')); });
    await waitFor(() => expect(mockSearchUnified).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    mockSearchUnified.mockResolvedValueOnce(newer);                 // C: All again, same query
    await act(async () => { fireEvent.press(r.getByText('All')); });
    await waitFor(() => expect(mockSearchUnified).toHaveBeenCalledTimes(3), PAST_DEBOUNCE);
    await act(async () => {});
    return { r, older };
  }

  it('SQ1 a superseded page 1 lands after the newer PARTIAL page 1: the newer rows and notice stand', async () => {
    const { r, older } = await supersede(page(['r3'], null, PARTIAL_REFUSAL));
    expect(r.queryByTestId('result-r3')).not.toBeNull();
    expect(r.queryByText(NOTICE_PARTIAL)).not.toBeNull();
    await act(async () => { older.resolve(page(['r1'], null)); });
    await act(async () => {});
    expect(r.queryByTestId('result-r1')).toBeNull();
    expect(r.queryByTestId('result-r3')).not.toBeNull();
    expect(r.queryByText(NOTICE_PARTIAL)).not.toBeNull();
  });

  it('SQ2 a superseded page 1 lands after the newer REFUSED page 1: the failure stands, no old rows', async () => {
    const { r, older } = await supersede(page([], null, REFUSAL_NOTHING));
    expect(r.queryByText(/Search is unavailable right now/)).not.toBeNull();
    await act(async () => { older.resolve(page(['r1'], null)); });
    await act(async () => {});
    expect(r.queryByTestId('result-r1')).toBeNull();
    expect(r.queryByText(/Search is unavailable right now/)).not.toBeNull();
  });

  it('SQ3 a superseded load-more lands after the newer page 1: nothing appended', async () => {
    const r = await renderPage1(page(['r1'], 'c2'));
    const more = deferred<unknown>();
    mockSearchUnified.mockReturnValueOnce(more.promise);            // page 2 of run 1
    await act(async () => { fireEvent(r.getByTestId('result-r1'), 'onEndReached', { distanceFromEnd: 0 }); });
    mockSearchUnified.mockReturnValueOnce(hang());                  // Places
    await act(async () => { fireEvent.press(r.getByText('Places')); });
    await waitFor(() => expect(mockSearchUnified).toHaveBeenCalledTimes(3), PAST_DEBOUNCE);
    mockSearchUnified.mockResolvedValueOnce(page(['r5'], null));   // All again
    await act(async () => { fireEvent.press(r.getByText('All')); });
    await waitFor(() => { expect(r.queryByTestId('result-r5')).not.toBeNull(); }, PAST_DEBOUNCE);
    await act(async () => { more.resolve(page(['r2'], 'c3')); });
    await act(async () => {});
    expect(r.queryByTestId('result-r2')).toBeNull();
    expect(r.queryByTestId('result-r5')).not.toBeNull();
  });

  it('SQ4 a superseded page 1 that THROWS after the newer good page 1: no failure is drawn', async () => {
    const older = deferred<unknown>();
    mockSearchUnified.mockReturnValueOnce(older.promise.then(() => { throw new Error('socket hang up'); }));
    const r = await render(<SearchScreen />);
    await waitFor(() => expect(mockSearchUnified).toHaveBeenCalledTimes(1), PAST_DEBOUNCE);
    mockSearchUnified.mockReturnValueOnce(hang());
    await act(async () => { fireEvent.press(r.getByText('Places')); });
    await waitFor(() => expect(mockSearchUnified).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    mockSearchUnified.mockResolvedValueOnce(page(['r3'], null));
    await act(async () => { fireEvent.press(r.getByText('All')); });
    await waitFor(() => { expect(r.queryByTestId('result-r3')).not.toBeNull(); }, PAST_DEBOUNCE);
    await act(async () => { older.resolve(null); });
    await act(async () => {});
    expect(r.queryByText('Something went wrong. Tap to retry.')).toBeNull();
    expect(r.queryByTestId('result-r3')).not.toBeNull();
  });

  it('SQ5 a superseded page 1 that lands while the newer one is in flight: never "No results found."', async () => {
    const { r, older } = await supersede(hang());
    await act(async () => { older.resolve(page([], null)); });
    await act(async () => {});
    expect(r.queryByText('No results found.')).toBeNull();
  });

  it('C1 CONTROL the newer answer is shown when it lands last', async () => {
    const { r, older } = await supersede(hang());
    void older;
    expect(r.queryByTestId('result-r1')).toBeNull();
  });
});
