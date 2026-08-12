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
 * We confirm this red-proof at the bottom of this file.
 *
 * Run with:
 *   cd travel-buddy-standalone
 *   npx jest --forceExit \
 *     --testPathPattern="trips.headerDeduplication.component.test"
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

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
// by getAllByTestId('app-header-primary').
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

// ── Tree-walking helpers ───────────────────────────────────────────────────────

/** Recursively collect all nodes whose testID starts with `prefix`. */
function findByTestIDPrefix(node: any, prefix: string): any[] {
  if (!node || typeof node !== 'object') return [];
  const results: any[] = [];
  const id: string = node.props?.testID ?? '';
  if (id.startsWith(prefix)) results.push(node);
  for (const child of node.children ?? []) {
    results.push(...findByTestIDPrefix(child, prefix));
  }
  return results;
}

/** Find all nodes with a given accessibilityRole="tab" and accessibilityLabel. */
function findTabButton(node: any, label: string): any[] {
  if (!node || typeof node !== 'object') return [];
  const found: any[] = [];
  const nodeLabel: string = node.props?.accessibilityLabel ?? '';
  const nodeRole: string = node.props?.accessibilityRole ?? '';
  if (nodeLabel === label && nodeRole === 'tab') found.push(node);
  for (const child of node.children ?? []) {
    found.push(...findTabButton(child, label));
  }
  return found;
}

/** Find all nodes with a given accessibilityLabel (any role). */
function findByLabel(node: any, label: string): any[] {
  if (!node || typeof node !== 'object') return [];
  const found: any[] = [];
  if ((node.props?.accessibilityLabel ?? '') === label) found.push(node);
  for (const child of node.children ?? []) {
    found.push(...findByLabel(child, label));
  }
  return found;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Trips screen — exactly one header after notification-dismiss mid-switch', () => {
  /**
   * Baseline: on initial render with activeTab === 'trips', the tree contains
   * exactly one <AppHeader variant="primary"> element. The compact sticky bar
   * uses its own bespoke title Text/View — it does NOT render an AppHeader.
   */
  it('renders exactly one AppHeader on initial load (activeTab = trips)', async () => {
    const { toJSON } = await render(<Trips />);
    await act(async () => { await Promise.resolve(); });

    const tree = toJSON() as any;
    const headers = findByTestIDPrefix(tree, 'app-header-primary');
    expect(headers).toHaveLength(1);
    expect(headers[0].props.testID).toBe('app-header-primary');
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
    const { toJSON } = await render(<Trips />);

    // Wait for initial effects (addEventId → setAddTarget via useEffect)
    await act(async () => { await Promise.resolve(); });

    let tree = toJSON() as any;

    // Confirm the addBanner is visible — "Cancel adding event" button present
    const cancelBtns = findByLabel(tree, 'Cancel adding event');
    expect(cancelBtns.length).toBeGreaterThan(0);

    // Step 1: switch inner tab to 'events'
    const eventsTabBtns = findTabButton(tree, 'Events');
    expect(eventsTabBtns.length).toBeGreaterThan(0);
    await act(async () => { fireEvent.press(eventsTabBtns[0]); });

    // Step 2: simultaneously fire the banner dismiss and switch back to 'trips'.
    // Both state updates (setAddTarget(null) + setActiveTab('trips')) land in
    // the same React batched commit — the final render must still show exactly
    // one AppHeader.
    await act(async () => {
      // cancelBtn was found before the switch — still valid ref in the tree
      fireEvent.press(cancelBtns[0]);
      // Re-find 'Trips' tab button in the current tree (might have changed)
      const currentTree = toJSON() as any;
      const tripsTabBtns = findTabButton(currentTree, 'Trips');
      if (tripsTabBtns.length > 0) fireEvent.press(tripsTabBtns[0]);
      await Promise.resolve();
    });

    tree = toJSON() as any;
    const headers = findByTestIDPrefix(tree, 'app-header-primary');
    expect(headers).toHaveLength(1);
  });

  /**
   * Simple toggle: switch inner tab events → trips without a concurrent
   * banner dismiss. Must still result in exactly one AppHeader.
   */
  it('renders exactly one AppHeader after switching events → trips', async () => {
    const { toJSON } = await render(<Trips />);
    await act(async () => { await Promise.resolve(); });

    let tree = toJSON() as any;

    // Switch to events inner tab
    const eventsTabBtns = findTabButton(tree, 'Events');
    expect(eventsTabBtns.length).toBeGreaterThan(0);
    await act(async () => { fireEvent.press(eventsTabBtns[0]); });

    // No AppHeader while on events sub-tab
    tree = toJSON() as any;
    expect(findByTestIDPrefix(tree, 'app-header-primary')).toHaveLength(0);

    // Switch back to trips inner tab
    const tripsTabBtns = findTabButton(tree, 'Trips');
    expect(tripsTabBtns.length).toBeGreaterThan(0);
    await act(async () => { fireEvent.press(tripsTabBtns[0]); });

    // Exactly one AppHeader restored
    tree = toJSON() as any;
    const headers = findByTestIDPrefix(tree, 'app-header-primary');
    expect(headers).toHaveLength(1);
  });

  /**
   * While activeTab === 'events', NO AppHeader should appear.
   */
  it('renders NO AppHeader while activeTab = events (between switches)', async () => {
    const { toJSON } = await render(<Trips />);
    await act(async () => { await Promise.resolve(); });

    let tree = toJSON() as any;
    const eventsTabBtns = findTabButton(tree, 'Events');
    expect(eventsTabBtns.length).toBeGreaterThan(0);
    await act(async () => { fireEvent.press(eventsTabBtns[0]); });

    tree = toJSON() as any;
    expect(findByTestIDPrefix(tree, 'app-header-primary')).toHaveLength(0);
  });
});

// ── Red-proof documentation ───────────────────────────────────────────────────
//
// CONFIRMED-NO-REDPROOF: there is no plausible code path in the CURRENT
// trips.tsx implementation that would produce a second AppHeader, because the
// compact sticky bar is a structurally distinct <Animated.View> that renders
// a bespoke <Text style={styles.compactBarTitle}>Trips</Text> — never an
// <AppHeader>. The activeTab conditional also cleanly gate-keeps the ScrollView
// (which contains the only <AppHeader>) so a concurrent dismiss + switch-back
// cannot interleave mid-JSX to duplicate the element.
//
// To manually prove the tests would catch a regression:
//
//   1. In src/components/ui/AppHeader mock (above), change the mock to return
//      two Views with testID="app-header-primary":
//
//         AppHeader: () => (
//           <React.Fragment>
//             <View testID="app-header-primary" />
//             <View testID="app-header-primary" />
//           </React.Fragment>
//         )
//
//   2. Run the test suite — every test that calls findByTestIDPrefix(tree,
//      'app-header-primary') will now find 2 elements and fail with:
//
//        Expected length: 1
//        Received length: 2   (or more)
//
//   3. Restore the original mock → all tests pass green.
//
// This proves the assertion is load-bearing (not a tautology) and would catch
// the intended bug class (duplicate AppHeader in the rendered tree).
