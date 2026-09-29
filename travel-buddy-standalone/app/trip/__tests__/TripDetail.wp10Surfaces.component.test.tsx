/**
 * Trip Detail (app/trip/[id].tsx) — WP-10 collaboration surfaces mounted
 * (census-trips §77): join-request review, ballots, transport policy,
 * lifecycle, shared contents, geofence check-in, post-trip; and "Mark trip as
 * complete" goes through POST /complete (COMPLETE_TRIP), not a status PATCH.
 *
 * Mock setup copied from TripDetail.remindMeEntry.component.test.tsx:
 *
 * Task #3574: trip and saved-place surfaces get a "Remind me" row that
 * pushes into /reminders/new with a preset target so the user never has to
 * re-pick the attachment on the create screen. Pins that:
 *   - the button only renders when authenticated (mirrors the other
 *     owner/auth-gated action-bar buttons already on this screen)
 *   - tapping it pushes exactly one route, to /reminders/new, with
 *     targetType=trip, targetId=<trip id>, and targetLabel=<trip title>
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { render, act, screen, fireEvent } from '@testing-library/react-native';
import { Alert } from 'react-native';

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
      title: 'Remind Me Test Trip',
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
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet: () => null }));


// ── WP-10 cards: marker stubs that echo the props the screen passes ─────────
function mockMarker(id: string) {
  const { Text } = jest.requireActual('react-native');
  return (props: Record<string, unknown>) => <Text testID={id}>{JSON.stringify(props, (k, v) => (typeof v === 'function' ? 'fn' : v))}</Text>;
}
// NOTE: intentional stubs — marker components; the cards have their own suites.
jest.mock('../../../src/features/trips/planning/TripBallotsCard.tsx', () => ({ TripBallotsCard: mockMarker('wp10-ballots') }));
jest.mock('../../../src/features/trips/planning/TripTransportPolicyCard.tsx', () => ({ TripTransportPolicyCard: mockMarker('wp10-transport') }));
jest.mock('../../../src/features/trips/lifecycle/TripLifecycleCard.tsx', () => ({ TripLifecycleCard: mockMarker('wp10-lifecycle') }));
jest.mock('../../../src/features/trips/joinRequests/JoinRequestsList.tsx', () => ({ JoinRequestsList: mockMarker('wp10-join') }));
jest.mock('../../../src/features/trips/sharedContent/TripSharedContentSection.tsx', () => ({ TripSharedContentSection: mockMarker('wp10-shared') }));
jest.mock('../../../src/features/trips/crew/TripGeofenceCard.tsx', () => ({ TripGeofenceCard: mockMarker('wp10-geofence') }));
jest.mock('../../../src/features/trips/closeout/TripPostTripCard.tsx', () => ({ TripPostTripCard: mockMarker('wp10-posttrip') }));
const mockRunLifecycleAction = jest.fn();
jest.mock('../../../src/features/trips/lifecycle/tripLifecycle.ts', () => ({
  ...jest.requireActual('../../../src/features/trips/lifecycle/tripLifecycle.ts'),
  runLifecycleAction: (...a: unknown[]) => mockRunLifecycleAction(...a),
}));

import TripDetail from '../[id].tsx';

const props = (id: string) => JSON.parse(String(screen.getByTestId(id).props.children));

describe('Trip Detail — WP-10 surfaces', () => {
  beforeEach(() => {
    mockSessionValue = { isAuthed: true, configured: true, userId: 'u1' };
    mockRunLifecycleAction.mockReset();
  });

  it('mounts every collaboration surface for the owner, with the owner flag set', async () => {
    await render(<TripDetail />);
    await act(async () => {});
    for (const id of ['wp10-ballots', 'wp10-transport', 'wp10-lifecycle', 'wp10-join', 'wp10-shared', 'wp10-geofence']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(props('wp10-ballots')).toEqual({ tripId: 'trip-abc', isOwner: true });
    expect(props('wp10-join').tripId).toBe('trip-abc');
    expect(props('wp10-lifecycle')).toMatchObject({ tripId: 'trip-abc', isOwner: true, storedStatus: 'planning', exclude: ['complete'] });
    expect(props('wp10-shared')).toEqual({ tripId: 'trip-abc', isHost: true });
    expect(props('wp10-geofence')).toMatchObject({ isOwner: true, isMember: true });
    // The fixture trip ended 2026-09-10, so the post-trip card mounts beside the closeout.
    expect(props('wp10-posttrip')).toEqual({ tripId: 'trip-abc' });
  });

  it('a crew member gets no owner review queue', async () => {
    mockSessionValue = { isAuthed: true, configured: true, userId: 'someone-else' };
    await render(<TripDetail />);
    await act(async () => {});
    expect(screen.queryByTestId('wp10-join')).toBeNull();
    expect(props('wp10-ballots').isOwner).toBe(false);
  });

  it('"Mark trip as complete" is POST /complete through the lifecycle client with an intent key, then re-reads the trip', async () => {
    mockRunLifecycleAction.mockResolvedValue({ state: 'done', data: {}, status: 200 });
    const spy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => { (buttons as any[])?.find((b) => b.text === 'Mark complete')?.onPress?.(); });
    await render(<TripDetail />);
    await act(async () => {});
    await act(async () => { fireEvent.press(screen.getByText('Mark trip as complete')); });
    await act(async () => {});
    expect(mockRunLifecycleAction).toHaveBeenCalledWith('trip-abc', 'complete', expect.stringMatching(/^trip-complete:trip-abc:/));
    expect(mockReloadTrip).toHaveBeenCalled();
    spy.mockRestore();
  });
});
