/**
 * Trip Detail (app/trip/[id].tsx) — nav-bar collapse handler wiring test.
 *
 * The scroll-architecture tests (Task #1523) verify the topBar lives inside
 * the ScrollView, but they stub useNavBarScrollHandler to a no-op. This test
 * confirms that the ScrollView's onScroll prop is the handler returned by
 * useNavBarScrollHandler — so removing the wiring causes this test to fail.
 *
 * Strategy:
 *   1. Mock useNavBarScrollHandler to return a jest.fn() spy.
 *   2. Render TripDetail (with a valid trip so it reaches full content).
 *   3. Walk toJSON tree to find the ScrollView whose onScroll === spy.
 *   4. Fire the handler to confirm it reaches the spy.
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
  useLocalSearchParams: () => ({ id: 'trip-test-1' }),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// NOTE: src/ is 3 directories up from app/trip/__tests__/.

// ── Nav-bar collapse — spy factory ────────────────────────────────────────────
// mockNavScrollHandler is returned by useNavBarScrollHandler. trip/[id].tsx
// passes it directly as <ScrollView onScroll={navBarScrollHandler} …>.
const mockNavScrollHandler = jest.fn();
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => mockNavScrollHandler,
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

// ── Backend hooks — include reload and error to match current useTrip shape ───
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
    error: null,
    reload: jest.fn(),
  }),
  usePendingTripInvites: () => ({ invites: [] }),
}));

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/safeReturn', () => ({
  getActiveSession: jest.fn().mockResolvedValue({ session: null }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/messaging',  () => ({ openTripChat:      jest.fn() }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/memories',   () => ({
  getTripMemory:    jest.fn().mockResolvedValue({ ok: false }),
  createTripMemory: jest.fn(),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/events',     () => ({
  getEventsNearTrip: jest.fn().mockResolvedValue({ ok: false }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/trips',      () => ({
  updateTrip:           jest.fn(),
  createInviteLink:     jest.fn(),
  getTripMemberRole:    jest.fn().mockResolvedValue(null),
}));

// ── ScreenErrorBoundary ───────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

// ── Heavy sub-components — null stubs ─────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/TripPage', () => ({
  TripHero:                  () => null,
  TodayNextUp:               () => null,
  SavedIdeas:                () => null,
  TripSavedPlacesSection:    () => null,
  CompassTripBrief:          () => null,
  CompassBriefErrorBoundary: ({ children }: any) => children,
  TripStamps:                () => null,
  TripPostsSection:          () => null,
  TripCrewSection:           () => null,
  TripCircle:                () => null,
  TripMapPreview:            () => null,
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
jest.mock('../../../src/components/MeetupCreationSheet',   () => ({ MeetupCreationSheet:   () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/TripInviteSheet',       () => ({ TripInviteSheet:       () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/TripInviteLinksSheet',  () => ({ TripInviteLinksSheet:  () => null }));
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

// ── Fake scroll event ─────────────────────────────────────────────────────────
const FAKE_SCROLL_EVENT = {
  nativeEvent: { contentOffset: { y: 150 }, contentSize: { height: 4000 }, layoutMeasurement: { height: 900 } },
} as any;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Trip Detail screen — nav-bar scroll handler wiring', () => {
  beforeEach(() => {
    mockNavScrollHandler.mockClear();
  });

  it('primary ScrollView onScroll prop is the useNavBarScrollHandler result', async () => {
    const { toJSON } = await render(<TripDetail />);
    await act(async () => {});

    const tree = toJSON() as any;
    const scrollViews = findScrollViews(tree);

    // trip/[id].tsx: <ScrollView onScroll={navBarScrollHandler} …>
    // navBarScrollHandler IS mockNavScrollHandler — identity match.
    const primary = scrollViews.find((sv) => sv.props?.onScroll === mockNavScrollHandler);
    expect(primary).toBeDefined();
  });

  it('firing the primary ScrollView onScroll invokes the collapse handler', async () => {
    const { toJSON } = await render(<TripDetail />);
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
