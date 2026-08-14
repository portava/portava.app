/**
 * Event Detail (app/event/[id].tsx) — nav-bar collapse handler wiring test.
 *
 * The scroll-architecture tests (Task #1523) verify the header lives inside
 * the ScrollView, but they stub useNavBarScrollHandler to a no-op. This test
 * confirms that the ScrollView's onScroll prop is the handler returned by
 * useNavBarScrollHandler — so removing the wiring causes this test to fail.
 *
 * Strategy:
 *   1. Mock useNavBarScrollHandler to return a jest.fn() spy.
 *   2. Mock getEvent to resolve immediately so the screen exits loading state.
 *   3. Walk toJSON tree to find the ScrollView whose onScroll === spy.
 *   4. Fire the handler to confirm it reaches the spy.
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
  useLocalSearchParams: () => ({ id: 'event-test-1' }),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// NOTE: src/ is 3 directories up from app/event/__tests__/.

// ── Nav-bar collapse — spy factory ────────────────────────────────────────────
// mockNavScrollHandler is returned by useNavBarScrollHandler. event/[id].tsx
// passes it directly as <ScrollView onScroll={navBarScrollHandler} …>.
const mockNavScrollHandler = jest.fn();
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => mockNavScrollHandler,
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Session ───────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
// EventVoiceRoomCard reads useCallState/useCallActions (needs CallProvider);
// irrelevant to scroll-architecture assertions here.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/events/EventVoiceRoomCard.tsx', () => ({
  EventVoiceRoomCard: () => null,
}));

// NOTE: intentional exhaustive stub — only session identity is consumed here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'u1' }),
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

// ── getEvent — resolves immediately with minimal valid data ───────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/events', () => ({
  getEvent: jest.fn().mockResolvedValue({
    ok: true,
    data: {
      id: 'event-test-1',
      title: 'Lisbon Sunset Hike',
      state: 'open',
      category: 'activities',
      startsAt: '2026-09-01T17:00:00Z',
      endsAt:   '2026-09-01T20:00:00Z',
      locationName: 'Miradouro da Graça',
      locationLat: 38.71,
      locationLng: -9.13,
      city: 'Lisbon',
      coverUrl: null,
      coverMediaType: null,
      myRsvp: null,
      myRole: null,
      myWaitlistPosition: null,
      myWaitlistOfferExpiresAt: null,
      counts: { going: 12 },
      goingCount: 12,
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
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  checkCityAvailable: jest.fn().mockResolvedValue({ available: false }),
  getTopInCity:       jest.fn().mockResolvedValue({ ok: false }),
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
  getAttendeeActionSet: jest.fn().mockReturnValue({
    canRsvp: false, canLeave: false, canJoinWaitlist: false,
  }),
  effectiveEventState: jest.fn((state) => state),
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

import EventDetailScreen from '../[id].tsx';

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
  nativeEvent: { contentOffset: { y: 200 }, contentSize: { height: 3000 }, layoutMeasurement: { height: 900 } },
} as any;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Event Detail screen — nav-bar scroll handler wiring', () => {
  beforeEach(() => {
    mockNavScrollHandler.mockClear();
  });

  it('primary ScrollView onScroll prop is the useNavBarScrollHandler result once event loads', async () => {
    const { toJSON } = await render(<EventDetailScreen />);
    // Flush getEvent promise so the component exits loading state.
    await act(async () => {});

    // waitFor gives extra time for the promise chain to settle and re-render.
    await waitFor(() => {
      const tree = toJSON() as any;
      const scrollViews = findScrollViews(tree);
      // event/[id].tsx: <ScrollView onScroll={navBarScrollHandler} …>
      const primary = scrollViews.find((sv) => sv.props?.onScroll === mockNavScrollHandler);
      expect(primary).toBeDefined();
    }, { timeout: 3000 });
  });

  it('firing the primary ScrollView onScroll invokes the collapse handler', async () => {
    const { toJSON } = await render(<EventDetailScreen />);
    await act(async () => {});

    let primary: any;
    await waitFor(() => {
      const tree = toJSON() as any;
      const scrollViews = findScrollViews(tree);
      primary = scrollViews.find((sv) => sv.props?.onScroll === mockNavScrollHandler);
      expect(primary).toBeDefined();
    }, { timeout: 3000 });

    primary.props.onScroll(FAKE_SCROLL_EVENT);
    expect(mockNavScrollHandler).toHaveBeenCalledTimes(1);
    expect(mockNavScrollHandler).toHaveBeenCalledWith(FAKE_SCROLL_EVENT);
  });
});
