/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; sweep SW30): the event screen's bookmark is the viewer's measured
 * saved state, and says so when it could not be read.
 *
 * The screen set `isSaved` from `!!body.isSaved`, a field GET /events/:id never served: every event the viewer had
 * saved was drawn "not saved" on its own screen. The route now serves it measured, or `null` with `event_saves` named
 * (api-server eventDetailSavedState). The screen keeps the null: the bookmark says "Couldn't check if saved" and a tap
 * saves and unsaves nothing.
 *
 * The harness is EventDetail.cachedCounts' (the real screen, heavy children stubbed).
 *
 *   ES0 isSaved true → "Remove from saved"
 *   ES1 isSaved null, event_saves named → "Couldn't check if saved"; a tap saves and unsaves nothing
 *   ES2 CONTROL: isSaved false → "Save event"; a tap saves
 */
import React from 'react';
import { render, act, waitFor, fireEvent } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ id: 'event-attendees-test' }),
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
let mockGetEvent: jest.Mock; let mockSaveEvent: jest.Mock; let mockUnsaveEvent: jest.Mock;
jest.mock('../../../src/services/events', () => {
  const fn = jest.fn();
  mockGetEvent = fn; mockSaveEvent = jest.fn(async () => ({ ok: true })); mockUnsaveEvent = jest.fn(async () => ({ ok: true }));
  return {
    getEvent:               fn,
    saveEvent:              mockSaveEvent,
    unsaveEvent:            mockUnsaveEvent,
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

const BASE = {
  id: 'event-attendees-test', title: 'Attendees Test Event', state: 'open', category: 'activities',
  startsAt: '2099-01-01T00:00:00Z', endsAt: '2099-01-02T00:00:00Z', locationName: null, locationLat: null, locationLng: null,
  city: null, coverUrl: null, coverMediaType: null, myRsvp: null, myRole: null, myWaitlistPosition: null,
  myWaitlistOfferExpiresAt: null, goingCount: 0, waitlistCount: 3, maxAttendees: 10, description: null,
  waitlistEnabled: true, isHost: false, isSaved: false, myJoinRequestStatus: null,
  host: { id: 'h1', handle: 'hosty', displayName: 'Hosty', avatarUrl: null },
};
const COUNTS = { going: 2, maybe: 0, interested: 0, cant_go: 0 };
async function screen(isSaved: boolean | null) {
  mockGetEvent.mockResolvedValueOnce({ ok: true, data: { ...BASE, counts: COUNTS, goingAttendees: [], isSaved, ...(isSaved === null ? { failedSources: ['event_saves'] } : {}) } });
  const ui = await render(<EventDetailScreen />);
  await act(async () => {});
  await waitFor(() => expect(ui.queryAllByText('Attendees Test Event').length).toBeGreaterThan(0), { timeout: 3000 });
  return ui;
}

describe('census-discovery §122 (SW30): the event screen\'s bookmark over an unread saved state', () => {
  beforeEach(() => { mockSaveEvent.mockClear(); mockUnsaveEvent.mockClear(); });
  it('ES0 isSaved true → "Remove from saved"', async () => {
    const ui = await screen(true);
    expect(ui.getByLabelText('Remove from saved')).toBeTruthy();
  });
  it('ES1 isSaved null → "Couldn\'t check if saved"; a tap saves and unsaves nothing', async () => {
    const ui = await screen(null);
    expect(ui.queryByLabelText('Save event')).toBeNull();
    await act(async () => { fireEvent.press(ui.getByLabelText("Couldn't check if saved")); });
    expect(mockSaveEvent).not.toHaveBeenCalled();
    expect(mockUnsaveEvent).not.toHaveBeenCalled();
  });
  it('ES2 CONTROL: isSaved false → "Save event"; a tap saves', async () => {
    const ui = await screen(false);
    await act(async () => { fireEvent.press(ui.getByLabelText('Save event')); });
    expect(mockSaveEvent).toHaveBeenCalledWith('event-attendees-test');
  });
});
