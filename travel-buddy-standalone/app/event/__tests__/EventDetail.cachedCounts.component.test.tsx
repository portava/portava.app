/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; the round-20 verifier's B25, probes EC0–EC4, and its C14 fixture
 * EC4): the event screen never says a count GET /events/:id named as unread as measured.
 *
 * When the going/maybe read fails the route serves the CACHED going_count in `counts.going` (with `counts.maybe` null)
 * and names `event_rsvps`; when the waitlist read fails it serves the cached `waitlist_count` and names
 * `event_waitlist`. The cached counters are the ones a failed recount leaves stale (D-W11X2-160), and the list cards say
 * them "(last known)" (D-W11X2-164). The screen said "7 going", "3 waitlisted", and over a cached 0 nothing at all
 * about a waitlist it could not read. It now says "7 going (last known)", "3 waitlisted (last known)" and "waitlist
 * unavailable". The avatar strip's "+N" counted from five avatars whatever was listed, and from an unread count.
 *
 * The harness is the round-20 suite EventDetail.attendeesUnread's (the real screen, heavy children stubbed).
 *
 *   EC0  CONTROL: every read answered → "2 going · 10 max · 3 waitlisted", nothing said unread
 *   EC1  the going/maybe read failed, cached 7 → "7 going (last known)"
 *   EC2  the waitlist read failed, cached 3 → "3 waitlisted (last known)"
 *   EC3  the waitlist read failed, cached 0 → "waitlist unavailable", never silence
 *   EC4  CONTROL (the fixture for the verifier's mutation C14): the host was read, a going traveller's profile was not →
 *        never "Couldn't load the host"
 *   EC5  only the full-RSVP read failed (`counts.maybe` read, `interested` null) → "2 going" as measured
 *   AV0  CONTROL: 4 going, 4 listed → no "+N"
 *   AV1  6 going, 2 listed → "+4" (the travellers not shown), never "+1"
 *   AV2  the going read failed, cached 7, 2 listed → no "+N" stated over the unread count
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
  myWaitlistOfferExpiresAt: null, goingCount: 0, waitlistCount: 3, maxAttendees: 10, description: null,
  waitlistEnabled: true, isHost: false, isSaved: false, myJoinRequestStatus: null,
  host: { id: 'h1', handle: 'hosty', displayName: 'Hosty', avatarUrl: null },
};
const ATT = [{ id: 'a1', handle: 'a1', displayName: null, avatarUrl: null }, { id: 'a2', handle: 'a2', displayName: null, avatarUrl: null }];
const BODIES: Record<string, any> = {
  EC0: { ...BASE, counts: { going: 2, maybe: 0, interested: 0, cant_go: 0 }, goingAttendees: ATT },
  EC1: { ...BASE, counts: { going: 7, maybe: null, interested: 0, cant_go: 0 }, goingAttendees: [], failedSources: ['event_rsvps'] },
  EC2: { ...BASE, counts: { going: 2, maybe: 0, interested: 0, cant_go: 0 }, goingAttendees: ATT, failedSources: ['event_waitlist'] },
  EC4: { ...BASE, counts: { going: 2, maybe: 0, interested: 0, cant_go: 0 }, goingAttendees: ATT, failedSources: ['profiles'] },
  AV0: { ...BASE, counts: { going: 4, maybe: 0, interested: 0, cant_go: 0 }, goingAttendees: [...ATT, { id: 'a3', handle: 'a3', displayName: null, avatarUrl: null }, { id: 'a4', handle: 'a4', displayName: null, avatarUrl: null }] },
  EC3: { ...BASE, waitlistCount: 0, counts: { going: 2, maybe: 0, interested: 0, cant_go: 0 }, goingAttendees: ATT, failedSources: ['event_waitlist'] },
};
async function line(key: string) {
  mockGetEvent.mockResolvedValueOnce({ ok: true, data: BODIES[key] });
  const ui = await render(<EventDetailScreen />);
  await act(async () => {});
  await waitFor(() => expect(ui.queryAllByText('Attendees Test Event').length).toBeGreaterThan(0), { timeout: 3000 });
  const t = ui.queryAllByText(/^(\d+ going|Going count unavailable)/).map((n: any) => [].concat(n.props.children).flat(3).join('')).join(' | ');  // the capacity line only
  return t;
}
function capacityLine(ui: any): string {
  return ui.queryAllByText(/^(\d+ going|Going count unavailable)/).map((n: any) => [].concat(n.props.children).flat(3).join('')).join(' | ');
}
async function screen(key: string) {
  mockGetEvent.mockResolvedValueOnce({ ok: true, data: BODIES[key] });
  const ui = await render(<EventDetailScreen />);
  await act(async () => {});
  await waitFor(() => expect(ui.queryAllByText('Attendees Test Event').length).toBeGreaterThan(0), { timeout: 3000 });
  return ui;
}
BODIES.EC5 = { ...BODIES.EC0, counts: { going: 2, maybe: 0, interested: null, cant_go: null }, failedSources: ['event_rsvps'] };
BODIES.AV1 = { ...BODIES.EC0, counts: { going: 6, maybe: 0, interested: 0, cant_go: 0 } };
BODIES.AV2 = { ...BODIES.EC1, goingAttendees: ATT };
const plus = (ui: any) => ui.queryAllByText(/^\+\d+$/).map((n: any) => [].concat(n.props.children).flat(3).join(''));

describe('census-discovery §118 (B25): the event screen says an unread count as last known', () => {
  it('EC0 CONTROL: every read answered → "2 going · 10 max · 3 waitlisted"', async () => {
    const t = capacityLine(await screen('EC0'));
    expect(t).toMatch(/2 going/); expect(t).toMatch(/3 waitlisted/); expect(t).not.toMatch(/last known|unavailable|couldn/i);
  });
  it('EC1 going/maybe read failed, cached 7 → "7 going (last known)"', async () => {
    expect(capacityLine(await screen('EC1'))).toMatch(/7 going \(last known\)/);
  });
  it('EC2 waitlist read failed, cached 3 → "3 waitlisted (last known)"', async () => {
    const t = capacityLine(await screen('EC2'));
    expect(t).toMatch(/3 waitlisted \(last known\)/); expect(t).toMatch(/2 going/); expect(t).not.toMatch(/going \(last known\)/);
  });
  it('EC3 waitlist read failed, cached 0 → "waitlist unavailable"', async () => {
    expect(capacityLine(await screen('EC3'))).toMatch(/waitlist unavailable/);
  });
  it('EC4 CONTROL: the host was read, a going traveller\'s profile was not → never "Couldn\'t load the host"', async () => {
    const ui = await screen('EC4');
    expect(ui.queryByText("Couldn't load the host")).toBeNull();
  });
  it('EC5 only the full-RSVP read failed → the live going count as measured', async () => {
    const t = capacityLine(await screen('EC5'));
    expect(t).toMatch(/2 going/); expect(t).not.toMatch(/last known/);
  });
  it('AV0 CONTROL: 4 going, 4 listed → no "+N"', async () => {
    expect(plus(await screen('AV0'))).toEqual([]);
  });
  it('AV1 6 going, 2 listed → "+4"', async () => {
    expect(plus(await screen('AV1'))).toEqual(['+4']);
  });
  it('AV2 the going read failed, cached 7, 2 listed → no "+N" over the unread count', async () => {
    expect(plus(await screen('AV2'))).toEqual([]);
  });
});
