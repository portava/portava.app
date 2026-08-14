/**
 * Pulse (app/(tabs)/index.tsx) — stale bucket-shape regression test.
 *
 * The guarded spread on line ~256 of index.tsx:
 *
 *   const fits = [...(buckets.fitsAvailability ?? []), ...(buckets.openNearby ?? [])];
 *
 * protects against a "not iterable" TypeError that fires when a stale Metro
 * bundler cache serves an older version of recommend.ts that returned different
 * property names (e.g. {fits, flexible} before they were renamed to
 * {fitsAvailability, openNearby}).  All normal tests mock useCityPulse with a
 * correctly-shaped object, so they pass even when the guard is removed.
 *
 * This file renders with degraded / empty-shape bucket mocks that simulate
 * real cache-version skew and confirms the screen renders without throwing.
 * If the `?? []` guards are ever removed, every test here will fail instantly.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';
import type { PulseBuckets } from '../../../src/types/models';

// ── Typed bucket factory ───────────────────────────────────────────────────────
// Defining the full-shape mock with `satisfies PulseBuckets` means TypeScript
// raises TS2353 here if PulseBuckets ever gains a new required property — so
// this file acts as a compile-time sentinel for the correct mock shape, while
// the stale-shape tests below exercise the runtime guard.
const FULL_MOCK_BUCKETS = {
  fitsAvailability: [],
  openNearby:       [],
  flexible:         [],
} satisfies PulseBuckets;

// ── Module-level variable: swap per test, read inside jest.mock factory ────────
// The jest.mock factory closes over this reference at hoist time; we update
// the object it points to before each test so we can vary the bucket shape.
let mockBuckets: Record<string, unknown> = { ...FULL_MOCK_BUCKETS };

// ── Reanimated ────────────────────────────────────────────────────────────────
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View: RN.View, ScrollView: RN.ScrollView },
    useAnimatedStyle:     () => ({}),
    useAnimatedReaction:  () => {},
    interpolate:          (_v: number, _in: number[], out: number[]) => out[0],
    makeMutable:          (v: number) => ({ value: v }),
    withSpring:           (v: number) => v,
    runOnJS:              (fn: any) => fn,
    useReducedMotion:     () => false,
  };
});

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider:  ({ children }: any) => children,
}));

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  navBarProgress:         { value: 0 },
  NAV_BAR_FILLER_HEIGHT:  96,
}));

// ── expo-router ───────────────────────────────────────────────────────────────
// useFocusEffect runs synchronously so mount-time effects fire in tests.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router:          { push: jest.fn(), back: jest.fn() },
  useFocusEffect:  (cb: () => void) => { cb(); },
}));

// ── Screen timing / snapshot cache — stub ─────────────────────────────────────
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

// ── useCityPulse — reads mockBuckets at call time so tests can vary the shape ──
// This is the hook under test. Each scenario below overwrites mockBuckets before
// rendering, which causes useCityPulse to return a different (possibly degraded)
// bucket object without needing to re-register the mock.
// NOTE: intentional exhaustive stub — useCityPulse has no other exports consumed
// by index.tsx; spreading requireActual would pull in real Supabase calls.
jest.mock('../../../src/hooks/useCityPulse', () => ({
  useCityPulse: () => ({
    buckets: mockBuckets,
    events:  [],
    status:  'not_set',
  }),
}));

// ── Remaining feed hooks ───────────────────────────────────────────────────────
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
  FOCUS_REFETCH_TTL_MS: 60000,
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
jest.mock('../../../src/hooks/useRankOutcome', () => ({
  fireRankOutcome: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/intelligence', () => ({
  fetchPreferences: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/layover', () => ({
  getActiveLayoverSession: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getLaunchStatus: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
    locationState: { place: { city: 'Cebu City' }, coords: null },
    openCityPicker: jest.fn(),
  }),
}));

// ── UI sub-components — render null ───────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseHeader',              () => ({ PulseHeader:             () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui/AppHeader.tsx',         () => ({ AppHeader: () => null, OVERLAY_HEADER_HEIGHT: 44 }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/NotificationBell',         () => ({ NotificationBell:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseFits',                () => ({ FitsCard: () => null, FlexibleStrip: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ExploreTodaySection',      () => ({ ExploreTodaySection:      () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseFeedCard',            () => ({ PulseFeedCard:            () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseCreate',              () => ({ PulseFilterSheet: () => null, UnifiedPostComposer: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/primitives',               () => ({ TravelEmptyState:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/LocationPermissionPrompt', () => ({ LocationPermissionPrompt: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',         () => ({ ManualCityPicker:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/ActiveLayoverPill',() => ({ ActiveLayoverPill:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PeopleYouMayKnow',         () => ({ PeopleYouMayKnow:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/CircleCompassSuggestions', () => ({ CircleCompassSuggestions: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/LivePulseRail',            () => ({ LivePulseRail:            () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/loading/FeedSkeleton',     () => ({ FeedSkeleton:             () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui',                       () => ({ Chip:                     () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LayoverSessionContext',        () => ({
  LayoverSessionProvider:    ({ children }: any) => children,
  useLayoverSessionContext:   () => ({ session: null }),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Pulse screen — stale bucket-shape guard (cache-version skew)', () => {
  // The useCityPulse mock factory reads `mockBuckets` at call time (on each
  // render), so changing the variable before rendering is enough — no
  // jest.resetModules() needed and the React instance stays consistent.

  beforeEach(() => {
    // Reset to the correct shape so tests that don't reassign are unaffected.
    mockBuckets = { ...FULL_MOCK_BUCKETS };
  });

  it('renders without throwing when useCityPulse returns an empty object (all bucket properties absent)', async () => {
    // Simulates the worst-case stale cache: the cached module returned {} with
    // no recognised property names. Without the `?? []` guard, the spread
    // `[...buckets.fitsAvailability]` throws "undefined is not iterable".
    mockBuckets = {};

    const Pulse = require('../index.tsx').default;
    await expect(render(<Pulse />)).resolves.toBeDefined();
    await act(async () => { await Promise.resolve(); });
  });

  it('renders without throwing when fitsAvailability is absent but openNearby is present', async () => {
    // Partial shape: only openNearby survived the cache round-trip.
    mockBuckets = { openNearby: [], flexible: [] };

    const Pulse = require('../index.tsx').default;
    await expect(render(<Pulse />)).resolves.toBeDefined();
    await act(async () => { await Promise.resolve(); });
  });

  it('renders without throwing when openNearby is absent but fitsAvailability is present', async () => {
    // Partial shape: only fitsAvailability survived.
    mockBuckets = { fitsAvailability: [], flexible: [] };

    const Pulse = require('../index.tsx').default;
    await expect(render(<Pulse />)).resolves.toBeDefined();
    await act(async () => { await Promise.resolve(); });
  });

  it('renders without throwing when both fitsAvailability and openNearby are absent', async () => {
    // Simulates the original stale-cache shape before the rename:
    // {fits, flexible} — neither renamed property is present.
    mockBuckets = { flexible: [] };

    const Pulse = require('../index.tsx').default;
    await expect(render(<Pulse />)).resolves.toBeDefined();
    await act(async () => { await Promise.resolve(); });
  });

  it('renders without throwing when useCityPulse returns undefined bucket values (null-ish fields)', async () => {
    // Bucket properties explicitly set to undefined — the spread must still
    // produce an empty array, not throw.
    mockBuckets = { fitsAvailability: undefined, openNearby: undefined, flexible: undefined };

    const Pulse = require('../index.tsx').default;
    await expect(render(<Pulse />)).resolves.toBeDefined();
    await act(async () => { await Promise.resolve(); });
  });

  it('renders correctly with the full correct bucket shape — baseline sanity', async () => {
    // Confirms the screen is not broken in the happy path — a failing baseline
    // here means the test infrastructure is misconfigured, not the guard.
    mockBuckets = { ...FULL_MOCK_BUCKETS };

    const Pulse = require('../index.tsx').default;
    const { toJSON } = await render(<Pulse />);
    await act(async () => { await Promise.resolve(); });

    expect(toJSON()).not.toBeNull();
  });
});
