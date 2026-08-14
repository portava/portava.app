/**
 * Event Detail (app/event/[id].tsx) — scroll-architecture regression test.
 *
 * Confirms that after Task #1519, the back-nav / title header is rendered as a
 * child INSIDE the primary ScrollView — NOT as a sibling View pinned above it.
 *
 * Strategy: mock getEvent to resolve immediately so the screen exits its
 * loading state, then walk the toJSON tree to verify the ScrollView is the
 * root content container and no header sibling precedes it.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
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

// NOTE: src/ is 3 directories up from app/event/__tests__/:
//   __tests__ → event → app → package-root → src/

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
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

// ── getEvent — data inline in factory to avoid jest.mock hoisting (TDZ) ───────
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
      // counts shape required by the event detail render (event.counts.going)
      counts: { going: 12 },
      goingCount: 12,
      waitlistCount: 0,
      // goingAttendees array required by the attendee strip (event.goingAttendees.length)
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
  getEventReminders:   jest.fn().mockResolvedValue({ ok: true, data: { reminders: [] } }),
  createEventReminder: jest.fn(),
  deleteEventReminder: jest.fn(),
  addEventToTrip: jest.fn(),
  buildRentBuddyCtaUrl:   jest.fn().mockReturnValue(''),
  shouldShowRentBuddyCta: jest.fn().mockReturnValue(false),
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
jest.mock('../../../src/components/HostDashboardPanel',        () => ({ HostDashboardPanel:  () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ReviewsSection',            () => ({ ReviewsSection:       () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui/SharedVideoPlayer',      () => ({ SharedVideoPlayer:   () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui',                        () => ({ Avatar: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/BuddyCard',                 () => ({ BuddyCard: () => null, BuddyCardSkeleton: () => null }));

import EventDetailScreen from '../[id].tsx';

// ── Tree-walking helpers ───────────────────────────────────────────────────────

function findScrollViews(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  const res: any[] = [];
  if (node.type === 'ScrollView' || node.type === 'RCTScrollView') res.push(node);
  for (const child of (node.children ?? [])) res.push(...findScrollViews(child));
  return res;
}

function subtreeHasText(node: any, text: string): boolean {
  if (typeof node === 'string') return node === text || node.includes(text);
  if (!node || typeof node !== 'object') return false;
  return (node.children ?? []).some((c: any) => subtreeHasText(c, text));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Event Detail screen — scroll architecture', () => {
  it('event title is rendered inside the primary ScrollView once the event loads', async () => {
    const { toJSON } = await render(<EventDetailScreen />);

    // Flush getEvent promise so the component exits loading → main content.
    await act(async () => {});

    // If still in loading state after one flush, waitFor gives it more time.
    let tree = toJSON() as any;
    let scrollViews = findScrollViews(tree);

    if (scrollViews.length === 0) {
      await waitFor(() => {
        tree = toJSON() as any;
        scrollViews = findScrollViews(tree);
        expect(scrollViews.length).toBeGreaterThan(0);
      }, { timeout: 3000 });
    }

    expect(scrollViews.length).toBeGreaterThan(0);

    // "Lisbon Sunset Hike" is the event title rendered in the header inside the ScrollView.
    const titleInScroll = scrollViews.some((sv) => subtreeHasText(sv, 'Lisbon Sunset Hike'));
    expect(titleInScroll).toBe(true);
  });

  it('root View has no non-overlay header sibling above the ScrollView once event loads', async () => {
    const { toJSON } = await render(<EventDetailScreen />);
    await act(async () => {});

    // Wait for the ScrollView to appear in the tree.
    let tree: any;
    await waitFor(() => {
      tree = toJSON() as any;
      const svs = findScrollViews(tree);
      expect(svs.length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const rootChildren: any[] = Array.isArray(tree?.children) ? tree.children : [];

    let foundScrollView = false;
    let nonOverlayBeforeScroll = false;

    for (const child of rootChildren) {
      if (!child || typeof child !== 'object') continue;
      if (child.type === 'ScrollView' || child.type === 'RCTScrollView') {
        foundScrollView = true;
        break;
      }
      if (child.type === 'RCTModalHostView' || child.type === 'Modal') continue;
      const style = child?.props?.style ?? {};
      const flat = Array.isArray(style)
        ? Object.assign({}, ...style.map((s: any) => (s && typeof s === 'object' ? s : {})))
        : style;
      if (flat.position !== 'absolute') nonOverlayBeforeScroll = true;
    }

    expect(foundScrollView).toBe(true);
    expect(nonOverlayBeforeScroll).toBe(false);
  });
});
