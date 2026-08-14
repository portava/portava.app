/**
 * Event Detail (app/event/[id].tsx) — state badge regression test.
 *
 * Confirms that the screen shows "Happening now" for an in-progress event
 * (startsAt in the past, endsAt in the future) and "Completed" once endsAt
 * has also passed — driven by effectiveEventState rather than raw event.state.
 *
 * Strategy:
 *   1. Use the REAL effectiveEventState so the badge reflects computed state.
 *   2. Stub getAttendeeActionSet (irrelevant to badge rendering).
 *   3. Configure getEvent per test via mockResolvedValueOnce (captured inside
 *      the factory to avoid jest.mock hoisting / TDZ issues).
 *   4. Assert badge text with getByText after the event loads.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ id: 'event-badge-test' }),
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
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Session ───────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'u1' }),
}));

// ── EventVoiceRoomCard — needs LiveKit provider; irrelevant here ───────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/events/EventVoiceRoomCard.tsx', () => ({
  EventVoiceRoomCard: () => null,
}));

// ── Rent-a-buddy flag ─────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

// ── RSVP hook ─────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useEventRsvp', () => ({
  useEventRsvp: () => ({
    busy: false,
    handleRsvp:          jest.fn(),
    handleLeave:         jest.fn(),
    handleJoinWaitlist:  jest.fn(),
    handleLeaveWaitlist: jest.fn(),
    handleAcceptOffer:   jest.fn(),
    handleRequestJoin:   jest.fn(),
    handleJoinChat:      jest.fn(),
  }),
}));

// ── Screen timing ─────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useScreenTiming', () => ({
  useScreenTiming: () => ({ markFirstContent: jest.fn(), epoch: 0 }),
}));

// ── Bottom inset ──────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useStickyBarInset: () => ({ inset: 0, onBarLayout: jest.fn() }),
}));

// ── Visual status channel — realtime AI cover; irrelevant here ────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useVisualStatusChannel.ts', () => ({
  useVisualStatusChannel: () => {},
}));

// ── getEvent — the jest.fn() is created inside the factory (avoids TDZ from
//    jest.mock hoisting) and exposed via a module-level binding that the tests
//    configure with mockResolvedValueOnce.
// NOTE: intentional stub — dates are the variable under test; everything else
//    is locked to avoid noise.
let mockGetEvent: jest.Mock;
jest.mock('../../../src/services/events', () => {
  const fn = jest.fn();
  mockGetEvent = fn;
  return {
    getEvent:               fn,
    saveEvent:              jest.fn(),
    unsaveEvent:            jest.fn(),
    shareEvent:             jest.fn(),
    reportEvent:            jest.fn(),
    addEventToTrip:         jest.fn(),
    buildRentBuddyCtaUrl:   jest.fn().mockReturnValue(''),
    shouldShowRentBuddyCta: jest.fn().mockReturnValue(false),
    getEventReminders:      jest.fn().mockResolvedValue({ ok: true, data: { reminders: [] } }),
    createEventReminder:    jest.fn(),
    deleteEventReminder:    jest.fn(),
  };
});

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  checkCityAvailable: jest.fn().mockResolvedValue({ available: false }),
  getTopInCity:       jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/places', () => ({
  getVenueInfoByCoords:  jest.fn().mockResolvedValue(null),
  clearVenueInfoCache:   jest.fn(),
  getCanonicalPlace:     jest.fn().mockResolvedValue(null),
}));

// ── Maps helper ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/maps', () => ({
  openMapsNavigation: jest.fn(),
}));

// ── Safe notifications ────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/safeNotifications', () => ({
  scheduleLocalNotificationAt:  jest.fn().mockResolvedValue(null),
  cancelScheduledNotification:  jest.fn().mockResolvedValue(undefined),
}));

// ── Lib helpers ───────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/displayIdentity', () => ({
  primaryIdentityText: jest.fn().mockReturnValue('Test User'),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/waitlistState', () => ({
  getWaitlistUiState: jest.fn().mockReturnValue('not_on_waitlist'),
}));

// ── eventRoleActions — REAL effectiveEventState, stubbed getAttendeeActionSet ──
// effectiveEventState must run for real so the badge reflects computed state.
// getAttendeeActionSet is irrelevant to badge rendering and is stubbed.
jest.mock('../../../src/lib/eventRoleActions', () => {
  const actual = jest.requireActual('../../../src/lib/eventRoleActions');
  return {
    effectiveEventState:  actual.effectiveEventState,
    getAttendeeActionSet: jest.fn().mockReturnValue({
      canRsvp: false, canLeave: false, canJoinWaitlist: false,
    }),
  };
});

// ── Visual helpers ────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/visuals/resolveHeaderImage', () => ({
  resolveHeaderImage: jest.fn().mockReturnValue(null),
}));
jest.mock('../../../src/lib/visuals/fallbackAssets', () => ({
  fallbackUriFor: jest.fn().mockReturnValue(null),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/visuals/AiRepresentationLabel.tsx', () => ({
  AiRepresentationLabel: () => null,
}));

// ── Heavy sub-components — null stubs ─────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/HostDashboardPanel',   () => ({ HostDashboardPanel:  () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ReviewsSection',        () => ({ ReviewsSection:       () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui/SharedVideoPlayer',  () => ({ SharedVideoPlayer:   () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui',                    () => ({ Avatar: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/BuddyCard',             () => ({ BuddyCard: () => null, BuddyCardSkeleton: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/stamps/StampButton',    () => ({ StampButton: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ReportSheet',           () => ({ ReportSheet: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/interaction/UserAvatarButton', () => ({ UserAvatarButton: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/privacy/PrivateEventCard',     () => ({ PrivateEventCard:  () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/place/PlaceInfoSection',       () => ({ PlaceInfoSection:  () => null }));

import EventDetailScreen from '../[id].tsx';

// ── Minimal event fixture ─────────────────────────────────────────────────────

function makeEventPayload(startsAt: string, endsAt: string) {
  return {
    ok: true,
    data: {
      id: 'event-badge-test',
      title: 'Badge Test Event',
      // Raw DB state is 'open'; effectiveEventState overrides it based on dates.
      state: 'open',
      category: 'activities',
      startsAt,
      endsAt,
      locationName: null,
      locationLat: null,
      locationLng: null,
      city: null,
      coverUrl: null,
      coverMediaType: null,
      myRsvp: null,
      myRole: null,
      myWaitlistPosition: null,
      myWaitlistOfferExpiresAt: null,
      counts: { going: 0 },
      goingCount: 0,
      waitlistCount: 0,
      goingAttendees: [],
      maxAttendees: null,
      host: null,
      description: null,
      waitlistEnabled: false,
      isHost: false,
      isSaved: false,
      myJoinRequestStatus: null,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Event Detail screen — state badge', () => {
  it('shows "Happening now" for an in-progress event (startsAt past, endsAt future)', async () => {
    // startsAt well in the past, endsAt well in the future → effectiveEventState → 'started'
    mockGetEvent.mockResolvedValueOnce(
      makeEventPayload('2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z'),
    );

    const { getByText } = await render(<EventDetailScreen />);
    await act(async () => {});

    await waitFor(() => {
      expect(getByText('Happening now')).toBeTruthy();
    }, { timeout: 3000 });
  });

  it('shows "Completed" once endsAt has passed', async () => {
    // Both startsAt and endsAt well in the past → effectiveEventState → 'completed'
    mockGetEvent.mockResolvedValueOnce(
      makeEventPayload('2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z'),
    );

    const { getByText } = await render(<EventDetailScreen />);
    await act(async () => {});

    await waitFor(() => {
      expect(getByText('Completed')).toBeTruthy();
    }, { timeout: 3000 });
  });
});
