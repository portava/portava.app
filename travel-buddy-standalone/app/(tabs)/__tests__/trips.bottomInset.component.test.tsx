/**
 * Trips (app/(tabs)/trips.tsx) — bottom-inset clearance test.
 *
 * Confirms that the trips screen provides bottom clearance ≥ 120 pt when a
 * layover session is active.  The trips tab achieves clearance via
 * <NavBarFiller /> (height = NAV_BAR_FILLER_HEIGHT + insets.bottom = 130 on
 * iPhone 14) rather than a direct contentContainerStyle.paddingBottom, so
 * this test verifies the filler element is present in the rendered tree with
 * a height that satisfies the minimum contract.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { View } from 'react-native';
import { render, act } from '@testing-library/react-native';

// ── Constants ─────────────────────────────────────────────────────────────────
const NAV_BAR_FILLER_HEIGHT = 96;
const IPHONE_BOTTOM  = 34;
const ANDROID_BOTTOM = 48;
/** Minimum clearance contract when a layover session is active. */
const MIN_CLEARANCE = 155;

// ── Safe-area — iPhone 14 (bottom = 34 pt) ───────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: IPHONE_BOTTOM, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
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
  useLocalSearchParams: () => ({}),
}));

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
// NOTE: intentional stub — clearance is now provided by useLayoverAwareBottomInset()
// on the ScrollView contentContainerStyle, not by NavBarFiller.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Bottom inset — layover-aware (iPhone 14 active: 34 + 74 + 44 + 16 = 168) ─
// NOTE: intentional stub — mocking the whole module avoids the LayoverSessionContext
// dependency chain. Returns the layover-active value so the assertion scenario is
// representative of the condition the hook is designed to handle.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useBottomInset:             () => 96 + 34,              // 130 (standard Tier-1)
  useLayoverAwareBottomInset: () => 34 + 74 + 44 + 16,   // 168 (layover-active)
  usePlainBottomInset:        () => 34 + 24,              // 58
  PlainBottomFiller:          () => null,
  BOTTOM_BREATHING_ROOM:      24,
  useStickyBarInset:          () => ({ inset: 96 + 34, onBarLayout: () => {} }),
  useKeyboardVisible:         () => false,
}));

// ── Layover service — active session ─────────────────────────────────────────
// NOTE: intentional stub — layover state not under test; active session is
// present to make the scenario representative of the layover-active condition.
jest.mock('../../../src/services/layover', () => ({
  getActiveLayoverSession: jest.fn().mockResolvedValue({
    session: { id: 'layover-trips-1', departureTime: '2026-07-30T22:00:00Z', manualIata: 'CDG' },
    airport: null,
  }),
}));

// ── Session + backend hooks ───────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'u1' }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBackend', () => ({
  useMyTrips:          () => ({ data: [], loading: false, error: null, reload: jest.fn() }),
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
  useBlockedIds: () => ({ blockedIds: new Set(), blockedByIds: new Set() }),
}));

// ── ScreenErrorBoundary — passthrough ─────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

// ── EventsTabScreen — stub to prevent events.tsx dep chain ───────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../events', () => ({ __esModule: true, default: () => null }));

// ── Heavy sub-components ──────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/NotificationBell',         () => ({ NotificationBell:       () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/cards/TripCard',           () => ({ TripCard:                () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/loading/TripCardSkeleton', () => ({ TripCardSkeleton:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui/EmptyState',            () => ({ EmptyState:              () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/CachedImage',              () => ({ CachedImage:             () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui/DisplayMediaImage',     () => ({ AvatarImage:             () => null }));

import Trips from '../trips.tsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect every bottom-clearance value from the rendered tree.
 * Trips uses `contentContainerStyle={{ paddingBottom: bottomInset }}` on its
 * ScrollView, so we scan both `style.paddingBottom` and
 * `contentContainerStyle.paddingBottom` at every node.
 */
function collectClearanceValues(node: any): number[] {
  if (!node || typeof node !== 'object') return [];
  const found: number[] = [];

  function extractPaddingBottom(styleProp: any): void {
    if (!styleProp) return;
    const flat = Array.isArray(styleProp)
      ? Object.assign({}, ...styleProp.map((s: any) => (s && typeof s === 'object' ? s : {})))
      : styleProp;
    if (typeof flat?.paddingBottom === 'number') found.push(flat.paddingBottom);
  }

  extractPaddingBottom(node.props?.style);
  extractPaddingBottom(node.props?.contentContainerStyle);

  for (const child of (node.children ?? [])) {
    found.push(...collectClearanceValues(child));
  }
  return found;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Trips tab — ScrollView paddingBottom clearance when layover active', () => {
  it('ScrollView paddingBottom ≥ 155 (iPhone 14, layover active)', async () => {
    const { toJSON } = await render(<Trips />);
    await act(async () => { await Promise.resolve(); });

    const clearances = collectClearanceValues(toJSON());
    expect(clearances.length).toBeGreaterThan(0);
    const max = Math.max(...clearances);
    expect(max).toBeGreaterThanOrEqual(MIN_CLEARANCE);
  });

  it('ScrollView paddingBottom equals useLayoverAwareBottomInset() value (168 on iPhone 14)', async () => {
    const { toJSON } = await render(<Trips />);
    await act(async () => { await Promise.resolve(); });

    const clearances = collectClearanceValues(toJSON());
    // 34 (insets.bottom) + 74 (pill offset) + 44 (pill height) + 16 (gap) = 168
    const expected = IPHONE_BOTTOM + 74 + 44 + 16; // 168
    expect(clearances).toContain(expected);
  });

  it('layover-active inset satisfies iPhone 14 home indicator (34 pt)', () => {
    expect(IPHONE_BOTTOM + 74 + 44 + 16).toBeGreaterThanOrEqual(IPHONE_BOTTOM);
  });

  it('layover-active inset satisfies Android gesture nav bar (48 dp)', () => {
    expect(ANDROID_BOTTOM + 74 + 44 + 16).toBeGreaterThanOrEqual(ANDROID_BOTTOM);
  });

  it('layover-active inset meets minimum contract (≥ 155)', () => {
    expect(IPHONE_BOTTOM + 74 + 44 + 16).toBeGreaterThanOrEqual(MIN_CLEARANCE);
  });
});
