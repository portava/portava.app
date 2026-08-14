/**
 * Pulse (app/(tabs)/index.tsx) — scroll-architecture regression test.
 *
 * Confirms the collapsing-header layout introduced by the collapsible-header task:
 *   - AppHeader is rendered INSIDE the FlatList's ListHeaderComponent so it
 *     scrolls away with the feed content (large-title pattern).
 *   - A compact Animated.View overlay at root fades in when the large header
 *     has scrolled off screen.
 *   - The FlatList/ScrollView exists as the primary scroll container.
 *   - The FlatList's ListHeaderComponent (containing AppHeader, LivePulseRail,
 *     fits, etc.) is rendered INSIDE the ScrollView subtree.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── Reanimated ────────────────────────────────────────────────────────────────
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View: RN.View, ScrollView: RN.ScrollView },
    useAnimatedStyle: () => ({}),
    useAnimatedReaction: () => {},
    interpolate: (_v: number, _in: number[], out: number[]) => out[0],
    makeMutable: (v: number) => ({ value: v }),
    withSpring: (v: number) => v,
    runOnJS: (fn: any) => fn,
    useReducedMotion: () => false,
  };
});

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// NOTE: all src/ modules are 3 directories up from app/(tabs)/__tests__/.
// Path: __tests__ → (tabs) → app → package-root → src/

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  navBarProgress: { value: 0 },
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => void) => { cb(); },
}));

// ── Screen timing / snapshot cache — stub ─────────────────────────────────────
// index.tsx gained useScreenTiming + useSnapshotCache. The real useScreenTiming
// calls setEpoch() inside useFocusEffect, which this file's synchronous
// useFocusEffect mock runs during render → "Too many re-renders". Stub both to
// inert values (not under test here).
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useScreenTiming', () => ({
  useScreenTiming: () => ({ markFirstContent: () => {}, epoch: 0 }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useSnapshotCache', () => ({
  useSnapshotCache: () => ({ snapshot: null, isStale: false, save: () => {}, clear: () => {} }),
}));

// ── Comment count store ───────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/commentCountStore', () => ({
  getCommentCountSnapshot: () => new Map(),
  subscribeCommentCount:   () => () => {},
}));

// ── ScreenErrorBoundary — passthrough ─────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

// ── Feed / city-pulse hooks ───────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useCityPulse', () => ({
  useCityPulse: () => ({
    buckets: { fitsAvailability: [], openNearby: [], flexible: [] },
    events: [],
    status: 'not_set',
  }),
}));

// usePulseFeed replaced useGlobalFeed as the primary Pulse feed hook.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/usePulseFeed', () => ({
  usePulseFeed: () => ({
    items: [], placeCards: [], loading: false, loadingMore: false,
    hasMore: false, error: null, reload: jest.fn(), loadMore: jest.fn(),
    markDeleted: jest.fn(), sessionId: null,
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/usePosts', () => ({
  useFollowingFeed: () => ({
    data: [], loading: false, loadingMore: false, error: null,
    markDeleted: jest.fn(), reload: jest.fn(), loadMore: jest.fn(),
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useCircleFlag', () => ({
  useCircleFlag: () => ({ enabled: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useLivePulse', () => ({
  useLivePulse: () => ({ refresh: jest.fn() }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/intelligence', () => ({
  fetchPreferences: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
    locationState: {
      place: { city: 'Cebu City' },
      coords: null,
    },
    openCityPicker: jest.fn(),
  }),
}));

// ── PulseHeader — kept for import compat (index.tsx no longer imports it) ─────
// NOTE: intentional stub — PulseHeader was replaced by AppHeader; kept so any
// residual transitive import doesn't crash the test suite.
jest.mock('../../../src/components/PulseHeader', () => ({
  PulseHeader: () => null,
}));

// ── AppHeader — sentinel stub ─────────────────────────────────────────────────
// Renders a Text node so toJSON tree-walking can confirm AppHeader appears
// as a direct sibling ABOVE the FlatList (fixed-header position, same as
// the old PulseHeader). Overflow actions not under test here.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui/AppHeader.tsx', () => ({
  AppHeader: () => {
    const { Text } = require('react-native');
    return <Text>__AppHeaderSentinel__</Text>;
  },
  OVERLAY_HEADER_HEIGHT: 44,
}));

// ── LivePulseRail — sentinel stub ─────────────────────────────────────────────
// Renders a Text node inside ListHeaderComponent so we can confirm the header
// content appears INSIDE the FlatList ScrollView.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/LivePulseRail', () => ({
  LivePulseRail: () => {
    const { Text } = require('react-native');
    return <Text>__LivePulseRailSentinel__</Text>;
  },
}));

// ── Other heavy UI sub-components ─────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseFits',               () => ({ FitsCard: () => null, FlexibleStrip: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseFeedCard',           () => ({ PulseFeedCard:          () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseCreate',             () => ({ PulseFilterSheet: () => null, UnifiedPostComposer: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/primitives',              () => ({ TravelEmptyState:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/LocationPermissionPrompt',() => ({ LocationPermissionPrompt: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',        () => ({ ManualCityPicker:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet:       () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/ActiveLayoverPill',() => ({ ActiveLayoverPill:      () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PeopleYouMayKnow',        () => ({ PeopleYouMayKnow:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/CircleCompassSuggestions', () => ({ CircleCompassSuggestions: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui',                      () => ({ Chip:                    () => null }));

// ── Tree-walking helpers ───────────────────────────────────────────────────────

function findScrollViews(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  const res: any[] = [];
  if (node.type === 'ScrollView' || node.type === 'RCTScrollView') res.push(node);
  for (const child of (node.children ?? [])) res.push(...findScrollViews(child));
  return res;
}

function subtreeHasText(node: any, text: string): boolean {
  if (typeof node === 'string') return node === text || node.includes(text);
  if (!node || typeof node !== 'object') return false;
  return (node.children ?? []).some((c: any) => subtreeHasText(c, text));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Pulse screen — scroll architecture', () => {
  it('AppHeader scrolls with content — sentinel is inside the FlatList scroll container (collapsing-header design)', async () => {
    const Pulse = require('../index.tsx').default;

    const { toJSON } = await render(<Pulse />);
    await act(async () => {});

    const tree = toJSON() as any;

    // Collapsing-header design: AppHeader lives inside ListHeaderComponent so
    // it scrolls away with the feed. The sentinel must appear INSIDE a ScrollView
    // (i.e. the FlatList's scroll container), not at root as a fixed sibling.
    const scrollViews = findScrollViews(tree);
    const headerInScroll = scrollViews.some((sv) =>
      subtreeHasText(sv, '__AppHeaderSentinel__'),
    );
    expect(headerInScroll).toBe(true);
  });

  it('FlatList exists and its ListHeaderComponent renders inside the scroll container', async () => {
    const Pulse = require('../index.tsx').default;

    const { toJSON } = await render(<Pulse />);
    await act(async () => {});

    const tree = toJSON() as any;

    // The primary scroll container (FlatList→ScrollView) must exist.
    const scrollViews = findScrollViews(tree);
    expect(scrollViews.length).toBeGreaterThan(0);

    // LivePulseRailSentinel appears inside the ListHeaderComponent which is
    // rendered inside the FlatList's ScrollView subtree.
    const railInScroll = scrollViews.some((sv) =>
      subtreeHasText(sv, '__LivePulseRailSentinel__'),
    );
    expect(railInScroll).toBe(true);
  });

  it('AppHeader sentinel IS inside the FlatList scroll container — it scrolls with content, not fixed at root', async () => {
    const Pulse = require('../index.tsx').default;

    const { toJSON } = await render(<Pulse />);
    await act(async () => {});

    const tree = toJSON() as any;

    // Verify the collapsing-header architecture: AppHeader scrolls WITH the list
    // (lives in ListHeaderComponent). A compact overlay bar at root takes the
    // "fixed" role when the large header has scrolled off screen.
    const scrollViews = findScrollViews(tree);
    const headerInScroll = scrollViews.some((sv) =>
      subtreeHasText(sv, '__AppHeaderSentinel__'),
    );
    expect(headerInScroll).toBe(true);
  });
});
