/**
 * DiscoveryHub — Map shortcut button params
 *
 * Confirms the Map shortcut Pressable in the tabRow calls router.push with:
 *   - pathname: '/map'
 *   - params.lat / params.lng when coords are available
 *   - params.title set to the current destination city
 *   - params.category matching the active tab
 *
 * Also confirms the button still navigates (with a degraded params set)
 * when coords are null — so the full-screen map never opens blank due to
 * a missing guard.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';

// ── expo-router ───────────────────────────────────────────────────────────────
// Override the moduleNameMapper entry so we can capture the router.push spy.
jest.mock('expo-router', () => ({
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
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — all import Supabase; requireActual OOMs.
jest.mock('../../../src/services/hashtag', () => ({
  getTrendingHashtags: jest.fn().mockResolvedValue({ ok: true, data: { trending: [] } }),
}));

jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryCategoryCounts:      jest.fn().mockResolvedValue({}),
  getDiscoveryCategoryCountsBatch: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue([]),
}));

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

jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState:  mockLocationState,
    showCityPicker: false,
    openCityPicker: jest.fn(),
    closeCityPicker: jest.fn(),
    setManualCity:  jest.fn().mockResolvedValue(undefined),
    isLoading:      false,
  }),
}));

// ── PlanPickerController ──────────────────────────────────────────────────────
jest.mock('../../../src/components/PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn() }),
}));

// ── Heavy sub-components ──────────────────────────────────────────────────────
// Each pulls in native modules (maps, camera, Supabase) unavailable in the
// jest-expo runner. Stub as null renders to isolate the Map shortcut logic.
const Null = () => null;

jest.mock('../../../src/components/layover/LayoverModeSheet',    () => ({ LayoverModeSheet:    Null }));
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab', () => ({ DiscoveryCategoryTab: Null }));
jest.mock('../../../src/components/discovery/PlaceDetailSheet',  () => ({ PlaceDetailSheet:  Null }));
jest.mock('../../../src/components/discovery/ForYouTab',         () => ({ ForYouTab:         Null }));
jest.mock('../../../src/components/discovery/DestinationBar',    () => ({ DestinationBar:    Null }));
jest.mock('../../../src/components/compass/CompassBuddyRow',     () => ({ CompassBuddyRow:   Null }));
jest.mock('../../../src/components/ManualCityPicker',            () => ({ ManualCityPicker:  Null }));
jest.mock('../../../src/components/FollowingHighlightsStrip',    () => ({ FollowingHighlightsStrip: Null }));
jest.mock('../../../src/components/RouteBuilderSheet',           () => ({ RouteBuilderSheet: Null }));
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',  () => ({ SubmitPlaceSheet:  Null }));

// SectionErrorBoundary must pass children through so nested content renders.
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
    // Reset location state; each test sets what it needs.
    mockLocationState = { place: { city: null, country: null }, coords: null };
  });

  it('passes lat, lng, title, and category when destination and coords are set', async () => {
    mockLocationState = {
      place:  { city: 'Paris', country: 'France' },
      coords: { lat: 48.8566, lng: 2.3522 },
    };

    const { unmount } = await render(<DiscoveryHub />);
    await act(async () => {});

    fireEvent.press(screen.getByText('Map'));

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
    // Default active tab
    expect(call.params.category).toBe('for_you');

    await act(async () => { unmount(); });
  });

  it('still navigates when coords are null — title and category present, lat/lng absent', async () => {
    mockLocationState = {
      place:  { city: 'Tokyo', country: 'Japan' },
      coords: null,
    };

    const { unmount } = await render(<DiscoveryHub />);
    await act(async () => {});

    fireEvent.press(screen.getByText('Map'));

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    const call = mockRouterPush.mock.calls[0][0] as {
      pathname: string;
      params: Record<string, string | undefined>;
    };
    expect(call.pathname).toBe('/map');
    // City and category are still forwarded
    expect(call.params.title).toBe('Tokyo');
    expect(call.params.category).toBe('for_you');
    // Lat/lng must be absent — not set to 'null' or 'undefined'
    expect(call.params.lat).toBeUndefined();
    expect(call.params.lng).toBeUndefined();

    await act(async () => { unmount(); });
  });

  it('forwards the active tab as category when the user has switched tabs', async () => {
    mockLocationState = {
      place:  { city: 'London', country: 'UK' },
      coords: { lat: 51.5074, lng: -0.1278 },
    };

    const { unmount } = await render(<DiscoveryHub />);
    await act(async () => {});

    // Switch to the Food tab
    fireEvent.press(screen.getByText('Food'));
    await act(async () => {});

    fireEvent.press(screen.getByText('Map'));

    // router.push may have been called once for the search bar or similar —
    // check the LAST call, which is from the Map shortcut.
    const lastCall = mockRouterPush.mock.calls[mockRouterPush.mock.calls.length - 1][0] as {
      pathname: string;
      params: Record<string, string | undefined>;
    };
    expect(lastCall.pathname).toBe('/map');
    expect(lastCall.params.category).toBe('food');

    await act(async () => { unmount(); });
  });
});
