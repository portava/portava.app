/**
 * Pulse (app/(tabs)/index.tsx) — nav-bar clearance architecture test.
 *
 * DIVERGENCE FROM THE MOBILE TREE (rule 13 rewrite):
 * The mobile Pulse screen wires a `useNavBarScrollHandler()` result into the
 * primary FlatList's `onScroll` prop so the floating tab pill collapses as the
 * feed scrolls. The STANDALONE fork does NOT use that collapse mechanism at
 * all — app/(tabs)/index.tsx does not import `useNavBarScrollHandler`, and the
 * FlatList has no `onScroll` prop. Instead it clears the tab pill statically
 * via `useBottomInset()` (NAV_BAR_FILLER_HEIGHT + insets.bottom) applied as the
 * FlatList's contentContainerStyle.paddingBottom.
 *
 * This test therefore pins the standalone's ACTUAL contract:
 *   1. The primary FlatList exists and carries NO onScroll handler (there is no
 *      scroll-driven nav-bar collapse in this fork).
 *   2. The FlatList's contentContainerStyle.paddingBottom clears the pill —
 *      i.e. equals the useBottomInset() value (NAV_BAR_FILLER_HEIGHT + inset).
 * Removing the paddingBottom clearance (or accidentally introducing a broken
 * onScroll wiring) would fail here.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── FlatList prop capture ─────────────────────────────────────────────────────
// Stub FlatList itself so we can inspect the raw props Pulse passes to it
// (onScroll and contentContainerStyle) before React Native wraps anything.
let capturedListProps: Record<string, any> | undefined;

// ── react-native Proxy (FlatList capture) ─────────────────────────────────────
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const MockFlatList = (props: any) => {
    capturedListProps = props;
    return null;
  };
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'FlatList') return MockFlatList;
      return Reflect.get(target, prop, receiver);
    },
  });
});

// ── Safe-area ─────────────────────────────────────────────────────────────────
// bottom: 34 (iPhone 14 home indicator) so useBottomInset() === 96 + 34 = 130.
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
// Standalone index.tsx does NOT import useNavBarScrollHandler, but useBottomInset
// (which index.tsx DOES use) imports NAV_BAR_FILLER_HEIGHT from this module. Pin
// it to 96 so useBottomInset() resolves deterministically.
// NOTE: intentional stub — NAV_BAR_FILLER_HEIGHT feeds useBottomInset.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Location ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    resolvedLocation: null,
    locationState: {
      ok: false,
      permissionStatus: 'undetermined',
      place: { city: null },
      coords: null,
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
jest.mock('../../../src/hooks/useCityPulse', () => ({
  useCityPulse: () => ({
    buckets: { fitsAvailability: [], openNearby: [], buddies: [] },
    status: 'not_set',
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/usePulseFeed', () => ({
  usePulseFeed: () => ({
    items: [],
    placeCards: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    reload: jest.fn(),
    loadMore: jest.fn(),
    markDeleted: jest.fn(),
    sessionId: null,
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/usePosts', () => ({
  useFollowingFeed: () => ({
    data: [],
    loading: false,
    loadingMore: false,
    error: null,
    reload: jest.fn(),
    loadMore: jest.fn(),
    markDeleted: jest.fn(),
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useLivePulse', () => ({
  useLivePulse: () => ({ events: [], loading: false, refresh: jest.fn() }),
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
jest.mock('../../../src/hooks/useRankOutcome', () => ({
  fireRankOutcome: jest.fn(),
}));

// ── Services / libs ───────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/intelligence', () => ({
  fetchPreferences: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/commentCountStore', () => ({
  getCommentCountSnapshot: jest.fn().mockReturnValue([]),
  subscribeCommentCount: jest.fn().mockReturnValue(() => {}),
}));

// ── Components ────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseHeader', () => ({
  PulseHeader: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseFits', () => ({
  FitsCard: () => null,
  FlexibleStrip: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseFeedCard', () => ({
  PulseFeedCard: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseCreate', () => ({
  PulseFilterSheet: () => null,
  UnifiedPostComposer: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui', () => ({
  Chip: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/primitives', () => ({
  TravelEmptyState: () => null,
}));


// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker', () => ({
  ManualCityPicker: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({
  LayoverModeSheet: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/ActiveLayoverPill', () => ({
  ActiveLayoverPill: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PeopleYouMayKnow', () => ({
  PeopleYouMayKnow: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/CircleCompassSuggestions', () => ({
  CircleCompassSuggestions: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/LivePulseRail', () => ({
  LivePulseRail: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/LocationPermissionPrompt', () => ({
  LocationPermissionPrompt: () => null,
}));


import Pulse from '../index.tsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Flatten a RN style prop (array or object) into a single plain object. */
function flattenStyle(style: any): Record<string, any> {
  if (!style) return {};
  return Array.isArray(style)
    ? Object.assign({}, ...style.map((s: any) => (s && typeof s === 'object' ? s : {})))
    : style;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Pulse screen — nav-bar clearance architecture (standalone)', () => {
  beforeEach(() => {
    capturedListProps = undefined;
  });

  it('primary FlatList carries NO onScroll handler — no scroll-driven collapse in this fork', async () => {
    await render(<Pulse />);
    await act(async () => {});

    // The standalone fork does not wire useNavBarScrollHandler; the FlatList
    // must not receive an onScroll prop.
    expect(capturedListProps).toBeDefined();
    expect(capturedListProps!.onScroll).toBeUndefined();
  });

  it('FlatList contentContainerStyle.paddingBottom clears the tab pill via useBottomInset (96 + inset)', async () => {
    await render(<Pulse />);
    await act(async () => {});

    expect(capturedListProps).toBeDefined();
    const flat = flattenStyle(capturedListProps!.contentContainerStyle);
    // useBottomInset() === NAV_BAR_FILLER_HEIGHT (96) + insets.bottom (34) = 130.
    expect(flat.paddingBottom).toBe(130);
  });
});
