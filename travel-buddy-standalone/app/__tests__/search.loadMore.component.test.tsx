/**
 * SearchScreen — a cursor page (page 2 and later) states its coverage, as page
 * 1 does (census-discovery §101, lane W11-X2 round 5; DV-83, §100.11 finding 1
 * and §100.10; register D-W11X2-28, D-W11X2-30).
 *
 * §100.11's verifier found `app/search.tsx`'s cursor arm appending a `partial`
 * page 2 as if complete: the incomplete notice was set on page 1 only. A
 * page-2 `nothing` refusal and a page-2 transport failure were silent too — the
 * cursor was kept, so no end was claimed, but nothing said the rest of the list
 * could not be read. Page 1 states all three; the cursor pages now do too.
 *
 *   SP1  page 1 complete, page 2 PARTIAL: the incomplete notice appears (the verifier's probe, unchanged)
 *   SP2  page 2 REFUSED (`nothing`): the "couldn't load more" line, page 1's rows kept
 *   SP3  page 2 transport failure (ok:false): the same line, rows kept
 *   SP4  page 2 THROWN read: the same line
 *   SP5  tapping the line asks again with the SAME cursor, and a good answer clears it
 *   SP6  a new page-1 search starts clean: the previous query's load-more failure is not carried
 *   C1   CONTROL: page 2 complete: no notice, no failure line
 *   C2   CONTROL: page 1 PARTIAL, page 2 complete: the notice stays (the set is still incomplete)
 *
 * Harness copied from the §100.11 verifier's probe (itself from
 * search.refusal.component.test.tsx).
 *
 * Run with: npx jest app/__tests__/search.loadMore.component.test.tsx
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

describe('SearchScreen — a cursor page states its coverage (DV-83, §101)', () => {
  // mockReset, not clearAllMocks: a queued once-value must not leak into the next case.
  // Any call a case did not queue hangs rather than answering for it.
  beforeEach(() => { mockSearchUnified.mockReset(); mockSearchUnified.mockReturnValue(new Promise(() => {})); });
  afterEach(() => { jest.clearAllMocks(); });

  it('SP1 page 1 complete, page 2 PARTIAL: the incomplete notice must appear', async () => {
    mockSearchUnified
      .mockResolvedValueOnce({ ok: true, data: { results: [{ id: 'r1', type: 'place', title: 'One', actionState: {} }], nextCursor: 'c2', timeLabel: null } })
      .mockResolvedValueOnce({ ok: true, data: { results: [{ id: 'r2', type: 'place', title: 'Two', actionState: {} }], nextCursor: null, timeLabel: null,
        refusal: { ...REFUSAL_NOTHING, code: 'search_sources_unreadable', coverage: 'partial', failedSources: ['plans'] } } });
    const r = await render(<SearchScreen />);
    await waitFor(() => { expect(r.queryByTestId('result-r1')).not.toBeNull(); }, PAST_DEBOUNCE);
    expect(r.queryByText(NOTICE_PARTIAL)).toBeNull();
    await act(async () => { fireEvent(r.getByTestId('result-r1'), 'onEndReached', { distanceFromEnd: 0 }); });
    await waitFor(() => { expect(r.queryByTestId('result-r2')).not.toBeNull(); }, PAST_DEBOUNCE);
    expect(mockSearchUnified.mock.calls[1][2]).toBe('c2');
    expect(r.queryByText(NOTICE_PARTIAL)).not.toBeNull();
  });

  it('SP2 page 2 REFUSED (`nothing`): the "couldn’t load more" line is shown, page 1’s rows kept', async () => {
    const r = await renderPage1(page(['r1'], 'c2'));
    mockSearchUnified.mockResolvedValueOnce(page([], null, REFUSAL_NOTHING));
    await loadMore(r);
    expect(mockSearchUnified.mock.calls[1][2]).toBe('c2');
    expect(r.getByTestId('search-more-failed')).toBeTruthy();
    expect(r.queryByText(MORE_FAILED)).not.toBeNull();
    expect(r.queryByTestId('result-r1')).not.toBeNull();
  });

  it('SP3 page 2 transport failure (ok:false): the same line, rows kept', async () => {
    const r = await renderPage1(page(['r1'], 'c2'));
    mockSearchUnified.mockResolvedValueOnce({ ok: false, error: 'Network error — check your connection' });
    await loadMore(r);
    expect(r.getByTestId('search-more-failed')).toBeTruthy();
    expect(r.queryByTestId('result-r1')).not.toBeNull();
  });

  it('SP4 page 2 THROWN read: the same line', async () => {
    const r = await renderPage1(page(['r1'], 'c2'));
    mockSearchUnified.mockRejectedValueOnce(new Error('boom'));
    await loadMore(r);
    expect(r.getByTestId('search-more-failed')).toBeTruthy();
    expect(r.queryByTestId('result-r1')).not.toBeNull();
  });

  it('SP5 tapping the line asks again with the SAME cursor, and a good answer clears it', async () => {
    const r = await renderPage1(page(['r1'], 'c2'));
    mockSearchUnified.mockResolvedValueOnce({ ok: false, error: 'HTTP 503' });
    await loadMore(r);
    mockSearchUnified.mockResolvedValueOnce(page(['r2'], null));
    await act(async () => { fireEvent.press(r.getByTestId('search-more-failed')); });
    await act(async () => {});
    expect(mockSearchUnified).toHaveBeenCalledTimes(3);
    expect(mockSearchUnified.mock.calls[2][2]).toBe('c2');
    expect(r.queryByTestId('result-r2')).not.toBeNull();
    expect(r.queryByTestId('search-more-failed')).toBeNull();
  });

  it('SP6 a new page-1 search starts clean: the previous load-more failure is not carried', async () => {
    const r = await renderPage1(page(['r1'], 'c2'));
    mockSearchUnified.mockResolvedValueOnce({ ok: false, error: 'HTTP 503' });
    await loadMore(r);
    expect(r.getByTestId('search-more-failed')).toBeTruthy();
    mockSearchUnified.mockResolvedValueOnce(page(['r1', 'r3'], null));
    // A tab tap re-runs page 1 for the same query.
    await act(async () => { fireEvent.press(r.getByText('Places')); });
    await waitFor(() => { expect(r.queryByTestId('result-r3')).not.toBeNull(); }, PAST_DEBOUNCE);
    expect(r.queryByTestId('search-more-failed')).toBeNull();
  });

  it('C1 CONTROL page 2 complete: no notice, no failure line', async () => {
    const r = await renderPage1(page(['r1'], 'c2'));
    mockSearchUnified.mockResolvedValueOnce(page(['r2'], null));
    await loadMore(r);
    expect(r.queryByTestId('result-r2')).not.toBeNull();
    expect(r.queryByText(NOTICE_PARTIAL)).toBeNull();
    expect(r.queryByTestId('search-more-failed')).toBeNull();
  });

  it('C2 CONTROL page 1 PARTIAL, page 2 complete: the notice stays', async () => {
    const r = await renderPage1(page(['r1'], 'c2', PARTIAL_REFUSAL));
    expect(r.queryByText(NOTICE_PARTIAL)).not.toBeNull();
    mockSearchUnified.mockResolvedValueOnce(page(['r2'], null));
    await loadMore(r);
    expect(r.queryByTestId('result-r2')).not.toBeNull();
    expect(r.queryByText(NOTICE_PARTIAL)).not.toBeNull();
  });
});
