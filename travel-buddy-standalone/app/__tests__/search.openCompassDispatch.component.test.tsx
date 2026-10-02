/**
 * §43 `open_compass` — the action the server emits and every client dropped
 * (census G305).
 *
 * The row's own words: "Produced (`semanticIntent.ts:259`) and then dropped by
 * every client surface: `search/smartActions.ts:35-43` excludes it from
 * DISPATCHABLE_ACTION_TYPES because it has 'no dispatch target in the global
 * search bar today', and the grouped-row bridge skips it too. A server-emitted
 * action that no client can act on."
 *
 * This test drives the WHOLE path with only the network stubbed: a suggest
 * response carrying an `open_compass` row goes through the real
 * `useInputAssistance` hook, the real `useGlobalSearchSuggestions` bridge, the
 * real `extractActionSuggestions` lift, and the real `handleSuggestionAction`
 * dispatcher in `app/search.tsx`. The only stand-in is the panel, which is
 * already mocked out in every search-screen suite for native-module reasons —
 * and it is given the minimum that makes the action lane observable: a button
 * per action row that calls the screen's own `onPickAction`.
 *
 * WHY EACH ASSERTION CAN FAIL:
 *   - remove 'open_compass' from DISPATCHABLE_ACTION_TYPES → the lift never
 *     happens, the panel receives no action rows, the button is not rendered
 *     and "dispatches to Compass" goes red at the query.
 *   - delete the `getOpenCompassTarget` branch in handleSuggestionAction → the
 *     button renders, the press is a no-op and the router assertion goes red.
 *   - hand Compass `s.label` instead of `s.replacementText` → "the user's own
 *     words" goes red.
 *
 * The CONTROL case is the other half: an `add_to_trip` row must still NOT route
 * to Compass, so the branch cannot pass by routing everything there.
 *
 * Harness copied from search.refusal.component.test.tsx.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
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
// avatar, and map components that require native modules.
// NOTE: intentionally exhaustive — SearchSuggestionsPanel pulls in icon,
// avatar, and map components that require native modules. This stand-in keeps
// the ACTION LANE observable: one button per action row, wired to the screen's
// own onPickAction, so the dispatcher under test is the real one.
jest.mock('../../src/components/search/SearchSuggestionsPanel', () => {
  const React = require('react');
  const { View, Pressable, Text } = require('react-native');
  return {
    SearchSuggestionsPanel: ({ actionSuggestions, onPickAction }: any) =>
      React.createElement(
        View,
        { testID: 'suggestions-panel' },
        ((actionSuggestions ?? []) as any[]).map((s) =>
          React.createElement(
            Pressable,
            { key: s.id, testID: `action-${s.id}`, onPress: () => onPickAction?.(s) },
            React.createElement(Text, null, s.label),
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
const mockRouterPush = (jest.requireMock('expo-router') as any).router.push as jest.Mock;

function compassRow(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: 'global_search:semantic:compass',
    type: 'ai_suggestion',
    context: 'global_search',
    label: 'rooftop bars · near your hotel · tonight',
    replacementText: 'rooftop bars near my hotel tonight',
    action: { type: 'open_compass', context: { category: 'bars' } },
    source: 'ai',
    confidence: 0.8,
    policyVersion: 'input-2026-08',
    ...over,
  } as InputSuggestion;
}

const PAST_DEBOUNCE = { timeout: 4000 };

describe('SearchScreen — an open_compass row reaches Compass (G305)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sharedSuggestionCache.clear?.();
    mockSearchUnified.mockResolvedValue({
      ok: true,
      data: { results: [], nextCursor: null, timeLabel: null },
    });
  });

  it('lifts the row into the action lane and dispatches it to Compass', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      suggestions: [compassRow()],
      requestId: 'req-1',
      policyVersion: 'input-2026-08',
    });

    const r = await render(<SearchScreen />);
    // The suggest lane only runs while the user is TYPING (not after submit),
    // which is the state this row exists for.
    fireEvent.changeText(
      r.getByPlaceholderText('Search travelers, trips, events, places…'),
      'rooftop bars near my hotel tonight',
    );
    const btn = await r.findByTestId(
      'action-global_search:semantic:compass',
      undefined,
      PAST_DEBOUNCE,
    );
    fireEvent.press(btn);

    expect(mockRouterPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(tabs)/ai',
        params: { prefillMessage: 'rooftop bars near my hotel tonight' },
      }),
    );
  });

  it('CONTROL: an add_to_trip row does NOT route to Compass', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      suggestions: [
        compassRow({
          id: 'a1',
          type: 'action',
          label: 'Add Bangkok to your trip',
          replacementText: undefined,
          action: { type: 'add_to_trip', entityId: 'city_bkk' },
          structuredValue: { kind: 'add_to_trip', entityId: 'city_bkk', city: 'Bangkok' },
        }),
      ],
      requestId: 'req-2',
      policyVersion: 'input-2026-08',
    });

    const r = await render(<SearchScreen />);
    fireEvent.changeText(
      r.getByPlaceholderText('Search travelers, trips, events, places…'),
      'add Bangkok to my trip',
    );
    const btn = await r.findByTestId('action-a1', undefined, PAST_DEBOUNCE);
    fireEvent.press(btn);

    expect(mockRouterPush).not.toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/(tabs)/ai' }),
    );
  });
});
