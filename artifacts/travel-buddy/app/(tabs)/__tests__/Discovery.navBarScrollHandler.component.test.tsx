/**
 * Discovery (app/(tabs)/discovery.tsx) — nav-bar collapse handler wiring test.
 *
 * The scroll-architecture tests (Task #1523) verify the discoveryHeader lives
 * inside the tab's list container, but they stub useNavBarScrollHandler to a
 * no-op. This test confirms that:
 *   - ForYouTab (the default active tab) receives the handler as its onScroll prop.
 *   - DiscoveryCategoryTab (all non-ForYou tabs) also receives the same handler —
 *     so removing the wiring from either branch would fail here.
 *
 * Strategy:
 *   1. Mock useNavBarScrollHandler to return a jest.fn() spy.
 *   2. Stub ForYouTab and DiscoveryCategoryTab to each capture the onScroll prop.
 *   3. After render, assert that the captured onScroll is the spy — confirming
 *      the screen passes the collapse handler into the scroll container.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
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
// mockSearchParams is mutable so individual test suites can set the active
// category without needing a separate module mock per describe block.
let mockSearchParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => mockSearchParams,
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
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => mockScrollHandlerSpy,
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Bottom inset ──────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useBottomInset: () => 130,
}));

// ── Session + location ────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'u1' }),
}));

// NOTE: intentional stub — not under test here.
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
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useFollowingHighlights', () => ({
  useFollowingHighlights: () => ({ highlights: [], loading: false }),
}));

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/hashtag', () => ({
  getTrendingHashtags: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryCategoryCounts:      jest.fn().mockResolvedValue({ ok: false }),
  getDiscoveryCategoryCountsBatch: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getAvailableNow: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── ForYouTab stub — captures onScroll prop ───────────────────────────────────
let capturedOnScroll: ((...args: any[]) => any) | null = null;
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/ForYouTab', () => ({
  ForYouTab: ({ onScroll }: { onScroll?: (...args: any[]) => any }) => {
    capturedOnScroll = onScroll ?? null;
    return null;
  },
}));

// ── DiscoveryCategoryTab stub — captures onScroll prop ────────────────────────
// Discovery renders DiscoveryCategoryTab for every non-ForYou tab with
// onScroll={navScrollHandler}. This stub captures what is actually passed so
// tests can assert identity against the spy.
let capturedCategoryOnScroll: ((...args: any[]) => any) | null = null;
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab', () => ({
  DiscoveryCategoryTab: ({ onScroll }: { onScroll?: (...args: any[]) => any }) => {
    capturedCategoryOnScroll = onScroll ?? null;
    return null;
  },
}));

// ── Sub-components ────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/PlaceDetailSheet',        () => ({ PlaceDetailSheet:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DestinationBar',          () => ({ DestinationBar:          () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',        () => ({ SubmitPlaceSheet:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SectionErrorBoundary',    () => ({
  SectionErrorBoundary: ({ children }: any) => children,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow',           () => ({ CompassBuddyRow:          () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',                  () => ({ ManualCityPicker:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet',          () => ({ LayoverModeSheet:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RouteBuilderSheet',                 () => ({ RouteBuilderSheet:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/FollowingHighlightsStrip',          () => ({ FollowingHighlightsStrip: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PlanPickerController',              () => ({
  usePlanPicker: () => ({ open: jest.fn(), close: jest.fn(), PlanPickerSheet: () => null }),
}));

import DiscoveryHub from '../discovery.tsx';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Discovery screen — nav-bar scroll handler wiring (ForYouTab)', () => {
  beforeEach(() => {
    mockSearchParams = {}; // default tab: for_you
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

// ── DiscoveryCategoryTab wiring ───────────────────────────────────────────────
// Switching to any non-ForYou tab causes Discovery to render DiscoveryCategoryTab
// instead of ForYouTab. This suite confirms the collapse handler is also wired
// there — catching any accidental removal of onScroll={navScrollHandler} from
// the DiscoveryCategoryTab branch.

describe('Discovery screen — nav-bar scroll handler wiring (DiscoveryCategoryTab)', () => {
  beforeEach(() => {
    // Start on the 'places' tab so Discovery renders DiscoveryCategoryTab, not ForYouTab.
    mockSearchParams = { category: 'places' };
    capturedCategoryOnScroll = null;
    mockScrollHandlerSpy.mockClear();
  });

  it('DiscoveryCategoryTab receives the useNavBarScrollHandler result as its onScroll prop', async () => {
    await render(<DiscoveryHub />);
    await act(async () => {});

    // The same collapse handler must reach DiscoveryCategoryTab — identity check.
    expect(capturedCategoryOnScroll).toBe(mockScrollHandlerSpy);
  });

  it('calling the captured DiscoveryCategoryTab onScroll invokes the collapse handler', async () => {
    await render(<DiscoveryHub />);
    await act(async () => {});

    expect(capturedCategoryOnScroll).not.toBeNull();
    capturedCategoryOnScroll!({ nativeEvent: { contentOffset: { y: 120 } } } as any);
    expect(mockScrollHandlerSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Parametrized: handler reaches every non-ForYou tab ────────────────────────
// Iterates over several TABS entries (places, events, beaches, nightlife) to
// confirm that onScroll={navScrollHandler} is wired regardless of which
// category is active. A per-category rendering branch that accidentally drops
// the prop for some tabs would fail here.

const NON_FOR_YOU_CATEGORIES = ['places', 'events', 'beaches', 'nightlife'] as const;

describe.each(NON_FOR_YOU_CATEGORIES)(
  'Discovery screen — collapse handler reaches DiscoveryCategoryTab (category=%s)',
  (category) => {
    beforeEach(() => {
      mockSearchParams = { category };
      capturedCategoryOnScroll = null;
      mockScrollHandlerSpy.mockClear();
    });

    it(`[${category}] DiscoveryCategoryTab receives the collapse handler as onScroll`, async () => {
      await render(<DiscoveryHub />);
      await act(async () => {});

      expect(capturedCategoryOnScroll).toBe(mockScrollHandlerSpy);
    });

    it(`[${category}] invoking the captured onScroll calls the collapse handler`, async () => {
      await render(<DiscoveryHub />);
      await act(async () => {});

      expect(capturedCategoryOnScroll).not.toBeNull();
      capturedCategoryOnScroll!({ nativeEvent: { contentOffset: { y: 80 } } } as any);
      expect(mockScrollHandlerSpy).toHaveBeenCalledTimes(1);
    });
  },
);
