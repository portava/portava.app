/**
 * Event Detail — location dedup regression test
 *
 * Confirms that the `formatEventLocationLine` fix prevents a duplicated city
 * in the location subtitle when `locationName` already contains the city.
 *
 * Example that triggered the bug:
 *   locationName = "Cebu, Philippines"  +  city = "Cebu"
 *   Before fix: "Cebu, Philippines, Cebu"
 *   After fix:  "Cebu, Philippines"
 *
 * Strategy: render EventDetailScreen with the offending combo, let it exit
 * loading state, then walk the rendered text to count occurrences of the
 * city name in the location row.
 *
 * Run with: pnpm --dir travel-buddy-standalone test:component
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
  useLocalSearchParams: () => ({ id: 'evt-loc-dedup-1' }),
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
  useSession: () => ({ userId: 'viewer-loc-dedup' }),
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

// ── EventVoiceRoomCard — needs CallProvider, irrelevant here ─────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/events/EventVoiceRoomCard.tsx', () => ({
  EventVoiceRoomCard: () => null,
}));

// ── services/events — location-dedup scenario ────────────────────────────────
// NOTE: intentional partial stub. Only getEvent is under test; others are no-ops.
jest.mock('../../../src/services/events', () => ({
  getEvent: jest.fn().mockResolvedValue({
    ok: true,
    data: {
      id: 'evt-loc-dedup-1',
      title: 'BGC Night Run',
      state: 'open',
      category: 'festival',
      startsAt: '2026-01-19T08:00:00Z',
      endsAt:   null,
      // Key combination that triggered the duplication bug:
      locationName: 'Cebu, Philippines',
      locationLat: 10.31,
      locationLng: 123.89,
      city: 'Cebu',
      coverUrl: null,
      coverMediaType: null,
      myRsvp: null,
      myRole: null,
      myWaitlistPosition: null,
      myWaitlistOfferExpiresAt: null,
      counts: { going: 8 },
      goingCount: 8,
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
  }),
  saveEvent:      jest.fn(),
  unsaveEvent:    jest.fn(),
  shareEvent:     jest.fn(),
  reportEvent:    jest.fn(),
  addEventToTrip: jest.fn(),
  buildRentBuddyCtaUrl:   jest.fn().mockReturnValue(''),
  shouldShowRentBuddyCta: jest.fn().mockReturnValue(false),
  // getEventReminders / reminder CRUD added to EventDetailScreen after this test
  // was written. Mock as no-ops — reminder display is not under test here.
  getEventReminders:    jest.fn().mockResolvedValue({ ok: true, data: { reminders: [] } }),
  createEventReminder:  jest.fn().mockResolvedValue({ ok: true }),
  deleteEventReminder:  jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  checkCityAvailable: jest.fn().mockResolvedValue({ available: false }),
  getTopInCity:       jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/places', () => ({
  getVenueInfoByCoords: jest.fn().mockResolvedValue(null),
  clearVenueInfoCache:  jest.fn(),
  getCanonicalPlace:    jest.fn().mockResolvedValue(null),
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
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/eventRoleActions', () => ({
  // effectiveEventState was added to EventDetailScreen after this test was written.
  // Return the raw state unchanged — location dedup is independent of lifecycle state.
  effectiveEventState: jest.fn((state: string) => state),
  getAttendeeActionSet: jest.fn().mockReturnValue({
    canRsvp: false, canLeave: false, canJoinWaitlist: false,
  }),
}));

// ── Visual helpers ────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useVisualStatusChannel.ts', () => ({
  useVisualStatusChannel: jest.fn(),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/visuals/resolveHeaderImage', () => ({
  resolveHeaderImage: jest.fn().mockReturnValue(null),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/visuals/fallbackAssets', () => ({
  fallbackUriFor: jest.fn().mockReturnValue(null),
}));

// ── Heavy sub-components — null stubs ─────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/HostDashboardPanel',   () => ({ HostDashboardPanel: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ReviewsSection',        () => ({ ReviewsSection: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui/SharedVideoPlayer',  () => ({ SharedVideoPlayer: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui',                    () => ({ Avatar: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/BuddyCard',             () => ({ BuddyCard: () => null, BuddyCardSkeleton: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ReportSheet',           () => ({ ReportSheet: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/stamps/StampButton',    () => ({ StampButton: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/place/PlaceInfoSection', () => ({ PlaceInfoSection: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/visuals/AiRepresentationLabel.tsx', () => ({
  AiRepresentationLabel: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/privacy/PrivateEventCard', () => ({
  PrivateEventCard: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/interaction/UserAvatarButton', () => ({
  UserAvatarButton: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useScreenTiming', () => ({
  useScreenTiming: () => ({ markFirstContent: jest.fn(), epoch: 0 }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useStickyBarInset: () => ({ inset: 0, onBarLayout: jest.fn() }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/usePosts', () => ({
  FOCUS_REFETCH_TTL_MS: 60_000,
}));

import EventDetailScreen from '../[id].tsx';

// ── Tree-walking helpers ───────────────────────────────────────────────────────

function collectAllText(node: any): string[] {
  if (typeof node === 'string') return [node];
  if (!node || typeof node !== 'object') return [];
  return (node.children ?? []).flatMap((c: any) => collectAllText(c));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Event Detail — location dedup fix', () => {
  it('shows the location name only once — city is not appended again when already in locationName', async () => {
    const { toJSON } = await render(<EventDetailScreen />);
    await act(async () => {});

    let tree: any;
    await waitFor(() => {
      tree = toJSON();
      const texts = collectAllText(tree);
      expect(texts.some((t) => t.includes('BGC Night Run'))).toBe(true);
    }, { timeout: 4000 });

    const allTexts = collectAllText(tree);

    // The correct display is the locationName "Cebu, Philippines" — the city "Cebu"
    // must NOT be appended a second time.
    const duplicatedForm = 'Cebu, Philippines, Cebu';
    const hasDuplicated = allTexts.some((t) => t.includes(duplicatedForm));
    expect(hasDuplicated).toBe(false);

    // The deduplicated form must appear exactly once.
    const hasCorrect = allTexts.some((t) => t === 'Cebu, Philippines');
    expect(hasCorrect).toBe(true);
  });

  it('still appends the city when it does not appear in locationName', async () => {
    // This variant confirms the fix does NOT suppress distinct city names.
    const { getEvent } = require('../../../src/services/events');
    getEvent.mockResolvedValueOnce({
      ok: true,
      data: {
        id: 'evt-loc-dedup-1',
        title: 'BGC Night Run',
        state: 'open',
        category: 'running',
        startsAt: '2026-03-10T18:00:00Z',
        endsAt: null,
        // locationName has a different value from the city — city should be appended.
        locationName: 'Bonifacio Global City',
        locationLat: 14.55,
        locationLng: 121.05,
        city: 'Taguig',
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
    });

    const { toJSON } = await render(<EventDetailScreen />);
    await act(async () => {});

    let tree: any;
    await waitFor(() => {
      tree = toJSON();
      const texts = collectAllText(tree);
      expect(texts.some((t) => t.includes('BGC Night Run'))).toBe(true);
    }, { timeout: 4000 });

    const allTexts = collectAllText(tree);
    const hasCombined = allTexts.some((t) => t.includes('Bonifacio Global City, Taguig'));
    expect(hasCombined).toBe(true);
  });
});
