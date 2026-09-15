/**
 * SearchScreen — a REFUSED search is not a search that found nothing.
 *
 * census-discovery §18 audited the refusal envelope's consumers and recorded
 * this screen as the worst of the four it found:
 *
 *   "**Defect.** The main search screen. A `coverage: "nothing"` refusal is
 *    `ok: true, results: []`, so it renders the empty state AND fires the
 *    Compass "no results" fallback — offering alternatives to a search that
 *    never ran. The one screen `GET /discovery/search`'s envelope was built for
 *    is the one that cannot read it."
 *
 * Two harms, not one. The empty state SAYS nothing matched. The Compass
 * fallback then acts on that claim, spending a second network call and a
 * section of screen on alternatives to a question the server never answered.
 *
 * The screen already has the honest destination built: an error state with a
 * "Tap to retry" affordance, which is what it shows when the transport fails. A
 * `coverage: "nothing"` refusal IS a failure that succeeded in transport, so it
 * belongs there and not in the empty state.
 *
 * `partial` is deliberately NOT routed there: the rows it carries are real, and
 * showing them is better than refusing them.
 *
 * Harness copied from search.homeCityCoords.component.test.tsx, plus a mock for
 * services/compass so the fallback call is observable.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
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

describe('SearchScreen — a refusal is not an empty result set', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('OUTAGE: does NOT fire the Compass "no results" fallback for a search that never ran', async () => {
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: { results: [], nextCursor: null, timeLabel: null, refusal: REFUSAL_NOTHING },
    });

    render(<SearchScreen />);
    await waitFor(() => { expect(mockSearchUnified).toHaveBeenCalled(); }, PAST_DEBOUNCE);

    // Give the fallback every chance to fire before asserting it did not.
    await new Promise((r) => setTimeout(r, 400));
    expect(mockFetchCompass).not.toHaveBeenCalled();
  });

  it('OUTAGE: shows the retry affordance, not the empty state', async () => {
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: { results: [], nextCursor: null, timeLabel: null, refusal: REFUSAL_NOTHING },
    });

    const { queryByText } = await render(<SearchScreen />);
    await waitFor(() => { expect(mockSearchUnified).toHaveBeenCalled(); }, PAST_DEBOUNCE);

    // Asserted on the RETRY AFFORDANCE rather than on the message wording: the
    // message is prose and will be rewritten, the affordance is the behaviour.
    await waitFor(() => { expect(queryByText('Tap to retry')).not.toBeNull(); }, PAST_DEBOUNCE);
  });

  it('CONTROL: a genuinely empty result STILL fires the fallback', async () => {
    // Without this, "do not fire the fallback" is satisfied by never firing it,
    // which would delete a feature rather than fix a defect.
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: { results: [], nextCursor: null, timeLabel: null },
    });

    render(<SearchScreen />);
    await waitFor(() => { expect(mockFetchCompass).toHaveBeenCalled(); }, PAST_DEBOUNCE);
  });

  // ── The partial that carries NO rows ───────────────────────────────────────
  //
  // Until `GET /discovery/search?type=all` learned to refuse, this state could
  // not occur: the fan-out collapsed every failed bucket to `[]` and answered
  // with no refusal at all. Now that a partial CAN arrive with an empty page —
  // 16 sources read and genuinely matching nothing, one unreadable — the screen
  // must not close the gap with a claim the server did not make.
  //
  // "No results found. / Nothing matched «q»." is exactly that claim. The rows
  // that were read are trustworthy; the ones behind `failedSources` are not
  // absent, they are unknown, and the difference is the whole point of the
  // envelope. The Compass fallback is left firing on purpose: it OFFERS
  // alternatives, it does not assert an absence, and suppressing it here would
  // delete a feature rather than fix a claim.
  it('OUTAGE with no rows: a PARTIAL refusal does not claim that nothing matched', async () => {
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: {
        results: [], nextCursor: null, timeLabel: null,
        refusal: { ...REFUSAL_NOTHING, code: 'search_sources_unreadable', coverage: 'partial', failedSources: ['plans'] },
      },
    });

    const { queryByText } = await render(<SearchScreen />);
    await waitFor(() => { expect(mockSearchUnified).toHaveBeenCalled(); }, PAST_DEBOUNCE);

    await waitFor(() => {
      expect(queryByText('Some of this search could not run.')).not.toBeNull();
    }, PAST_DEBOUNCE);
    expect(queryByText('No results found.')).toBeNull();
  });

  it('CONTROL: a genuinely empty result still says nothing matched', async () => {
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: { results: [], nextCursor: null, timeLabel: null },
    });

    const { queryByText } = await render(<SearchScreen />);
    await waitFor(() => { expect(queryByText('No results found.')).not.toBeNull(); }, PAST_DEBOUNCE);
    expect(queryByText('Some of this search could not run.')).toBeNull();
  });

  it('CONTROL: a PARTIAL refusal renders its real rows and fires no fallback', async () => {
    // `partial` carries real rows. It is not an outage to refuse and not an
    // empty answer to offer alternatives to.
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: {
        results: [{ id: 'r1', type: 'place', title: 'Real Place', actionState: {} }],
        nextCursor: null, timeLabel: null,
        refusal: { ...REFUSAL_NOTHING, coverage: 'partial' },
      },
    });

    const { queryByTestId } = await render(<SearchScreen />);
    await waitFor(() => { expect(queryByTestId('result-r1')).not.toBeNull(); }, PAST_DEBOUNCE);
    expect(mockFetchCompass).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PARTIAL COVERAGE THAT RETURNED ROWS
//
// The block above pins the two ends: `nothing` (retry affordance) and the
// partial that happened to carry no rows (no "nothing matched" claim). The
// middle case — a partial that DID return rows — was the one the screen could
// not express. `partialSources` was computed on every first page, then read in
// exactly one place: inside the `isEmpty` branch. With rows on screen that
// branch never runs, so a short list from a half-read index looked exactly like
// a complete answer, and the person had no way to tell the difference. That is
// the same fabrication as the empty state's, only quieter: a list implies "this
// is what there is".
//
// MapSearchSheet already solved this and is the precedent followed here: its
// NOTICE_PARTIAL line is rendered from `allPartial` alone, above the results,
// unconditionally — not folded into an empty-state branch. Wording is taken
// from it verbatim so the two search surfaces say the same thing.
// ─────────────────────────────────────────────────────────────────────────────

const NOTICE_PARTIAL = 'These results are incomplete — part of the search couldn’t be run.';

describe('SearchScreen — a partial answer says so, with or without rows', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('PARTIAL WITH ROWS: shows the incomplete notice alongside the rows it did get', async () => {
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: {
        results: [{ id: 'r1', type: 'place', title: 'Real Place', actionState: {} }],
        nextCursor: null, timeLabel: null,
        refusal: {
          ...REFUSAL_NOTHING, code: 'search_sources_unreadable',
          coverage: 'partial', failedSources: ['plans'],
        },
      },
    });

    const { queryByTestId, queryByText } = await render(<SearchScreen />);
    await waitFor(() => { expect(queryByTestId('result-r1')).not.toBeNull(); }, PAST_DEBOUNCE);
    // The rows are real and stay. The notice is what was missing.
    await waitFor(() => { expect(queryByText(NOTICE_PARTIAL)).not.toBeNull(); }, PAST_DEBOUNCE);
  });

  it('CONTROL: a COMPLETE search with rows shows no such notice', async () => {
    // Without this, the notice could be shown on every search and the assertion
    // above would still pass — which would make it meaningless.
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: {
        results: [{ id: 'r1', type: 'place', title: 'Real Place', actionState: {} }],
        nextCursor: null, timeLabel: null,
      },
    });

    const { queryByTestId, queryByText } = await render(<SearchScreen />);
    await waitFor(() => { expect(queryByTestId('result-r1')).not.toBeNull(); }, PAST_DEBOUNCE);
    expect(queryByText(NOTICE_PARTIAL)).toBeNull();
  });

  it('PARTIAL WITH NO ROWS: the notice is there too — coverage, not row count, decides', async () => {
    // Same fact, other branch. The empty state's own wording still applies (the
    // case above asserts it); this pins that the notice itself is driven by
    // coverage and not by whether the list happened to come back empty.
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: {
        results: [], nextCursor: null, timeLabel: null,
        refusal: {
          ...REFUSAL_NOTHING, code: 'search_sources_unreadable',
          coverage: 'partial', failedSources: ['plans'],
        },
      },
    });

    const { queryByText } = await render(<SearchScreen />);
    await waitFor(() => { expect(queryByText(NOTICE_PARTIAL)).not.toBeNull(); }, PAST_DEBOUNCE);
  });

  it('CONTROL: a coverage:"nothing" refusal keeps the retry state and does not show the partial notice', async () => {
    // "Nothing was searched" and "part of the search failed" are different
    // facts. The first already has its own destination; the partial notice must
    // not leak into it and soften it into "some results are missing".
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: { results: [], nextCursor: null, timeLabel: null, refusal: REFUSAL_NOTHING },
    });

    const { queryByText } = await render(<SearchScreen />);
    await waitFor(() => { expect(queryByText('Tap to retry')).not.toBeNull(); }, PAST_DEBOUNCE);
    expect(queryByText(NOTICE_PARTIAL)).toBeNull();
  });
});
