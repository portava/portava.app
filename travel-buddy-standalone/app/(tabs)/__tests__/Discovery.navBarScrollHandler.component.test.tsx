/**
 * Discovery (app/(tabs)/discovery.tsx) — tab-routing / no-collapse architecture test.
 *
 * DIVERGENCE FROM THE MOBILE TREE (rule 13 rewrite):
 * The mobile Discovery screen wires a `useNavBarScrollHandler()` result into the
 * `onScroll` prop of ForYouTab / DiscoveryCategoryTab so the floating tab pill
 * collapses as the tab scrolls. The STANDALONE fork does NOT use that mechanism
 * — app/(tabs)/discovery.tsx does not import `useNavBarScrollHandler`, and it
 * passes NO `onScroll` prop into either tab component.
 *
 * This test therefore pins the standalone's ACTUAL contract:
 *   1. The default tab (for_you) renders ForYouTab, which receives NO onScroll.
 *   2. Any non-ForYou `category` param renders DiscoveryCategoryTab, which also
 *      receives NO onScroll — confirming there is no scroll-driven collapse in
 *      this fork regardless of which tab is active.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
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

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
// Standalone discovery.tsx does NOT import useNavBarScrollHandler; this stub is
// only defensive in case a transitive import pulls the module in.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Bottom inset ──────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => 130,
  useLayoverAwareBottomInset: () => 130,
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

// ── ForYouTab stub — captures its full props ──────────────────────────────────
let capturedForYouProps: Record<string, any> | null = null;
let forYouRendered = false;
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/ForYouTab', () => ({
  ForYouTab: (props: Record<string, any>) => {
    capturedForYouProps = props;
    forYouRendered = true;
    return null;
  },
}));

// ── DiscoveryCategoryTab stub — captures its full props ───────────────────────
let capturedCategoryProps: Record<string, any> | null = null;
let categoryRendered = false;
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab', () => ({
  DiscoveryCategoryTab: (props: Record<string, any>) => {
    capturedCategoryProps = props;
    categoryRendered = true;
    return null;
  },
  // discovery.tsx also imports FilterStrip + SORT_LABELS from this module.
  FilterStrip: () => null,
  SORT_LABELS: {},
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

describe('Discovery screen — ForYouTab has no scroll-driven collapse (standalone)', () => {
  beforeEach(() => {
    mockSearchParams = {}; // default tab: for_you
    capturedForYouProps = null;
    forYouRendered = false;
  });

  it('ForYouTab renders as the default tab and receives NO onScroll prop', async () => {
    await render(<DiscoveryHub />);
    await act(async () => {});

    expect(forYouRendered).toBe(true);
    expect(capturedForYouProps).not.toBeNull();
    // Standalone fork has no nav-bar collapse: no onScroll is wired to the tab.
    expect(capturedForYouProps!.onScroll).toBeUndefined();
  });
});

// ── DiscoveryCategoryTab routing ──────────────────────────────────────────────
// Any non-ForYou `category` param causes Discovery to render DiscoveryCategoryTab
// instead of ForYouTab. This suite confirms that branch renders and — matching
// the standalone architecture — receives NO onScroll prop.

describe('Discovery screen — DiscoveryCategoryTab has no scroll-driven collapse (standalone)', () => {
  beforeEach(() => {
    mockSearchParams = { category: 'places' };
    capturedCategoryProps = null;
    categoryRendered = false;
  });

  it('DiscoveryCategoryTab renders for a non-ForYou category and receives NO onScroll prop', async () => {
    await render(<DiscoveryHub />);
    await act(async () => {});

    expect(categoryRendered).toBe(true);
    expect(capturedCategoryProps).not.toBeNull();
    expect(capturedCategoryProps!.onScroll).toBeUndefined();
  });
});

// ── Parametrized: every non-ForYou tab routes to DiscoveryCategoryTab ──────────
// Iterates several category params to confirm the routing branch is stable and
// that none of them accidentally introduce an onScroll collapse wiring.

const NON_FOR_YOU_CATEGORIES = ['places', 'events', 'beaches', 'nightlife'] as const;

describe.each(NON_FOR_YOU_CATEGORIES)(
  'Discovery screen — category %s routes to DiscoveryCategoryTab (no collapse)',
  (category) => {
    beforeEach(() => {
      mockSearchParams = { category };
      capturedCategoryProps = null;
      categoryRendered = false;
    });

    it(`[${category}] renders DiscoveryCategoryTab with no onScroll prop`, async () => {
      await render(<DiscoveryHub />);
      await act(async () => {});

      expect(categoryRendered).toBe(true);
      expect(capturedCategoryProps).not.toBeNull();
      expect(capturedCategoryProps!.onScroll).toBeUndefined();
    });
  },
);
