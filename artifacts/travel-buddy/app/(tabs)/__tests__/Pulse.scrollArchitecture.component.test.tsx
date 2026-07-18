/**
 * Pulse (app/(tabs)/index.tsx) — scroll-architecture regression test.
 *
 * Confirms that after Task #1519, the header content (mode-row toggle,
 * filter chips, PulseHeader) lives inside the FlatList's ListHeaderComponent
 * and NOT as a sibling View rendered above the scroll container.
 *
 * Strategy:
 * 1. Stub PulseHeader to render an identifiable sentinel Text node. In the
 *    jest-expo environment FlatList renders its ListHeaderComponent inside a
 *    ScrollView, so the sentinel appears as a descendant of a ScrollView.
 *    Walking the toJSON tree confirms the sentinel is INSIDE the scroll
 *    container — not a sibling above it.
 * 2. Walk the root children to confirm there is only one non-overlay child
 *    (the FlatList/ScrollView container). A second non-absolute sibling would
 *    mean a pinned header was broken out above the list.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
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
    interpolate: (_v: number, _in: number[], out: number[]) => out[0],
    makeMutable: (v: number) => ({ value: v }),
    withSpring: (v: number) => v,
  };
});

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
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

// ── Bottom inset ──────────────────────────────────────────────────────────────
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useBottomInset: () => 130,
}));

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => void) => { cb(); },
}));

// ── Feed / city-pulse hooks ───────────────────────────────────────────────────
jest.mock('../../../src/hooks/useCityPulse', () => ({
  useCityPulse: () => ({
    buckets: { fitsAvailability: [], openNearby: [], flexible: [] },
    status: 'not_set',
  }),
}));

jest.mock('../../../src/hooks/usePosts', () => ({
  useGlobalFeed: () => ({
    data: [], pending: [], loading: false, error: null,
    markDeleted: jest.fn(), reload: jest.fn(),
    refreshIfStale: jest.fn(), applyPending: jest.fn(),
  }),
  useFollowingFeed: () => ({
    data: [], pending: [], loading: false, error: null,
    markDeleted: jest.fn(), reload: jest.fn(),
    refreshIfStale: jest.fn(), applyPending: jest.fn(),
  }),
}));

jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

jest.mock('../../../src/services/intelligence', () => ({
  fetchPreferences: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    // resolvedLocation is the unified source of truth after Task #1534 merge.
    resolvedLocation: {
      place: { city: 'Cebu City' },
      coords: null,
      source: 'home',
      freshness: 'unavailable',
    },
    locationState: {
      ok: false,
      permissionStatus: 'denied',
      place: { city: 'Cebu City' },
      coords: null,
    },
    openCityPicker: jest.fn(),
    clearSessionLocation: jest.fn(),
    setSessionLocation: jest.fn(),
  }),
}));

// ── PulseHeader — sentinel stub ───────────────────────────────────────────────
// Renders a Text node so toJSON tree-walking can confirm the header appears
// INSIDE the FlatList's ScrollView subtree, not above it as a sibling.
jest.mock('../../../src/components/PulseHeader', () => ({
  PulseHeader: () => {
    const { Text } = require('react-native');
    return <Text>__PulseHeaderSentinel__</Text>;
  },
}));

// ── Other heavy UI sub-components ─────────────────────────────────────────────
jest.mock('../../../src/components/PulseFits',          () => ({ FitsCard: () => null, FlexibleStrip: () => null }));
jest.mock('../../../src/components/PulseFeedCard',      () => ({ PulseFeedCard:          () => null }));
jest.mock('../../../src/components/PulseCreate',        () => ({ PulseFilterSheet: () => null, UnifiedPostComposer: () => null }));
jest.mock('../../../src/components/PulseLiveBanner',    () => ({ PulseLiveBanner:        () => null }));
jest.mock('../../../src/components/primitives',         () => ({ TravelEmptyState:        () => null }));
jest.mock('../../../src/components/PostCard',           () => ({ PostCard:                () => null }));
jest.mock('../../../src/components/LocationPermissionPrompt', () => ({ LocationPermissionPrompt: () => null }));
jest.mock('../../../src/components/ManualCityPicker',   () => ({ ManualCityPicker:        () => null }));
jest.mock('../../../src/components/layover/LayoverModeSheet',  () => ({ LayoverModeSheet:  () => null }));
jest.mock('../../../src/components/layover/ActiveLayoverPill', () => ({ ActiveLayoverPill: () => null }));
jest.mock('../../../src/components/PeopleYouMayKnow',   () => ({ PeopleYouMayKnow:        () => null }));

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
  it('PulseHeader sentinel appears inside the FlatList ScrollView — header scrolls with content', async () => {
    // Require after mocks so the PulseHeader sentinel stub is in place.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Pulse = require('../index.tsx').default;

    const { toJSON } = await render(<Pulse />);
    await act(async () => {});

    const tree = toJSON() as any;

    // In the jest-expo environment FlatList renders its ListHeaderComponent
    // inside a ScrollView (via VirtualizedList). Walking the tree for ScrollView
    // nodes and checking for the sentinel confirms the header is inside the
    // scroll container — not a pinned sibling above it.
    const scrollViews = findScrollViews(tree);
    expect(scrollViews.length).toBeGreaterThan(0);

    const headerInScroll = scrollViews.some((sv) =>
      subtreeHasText(sv, '__PulseHeaderSentinel__'),
    );
    expect(headerInScroll).toBe(true);
  });

  it('no non-overlay sibling sits above the scroll container in root children', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Pulse = require('../index.tsx').default;

    const { toJSON } = await render(<Pulse />);
    await act(async () => {});

    const tree = toJSON() as any;
    const rootChildren: any[] = Array.isArray(tree?.children) ? tree.children : [];

    // Only the FlatList (as ScrollView) should be non-absolute at root level.
    // A second non-absolute child would indicate a pinned header split.
    let nonAbsoluteCount = 0;
    for (const child of rootChildren) {
      if (!child || typeof child !== 'object') continue;
      const style = child?.props?.style ?? {};
      const flat = Array.isArray(style)
        ? Object.assign({}, ...style.map((s: any) => (s && typeof s === 'object' ? s : {})))
        : style;
      if (flat.position !== 'absolute') nonAbsoluteCount += 1;
    }
    expect(nonAbsoluteCount).toBeLessThanOrEqual(1);
  });
});
