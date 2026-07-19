/**
 * DiscoveryHub — Map shortcut button params
 *
 * Confirms the Map shortcut Pressable in the tabRow calls router.push with:
 *   - pathname: '/map'
 *   - params.lat / params.lng when coords are available
 *   - params.title set to the current destination city
 *   - params.category matching the active tab
 *
 * Also confirms the button is disabled (router.push NOT called) when no
 * destination is set — so the full-screen map never opens blank.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';

// ── expo-router ───────────────────────────────────────────────────────────────
// Override the moduleNameMapper entry so we can capture the router.push spy.
// react-native Proxy mock — DiscoveryHub mounts a raw <Modal> (age filter).
// Modal's animation lifecycle leaves a floating async act() scope inside
// RNTL's render() promise; the next act() collides with it, corrupting the
// act-scope depth so every later render in this file commits an EMPTY tree.
// Stubbing Modal as a plain conditional View keeps the lifecycle synchronous.
// ActivityIndicator must be stubbed too: through the Proxy its getter re-enters
// with `this === Proxy` and can hit uninitialised native-module stubs.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: {
    push:     jest.fn(),
    replace:  jest.fn(),
    back:     jest.fn(),
    navigate: jest.fn(),
    dismiss:  jest.fn(),
  },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname:          () => '/',
  useSegments:          () => [],
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
  useNavigation: () => ({
    navigate:    jest.fn(),
    goBack:      jest.fn(),
    setOptions:  jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link:     ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
  Stack:    { Screen: () => null },
  Tabs:     { Screen: () => null },
}));

// ── react-native-safe-area-context ────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — all import Supabase; requireActual OOMs.
jest.mock('../../../src/services/hashtag', () => ({
  getTrendingHashtags: jest.fn().mockResolvedValue({ ok: true, data: { trending: [] } }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryCategoryCounts:      jest.fn().mockResolvedValue({}),
  getDiscoveryCategoryCountsBatch: jest.fn().mockResolvedValue({}),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue([]),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getAvailableNow: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — accesses native scroll metrics / Reanimated.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  navBarProgress:         { value: 0 },
  NAV_BAR_FILLER_HEIGHT:  96,
}));

// NOTE: intentionally exhaustive — depends on native inset calculations.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => 130,
}));

// NOTE: intentionally exhaustive — calls Supabase subscriptions.
jest.mock('../../../src/hooks/useFollowingHighlights', () => ({
  useFollowingHighlights: () => ({
    users:            [],
    sessionViewedIds: new Set<string>(),
    markSessionViewed: jest.fn(),
  }),
}));

// ── Contexts ──────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — imports Supabase + native-incompatible modules.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'user-test-1', isAuthed: true }),
}));

// Mutable so individual tests can supply different location states.
let mockLocationState: {
  place: { city: string | null; country: string | null };
  coords: { lat: number; lng: number } | null;
} = { place: { city: null, country: null }, coords: null };

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
    locationState:  mockLocationState,
    // resolvedLocation — required by discovery.tsx after location unification.
    resolvedLocation: {
      place:  mockLocationState.place,
      coords: mockLocationState.coords,
      source: 'home',
      freshness: 'unavailable',
    },
    showCityPicker: false,
    openCityPicker: jest.fn(),
    closeCityPicker: jest.fn(),
    setManualCity:  jest.fn().mockResolvedValue(undefined),
    isLoading:      false,
  }),
}));

// ── PlanPickerController ──────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn() }),
}));

// ── Heavy sub-components ──────────────────────────────────────────────────────
// Each pulls in native modules (maps, camera, Supabase) unavailable in the
// jest-expo runner. Stub as null renders to isolate the Map shortcut logic.
const Null = () => null;

// The tabs render discoveryHeader (chips, search bar, nudge, tab row) inside
// their FlatList via listHeaderComponent. Rendering it from the stub keeps the
// header UI in the test tree without pulling in the tabs' native deps.
const HeaderOnly = ({ listHeaderComponent }: { listHeaderComponent?: React.ReactElement | null }) =>
  listHeaderComponent ?? null;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet',    () => ({ LayoverModeSheet:    Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab', () => ({ DiscoveryCategoryTab: HeaderOnly }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/PlaceDetailSheet',  () => ({ PlaceDetailSheet:  Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/ForYouTab',         () => ({ ForYouTab:         HeaderOnly }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DestinationBar',    () => ({ DestinationBar:    Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow',     () => ({ CompassBuddyRow:   Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',            () => ({ ManualCityPicker:  Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/FollowingHighlightsStrip',    () => ({ FollowingHighlightsStrip: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RouteBuilderSheet',           () => ({ RouteBuilderSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',  () => ({ SubmitPlaceSheet:  Null }));

// SectionErrorBoundary must pass children through so nested content renders.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SectionErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

// ── Typed spy reference ───────────────────────────────────────────────────────
// Capture router.push after jest.mock hoisting completes.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockRouterPush = require('expo-router').router.push as jest.Mock;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryHub — Map shortcut', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLocationState = { place: { city: null, country: null }, coords: null };
  });

  // Single consolidated test on ONE instance: this renderer (React 19 +
  // RNTL v14) only reliably dispatches presses on the first instance per
  // file.  The geocode / coords-null / disabled scenarios (which need
  // different pre-mount location states) live in
  // discovery.mapShortcutGeocode.component.test.tsx.
  it('forwards title, coords, zoom, and the active tab as category', async () => {
    mockLocationState = {
      place:  { city: 'Paris', country: 'France' },
      coords: { lat: 48.8566, lng: 2.3522 },
    };

    const view = await render(<DiscoveryHub />);
    await act(async () => {});

    fireEvent.press(view.getByText('Map'));

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    const call = mockRouterPush.mock.calls[0][0] as {
      pathname: string;
      params: Record<string, string | undefined>;
    };
    expect(call.pathname).toBe('/map');
    // City name is forwarded as title
    expect(call.params.title).toBe('Paris');
    // Coordinates are stringified
    expect(call.params.lat).toBe('48.8566');
    expect(call.params.lng).toBe('2.3522');
    // City-level zoom is forwarded (default 11 — geocode effect skipped because coords already set)
    expect(call.params.zoom).toBe('11');
    // Default active tab
    expect(call.params.category).toBe('for_you');

    // Switch to the Food tab, then hit the Map shortcut again — the active
    // tab must be forwarded as category.
    fireEvent.press(view.getByText('Food'));
    await act(async () => {});

    fireEvent.press(view.getByText('Map'));

    const lastCall = mockRouterPush.mock.calls[mockRouterPush.mock.calls.length - 1][0] as {
      pathname: string;
      params: Record<string, string | undefined>;
    };
    expect(lastCall.pathname).toBe('/map');
    expect(lastCall.params.category).toBe('food');
  });
});
