/**
 * PR-D2-11 (lead ruling 2026-10-08, census G82) — an 'experience' suggestion is a
 * category + time scoped-search row under an 'Experiences' label, on the mounted
 * search bar (`app/search.tsx`).
 *
 * The WHOLE client path with only the network stubbed (harness copied from
 * search.openOnMapDispatch.component.test.tsx): the real gateway hook, the real
 * grouped-row bridge (`globalSearch.ts#mapSuggestionsToGroups`) and the screen's
 * real pick handler. The mixed answer carries the five sections the census row
 * names — PLACES / EXPERIENCES / PEOPLE / HIDDEN GEMS / SEARCH FOR — and tapping
 * the experience submits the scoped search: category AND time.
 *
 * The server half (the row is produced, and the search route's own time parser
 * reads its time back) is inputAssistanceSemanticIntent.test.ts, "PR-D2-11".
 *
 * MUTATION LOG (each alone, run red, restored byte-for-byte):
 *   X1 globalSearch.ts: never treat a row as an experience → it lands under
 *      "Search for" → test 1 red.
 *   X2 globalSearch.ts: an experience row without its submitQuery → the tap
 *      routes nowhere / submits the typed text → test 1 red at the search call.
 */

import React from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
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
    useLocalSearchParams: () => ({}),
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
// avatar, and map components that require native modules. This stand-in keeps
// the GROUPED LANE observable: one header per group (its label), one button per
// row, wired to the screen's own onPickResult, so the pick handler is the real one.
jest.mock('../../src/components/search/SearchSuggestionsPanel', () => {
  const React = require('react');
  const { View, Pressable, Text } = require('react-native');
  return {
    SearchSuggestionsPanel: ({ groups, onPickResult }: any) =>
      React.createElement(
        View,
        { testID: 'suggestions-panel' },
        ((groups ?? []) as any[]).map((g) =>
          React.createElement(
            View,
            { key: g.type, testID: `group-${g.type}` },
            React.createElement(Text, { testID: `group-label-${g.type}` }, g.label),
            (g.items as any[]).map((it) =>
              React.createElement(
                Pressable,
                { key: it.id, testID: `row-${it.id}`, onPress: () => onPickResult?.(it) },
                React.createElement(Text, null, it.title),
              ),
            ),
          ),
        ),
      ),
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
// NOTE: intentionally exhaustive — services/compass.ts reaches the network.
jest.mock('../../src/services/compass', () => ({
  fetchCompassRecommendations: jest.fn().mockResolvedValue({ ok: true, data: { recommendations: [] } }),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));


const mockSearchUnified = searchUnified as jest.Mock;

// NOTE: intentionally exhaustive — services/inputAssistance.ts reaches the
// network through apiToken.ts (Supabase-backed) at module load. `requestSuggestions`
// is the only export the gateway hook calls; stubbing it here leaves the hook,
// the grouped-row bridge, the smart-action lift and the screen dispatcher REAL.
jest.mock('../../src/platform/input-assistance/services/inputAssistance', () => ({
  requestSuggestions: jest.fn(),
}));

// NOTE: intentionally exhaustive — `recordSuggestionSelection` is the module's
// only export and it reaches Supabase at load.
jest.mock('../../src/platform/input-assistance/services/selectionRecorder', () => ({
  recordSuggestionSelection: jest.fn(),
}));

import { requestSuggestions } from '../../src/platform/input-assistance/services/inputAssistance';
import { sharedSuggestionCache } from '../../src/platform/input-assistance/services/suggestionCache';
import type { InputSuggestion } from '../../src/platform/input-assistance/types/inputSuggestion';

// ── SEEDED 2026-09-21 (G340) ────────────────────────────────────────────────
// `useInputAssistance` derives its policy from the context descriptor, which
// since G340 comes from `GET /input-assistance/policies` rather than a local
// table. With nothing fetched every context resolves CONSERVATIVE — mode
// `no_assistance`, an unreachable `minChars` — so the hook correctly makes no
// request and renders no rows, and every assertion below about suggestions
// would be vacuous. Seeding states the premise these tests always relied on.
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../src/platform/input-assistance/types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../src/platform/input-assistance/services/policyStore.ts';
_seedPolicy(_SEED_CONTEXTS);


const mockRequest = requestSuggestions as jest.Mock;

/** `semanticIntent.ts#buildExperienceRow` for "rooftop nightlife tonight", field for field. */
const EXPERIENCE: InputSuggestion = {
  id: 'global_search:semantic:experience', type: 'action', context: 'global_search',
  label: 'Rooftop Bar · tonight', action: { type: 'submit_search', query: 'rooftop bar tonight' },
  structuredValue: { kind: 'experience', category: 'rooftop_bar', experienceQualifiers: [], temporal: { type: 'tonight', label: 'Tonight', startsAfter: '2026-10-08T11:00:00.000Z', startsBefore: '2026-10-08T21:00:00.000Z' } },
  confidence: 0.65, source: 'local', reason: 'Experience', policyVersion: 'input-2026-08',
} as InputSuggestion;
const MIXED: InputSuggestion[] = [
  { id: 'p1', type: 'entity', context: 'global_search', label: 'Sky Bar Saigon', entityType: 'place', entityId: 'p1', destination: { route: '/place/p1', entityType: 'place', entityId: 'p1' }, source: 'canonical', policyVersion: 'input-2026-08' } as InputSuggestion,
  EXPERIENCE,
  { id: 'u1', type: 'entity', context: 'global_search', label: 'Linh Tran', entityType: 'user', entityId: 'u1', destination: { route: '/passport/linh', entityType: 'user', entityId: 'u1' }, source: 'canonical', policyVersion: 'input-2026-08' } as InputSuggestion,
  { id: 'g1', type: 'entity', context: 'global_search', label: 'Secret Garden Rooftop', entityType: 'hidden_gem', entityId: 'g1', destination: { route: '/hidden-gem/g1', entityType: 'hidden_gem', entityId: 'g1' }, source: 'canonical', policyVersion: 'input-2026-08' } as InputSuggestion,
  { id: 'global_search:completion:rooftop bars', type: 'completion', context: 'global_search', label: 'Search "rooftop bars"', replacementText: 'rooftop bars', action: { type: 'submit_search', query: 'rooftop bars' }, source: 'local', policyVersion: 'input-2026-08' } as InputSuggestion,
];

const PAST_DEBOUNCE = { timeout: 4000 };

describe('SearchScreen — an experience is a category + time scoped search under "Experiences" (G82, PR-D2-11)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sharedSuggestionCache.clear?.();
    mockSearchUnified.mockResolvedValue({ ok: true, data: { results: [], nextCursor: null, timeLabel: null } });
  });

  it('a mixed answer shows all five sections; the experience sits under Experiences and its tap runs the scoped search', async () => {
    mockRequest.mockResolvedValue({ ok: true, suggestions: MIXED, requestId: 'req-x1', policyVersion: 'input-2026-08' });
    const r = await render(<SearchScreen />);
    fireEvent.changeText(r.getByPlaceholderText('Search travelers, trips, events, places…'), 'rooftop nightlife tonight');
    const row = await r.findByTestId('row-global_search:semantic:experience', undefined, PAST_DEBOUNCE);

    const labels = ['places', 'hidden_gems', 'events', 'travelers', 'query'].map((t) => r.getByTestId(`group-label-${t}`).props.children);
    expect(labels).toEqual(['Places', 'Hidden Gems', 'Experiences', 'People', 'Search for']);
    // The experience is IN the Experiences section, and not under "Search for".
    expect(within(r.getByTestId('group-events')).getByText('Rooftop Bar · tonight')).toBeTruthy();
    expect(within(r.getByTestId('group-query')).queryByText('Rooftop Bar · tonight')).toBeNull();

    mockSearchUnified.mockClear();
    fireEvent.press(row);
    await waitFor(() => expect(mockSearchUnified).toHaveBeenCalled(), PAST_DEBOUNCE);
    expect(mockSearchUnified.mock.calls[0][0]).toBe('rooftop bar tonight');
  });

  it('CONTROL: the same row without the experience marker is an ordinary "Search for" row', async () => {
    const plain = { ...EXPERIENCE, id: 'global_search:semantic:search', structuredValue: { category: 'rooftop_bar' } } as InputSuggestion;
    mockRequest.mockResolvedValue({ ok: true, suggestions: [plain], requestId: 'req-x2', policyVersion: 'input-2026-08' });
    const r = await render(<SearchScreen />);
    fireEvent.changeText(r.getByPlaceholderText('Search travelers, trips, events, places…'), 'rooftop nightlife tonight');
    await r.findByTestId('row-global_search:semantic:search', undefined, PAST_DEBOUNCE);
    expect(r.queryByTestId('group-events')).toBeNull();
    expect(within(r.getByTestId('group-query')).getByText('Rooftop Bar · tonight')).toBeTruthy();
  });
});
