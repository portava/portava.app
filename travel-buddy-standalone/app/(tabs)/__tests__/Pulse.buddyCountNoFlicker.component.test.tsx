/**
 * Pulse (app/(tabs)/index.tsx) — buddy card count no-flicker test.
 *
 * The buddyAvailableCount useEffect fires getLaunchStatus(activeCity) on every
 * city change. It guards stale responses with a `cancelled` boolean in the
 * cleanup function. If the user switches city rapidly (A → B → C), three
 * parallel requests can resolve out of order.
 *
 * This test confirms the cleanup guard works: when cities switch A → B → C and
 * responses resolve in the stale order (A, B, then C), the buddy card shows
 * city C's count — not a stale count from A or B.
 *
 * Strategy:
 *   1. Mock getLaunchStatus with deferred promises we control manually.
 *   2. Mock useRentABuddyFlag with enabled: true so the buddy module renders.
 *   3. Mock useLocationContext reading from a module-level variable so rerenders
 *      pick up city changes without a wrapper component.
 *   4. Render (city A pending), rerender with city B (A cancelled), rerender
 *      with city C (B cancelled).
 *   5. Resolve A (count=5 → "Local buddies available"), then B (count=3),
 *      then C (count=0 → "No buddies online right now in Gamma City").
 *   6. Assert: the stale "Local buddies available" text is absent; the
 *      city-C-specific "No buddies online right now in Gamma City" text is shown.
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

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  navBarProgress: { value: 0 },
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── expo-router ───────────────────────────────────────────────────────────────
// useFocusEffect runs synchronously so mount-time effects fire in tests.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => void) => { cb(); },
}));

// ── Screen timing / snapshot cache — stub ────────────────────────────────────
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

// ── Rent-a-buddy feature flag — ENABLED so the buddy module renders ───────────
// NOTE: intentionally returns enabled:true — the buddy module must be visible for the count assertions to be meaningful.
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: true }),
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

// ── getLaunchStatus — the key mock: deferred promises controlled per test ─────
// index.tsx imports getLaunchStatus from rentABuddy and calls it inside a
// useEffect on every activeCity change. We intercept it here so we can
// resolve promises in arbitrary order to simulate out-of-order network responses.
const mockGetLaunchStatus = jest.fn();
// NOTE: intentional exhaustive stub — only getLaunchStatus is called by index.tsx; other rentABuddy exports are not needed here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getLaunchStatus: (...args: any[]) => mockGetLaunchStatus(...args),
}));

// ── LocationContext — reads from module-level variable so rerenders pick up ───
// city changes without a wrapper component.
let mockActiveCity: string | null = 'Alpha City';
// NOTE: intentional exhaustive stub — only locationState.place.city and openCityPicker are needed; reads mockActiveCity at call time so rerenders pick up city changes.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
    locationState: { place: { city: mockActiveCity }, coords: null },
    openCityPicker: jest.fn(),
  }),
}));

// ── UI sub-components — render null ──────────────────────────────────────────
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
  LayoverSessionProvider: ({ children }: any) => children,
  useLayoverSessionContext: () => ({ session: null }),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Pulse screen — buddy card count no-flicker during rapid city changes', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGetLaunchStatus.mockReset();
    mockActiveCity = 'Alpha City';
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows "Checking availability…" while the initial request is pending', async () => {
    // Deferred promise — never resolves during this test so count stays null.
    // With fake timers the 300 ms debounce never fires unless we explicitly
    // advance time, so getLaunchStatus is never called and count remains null.
    mockGetLaunchStatus.mockReturnValue(new Promise(() => {}));

    const Pulse = require('../index.tsx').default;
    const { getByText } = await render(<Pulse />);
    await act(async () => {});

    expect(getByText('Checking availability…')).toBeTruthy();
  });

  it(
    'cleanup cancels earlier requests — last city count wins when responses resolve out of order',
    async () => {
      // ── Set up three deferred promises, one per city ──────────────────────
      // Alpha (city A): count=5  → would display "Local buddies available"
      // Beta  (city B): count=3  → would display "Local buddies available"
      // Gamma (city C): count=0  → must display "No buddies online right now in Gamma City…"
      //
      // Each city change is followed by a 350 ms timer advance so the debounce
      // fires and getLaunchStatus is actually called for that city. Responses
      // deliberately resolve in stale-first order: A, B, then C. The
      // cancelled-boolean cleanup on each effect means A and B are no-ops.
      let resolveAlpha!: (v: any) => void;
      let resolveBeta!:  (v: any) => void;
      let resolveGamma!: (v: any) => void;

      const alphaPromise = new Promise<any>((res) => { resolveAlpha = res; });
      const betaPromise  = new Promise<any>((res) => { resolveBeta  = res; });
      const gammaPromise = new Promise<any>((res) => { resolveGamma = res; });

      const deferreds = [alphaPromise, betaPromise, gammaPromise];
      let callCount = 0;
      mockGetLaunchStatus.mockImplementation(() => deferreds[callCount++] ?? new Promise(() => {}));

      // ── Render with Alpha City ─────────────────────────────────────────────
      mockActiveCity = 'Alpha City';
      const Pulse = require('../index.tsx').default;
      const { rerender, queryByText } = await render(<Pulse />);
      // Advance past the 300 ms debounce so Alpha's getLaunchStatus call fires.
      await act(async () => { jest.advanceTimersByTime(350); });

      // Alpha's request is in-flight — count is null.
      expect(queryByText('Checking availability…')).toBeTruthy();

      // ── Switch to Beta City ────────────────────────────────────────────────
      // Alpha's effect cleanup sets its `cancelled` flag + clears its (already-
      // fired) timer. Beta's new debounce timer starts from zero.
      mockActiveCity = 'Beta City';
      await act(async () => { rerender(<Pulse />); });
      // Advance past the 300 ms debounce so Beta's getLaunchStatus call fires.
      await act(async () => { jest.advanceTimersByTime(350); });

      // ── Switch to Gamma City ───────────────────────────────────────────────
      mockActiveCity = 'Gamma City';
      await act(async () => { rerender(<Pulse />); });
      // Advance past the 300 ms debounce so Gamma's getLaunchStatus call fires.
      await act(async () => { jest.advanceTimersByTime(350); });

      // ── Resolve out of order: A first (stale, cancelled) ──────────────────
      await act(async () => {
        resolveAlpha({ ok: true, data: { availableNowCount: 5 } });
        // Flush microtasks so the .then() in the cancelled effect runs.
        await Promise.resolve();
      });

      // Count for Alpha (5) must NOT appear — its effect was already cancelled.
      // "Local buddies available" is only shown when count > 0.
      expect(queryByText('Local buddies available')).toBeNull();
      // Still loading Gamma.
      expect(queryByText('Checking availability…')).toBeTruthy();

      // ── Resolve B (stale, cancelled) ──────────────────────────────────────
      await act(async () => {
        resolveBeta({ ok: true, data: { availableNowCount: 3 } });
        await Promise.resolve();
      });

      // Beta's count (3) must also not appear.
      expect(queryByText('Local buddies available')).toBeNull();
      expect(queryByText('Checking availability…')).toBeTruthy();

      // ── Resolve C (the live request) ──────────────────────────────────────
      await act(async () => {
        resolveGamma({ ok: true, data: { availableNowCount: 0 } });
        await Promise.resolve();
      });

      // Gamma returned 0 buddies — the "no buddies" message for Gamma must show.
      expect(queryByText(/No buddies online right now in Gamma City/)).toBeTruthy();
      // Stale positive count from Alpha/Beta must still be absent.
      expect(queryByText('Local buddies available')).toBeNull();
      // Loading indicator must be gone.
      expect(queryByText('Checking availability…')).toBeNull();
    },
  );

  it(
    'count IS applied when the single active request resolves without any cancellation',
    async () => {
      // Baseline: one city, one request, resolves after the debounce fires.
      mockActiveCity = 'Solo City';
      let resolveSolo!: (v: any) => void;
      const soloPromise = new Promise<any>((res) => { resolveSolo = res; });
      mockGetLaunchStatus.mockReturnValue(soloPromise);

      const Pulse = require('../index.tsx').default;
      const { queryByText } = await render(<Pulse />);
      // Advance past the 300 ms debounce so getLaunchStatus is actually called.
      await act(async () => { jest.advanceTimersByTime(350); });

      expect(queryByText('Checking availability…')).toBeTruthy();

      await act(async () => {
        resolveSolo({ ok: true, data: { availableNowCount: 4 } });
        await Promise.resolve();
      });

      // Count=4 → "Local buddies available" must appear (count > 0 path).
      expect(queryByText('Local buddies available')).toBeTruthy();
      expect(queryByText('Checking availability…')).toBeNull();
    },
  );

  it(
    'debounce — switching city 3 times rapidly fires getLaunchStatus only once',
    async () => {
      // Simulates a user scrolling rapidly through a city picker: A → B → C all
      // happen within the 300 ms debounce window. Only the final city (C) should
      // produce a getLaunchStatus call; A and B are swallowed by the debounce.
      mockGetLaunchStatus.mockReturnValue(new Promise(() => {})); // never resolves

      mockActiveCity = 'Alpha City';
      const Pulse = require('../index.tsx').default;
      const { rerender } = await render(<Pulse />);
      // Time has NOT advanced — Alpha's 300 ms debounce timer is still running.

      // Switch to Beta before 300 ms elapses (cancels Alpha's timer).
      mockActiveCity = 'Beta City';
      await act(async () => { rerender(<Pulse />); });

      // Switch to Gamma before 300 ms elapses (cancels Beta's timer).
      mockActiveCity = 'Gamma City';
      await act(async () => { rerender(<Pulse />); });

      // No time has passed — getLaunchStatus must not have been called yet.
      expect(mockGetLaunchStatus).toHaveBeenCalledTimes(0);

      // Advance past the 300 ms debounce — only Gamma's timer fires.
      await act(async () => { jest.advanceTimersByTime(350); });

      // Exactly one call, for the final city only.
      expect(mockGetLaunchStatus).toHaveBeenCalledTimes(1);
      expect(mockGetLaunchStatus).toHaveBeenCalledWith('Gamma City');
    },
  );

});
