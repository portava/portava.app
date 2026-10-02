/**
 * ForYouTab — a pull refetches the "Live from events" rail (census-discovery
 * §94.10, lane W11-X2 round 2; DV-83).
 *
 * The rail's refused copy says "Pull to refresh", but ForYouTab.handleRefresh
 * reloaded only the OSM baseline: the rail's effect inputs did not change, so
 * a pull never asked the feed again and the refused state stayed on screen.
 * This runs the REAL ForYouTab with the REAL rail; only the service and the
 * heavy children are stubbed.
 *
 *   R1  refused → pull → a second getDiscoveryFeed call, and the rail shows the
 *       posts it answered
 *   R2  CONTROL: without a pull the rail asks once
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

// ── Services ──────────────────────────────────────────────────────────────────

const mockGetDiscoveryPlaces       = jest.fn();
const mockGetCachedDiscoveryPlaces = jest.fn();
const mockGetDiscoveryFeed         = jest.fn();

// NOTE: intentionally exhaustive — the real module imports Supabase; spreading
// requireActual would load the client and OOM the Jest runner.
jest.mock('../../../services/discovery', () => ({
  getDiscoveryPlaces:       (...args: unknown[]) => mockGetDiscoveryPlaces(...args),
  getSavedPlaceIds:         jest.fn().mockResolvedValue([]),
  getCachedDiscoveryPlaces: (...args: unknown[]) => mockGetCachedDiscoveryPlaces(...args),
  // The REAL DiscoveryEventPostsRail calls this; each test controls its answers.
  getDiscoveryFeed:         (...args: unknown[]) => mockGetDiscoveryFeed(...args),
}));

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../services/compass', () => ({
  postCompassFrontloadEvent:  jest.fn().mockResolvedValue(undefined),
  reportCompassViewed:        jest.fn().mockResolvedValue(undefined),
  fetchCompassSettings:       jest.fn().mockResolvedValue({ data: null, error: null }),
  fetchCompassPreferences:    jest.fn().mockResolvedValue({ data: null, error: null }),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — the real hook imports Supabase + realtime.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, userId: 'u-test-1' }),
}));

// NOTE: intentionally exhaustive — the real hook opens Compass WebSocket.
jest.mock('../../../hooks/compass/useCompassFeed', () => ({
  useCompassFeed: () => ({ data: null, compassEnabled: false, refresh: jest.fn() }),
}));

// NOTE: intentionally exhaustive — the real hook fetches community posts.
jest.mock('../../../hooks/useCommunityDiscovery', () => ({
  useCommunityDiscovery: () => ({ gems: [], picks: [], places: [], loading: false }),
}));

// ── Heavy child component stubs ───────────────────────────────────────────────

const Null = () => null;

// NOTE: intentional stub — not under test; real implementation pulls react-native-maps.
jest.mock('../PlaceCard', () => ({ __esModule: true, default: Null }));
// NOTE: intentional stub — not under test; pulls native Sheet modules.
jest.mock('../PlaceDetailSheet', () => ({ PlaceDetailSheet: Null }));
// NOTE: intentional stub — not under test; pulls native Share + Sheet modules.
jest.mock('../../DiscoveryShareSheet', () => ({ DiscoveryShareSheet: Null }));
// NOTE: intentional stub — not under test; pulls Supabase.
jest.mock('../../compass/CompassFeedbackMenu', () => ({ CompassFeedbackMenu: Null }));
// NOTE: intentional stub — not under test; pulls Supabase.
jest.mock('../../compass/CompassWhySheet', () => ({ CompassWhySheet: Null }));
// NOTE: intentional stub — not under test; pulls Supabase + native modules.
jest.mock('../../compass/CompassTravelerRow', () => ({ CompassTravelerRow: Null }));
// NOTE: intentional stub — not under test; pulls SVG native module.
jest.mock('../../icons/TelegraphSendIcon', () => ({ TelegraphSendIcon: Null }));
// NOTE: intentional stub — not under test; pulls Supabase + community data.
jest.mock('../../DiscoveryWall', () => ({
  HiddenGemsSection:    Null,
  TravelerPicksSection: Null,
  prefillSavedPlaceIds: jest.fn(),
}));
// NOTE: intentional stub — not under test; pulls reanimated animations.
jest.mock('../PlaceSkeleton', () => ({ PlaceSkeletonList: Null }));

// NOTE: intentionally exhaustive — the rail's outcome hook posts through fetch.
jest.mock('../../../hooks/useRankOutcome', () => ({
  useRankOutcome: () => ({ reportTap: jest.fn(), reportSave: jest.fn(), reportJoin: jest.fn(), reportRsvp: jest.fn() }),
}));
// NOTE: intentional stub — a card that surfaces the post id, without expo-router / expo-image.
jest.mock('../DiscoveryEventPostCard', () => ({
  DiscoveryEventPostCard: ({ post }: { post: { id: string } }) => {
    const RN = require('react-native');
    return <RN.Text testID={`post-stub-${post.id}`}>{post.id}</RN.Text>;
  },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { ForYouTab } from '../ForYouTab.tsx';

const MOCK_PLACE = {
  id: 'p1', name: 'Cafe A', category: 'food', type: null, description: null,
  distanceKm: null, lat: null, lng: null, address: null, openingHours: null,
  rating: null, photoUrl: null, visitCount: null, savedCount: null,
};
const REFUSED = {
  ok: true as const,
  data: {
    places: [], posts: [], nextCursor: null, total: 0, destination: 'Lisbon',
    sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 0 }, sessionId: null,
    refusal: { class: 'transient_db', code: 'feed_event_posts_read_failed', route: 'GET /discovery/feed', coverage: 'nothing', failedSources: ['event_posts'] },
  },
};
const POSTED = {
  ok: true as const,
  data: {
    places: [], nextCursor: null, total: 1, destination: 'Lisbon',
    posts: [{ id: 'post-1', authorId: 'a', content: 'live', mediaUrls: [], venueName: null, locationCity: 'Lisbon', publicLat: null, publicLng: null, createdAt: new Date().toISOString(), likeCount: 0, commentCount: 0, linkedEventId: null, linkedEventTitle: null, venueLabel: null, sourceKind: 'venue_category' }],
    sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 1 }, sessionId: 's-2',
  },
};

describe('ForYouTab — a pull refetches the Live-from-events rail (§94.10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedDiscoveryPlaces.mockReturnValue(null);
    mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: { places: [MOCK_PLACE] } });
  });
  afterEach(async () => { await act(async () => {}); });

  it('R1 refused → pull → the rail asks the feed again and shows what it answered', async () => {
    mockGetDiscoveryFeed.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(POSTED);
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} />);
    expect(await screen.findByTestId('discovery-event-posts-rail-refused')).toBeTruthy();
    expect(mockGetDiscoveryFeed).toHaveBeenCalledTimes(1);

    const scroll = await screen.findByTestId('main-scroll');
    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    await waitFor(() => expect(mockGetDiscoveryFeed).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('post-stub-post-1')).toBeTruthy();
    expect(screen.queryByTestId('discovery-event-posts-rail-refused')).toBeNull();
  });

  it('R2 CONTROL: without a pull, the rail asks once', async () => {
    mockGetDiscoveryFeed.mockResolvedValue(REFUSED);
    await render(<ForYouTab destination="Lisbon" onAddToPlan={jest.fn()} />);
    expect(await screen.findByTestId('discovery-event-posts-rail-refused')).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(mockGetDiscoveryFeed).toHaveBeenCalledTimes(1);
  });
});
