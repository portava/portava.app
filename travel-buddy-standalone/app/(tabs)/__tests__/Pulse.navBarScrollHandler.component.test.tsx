/**
 * Pulse (app/(tabs)/index.tsx) — nav-bar collapse handler wiring test.
 *
 * The scroll-architecture tests (Task #1523) verify the PulseHeader lives
 * inside the FlatList, but they mock useNavBarScrollHandler to a no-op.
 * This test confirms that the primary FlatList receives the handler as its
 * onScroll prop — so removing the wiring would fail here.
 *
 * Strategy:
 *   1. Mock useNavBarScrollHandler to return a jest.fn() spy.
 *   2. Render the Pulse screen; walk the toJSON tree to find the ScrollView
 *      (the FlatList renders onScroll through to its internal ScrollView)
 *      whose onScroll prop === spy — identity comparison confirms wiring.
 *   3. Fire the handler and confirm the spy is invoked.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── FlatList prop capture ─────────────────────────────────────────────────────
// React Native wraps the `onScroll` callback before forwarding it to the
// internal ScrollView, so identity-checking the inner ScrollView's onScroll
// prop always fails for FlatList.  Instead, stub FlatList itself to capture
// the prop before the wrapping occurs.  capturedListOnScroll is written
// (not read) inside the factory, which jest.mock hoisting allows.
let capturedListOnScroll: ((e: any) => void) | undefined;

// ── react-native Proxy (FlatList capture) ─────────────────────────────────────
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const MockFlatList = ({ onScroll }: any) => {
    capturedListOnScroll = onScroll;
    return null;
  };
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'FlatList') return MockFlatList;
      return Reflect.get(target, prop, receiver);
    },
  });
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
// mockNavScrollHandler is the exact value returned by useNavBarScrollHandler.
// Pulse passes it directly as onScroll to the main FlatList, so an identity
// check in the toJSON props is reliable.
const mockNavScrollHandler = jest.fn();
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => mockNavScrollHandler,
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Location ──────────────────────────────────────────────────────────────────
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
jest.mock('../../../src/hooks/useCityPulse', () => ({
  useCityPulse: () => ({
    buckets: { fitsAvailability: [], openNearby: [], buddies: [] },
    status: 'not_set',
  }),
}));

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

jest.mock('../../../src/hooks/useLivePulse', () => ({
  useLivePulse: () => ({ events: [], loading: false, refresh: jest.fn() }),
}));

jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

jest.mock('../../../src/hooks/useCircleFlag', () => ({
  useCircleFlag: () => ({ enabled: false }),
}));

jest.mock('../../../src/hooks/useRankOutcome', () => ({
  fireRankOutcome: jest.fn(),
}));

// ── Services / libs ───────────────────────────────────────────────────────────
jest.mock('../../../src/services/intelligence', () => ({
  fetchPreferences: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock('../../../src/lib/commentCountStore', () => ({
  getCommentCountSnapshot: jest.fn().mockReturnValue([]),
  subscribeCommentCount: jest.fn().mockReturnValue(() => {}),
}));

// ── Components ────────────────────────────────────────────────────────────────
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

jest.mock('../../../src/components/PulseHeader', () => ({
  PulseHeader: () => null,
}));

jest.mock('../../../src/components/PulseFits', () => ({
  FitsCard: () => null,
  FlexibleStrip: () => null,
}));

jest.mock('../../../src/components/PulseFeedCard', () => ({
  PulseFeedCard: () => null,
}));

jest.mock('../../../src/components/PulseCreate', () => ({
  PulseFilterSheet: () => null,
  UnifiedPostComposer: () => null,
}));

jest.mock('../../../src/components/ui', () => ({
  Chip: () => null,
}));

jest.mock('../../../src/components/primitives', () => ({
  TravelEmptyState: () => null,
}));

jest.mock('../../../src/components/PostCard', () => ({
  PostCard: () => null,
}));

jest.mock('../../../src/components/ManualCityPicker', () => ({
  ManualCityPicker: () => null,
}));

jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({
  LayoverModeSheet: () => null,
}));

jest.mock('../../../src/components/layover/ActiveLayoverPill', () => ({
  ActiveLayoverPill: () => null,
}));

jest.mock('../../../src/components/PeopleYouMayKnow', () => ({
  PeopleYouMayKnow: () => null,
}));

jest.mock('../../../src/components/CircleCompassSuggestions', () => ({
  CircleCompassSuggestions: () => null,
}));

jest.mock('../../../src/components/LivePulseRail', () => ({
  LivePulseRail: () => null,
}));

jest.mock('../../../src/components/LocationPermissionPrompt', () => ({
  LocationPermissionPrompt: () => null,
}));

jest.mock('lucide-react-native', () => ({
  Plane: () => null,
  Users: () => null,
  MapPin: () => null,
}));

import Pulse from '../index.tsx';

// ── Fake scroll event ─────────────────────────────────────────────────────────
const FAKE_SCROLL_EVENT = {
  nativeEvent: { contentOffset: { y: 120 }, contentSize: { height: 2000 }, layoutMeasurement: { height: 800 } },
} as any;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Pulse screen — nav-bar scroll handler wiring', () => {
  beforeEach(() => {
    capturedListOnScroll = undefined;
    mockNavScrollHandler.mockClear();
  });

  it('primary FlatList onScroll prop is the useNavBarScrollHandler result', async () => {
    await render(<Pulse />);
    await act(async () => {});

    // The stub captures the raw onScroll prop before React Native wraps it.
    // index.tsx: <FlatList onScroll={navBarScrollHandler} …>
    // navBarScrollHandler IS mockNavScrollHandler — identity match confirms wiring.
    expect(capturedListOnScroll).toBe(mockNavScrollHandler);
  });

  it('firing the captured FlatList onScroll invokes the collapse handler', async () => {
    await render(<Pulse />);
    await act(async () => {});

    expect(capturedListOnScroll).toBeDefined();
    capturedListOnScroll!(FAKE_SCROLL_EVENT);
    expect(mockNavScrollHandler).toHaveBeenCalledTimes(1);
    expect(mockNavScrollHandler).toHaveBeenCalledWith(FAKE_SCROLL_EVENT);
  });
});
