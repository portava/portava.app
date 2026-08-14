/**
 * Trips (app/(tabs)/trips.tsx) — nav-bar collapse handler wiring test.
 *
 * The scroll-architecture tests (Task #1523) verify the ScreenHeader lives
 * inside the ScrollView, but they mock useNavBarScrollHandler to a no-op.
 * This test confirms that the primary ScrollView's onScroll prop is the
 * handler returned by useNavBarScrollHandler — so removing the wiring fails.
 *
 * Strategy:
 *   1. Mock useNavBarScrollHandler to return a jest.fn() spy.
 *   2. Render Trips; walk the toJSON tree to find the ScrollView whose
 *      onScroll prop === spy (trips.tsx passes navScrollHandler directly).
 *   3. Fire the handler and confirm the spy is invoked.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// NOTE: all src/ modules are 3 directories up from app/(tabs)/__tests__/.

// ── Nav-bar collapse — spy factory ────────────────────────────────────────────
// mockNavScrollHandler is returned by useNavBarScrollHandler. trips.tsx passes
// it directly as <ScrollView onScroll={navScrollHandler} …>, so an identity
// check in the toJSON props is reliable.
const mockNavScrollHandler = jest.fn();
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => mockNavScrollHandler,
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Session + backend hooks ───────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'u1' }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBackend', () => ({
  useMyTrips: () => ({ data: [], loading: false, error: null, reload: jest.fn() }),
  usePendingTripInvites: () => ({ invites: [], reload: jest.fn() }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useMessaging', () => ({
  useUnreadCounts: () => ({ meetups: 0 }),
}));

// ── Screen timing / snapshot cache — stub ─────────────────────────────────────
// trips.tsx gained useScreenTiming + useSnapshotCache. The real useSnapshotCache
// returns a `save` that calls setState, and the persistence effect fires on every
// render (useMyTrips returns a fresh []), so the unmocked pair drives an infinite
// setState loop → OOM. Stub both to inert values (not under test here).
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

// ── ScreenErrorBoundary — passthrough ─────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

// ── EventsTabScreen — stub ────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../events', () => ({ __esModule: true, default: () => null }));

// ── Sub-components ────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/NotificationBell',         () => ({ NotificationBell:  () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet:   () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ScreenHeader',             () => ({
  ScreenHeader: ({ title }: { title: string }) => {
    const { Text } = require('react-native');
    return <Text>{title}</Text>;
  },
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui', () => ({ Stamp: () => null }));

import Trips from '../trips.tsx';

// ── Tree-walking helpers ───────────────────────────────────────────────────────

/** Find all ScrollView nodes (including RCTScrollView) anywhere in the tree. */
function findScrollViews(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  const res: any[] = [];
  if (node.type === 'ScrollView' || node.type === 'RCTScrollView') res.push(node);
  for (const child of (node.children ?? [])) res.push(...findScrollViews(child));
  return res;
}

// ── Fake scroll event ─────────────────────────────────────────────────────────
const FAKE_SCROLL_EVENT = {
  nativeEvent: { contentOffset: { y: 120 }, contentSize: { height: 2000 }, layoutMeasurement: { height: 800 } },
} as any;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Trips screen — nav-bar scroll handler wiring', () => {
  beforeEach(() => {
    mockNavScrollHandler.mockClear();
  });

  it('primary ScrollView onScroll prop is the useNavBarScrollHandler result', async () => {
    const { toJSON } = await render(<Trips />);
    await act(async () => {});

    const tree = toJSON() as any;
    const scrollViews = findScrollViews(tree);

    // trips.tsx: <ScrollView onScroll={navScrollHandler} …>
    // navScrollHandler IS mockNavScrollHandler — identity match confirms wiring.
    const primary = scrollViews.find((sv) => sv.props?.onScroll === mockNavScrollHandler);
    expect(primary).toBeDefined();
  });

  it('firing the primary ScrollView onScroll invokes the collapse handler', async () => {
    const { toJSON } = await render(<Trips />);
    await act(async () => {});

    const tree = toJSON() as any;
    const scrollViews = findScrollViews(tree);
    const primary = scrollViews.find((sv) => sv.props?.onScroll === mockNavScrollHandler);
    expect(primary).toBeDefined();

    primary.props.onScroll(FAKE_SCROLL_EVENT);
    expect(mockNavScrollHandler).toHaveBeenCalledTimes(1);
    expect(mockNavScrollHandler).toHaveBeenCalledWith(FAKE_SCROLL_EVENT);
  });
});
