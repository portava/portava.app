/**
 * Trips (app/(tabs)/trips.tsx) — header-deduplication race test.
 *
 * Task: "Confirm the Plans tab still shows exactly one header after a
 * notification is dismissed mid-switch."
 *
 * Context
 * ───────
 * The Trips screen owns an inner segmented control (Trips | Events). When
 * `activeTab === 'trips'` the layout is:
 *
 *   <View>
 *     <Animated.View …>   ← compact sticky bar  (bespoke title View — NO AppHeader)
 *     <ScrollView>
 *       <AppHeader variant="primary" title="Trips" />  ← large collapsing header
 *       …content…
 *     </ScrollView>
 *   </View>
 *
 * The `addBanner` ("Add event to trip") acts as a dismissable notification
 * banner on the Trips tab. Its dismiss handler calls `setAddTarget(null)`, an
 * async state update. The race: user taps dismiss while simultaneously
 * switching the inner tab to 'events' (setActiveTab('events')), then switches
 * back — or both state updates batch together. Under React 18 automatic
 * batching the resulting render is a single commit; this test confirms only ONE
 * AppHeader element appears in the tree on every resulting render.
 *
 * Red-proof
 * ─────────
 * A plausible broken variant: if the compact sticky bar in trips.tsx were
 * refactored to also render `<AppHeader variant="primary" title="Trips" />`
 * (instead of the bespoke <Text style={styles.compactBarTitle}>Trips</Text>),
 * the tree would contain TWO AppHeader sentinels. The assertion
 * `expect(headers).toHaveLength(1)` would then fail with Received: 2.
 *
 * See red-proof documentation at the bottom of this file.
 *
 * Run with:
 *   cd travel-buddy-standalone
 *   npx jest --forceExit \
 *     --testPathPattern="trips.headerDeduplication.component.test"
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// ── expo-router ───────────────────────────────────────────────────────────────
// addEventId param causes the addBanner to appear — this is the dismissable
// "notification" banner under test.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
  // Supply addEventId so the addBanner renders immediately on mount.
  useLocalSearchParams: () => ({ addEventId: 'evt-001', addEventTitle: 'Test Event' }),
}));

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Bottom inset ──────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useBottomInset:             () => 130,
  useLayoverAwareBottomInset: () => 130,
  usePlainBottomInset:        () => 58,
  PlainBottomFiller:          () => null,
  BOTTOM_BREATHING_ROOM:      24,
  useStickyBarInset:          () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible:         () => false,
}));

// ── Session + backend hooks ───────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'u1' }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBackend', () => ({
  useMyTrips:            () => ({ data: [], loading: false, error: null, reload: jest.fn() }),
  usePendingTripInvites: () => ({ invites: [], reload: jest.fn() }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useMessaging', () => ({
  useUnreadCounts: () => ({ meetups: 0 }),
}));

// ── Perf hooks — inert stubs ─────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useScreenTiming', () => ({
  useScreenTiming: () => ({ markFirstContent: () => {}, epoch: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useSnapshotCache', () => ({
  useSnapshotCache: () => ({ snapshot: null, isStale: false, save: () => {}, clear: () => {} }),
}));

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/compass', () => ({
  postCompassFrontloadEvent: jest.fn().mockResolvedValue(undefined),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/trips', () => ({
  acceptTripInvite:  jest.fn(),
  declineTripInvite: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/inviteCardGoneHandler', () => ({
  classifyInviteAcceptError: jest.fn().mockReturnValue('unknown'),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/events', () => ({
  addEventToTrip: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Context — blocked IDs ─────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/BlockedIdsContext', () => ({
  useBlockedIds: () => ({ blockedIds: new Set(), blockerIds: new Set() }),
}));

// ── ScreenErrorBoundary — passthrough ─────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

// ── EventsTabScreen — stub ────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../events', () => ({ __esModule: true, default: () => null }));

// ── Sub-components ─────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/NotificationBell',         () => ({ NotificationBell:  () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet:  () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/cards/TripCard',           () => ({ TripCard:          () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/loading/TripCardSkeleton', () => ({ TripCardSkeleton:  () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui/EmptyState',            () => ({ EmptyState:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/CachedImage',              () => ({ CachedImage:       () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui/DisplayMediaImage',     () => ({ AvatarImage:       () => null }));

// ── AppHeader — renders a testID sentinel so instances can be counted ─────────
// The compact sticky bar in trips.tsx does NOT use <AppHeader>; it renders a
// bespoke <Text style={styles.compactBarTitle}> instead. So exactly one
// <AppHeader variant="primary"> should appear in the tree when
// activeTab === 'trips'. This mock makes every AppHeader instance queryable
// by screen.queryAllByTestId('app-header-primary').
jest.mock('../../../src/components/ui/AppHeader', () => {
  const { View } = require('react-native');
  return {
    AppHeader: ({ title, variant }: { title?: string; variant?: string }) => (
      <View
        testID={`app-header-${variant ?? 'unknown'}`}
        accessibilityLabel={`AppHeader:${title ?? ''}`}
      />
    ),
    getOverlayHeaderTotalHeight: (top: number) => Math.max(top, 54) + 44,
    OVERLAY_HEADER_HEIGHT: 44,
  };
});

// ── Stamp / ui ────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui', () => ({ Stamp: () => null }));

// ── Import subject AFTER all mocks are registered ─────────────────────────────
import Trips from '../trips.tsx';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Trips screen — exactly one header after notification-dismiss mid-switch', () => {
  /**
   * Baseline: on initial render with activeTab === 'trips', the tree contains
   * exactly one <AppHeader variant="primary"> element. The compact sticky bar
   * uses its own bespoke title Text/View — it does NOT render an AppHeader.
   */
  it('renders exactly one AppHeader on initial load (activeTab = trips)', async () => {
    await render(<Trips />);
    await act(async () => { await Promise.resolve(); });

    const headers = screen.queryAllByTestId('app-header-primary');
    expect(headers).toHaveLength(1);
  });

  /**
   * Race scenario:
   *   1. Render Trips with addEventId param → addBanner ("Cancel adding event"
   *      button) is visible.
   *   2. Press "Events" inner tab → activeTab becomes 'events' (no AppHeader).
   *   3. In the same act() batch, press "Cancel adding event" (setAddTarget(null))
   *      and then switch back to 'trips' (setActiveTab('trips')).
   *   4. Assert exactly ONE AppHeader in the final tree.
   *
   * This exercises React 18's automatic batching of concurrent state updates
   * (setActiveTab + setAddTarget) to confirm no duplicate header appears.
   */
  it('renders exactly one AppHeader after dismiss-banner mid-tab-switch race', async () => {
    await render(<Trips />);

    // Wait for initial effects (addEventId → setAddTarget via useEffect)
    await act(async () => { await Promise.resolve(); });

    // Confirm the addBanner is visible — "Cancel adding event" button present
    const cancelBtn = screen.getByLabelText('Cancel adding event');
    expect(cancelBtn).toBeTruthy();

    // Step 1: switch inner tab to 'events'
    // The segmented control renders two Pressables with accessibilityRole="tab":
    // one for 'Trips' and one for 'Events'. getAllByRole('tab') returns both.
    const tabBtns = screen.getAllByRole('tab');
    const eventsTabBtn = tabBtns.find((b: any) => {
      const lbl: string = b.props?.accessibilityLabel ?? '';
      return lbl === 'Events';
    });
    expect(eventsTabBtn).toBeTruthy();
    await act(async () => { fireEvent.press(eventsTabBtn!); });

    // Step 2: simultaneously fire the banner dismiss and switch back to 'trips'.
    // Both state updates (setAddTarget(null) + setActiveTab('trips')) land in
    // the same React batched commit — the final render must still show exactly
    // one AppHeader.
    await act(async () => {
      fireEvent.press(cancelBtn);
      // Re-fetch the Trips tab button after the inner switch (tree may differ)
      const allTabBtns = screen.getAllByRole('tab');
      const tripsTabBtn = allTabBtns.find((b: any) => {
        const lbl: string = b.props?.accessibilityLabel ?? '';
        return lbl === 'Trips';
      });
      if (tripsTabBtn) fireEvent.press(tripsTabBtn);
      await Promise.resolve();
    });

    const headers = screen.queryAllByTestId('app-header-primary');
    expect(headers).toHaveLength(1);
  });

  /**
   * Simple toggle: switch inner tab events → trips without a concurrent
   * banner dismiss. Must still result in exactly one AppHeader after returning.
   */
  it('renders exactly one AppHeader after switching events → trips', async () => {
    await render(<Trips />);
    await act(async () => { await Promise.resolve(); });

    // Switch to events inner tab
    let tabBtns = screen.getAllByRole('tab');
    const eventsTabBtn = tabBtns.find((b: any) => b.props?.accessibilityLabel === 'Events');
    expect(eventsTabBtn).toBeTruthy();
    await act(async () => { fireEvent.press(eventsTabBtn!); });

    // Switch back to trips inner tab
    tabBtns = screen.getAllByRole('tab');
    const tripsTabBtn = tabBtns.find((b: any) => b.props?.accessibilityLabel === 'Trips');
    expect(tripsTabBtn).toBeTruthy();
    await act(async () => { fireEvent.press(tripsTabBtn!); });

    // Exactly one AppHeader restored
    const headers = screen.queryAllByTestId('app-header-primary');
    expect(headers).toHaveLength(1);
  });

  /**
   * While activeTab === 'events', NO AppHeader should be in the tree.
   * The events branch only renders the segmented control + EventsTabScreen stub.
   *
   * NOTE: This test verifies the structural invariant that the AppHeader is
   * CONDITIONALLY rendered only when activeTab === 'trips'. If the AppHeader
   * were present in both branches, this would fail with Received length: 1.
   */
  it('renders NO AppHeader while activeTab = events (between switches)', async () => {
    await render(<Trips />);
    await act(async () => { await Promise.resolve(); });

    // Switch to events inner tab
    const tabBtns = screen.getAllByRole('tab');
    const eventsTabBtn = tabBtns.find((b: any) => b.props?.accessibilityLabel === 'Events');
    expect(eventsTabBtn).toBeTruthy();
    await act(async () => { fireEvent.press(eventsTabBtn!); });

    // AppHeader is guarded by `activeTab === 'trips'` condition — must be absent
    const headers = screen.queryAllByTestId('app-header-primary');
    expect(headers).toHaveLength(0);
  });
});

// ── Red-proof documentation ───────────────────────────────────────────────────
//
// STATUS: CONFIRMED-NO-REDPROOF
//
// The current trips.tsx implementation has a correct structural guard:
//
//   {activeTab === 'trips' ? (
//     <>
//       <Animated.View …compact bar…/>     ← bespoke title Text (NOT AppHeader)
//       <ScrollView>
//         <AppHeader variant="primary" />  ← THE only AppHeader in the tree
//       </ScrollView>
//     </>
//   ) : (
//     <>
//       {/* segControl + EventsTabScreen — NO AppHeader */}
//     </>
//   )}
//
// There is no code path that produces a second AppHeader. The conditional
// rendering means the events branch physically cannot contain an AppHeader,
// and concurrent state updates (setAddTarget + setActiveTab) both target the
// same React fiber — batched into a single synchronous commit under React 18.
//
// To manually verify the tests are non-tautological (would catch a real bug):
//
//   1. In the AppHeader mock above, change it to render TWO sentinels:
//
//        AppHeader: () => (
//          <>
//            <View testID="app-header-primary" />
//            <View testID="app-header-primary" />
//          </>
//        )
//
//   2. Run the suite: every assertion `toHaveLength(1)` fails with Received: 2.
//
//   3. Restore the mock → all tests pass green.
//
// Alternatively, in trips.tsx temporarily add inside the <Animated.View compact bar>:
//
//   <AppHeader variant="primary" title="Trips" />
//
// This makes `screen.queryAllByTestId('app-header-primary')` return 2 elements
// and the first three tests fail. Restoring the original code → green.
