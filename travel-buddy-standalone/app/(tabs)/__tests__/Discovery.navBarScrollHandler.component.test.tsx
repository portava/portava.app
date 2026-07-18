/**
 * Discovery (app/(tabs)/discovery.tsx) — nav-bar collapse handler wiring test.
 *
 * The scroll-architecture tests (Task #1523) verify the discoveryHeader lives
 * inside the tab's list container, but they stub useNavBarScrollHandler to a
 * no-op. This test confirms that ForYouTab (the default active tab) receives
 * the handler as its onScroll prop — so removing the wiring would fail here.
 *
 * Strategy:
 *   1. Mock useNavBarScrollHandler to return a jest.fn() spy.
 *   2. Stub ForYouTab to capture the onScroll prop it receives.
 *   3. After render, assert that the captured onScroll is the spy — confirming
 *      the screen passes the collapse handler into the scroll container.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── Reanimated ────────────────────────────────────────────────────────────────
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View: RN.View, ScrollView: RN.ScrollView },
    useAnimatedStyle: () => ({}),
    interpolate: (_v: number, _in: number[], out: number[]) => out[0],
    useSharedValue: (v: number) => ({ value: v }),
    withSpring: (v: number) => v,
    withTiming: (v: number) => v,
  };
});

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({}),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// ── Nav-bar collapse — spy factory ────────────────────────────────────────────
// The spy is the exact value returned by useNavBarScrollHandler. Discovery
// passes it directly as onScroll to ForYouTab / DiscoveryCategoryTab, so
// identity comparison is reliable.
const mockScrollHandlerSpy = jest.fn();
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => mockScrollHandlerSpy,
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Bottom inset ──────────────────────────────────────────────────────────────
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useBottomInset: () => 130,
}));

// ── Session + location ────────────────────────────────────────────────────────
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'u1' }),
}));

jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    resolvedLocation: {
      place: { city: 'Barcelona' },
      coords: { lat: 41.38, lng: 2.17 },
      source: 'gps',
      freshness: 'live',
    },
    locationState: {
      ok: true,
      permissionStatus: 'granted',
      place: { city: 'Barcelona' },
      coords: { lat: 41.38, lng: 2.17 },
    },
    showCityPicker: false,
    openCityPicker: jest.fn(),
    closeCityPicker: jest.fn(),
    isLoading: false,
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
  }),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

jest.mock('../../../src/hooks/useFollowingHighlights', () => ({
  useFollowingHighlights: () => ({ highlights: [], loading: false }),
}));

// ── Services ──────────────────────────────────────────────────────────────────
jest.mock('../../../src/services/hashtag', () => ({
  getTrendingHashtags: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryCategoryCounts:      jest.fn().mockResolvedValue({ ok: false }),
  getDiscoveryCategoryCountsBatch: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock('../../../src/services/rentABuddy', () => ({
  getAvailableNow: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── ForYouTab stub — captures onScroll prop ───────────────────────────────────
let capturedOnScroll: ((...args: any[]) => any) | null = null;
jest.mock('../../../src/components/discovery/ForYouTab', () => ({
  ForYouTab: ({ onScroll }: { onScroll?: (...args: any[]) => any }) => {
    capturedOnScroll = onScroll ?? null;
    return null;
  },
}));

// ── Sub-components ────────────────────────────────────────────────────────────
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab',    () => ({ DiscoveryCategoryTab:    () => null }));
jest.mock('../../../src/components/discovery/PlaceDetailSheet',        () => ({ PlaceDetailSheet:        () => null }));
jest.mock('../../../src/components/discovery/DestinationBar',          () => ({ DestinationBar:          () => null }));
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',        () => ({ SubmitPlaceSheet:        () => null }));
jest.mock('../../../src/components/discovery/SectionErrorBoundary',    () => ({
  SectionErrorBoundary: ({ children }: any) => children,
}));
jest.mock('../../../src/components/compass/CompassBuddyRow',           () => ({ CompassBuddyRow:          () => null }));
jest.mock('../../../src/components/ManualCityPicker',                  () => ({ ManualCityPicker:         () => null }));
jest.mock('../../../src/components/layover/LayoverModeSheet',          () => ({ LayoverModeSheet:         () => null }));
jest.mock('../../../src/components/RouteBuilderSheet',                 () => ({ RouteBuilderSheet:        () => null }));
jest.mock('../../../src/components/FollowingHighlightsStrip',          () => ({ FollowingHighlightsStrip: () => null }));
jest.mock('../../../src/components/PlanPickerController',              () => ({
  usePlanPicker: () => ({ open: jest.fn(), close: jest.fn(), PlanPickerSheet: () => null }),
}));

import DiscoveryHub from '../discovery.tsx';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Discovery screen — nav-bar scroll handler wiring', () => {
  beforeEach(() => {
    capturedOnScroll = null;
    mockScrollHandlerSpy.mockClear();
  });

  it('ForYouTab receives the useNavBarScrollHandler result as its onScroll prop', async () => {
    await render(<DiscoveryHub />);
    await act(async () => {});

    // The handler must be passed through — not dropped or replaced with undefined.
    expect(capturedOnScroll).toBe(mockScrollHandlerSpy);
  });

  it('calling the captured onScroll invokes the collapse handler', async () => {
    await render(<DiscoveryHub />);
    await act(async () => {});

    expect(capturedOnScroll).not.toBeNull();
    capturedOnScroll!({ nativeEvent: { contentOffset: { y: 80 } } } as any);
    expect(mockScrollHandlerSpy).toHaveBeenCalledTimes(1);
  });
});
