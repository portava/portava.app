/**
 * census-layover L267 — a layover started FROM a trip belongs to that trip.
 *
 * The trip screen's "Layover at this destination?" banner opened
 * `LayoverModeSheet` with `initialCity` and nothing else. The sheet sends
 * `tripId: tripId ?? null`, so every layover started from a trip was created
 * UNLINKED: the server's trip-timeline mirror (`mirrorSessionToTrip`) never ran,
 * "Ask locals" on the dashboard could never post to the trip chat (it needs
 * `session.tripId`), and the session carried no trip scope for the presence
 * gate. The trip screen knew the trip id the whole time.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { render, act, screen, fireEvent } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-router ───────────────────────────────────────────────────────────────
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (...args: unknown[]) => mockPush(...args), back: jest.fn() },
  useLocalSearchParams: () => ({ id: 'trip-abc' }),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => jest.fn(),
  NAV_BAR_FILLER_HEIGHT: 96,
}));

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

// ── Session — mutable so both auth states can be exercised ────────────────────
let mockSessionValue: { isAuthed: boolean; configured: boolean; userId: string | null } = {
  isAuthed: true,
  configured: true,
  userId: 'u1',
};
// NOTE: intentional stub — the mutable mockSessionValue is the thing under test.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => mockSessionValue,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/stamps/StampEarnedToast', () => ({
  useStampToast: () => ({ checkForNewStamps: jest.fn() }),
}));

// ── Backend hooks ─────────────────────────────────────────────────────────────
const mockReloadTrip = jest.fn().mockResolvedValue(undefined);
// NOTE: intentional stub — fixed trip fixture; not under test here.
jest.mock('../../../src/hooks/useBackend', () => ({
  useTrip: () => ({
    data: {
      id: 'trip-abc',
      title: 'Layover Link Test Trip',
      destinationCity: 'Lisbon',
      destinationCountry: 'Portugal',
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

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/tripIntel', () => ({
  ...jest.requireActual('../../../src/services/tripIntel'),
  fetchTripReadiness: jest.fn().mockResolvedValue({ state: 'off' }),
}));
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

// NOTE: intentional stub — not under test here.
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

// ── Heavy sub-components — null stubs ─────────────────────────────────────────
// NOTE: intentional stubs — these render null so the "Remind me" action bar
// (which lives in TripDetail's own JSX, not any of these sub-components) is
// the only thing under test. Deliberately exhaustive per-name replacements.
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
jest.mock('../../../src/features/trips/planning/TripPlanSection',                  () => ({ TripPlanSection:         () => null }));
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
// The sheet is the thing under test's RECEIVER: every render's props are kept
// so the case can read what the trip screen handed it.
const mockSheetProps: Array<Record<string, unknown>> = [];
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({
  LayoverModeSheet: (props: Record<string, unknown>) => { mockSheetProps.push(props); return null; },
}));

import TripDetail from '../[id].tsx';

describe('Trip Detail screen — the layover banner links the layover to the trip', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockSheetProps.length = 0;
    mockSessionValue = { isAuthed: true, configured: true, userId: 'u1' };
  });

  it('opens the layover sheet WITH this trip\'s id, so the session is created linked', async () => {
    await render(<TripDetail />);
    await act(async () => {});

    await fireEvent.press(screen.getByText('Layover at this destination?'));
    await act(async () => {});

    const opened = mockSheetProps.filter((p) => p.visible === true);
    expect(opened.length).toBeGreaterThan(0);
    expect(opened[opened.length - 1].tripId).toBe('trip-abc');
    // The city prefill it always passed is still passed.
    expect(opened[opened.length - 1].initialCity).toBe('Lisbon');
  });
});
