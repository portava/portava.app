/**
 * Trips (app/(tabs)/trips.tsx) — scroll-architecture regression test.
 *
 * Confirms that after Task #1519, the ScreenHeader ("Trips" title) and the
 * segmented control (Trips | Events) are rendered INSIDE the ScrollView —
 * NOT as sibling Views pinned above it.
 *
 * Strategy: render the screen, walk the toJSON tree to find all ScrollView
 * nodes, then check that key text lives within at least one of them.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
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
// Path: __tests__ → (tabs) → app → package-root → src/

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
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

// ── Perf hooks — inert stubs ─────────────────────────────────────────────────
// trips.tsx gained useScreenTiming + useSnapshotCache after this test was
// written. The real useSnapshotCache returns a save() that setStates; with
// the fresh [] identity from the useMyTrips stub above, the persistence
// effect loops → heap exhaustion → worker SIGTERM (same root cause as the
// fixed sibling Trips.navBarScrollHandler).
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useScreenTiming', () => ({
  useScreenTiming: () => ({ markFirstContent: () => {}, epoch: 0 }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useSnapshotCache', () => ({
  useSnapshotCache: () => ({ snapshot: null, isStale: false, save: () => {}, clear: () => {} }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useMessaging', () => ({
  useUnreadCounts: () => ({ meetups: 0 }),
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
// trips.tsx imports from @/components/ScreenErrorBoundary (alias).
// jest.config.js maps ^@/(.*) → <rootDir>/$1 so this key resolves correctly.
// NOTE: intentional stub — not under test here.
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

// ── EventsTabScreen — stub to prevent events.tsx dep chain loading ────────────
// Imported by trips.tsx but only rendered when activeTab === 'events'.
// Must be mocked to avoid unresolvable imports in events.tsx.
// NOTE: intentional stub — not under test here.
jest.mock('../events', () => ({ __esModule: true, default: () => null }));

// ── Heavy sub-components ──────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/NotificationBell',         () => ({ NotificationBell:       () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ScreenHeader',             () => ({
  // Render Text so tree-walking can find the title.
  ScreenHeader: ({ title }: { title: string }) => {
    const { Text } = require('react-native');
    return <Text testID="screen-header-title">{title}</Text>;
  },
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui', () => ({ Stamp: () => null }));

import Trips from '../trips.tsx';

// ── Tree-walking helpers ───────────────────────────────────────────────────────

function findScrollViews(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  const res: any[] = [];
  if (node.type === 'ScrollView' || node.type === 'RCTScrollView') res.push(node);
  for (const child of (node.children ?? [])) res.push(...findScrollViews(child));
  return res;
}

function subtreeHasText(node: any, text: string): boolean {
  if (typeof node === 'string') return node === text;
  if (!node || typeof node !== 'object') return false;
  return (node.children ?? []).some((c: any) => subtreeHasText(c, text));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Trips screen — scroll architecture', () => {
  it('ScreenHeader ("Trips") is inside the primary ScrollView — not pinned above it', async () => {
    const { toJSON } = await render(<Trips />);
    await act(async () => {});

    const tree = toJSON() as any;
    const scrollViews = findScrollViews(tree);
    expect(scrollViews.length).toBeGreaterThan(0);

    // The "Trips" title must appear within the ScrollView subtree.
    const titleInScroll = scrollViews.some((sv) => subtreeHasText(sv, 'Trips'));
    expect(titleInScroll).toBe(true);
  });

  it('segmented control ("Events" tab) is inside the ScrollView — not pinned above it', async () => {
    const { toJSON } = await render(<Trips />);
    await act(async () => {});

    const tree = toJSON() as any;
    const scrollViews = findScrollViews(tree);
    expect(scrollViews.length).toBeGreaterThan(0);

    const eventsInScroll = scrollViews.some((sv) => subtreeHasText(sv, 'Events'));
    expect(eventsInScroll).toBe(true);
  });

  it('root View has no non-overlay header sibling above the ScrollView', async () => {
    const { toJSON } = await render(<Trips />);
    await act(async () => {});

    const tree = toJSON() as any;
    const rootChildren: any[] = Array.isArray(tree?.children) ? tree.children : [];

    let foundScrollView = false;
    let nonOverlayBeforeScroll = false;

    for (const child of rootChildren) {
      if (!child || typeof child !== 'object') continue;
      if (child.type === 'ScrollView' || child.type === 'RCTScrollView') {
        foundScrollView = true;
        break;
      }
      if (child.type === 'RCTModalHostView' || child.type === 'Modal') continue;
      const style = child?.props?.style ?? {};
      const flat = Array.isArray(style)
        ? Object.assign({}, ...style.map((s: any) => (s && typeof s === 'object' ? s : {})))
        : style;
      if (flat.position !== 'absolute') nonOverlayBeforeScroll = true;
    }

    expect(foundScrollView).toBe(true);
    expect(nonOverlayBeforeScroll).toBe(false);
  });
});
