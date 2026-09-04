/**
 * Trip Detail (app/trip/[id].tsx) — pull-to-refresh readiness propagation test.
 *
 * Confirms that when the ScrollView's RefreshControl fires onRefresh,
 * TripReadinessCard receives refresh=true and therefore calls
 * fetchTripReadiness(tripId, true).
 *
 * Strategy:
 *   1. Mock fetchTripReadiness as a jest.fn() spy.
 *   2. Render TripDetail (with a valid trip so it reaches full content).
 *   3. Wait for the initial fetchTripReadiness(tripId, false) call.
 *   4. Find the RefreshControl in the tree and fire its onRefresh callback.
 *   5. Assert fetchTripReadiness was subsequently called with (tripId, true).
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { render, act, waitFor, screen } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ id: 'trip-abc' }),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => jest.fn(),
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

// ── Backend hooks ─────────────────────────────────────────────────────────────
const mockReloadTrip = jest.fn().mockResolvedValue(undefined);
// NOTE: intentional stub — not under test here; only reload spy and trip shape matter.
jest.mock('../../../src/hooks/useBackend', () => ({
  useTrip: () => ({
    data: {
      id: 'trip-abc',
      title: 'Readiness Test Trip',
      destinationCity: 'Tokyo',
      destinationCountry: 'Japan',
      neighborhoods: [],
      startDate: '2026-09-01',
      endDate: '2026-09-10',
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
    reload: mockReloadTrip,
  }),
  usePendingTripInvites: () => ({ invites: [] }),
}));

// ── fetchTripReadiness spy ────────────────────────────────────────────────────
// This is the key mock: we capture every call so we can assert refresh=true.
const mockFetchTripReadiness = jest.fn().mockResolvedValue(null);
jest.mock('../../../src/services/tripIntel', () => ({
  ...jest.requireActual('../../../src/services/tripIntel'),
  fetchTripReadiness: (...args: unknown[]) => mockFetchTripReadiness(...args),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Pull the onRefresh callback from the trip-detail ScrollView's refreshControl prop.
 *
 * toJSON() doesn't serialize event-handler props on RefreshControl nodes, so
 * we reach the fiber instance via testID, then read the refreshControl
 * React-element's props directly — the same pattern used by StampStudioIndex tests.
 */
function getOnRefresh(): (() => void) | undefined {
  const scrollView = screen.getByTestId('trip-detail-scroll');
  return scrollView.props?.refreshControl?.props?.onRefresh as (() => void) | undefined;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Trip Detail screen — pull-to-refresh readiness propagation', () => {
  beforeEach(() => {
    mockFetchTripReadiness.mockClear();
    mockReloadTrip.mockClear();
  });

  it('calls fetchTripReadiness with refresh=false on initial mount', async () => {
    await render(<TripDetail />);
    await act(async () => {});

    await waitFor(() => {
      expect(mockFetchTripReadiness).toHaveBeenCalledWith('trip-abc', false);
    });
  });

  it('calls fetchTripReadiness with (tripId, true) when RefreshControl fires onRefresh', async () => {
    await render(<TripDetail />);
    await act(async () => {});

    // Wait for initial load call
    await waitFor(() => {
      expect(mockFetchTripReadiness).toHaveBeenCalledWith('trip-abc', false);
    });

    mockFetchTripReadiness.mockClear();

    // Reach the live onRefresh handler via the fiber instance
    const onRefresh = getOnRefresh();
    expect(onRefresh).toBeDefined();

    await act(async () => {
      onRefresh!();
    });

    // After pull-to-refresh, fetchTripReadiness must be called with refresh=true
    await waitFor(() => {
      expect(mockFetchTripReadiness).toHaveBeenCalledWith('trip-abc', true);
    });
  });

  it('also reloads trip data (reloadTrip) when RefreshControl fires onRefresh', async () => {
    await render(<TripDetail />);
    await act(async () => {});

    const onRefresh = getOnRefresh();
    expect(onRefresh).toBeDefined();

    await act(async () => {
      onRefresh!();
    });

    await waitFor(() => {
      expect(mockReloadTrip).toHaveBeenCalledTimes(1);
    });
  });
});
