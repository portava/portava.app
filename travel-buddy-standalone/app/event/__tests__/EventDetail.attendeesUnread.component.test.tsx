/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; the round-19 verifier's B19): the event screen never says a failed
 * read of who is going, or of the host, as a count of 0 or as nobody.
 *
 * GET /events/:id names a failed going/maybe read (`event_rsvps`) or profiles read (`profiles`) in `failedSources`, beside
 * an empty `goingAttendees` and, when no cached count exists, `counts.going: null`. The screen drew `0 going` over a null
 * count, hid the attendee strip and the host row without a word, and never read `failedSources`.
 *
 *   ED0  CONTROL: every read answered, two going → "2 going", no unread notice
 *   ED1  the going/maybe read failed (the cached count 7 served) → "Couldn't load who's going"
 *   ED2  the going count is null (no cached count) → "Going count unavailable", never "0 going"
 *   ED3  the host's profile read failed → "Couldn't load the host"
 *   ED0b CONTROL: every read answered, nobody going → "0 going", no unread notice
 *
 * The harness is EventDetail.stateBadge's (the real screen, its heavy children stubbed); getEvent answers the bodies.
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


const BASE = {
  id: 'event-attendees-test', title: 'Attendees Test Event', state: 'open', category: 'activities',
  startsAt: '2099-01-01T00:00:00Z', endsAt: '2099-01-02T00:00:00Z', locationName: null, locationLat: null, locationLng: null,
  city: null, coverUrl: null, coverMediaType: null, myRsvp: null, myRole: null, myWaitlistPosition: null,
  myWaitlistOfferExpiresAt: null, goingCount: 0, waitlistCount: 0, maxAttendees: null, description: null,
  waitlistEnabled: false, isHost: false, isSaved: false, myJoinRequestStatus: null,
  host: { id: 'h1', handle: 'hosty', displayName: 'Hosty', avatarUrl: null },
};
const ATT = [{ id: 'a1', handle: 'a1', displayName: null, avatarUrl: null }, { id: 'a2', handle: 'a2', displayName: null, avatarUrl: null }];
const BODIES: Record<string, any> = {
  ED0:  { ...BASE, counts: { going: 2, maybe: 0, interested: 0, cant_go: 0 }, goingAttendees: ATT },
  ED0b: { ...BASE, counts: { going: 0, maybe: 0, interested: 0, cant_go: 0 }, goingAttendees: [] },
  ED1:  { ...BASE, counts: { going: 7, maybe: null, interested: 0, cant_go: 0 }, goingAttendees: [], failedSources: ['event_rsvps'] },
  ED2:  { ...BASE, counts: { going: null, maybe: null, interested: 0, cant_go: 0 }, goingAttendees: [], failedSources: ['event_rsvps'] },
  ED3:  { ...BASE, host: null, counts: { going: 2, maybe: 0, interested: 0, cant_go: 0 }, goingAttendees: ATT, failedSources: ['profiles'] },
};

async function screen(key: string) {
  mockGetEvent.mockResolvedValueOnce({ ok: true, data: BODIES[key] });
  const ui = await render(<EventDetailScreen />);
  await act(async () => {});
  await waitFor(() => expect(ui.queryAllByText('Attendees Test Event').length).toBeGreaterThan(0), { timeout: 3000 });
  const has = (t: string | RegExp) => ui.queryAllByText(t).length > 0;
  return {
    whoUnread: has("Couldn't load who's going"), hostUnread: has("Couldn't load the host"), countUnread: has('Going count unavailable'),
    zeroGoing: has(/^0 going/), going2: has(/^2 going/), going7: has(/^7 going/),
  };
}

describe("census-discovery §117 (B19): the event screen over a failed read of who is going", () => {
  it('ED0 CONTROL: every read answered, two going → "2 going", no unread notice', async () => {
    expect(await screen('ED0')).toEqual({ whoUnread: false, hostUnread: false, countUnread: false, zeroGoing: false, going2: true, going7: false });
  });
  it('ED0b CONTROL: every read answered, nobody going → "0 going", no unread notice', async () => {
    expect(await screen('ED0b')).toEqual({ whoUnread: false, hostUnread: false, countUnread: false, zeroGoing: true, going2: false, going7: false });
  });
  it('ED1 the going/maybe read failed (cached count 7) → "Couldn\'t load who\'s going"', async () => {
    expect(await screen('ED1')).toEqual({ whoUnread: true, hostUnread: false, countUnread: false, zeroGoing: false, going2: false, going7: true });
  });
  it('ED2 the going count is null → "Going count unavailable", never "0 going"', async () => {
    expect(await screen('ED2')).toEqual({ whoUnread: true, hostUnread: false, countUnread: true, zeroGoing: false, going2: false, going7: false });
  });
  it('ED3 the host\'s profile read failed → "Couldn\'t load the host"', async () => {
    expect(await screen('ED3')).toEqual({ whoUnread: false, hostUnread: true, countUnread: false, zeroGoing: false, going2: true, going7: false });
  });
});
