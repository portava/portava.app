/**
 * §21 Trip actions in the search bar (census G135): "invite @maya to my trip"
 * and "reorder my trip" arrive as `trip_action` rows; the REAL dispatcher in
 * app/search.tsx opens a picker of the person's OWN open Trips, and the write is
 * the existing authorised endpoint's (POST /trips/:id/invite via sendTripInvite;
 * reorder lands on the Trip's edit screen). Only the network is stubbed.
 *
 * Harness copied from search.openCompassDispatch.component.test.tsx.
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


// NOTE: intentionally exhaustive — trips.ts / friends.ts reach Supabase at load; the sheets call exactly these.
jest.mock('../../src/services/trips', () => ({
  listMyTrips: jest.fn(),
}));
jest.mock('../../src/services/friends', () => ({
  sendTripInvite: jest.fn(),
}));
import { listMyTrips } from '../../src/services/trips';
import { sendTripInvite } from '../../src/services/friends';

const TRIPS = [
  { id: 'trip-mine', title: 'Central Vietnam', ownerId: 'user-1', status: 'upcoming', destinationCity: 'Hue', destinationCountry: 'Vietnam', startDate: null, endDate: null },
  { id: 'trip-theirs', title: 'Not mine', ownerId: 'user-2', status: 'upcoming', destinationCity: null, destinationCountry: null, startDate: null, endDate: null },
];

function tripRow(action: any, label: string, structuredValue: any = {}): InputSuggestion {
  return { id: `ta-${action.action}`, type: 'action', context: 'global_search', label, action, structuredValue, source: 'canonical', confidence: 0.9, policyVersion: 'input-2026-08' } as InputSuggestion;
}

async function typeAndTap(r: any, text: string, id: string) {
  fireEvent.changeText(r.getByPlaceholderText('Search travelers, trips, events, places…'), text);
  const btn = await r.findByTestId(`action-${id}`, undefined, { timeout: 4000 });
  fireEvent.press(btn);
}

describe('SearchScreen — §21 Trip actions (G135)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sharedSuggestionCache.clear?.();
    mockSearchUnified.mockResolvedValue({ ok: true, data: { results: [], nextCursor: null, timeLabel: null } });
    (listMyTrips as jest.Mock).mockResolvedValue(TRIPS);
    (sendTripInvite as jest.Mock).mockResolvedValue({ ok: true, data: { status: 'invited' } });
  });

  it('TA1. invite Crew: the picker lists only the viewer\'s own Trips, and Invite calls the existing invite endpoint for THAT trip and person', async () => {
    mockRequest.mockResolvedValue({ ok: true, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [
      tripRow({ type: 'trip_action', action: 'invite_crew', entityType: 'user', entityId: 'user-maya' }, 'Invite @maya to one of your Trips', { kind: 'trip_action', action: 'invite_crew', handle: 'maya' }),
    ] });
    const r = await render(<SearchScreen />);
    await typeAndTap(r, 'invite @maya to my trip', 'ta-invite_crew');
    await r.findByTestId('trip-invite-row-trip-mine', undefined, { timeout: 4000 });
    expect(r.queryByTestId('trip-invite-row-trip-theirs')).toBeNull();
    expect(sendTripInvite).not.toHaveBeenCalled();
    fireEvent.press(r.getByTestId('trip-invite-btn-trip-mine'));
    await r.findByText('Invited', undefined, { timeout: 4000 });
    expect(sendTripInvite).toHaveBeenCalledWith('trip-mine', 'user-maya');
  });

  it('TA2. reorder plan: picking a Trip opens ITS edit screen; nothing is written', async () => {
    mockRequest.mockResolvedValue({ ok: true, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [
      tripRow({ type: 'trip_action', action: 'reorder_plan' }, 'Reorder the stops on one of your Trips'),
    ] });
    const r = await render(<SearchScreen />);
    await typeAndTap(r, 'reorder my trip', 'ta-reorder_plan');
    fireEvent.press(await r.findByTestId('trip-reorder-row-trip-mine', undefined, { timeout: 4000 }));
    expect(mockRouterPush).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/trip/edit', params: { id: 'trip-mine' } }));
    expect(sendTripInvite).not.toHaveBeenCalled();
  });

  it('TA3. a malformed trip_action (no user) is no chip at all', async () => {
    mockRequest.mockResolvedValue({ ok: true, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [
      tripRow({ type: 'trip_action', action: 'invite_crew' }, 'Invite someone'),
    ] });
    const r = await render(<SearchScreen />);
    fireEvent.changeText(r.getByPlaceholderText('Search travelers, trips, events, places…'), 'invite @x to my trip');
    await new Promise((res) => setTimeout(res, 800));
    expect(mockRequest).toHaveBeenCalled(); // premise: the row WAS served
    expect(r.queryByTestId('action-ta-invite_crew')).toBeNull();
  });
});
