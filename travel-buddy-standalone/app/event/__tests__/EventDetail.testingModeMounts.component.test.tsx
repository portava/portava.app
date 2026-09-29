/**
 * Event detail — the testing-mode surfaces are MOUNTED where they belong
 * (PLAT-F26, PLAT-F29, PLAT-F30). Each component is stubbed to a marker; its
 * own behaviour is pinned in src/components/events/__tests__. This file pins
 * only the wiring:
 *   - a Going attendee's page carries the check-in card, the posts / photos /
 *     comments section and the memory card;
 *   - someone with no RSVP gets no posts section (the GET routes' scope);
 *   - a private event opened from a shared link (?share=<token>) mounts the
 *     shared-link preview with that token; without a token it does not.
 */
import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';

let mockParams: Record<string, string> = { id: 'event-tm' };

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => mockParams,
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


// ── The components under wiring test — markers ────────────────────────────────
// NOTE: intentional stubs — each renders a marker so the mount point is visible.
jest.mock('../../../src/components/events/EventCheckInCard.tsx', () => {
  const { Text } = require('react-native');
  return { EventCheckInCard: () => <Text>marker:checkin</Text> };
});
// NOTE: intentional stub — marker.
jest.mock('../../../src/components/events/EventCommunitySection.tsx', () => {
  const { Text } = require('react-native');
  return { EventCommunitySection: () => <Text>marker:community</Text> };
});
// NOTE: intentional stub — marker.
jest.mock('../../../src/components/events/EventMemoryCard.tsx', () => {
  const { Text } = require('react-native');
  return { EventMemoryCard: () => <Text>marker:memory</Text> };
});
// NOTE: intentional stub — marker carrying the token it was given.
jest.mock('../../../src/components/events/SharedEventLinkPreview.tsx', () => {
  const { Text } = require('react-native');
  return { SharedEventLinkPreview: ({ token }: { token: string }) => <Text>{`marker:shared:${token}`}</Text> };
});

import EventDetailScreen from '../[id].tsx';

function payload(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      id: 'event-tm', title: 'Wiring Event', state: 'open', category: 'activities',
      startsAt: '2099-01-01T18:00:00Z', endsAt: '2099-01-01T21:00:00Z',
      locationName: null, locationLat: null, locationLng: null, city: null,
      coverUrl: null, coverMediaType: null, myRsvp: null, myRole: null,
      myWaitlistPosition: null, myWaitlistOfferExpiresAt: null, counts: { going: 1 },
      goingCount: 1, waitlistCount: 0, goingAttendees: [], maxAttendees: null, host: null,
      description: null, waitlistEnabled: false, isHost: false, isSaved: false,
      myJoinRequestStatus: null, chatEnabled: true, ...over,
    },
  };
}

beforeEach(() => { mockParams = { id: 'event-tm' }; });

describe('Event detail — testing-mode mounts', () => {
  it('a Going attendee sees check-in, posts / photos / comments and the memory card', async () => {
    mockGetEvent.mockResolvedValueOnce(payload({ myRsvp: 'going' }));
    const view = await render(<EventDetailScreen />);
    await act(async () => {});
    await waitFor(() => expect(view.getByText('marker:community')).toBeTruthy());
    expect(view.getByText('marker:checkin')).toBeTruthy();
    expect(view.getByText('marker:memory')).toBeTruthy();
  });

  it('no RSVP: no posts section (the GET routes answer 403 to non-participants)', async () => {
    mockGetEvent.mockResolvedValueOnce(payload({ myRsvp: null }));
    const view = await render(<EventDetailScreen />);
    await act(async () => {});
    await waitFor(() => expect(view.getByText('marker:checkin')).toBeTruthy());
    expect(view.queryByText('marker:community')).toBeNull();
  });

  it('a private event opened from a shared link mounts the preview with the token', async () => {
    mockParams = { id: 'event-tm', share: 'tok_abcdef12' };
    mockGetEvent.mockResolvedValueOnce({ ok: true, data: { isPrivate: true, id: 'event-tm', title: 'Secret supper' } });
    const view = await render(<EventDetailScreen />);
    await act(async () => {});
    await waitFor(() => expect(view.getByText('marker:shared:tok_abcdef12')).toBeTruthy());
  });

  it('a private event without a share token does not mount the preview', async () => {
    mockGetEvent.mockResolvedValueOnce({ ok: true, data: { isPrivate: true, id: 'event-tm', title: 'Secret supper' } });
    const view = await render(<EventDetailScreen />);
    await act(async () => {});
    await waitFor(() => expect(mockGetEvent).toHaveBeenCalled());
    expect(view.queryByText(/marker:shared/)).toBeNull();
  });
});
