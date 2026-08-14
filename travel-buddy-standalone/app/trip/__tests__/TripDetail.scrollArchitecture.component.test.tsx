/**
 * Trip Detail (app/trip/[id].tsx) — scroll-architecture regression test.
 *
 * Confirms that after Task #1519, the topBar (back-nav + "My Trip" label) is
 * rendered INSIDE the primary ScrollView — NOT as a sibling View pinned above.
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
  useLocalSearchParams: () => ({ id: 'trip-test-1' }),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// NOTE: src/ is 3 directories up from app/trip/__tests__/:
//   __tests__ → trip → app → package-root → src/

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Bottom inset ──────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => 130,
  useLayoverAwareBottomInset: () => 130,
}));

// ── Session ───────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'u1' }),
}));

// ── Rent-a-buddy flag ─────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

// ── Stamp toast ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/stamps/StampEarnedToast', () => ({
  useStampToast: () => ({ checkForNewStamps: jest.fn() }),
}));

// ── Backend hooks — data inline in factory to avoid jest.mock hoisting issue ──
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBackend', () => ({
  useTrip: () => ({
    data: {
      id: 'trip-test-1',
      title: 'Test Trip',
      destinationCity: 'Lisbon',
      destinationCountry: 'Portugal',
      neighborhoods: [],
      startDate: '2026-08-01',
      endDate: '2026-08-10',
      status: 'planning',
      visibility: 'public',
      travelStyle: 'balanced',
      openToMeet: true,
      ownerId: 'u1',
      coverUrl: null,
      coverMediaType: null,
      progress: 0,
      tripNotes: null,
    },
    loading: false,
  }),
  usePendingTripInvites: () => ({ invites: [] }),
}));

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/safeReturn', () => ({
  getActiveSession: jest.fn().mockResolvedValue({ session: null }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/messaging', () => ({
  openTripChat: jest.fn(),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/memories', () => ({
  getTripMemory:    jest.fn().mockResolvedValue({ ok: false }),
  createTripMemory: jest.fn(),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/events', () => ({
  getEventsNearTrip: jest.fn().mockResolvedValue({ ok: false }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/trips', () => ({
  updateTrip:           jest.fn(),
  createInviteLink:     jest.fn(),
  getTripMemberRole:    jest.fn().mockResolvedValue(null),
}));

// ── ScreenErrorBoundary — passthrough ─────────────────────────────────────────
// @/ resolves to package root via jest.config.js moduleNameMapper.
// NOTE: intentional stub — not under test here.
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

// ── Heavy sub-components — null stubs ─────────────────────────────────────────
// NOTE: React.forwardRef cannot be referenced inside jest.mock factories
// (factories are hoisted; React import binding is not yet bound).
// Use require('react').forwardRef inside the factory instead.
jest.mock('../../../src/components/TripPage', () => ({
  TripHero:                   () => null,
  TodayNextUp:                () => null,
  SavedIdeas:                 () => null,
  TripSavedPlacesSection:     () => null,
  CompassTripBrief:           () => null,
  CompassBriefErrorBoundary:  ({ children }: any) => children,
  TripStamps:                 () => null,
  TripPostsSection:           () => null,
  TripCrewSection:            () => null,
  TripCircle:                 () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/safeReturn/ActiveSafeReturnCard',  () => ({ ActiveSafeReturnCard:   () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/safeReturn/SafeReturnSetupSheet',  () => ({ SafeReturnSetupSheet:   () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/safeReturn/MissedCheckinPrompt',   () => ({ MissedCheckinPrompt:    () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/TripPlanSection',                  () => ({ TripPlanSection:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/TripAvailabilitySection',          () => ({ TripAvailabilitySection: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ReviewsSection',                   () => ({ ReviewsSection:          () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/DailyBriefCard',                   () => ({ DailyBriefCard:          () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ConciergeCommandBar',              () => ({
  ConciergeCommandBar: require('react').forwardRef((_p: any, _r: any) => null),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/MeetupCreationSheet',  () => ({ MeetupCreationSheet:  () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/TripInviteSheet',      () => ({ TripInviteSheet:      () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/TripInviteLinksSheet', () => ({ TripInviteLinksSheet: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet: () => null }));

import TripDetail from '../[id].tsx';

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

describe('Trip Detail screen — scroll architecture', () => {
  it('topBar ("My Trip" label) is inside the primary ScrollView — not pinned above it', async () => {
    const { toJSON } = await render(<TripDetail />);
    await act(async () => {});

    const tree = toJSON() as any;
    const scrollViews = findScrollViews(tree);
    expect(scrollViews.length).toBeGreaterThan(0);

    // "My Trip" back-button text must appear within the ScrollView subtree.
    const titleInScroll = scrollViews.some((sv) => subtreeHasText(sv, 'My Trip'));
    expect(titleInScroll).toBe(true);
  });

  it('root View has no non-overlay sibling above the ScrollView', async () => {
    const { toJSON } = await render(<TripDetail />);
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
