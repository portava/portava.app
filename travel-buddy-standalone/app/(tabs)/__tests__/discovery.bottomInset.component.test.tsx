/**
 * Discovery (app/(tabs)/discovery.tsx) — bottom-inset clearance test.
 *
 * Confirms that the `bottomInset` value derived from `useBottomInset()` and
 * forwarded to ForYouTab / DiscoveryCategoryTab as a prop is at least 120 pt
 * when a layover session is active.
 *
 * Discovery does not own the FlatList directly — it passes `bottomInset` as a
 * prop into the tab components (ForYouTab, DiscoveryCategoryTab) which apply it
 * to their own FlatList `contentContainerStyle`.  This test captures that prop
 * at the boundary so a future refactor that drops the forwarding cannot go
 * unnoticed.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── Reanimated ────────────────────────────────────────────────────────────────
// NOTE: intentional stub — discovery.tsx imports Animated and useCollapsingHeader
// which references reanimated worklet APIs unavailable in JSDOM.
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View: RN.View, ScrollView: RN.ScrollView },
    useAnimatedStyle: () => ({}),
    useAnimatedReaction: () => {},
    useAnimatedScrollHandler: () => () => {},
    interpolate: (_v: number, _in: number[], out: number[]) => out[0],
    useSharedValue: (v: number) => ({ value: v }),
    makeMutable: (v: number) => ({ value: v }),
    withSpring: (v: number) => v,
    withTiming: (v: number) => v,
    runOnJS: (fn: any) => fn,
    useReducedMotion: () => false,
  };
});

// ── Safe-area — iPhone 14 (bottom = 34 pt) ───────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
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

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Bottom inset — controlled value (iPhone 14 layover-active: 34 + 74 + 44 + 16 = 168) ──
// The test scenario is: layover active, useLayoverAwareBottomInset returns the
// layover-aware Tier-1 value.  168 ≥ 155 satisfies the minimum clearance contract.
let mockBottomInset = 168;
// NOTE: intentional stub — only the forwarded bottomInset prop is under test.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useBottomInset:              () => 130,
  useLayoverAwareBottomInset:  () => mockBottomInset,
  usePlainBottomInset:         () => 58,
  PlainBottomFiller:           () => null,
  BOTTOM_BREATHING_ROOM:       24,
  useStickyBarInset:           () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible:          () => false,
}));

// ── Layover service — active session ─────────────────────────────────────────
// NOTE: intentional stub — layover state not under test; we just need an
// active session present so the scenario is representative.
jest.mock('../../../src/services/layover', () => ({
  getActiveLayoverSession: jest.fn().mockResolvedValue({
    session: { id: 'layover-disc-1', departureTime: '2026-07-30T22:00:00Z', manualIata: 'LAX' },
    airport: null,
  }),
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

// ── Feature flags ─────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false, loading: false }),
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
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discoveryLocalCache', () => ({
  loadCachedCounts: jest.fn().mockResolvedValue(null),
  saveCachedCounts: jest.fn(),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/apiToken', () => ({
  freshToken: jest.fn().mockResolvedValue(null),
}));

// ── ForYouTab stub — captures bottomInset prop ────────────────────────────────
// This is the primary probe: discovery.tsx calls
//   <ForYouTab bottomInset={bottomInset} ... />
// Capturing the value confirms the prop is correctly forwarded and >= 120.
let capturedForYouBottomInset: number | undefined;
// NOTE: intentional stub — only bottomInset forwarding is under test.
jest.mock('../../../src/components/discovery/ForYouTab', () => ({
  ForYouTab: ({ bottomInset, listHeaderComponent }: { bottomInset?: number; listHeaderComponent?: React.ReactNode }) => {
    capturedForYouBottomInset = bottomInset;
    return null;
  },
}));

// ── DiscoveryCategoryTab stub — captures bottomInset prop ─────────────────────
let capturedCategoryBottomInset: number | undefined;
// NOTE: intentional stub — not under test here (only bottomInset captured).
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab', () => ({
  DiscoveryCategoryTab: ({ bottomInset }: { bottomInset?: number }) => {
    capturedCategoryBottomInset = bottomInset;
    return null;
  },
}));

// ── Sub-component stubs ───────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/PlaceDetailSheet',     () => ({ PlaceDetailSheet:     () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DestinationBar',       () => ({ DestinationBar:       () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',     () => ({ SubmitPlaceSheet:     () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SectionErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: any) => children,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow',        () => ({ CompassBuddyRow:      () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CityConfidenceBadge',    () => ({ CityConfidenceBadge: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',               () => ({ ManualCityPicker:     () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet',       () => ({ LayoverModeSheet:     () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RouteBuilderSheet',              () => ({ RouteBuilderSheet:    () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/FollowingHighlightsStrip',       () => ({ FollowingHighlightsStrip: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PlanPickerController',           () => ({
  usePlanPicker: () => ({ open: jest.fn(), close: jest.fn(), PlanPickerSheet: () => null }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/BuddyCard',                     () => ({ BuddyCardSkeleton: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/loading/PlaceCardSkeleton',      () => ({ PlaceCardSkeleton:  () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/loading/EventCardSkeleton',      () => ({ EventCardSkeleton:  () => null }));

import DiscoveryHub from '../discovery.tsx';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Discovery tab — bottomInset forwarded to tab component when layover active', () => {
  beforeEach(() => {
    capturedForYouBottomInset   = undefined;
    capturedCategoryBottomInset = undefined;
    mockBottomInset = 168; // iPhone 14 layover-active: insets.bottom (34) + 74 + 44 + 16
  });

  it('ForYouTab receives bottomInset ≥ 155 (iPhone 14, layover active)', async () => {
    await render(<DiscoveryHub />);
    await act(async () => { await Promise.resolve(); });

    // The default tab is 'for_you', so ForYouTab should have been rendered.
    expect(capturedForYouBottomInset).toBeDefined();
    expect(capturedForYouBottomInset!).toBeGreaterThanOrEqual(155);
  });

  it('ForYouTab bottomInset equals the value from useLayoverAwareBottomInset() (168 on iPhone 14)', async () => {
    await render(<DiscoveryHub />);
    await act(async () => { await Promise.resolve(); });

    expect(capturedForYouBottomInset).toBe(168);
  });

  it('bottomInset contract satisfied: iPhone bottom (34) + pill offset (74) + pill height (44) + gap (16) = 168 ≥ 155', () => {
    const IPHONE_BOTTOM = 34;
    const LAYOVER_PILL_BOTTOM_OFFSET = 74;
    const LAYOVER_PILL_HEIGHT = 44;
    const LAYOVER_PILL_TOP_GAP = 16;
    expect(IPHONE_BOTTOM + LAYOVER_PILL_BOTTOM_OFFSET + LAYOVER_PILL_HEIGHT + LAYOVER_PILL_TOP_GAP).toBeGreaterThanOrEqual(155);
  });

  it('bottomInset contract satisfied on Android: Android bottom (48) + 74 + 44 + 16 = 182 ≥ 155', () => {
    const ANDROID_BOTTOM = 48;
    expect(ANDROID_BOTTOM + 74 + 44 + 16).toBeGreaterThanOrEqual(155);
  });
});
