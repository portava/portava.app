/**
 * Deep-link path regression guards — 9 fixed navigation call sites.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 *
 * ## What's covered
 *
 * Each test asserts that the specific router.push call in the listed source file
 * uses the exact corrected path string. These were manually fixed in Stage 1 of
 * the nav-path audit; zero automated coverage existed before.
 *
 *  1. ExploreTodaySection  NowChip    → /event/:id        (was /events/:id)
 *  2. ExploreTodaySection  ChronRow   → /event/:id        (was /events/:id)
 *  3. CompassHome          event      → /event/:id        (was /events/:id)
 *  4. CompassHome          hidden_gem → /gems/:id         (gem: prefix stripped)
 *  5. CompassPicksSection  event      → /event/:id        (was /events/:id)
 *  6. CompassPicksSection  hidden_gem → /gems/:id         (gem: prefix stripped)
 *  7. CompassPicksSection  traveler   → /u/:handle        (was /(tabs)/discovery)
 *  8. MapEntityPreviewCard buddy      → /(rent-a-buddy)/buddy/:id  (prefix was missing)
 *  9. MapEntityPreviewCard event      → /event/:id        (was /events/:id)
 *
 * ## Mock strategy
 *
 * expo-router's singleton `router` is mocked via jest.mock(). All assertions
 * read `(router.push as jest.Mock).mock.calls`. Services that make network
 * calls are stubbed to return inert values so tests stay offline.
 *
 * NOTE comments on exhaustive mocks explain why requireActual is not used.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// ── Module mocks (hoisted by babel-jest before imports) ───────────────────────

// NOTE: intentional stub — expo-router requires native modules not available under
// jest-expo; spreading requireActual pulls in those modules and crashes the suite.
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: {
      push:     jest.fn(),
      back:     jest.fn(),
      replace:  jest.fn(),
      navigate: jest.fn(),
    },
    useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: jest.fn(() => ({})),
    usePathname:          () => '/',
    useSegments:          () => [],
    useFocusEffect: (cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    useNavigation: () => ({
      navigate:    jest.fn(),
      goBack:      jest.fn(),
      setOptions:  jest.fn(),
      addListener: (_e: unknown, _cb: unknown) => () => {},
    }),
    Link:     ({ children }: { children: React.ReactNode }) => children as any,
    Redirect: () => null,
    Stack:    { Screen: () => null },
    Tabs:     { Screen: () => null },
  };
});

// NOTE: intentional stub — useSafeAreaInsets requires native modules not available under jest-expo.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider:  ({ children }: { children: React.ReactNode }) => children,
}));

// ── ExploreTodaySection deps ───────────────────────────────────────────────────

// NOTE: intentional stub — FitsCard's real implementation pulls in Supabase and
// AsyncStorage internals that are not safe under jest-expo.
jest.mock('../PulseFits.tsx', () => ({
  FitsCard: () => null,
}));

// ── CompassHome deps ──────────────────────────────────────────────────────────

jest.mock('../../services/compass', () => ({
  ...jest.requireActual('../../services/compass'),
  fetchCompassHome:            jest.fn(),
  postCompassAnalyticsEvent:   jest.fn(),
  reportCompassViewed:         jest.fn(),
  COMPASS_ENGINE_VERSION:      'test-v0',
}));

// ── CompassPicksSection deps ──────────────────────────────────────────────────

// NOTE: intentional stub — useCompassFeed is a network hook; spreading
// requireActual would pull in Supabase / fetch internals that crash jest-expo.
jest.mock('../../hooks/compass/useCompassFeed.ts', () => ({
  useCompassFeed: jest.fn(),
}));

// NOTE: intentional stub — CompassWhySheet requires a native BottomSheet module
// not available under jest-expo.
jest.mock('../compass/CompassWhySheet.tsx', () => ({
  CompassWhySheet: () => null,
}));

// NOTE: intentional stub — CompassFeedbackMenu renders a native ActionSheet /
// BottomSheet that crashes under jest-expo.
jest.mock('../compass/CompassFeedbackMenu.tsx', () => ({
  CompassFeedbackMenu: () => null,
}));

jest.mock('../../utils/compassFormat', () => ({
  ...jest.requireActual('../../utils/compassFormat'),
  resolveCompassTitle:    jest.fn(() => 'Mock Title'),
  formatCompassSubtitle:  jest.fn(() => 'Mock Subtitle'),
  formatCompassContext:   jest.fn(() => 'Mock context'),
  resolveCompassCategory: jest.fn(() => 'Mock Category'),
}));

// ── MapEntityPreviewCard deps ─────────────────────────────────────────────────

// NOTE: intentional stub — MapEntityActionRow pulls in Supabase service calls
// and React Native Reanimated internals that are not safe under jest-expo.
jest.mock('../map/MapEntityActionRow.tsx', () => ({
  MapEntityActionRow: () => null,
}));

// NOTE: intentional stub — DisplayMediaImage / AvatarImage depend on expo-image
// native internals not available under jest-expo.
jest.mock('../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: () => null,
  AvatarImage:       () => null,
}));

// NOTE: intentional stub — openDirectThread makes a live Supabase RPC call;
// spreading requireActual would pull in network dependencies.
jest.mock('../../services/messaging', () => ({
  openDirectThread: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Imports (after mocks are hoisted) ─────────────────────────────────────────

import { router } from 'expo-router';
import { ExploreTodaySection } from '../ExploreTodaySection.tsx';
import { CompassHome }          from '../compass/CompassHome.tsx';
import { CompassPicksSection }  from '../compass/CompassPicksSection.tsx';
import { MapEntityPreviewCard } from '../map/MapEntityPreviewCard.tsx';
import { useCompassFeed }       from '../../hooks/compass/useCompassFeed.ts';
import { fetchCompassHome }     from '../../services/compass.ts';
import type { CompassFeedItem } from '../../services/compass.ts';
import type { MapEntity }       from '../../types/mapTypes.ts';
import type { BuddyProfile }    from '../../services/rentABuddy.ts';
import type { EventListItem }   from '../../services/events.ts';

// ── Typed mock refs ───────────────────────────────────────────────────────────

const mockPush            = router.push as jest.Mock;
const mockUseCompassFeed  = useCompassFeed as jest.Mock;
const mockFetchCompassHome = fetchCompassHome as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CITY_EVENT = {
  id: 'evt-abc',
  title: 'Jazz Night',
  startAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(), // 20 min from now
  attendeeCount: 30,
  capacity: 100,
  block: 'evening' as const,
};

function makeCompassFeedItem(overrides: Partial<CompassFeedItem> = {}): CompassFeedItem {
  return {
    id:                  'item-001',
    type:                'event',
    title:               'Test Item',
    category:            'culture',
    data:                {},
    score:               0.9,
    rank:                1,
    recommendationToken: 'tok-001',
    ...overrides,
  } as CompassFeedItem;
}

function makeCompassFeedResult(items: CompassFeedItem[]) {
  return {
    compassEnabled: true,
    loading:        false,
    data: {
      sections:  [{ name: 'compass_picks', items }],
      safeItems: [],
    },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPush.mockClear();

  // Default no-data stubs — individual tests override as needed
  mockUseCompassFeed.mockReturnValue({
    compassEnabled: false,
    loading:        false,
    data:           null,
  });
  mockFetchCompassHome.mockResolvedValue({ ok: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 & 2. ExploreTodaySection — /event/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('ExploreTodaySection — event navigation paths', () => {
  it('1. NowChip tapped → router.push called with /event/:id (not /events/)', async () => {
    await render(
      <ExploreTodaySection events={[CITY_EVENT]} city="Tokyo" />,
    );

    // The event appears in both the NowChip strip and the ChronRow list.
    // getAllByText returns them in DOM order; [0] is the NowChip (rendered first).
    fireEvent.press(screen.getAllByText('Jazz Night')[0]);

    expect(mockPush).toHaveBeenCalledTimes(1);
    const pushed = mockPush.mock.calls[0][0] as string;
    expect(pushed).toBe(`/event/${CITY_EVENT.id}`);
    expect(pushed).not.toMatch(/\/events\//);
  });

  it('2. ChronRow tapped → router.push called with /event/:id (not /events/)', async () => {
    // Only a ChronRow renders when the event is NOT in the ±60-min now window.
    const futureEvent = {
      ...CITY_EVENT,
      id: 'evt-future',
      title: 'Morning Yoga',
      startAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(), // 5 h from now
      block: 'morning' as const,
    };

    await render(
      <ExploreTodaySection events={[futureEvent]} city="Tokyo" />,
    );

    // The ChronRow appears in the "Full Day" section — every event is listed there.
    fireEvent.press(screen.getByText('Morning Yoga'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const pushed = mockPush.mock.calls[0][0] as string;
    expect(pushed).toBe(`/event/${futureEvent.id}`);
    expect(pushed).not.toMatch(/\/events\//);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 & 4. CompassHome — bestMoveTap paths
// ─────────────────────────────────────────────────────────────────────────────

describe('CompassHome — bestMoveTap navigation paths', () => {
  function renderCompassHome(bestNextMove: object) {
    mockFetchCompassHome.mockResolvedValue({
      ok:   true,
      data: {
        compassEnabled: true,
        fallback:       false,
        timeOfDay:      'evening',
        city:           'Tokyo',
        bestNextMove,
        startingSoon:   [],
      },
    });
    return render(<CompassHome onAsk={jest.fn()} />);
  }

  it('3. bestMoveTap (type=event) → router.push /event/:id (not /events/)', async () => {
    await renderCompassHome({ id: 'evt-xyz', type: 'event', title: 'Art Show' });

    // Wait for async fetchCompassHome to resolve and the card to appear.
    await screen.findByText('Art Show');
    fireEvent.press(screen.getByText('Art Show'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const pushed = mockPush.mock.calls[0][0] as string;
    expect(pushed).toBe('/event/evt-xyz');
    expect(pushed).not.toMatch(/\/events\//);
  });

  it('4. bestMoveTap (type=hidden_gem, gem:-prefixed id) → gem: prefix stripped → /gems/:id', async () => {
    await renderCompassHome({ id: 'gem:roof-bar', type: 'hidden_gem', title: 'Rooftop Bar' });

    await screen.findByText('Rooftop Bar');
    fireEvent.press(screen.getByText('Rooftop Bar'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const pushed = mockPush.mock.calls[0][0] as string;
    // gem: prefix must be stripped — the route is /gems/<raw-id>, not /gems/gem:<id>
    expect(pushed).toBe('/gems/roof-bar');
    expect(pushed).not.toContain('gem:');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5, 6, 7. CompassPicksSection — navigateToItem paths
// ─────────────────────────────────────────────────────────────────────────────

describe('CompassPicksSection — navigateToItem paths', () => {
  it('5. event card action tapped → router.push /event/:id (not /events/)', async () => {
    mockUseCompassFeed.mockReturnValue(
      makeCompassFeedResult([
        makeCompassFeedItem({ id: 'evt-picks-1', type: 'event', title: 'Rooftop Concert' }),
      ]),
    );

    await render(<CompassPicksSection city="Tokyo" enabled />);

    // The "Join" action button triggers handleActionTap → navigateToItem.
    fireEvent.press(screen.getByText('Join'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const pushed = mockPush.mock.calls[0][0] as string;
    expect(pushed).toBe('/event/evt-picks-1');
    expect(pushed).not.toMatch(/\/events\//);
  });

  it('6. hidden_gem card action tapped → gem: prefix stripped → /gems/:id', async () => {
    mockUseCompassFeed.mockReturnValue(
      makeCompassFeedResult([
        makeCompassFeedItem({
          id:   'gem:secret-cafe',
          type: 'hidden_gem',
          title: 'Secret Café',
          data: { id: 'secret-cafe' },
        }),
      ]),
    );

    await render(<CompassPicksSection city="Tokyo" enabled />);

    // "View" is the default action label for unmapped types; hidden_gem falls through.
    fireEvent.press(screen.getByText('View'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const pushed = mockPush.mock.calls[0][0] as string;
    // gem: prefix must be stripped — the route is /gems/<rawId>
    expect(pushed).toBe('/gems/secret-cafe');
    expect(pushed).not.toContain('gem:');
  });

  it('7. traveler card action tapped → /u/:handle (not /(tabs)/discovery)', async () => {
    mockUseCompassFeed.mockReturnValue(
      makeCompassFeedResult([
        makeCompassFeedItem({
          id:   'usr-1',
          type: 'traveler',
          title: 'Alice',
          data: { handle: 'alice_travels', username: 'alice_travels' },
        }),
      ]),
    );

    await render(<CompassPicksSection city="Tokyo" enabled />);

    // "Follow" is the action label for traveler type.
    fireEvent.press(screen.getByText('Follow'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const pushed = mockPush.mock.calls[0][0] as string;
    expect(pushed).toBe('/u/alice_travels');
    expect(pushed).not.toContain('/(tabs)/discovery');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 & 9. MapEntityPreviewCard — CTA navigation paths
// ─────────────────────────────────────────────────────────────────────────────

describe('MapEntityPreviewCard — CTA navigation paths', () => {
  const onClose = jest.fn();

  beforeEach(() => onClose.mockClear());

  it('8. buddy CTA → /(rent-a-buddy)/buddy/:id (not /buddy/:id without prefix)', async () => {
    const buddyEntity: MapEntity<BuddyProfile> = {
      id:      'buddy-77',
      type:    'buddies',
      lat:     35.6762,
      lng:     139.6503,
      payload: {
        id:            'buddy-77',
        displayName:   'Kenji',
        categories:    ['Food', 'Culture'],
        city:          'Tokyo',
        hourlyRateUsd: 25,
        averageRating: 4.8,
        reviewCount:   14,
        coverPhotoUrl: null,
      } as unknown as BuddyProfile,
    };

    await render(<MapEntityPreviewCard entity={buddyEntity} onClose={onClose} />);

    fireEvent.press(screen.getByText('View Buddy Profile'));

    // Navigation is deferred until after the sheet's close animation finishes
    // (BUG CC/CD fix — see closeThenNavigate), so wait for it here.
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    const pushed = mockPush.mock.calls[0][0] as string;
    expect(pushed).toBe('/(rent-a-buddy)/buddy/buddy-77');
    // Must include the /(rent-a-buddy)/ group prefix — the old bug omitted it.
    expect(pushed).toContain('/(rent-a-buddy)/');
    expect(pushed).not.toMatch(/^\/buddy\//);
  });

  it('9. event CTA → /event/:id (not /events/:id)', async () => {
    const eventEntity: MapEntity<EventListItem> = {
      id:   'event:concert-88',
      type: 'events',
      lat:  35.6762,
      lng:  139.6503,
      payload: {
        id:         'concert-88',
        title:      'Live Jazz',
        startsAt:   new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        endsAt:     null,
        goingCount: 42,
        priceType:  'free',
        hostName:   'Jazz Club',
        coverUrl:   null,
      } as unknown as EventListItem,
    };

    await render(<MapEntityPreviewCard entity={eventEntity} onClose={onClose} />);

    fireEvent.press(screen.getByText('View Event'));

    // Navigation is deferred until after the sheet's close animation finishes
    // (BUG CC/CD fix — see closeThenNavigate), so wait for it here.
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    const pushed = mockPush.mock.calls[0][0] as string;
    expect(pushed).toBe('/event/concert-88');
    expect(pushed).not.toMatch(/\/events\//);
  });
});
