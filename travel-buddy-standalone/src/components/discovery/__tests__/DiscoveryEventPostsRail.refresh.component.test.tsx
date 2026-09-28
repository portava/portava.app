/**
 * DiscoveryEventPostsRail — a pull refetches the rail (census-discovery §97,
 * DV-83; the second path §94.10's verifier found).
 *
 * The refused state tells the user "Pull to refresh". The rail fetched only
 * when its destination or coordinates changed, so pulling the For You tab
 * reloaded the places and left this rail on its refused copy. ForYouTab now
 * bumps `refreshKey` on every pull (ForYouTab.pullToRefresh covers that
 * wiring); here the rail itself is held to it.
 *
 *   R1  a new refreshKey with the same place refetches, and a healthy answer replaces the refused copy
 *   R2  CONTROL: re-rendering with the same refreshKey does not refetch
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { DiscoveryEventPostsRail } from '../DiscoveryEventPostsRail.tsx';
import type { DiscoveryEventPost } from '../../../types/discovery.ts';

// NOTE: intentionally exhaustive — the rail's outcome hook posts through fetch;
// nothing here is about outcomes.
jest.mock('../../../hooks/useRankOutcome', () => ({
  useRankOutcome: () => ({ reportTap: jest.fn(), reportSave: jest.fn(), reportJoin: jest.fn(), reportRsvp: jest.fn() }),
}));

const mockGetDiscoveryFeed = jest.fn();
// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals that crash under jest-expo; only the feed call is needed.
jest.mock('../../../services/discovery', () => ({
  getDiscoveryFeed: (...args: unknown[]) => mockGetDiscoveryFeed(...(args as [])),
}));

// NOTE: intentionally exhaustive — a stub card that surfaces the post id.
jest.mock('../DiscoveryEventPostCard', () => ({
  DiscoveryEventPostCard: ({ post }: { post: { id: string } }) => {
    const RN = require('react-native');
    return <RN.Text testID={`post-stub-${post.id}`}>{post.id}</RN.Text>;
  },
}));

function post(id: string): DiscoveryEventPost {
  return {
    id, authorId: `author-${id}`, content: `Live from ${id}`, mediaUrls: [],
    venueName: null, locationCity: 'Miami', publicLat: null, publicLng: null,
    createdAt: new Date().toISOString(), likeCount: 0, commentCount: 0,
    linkedEventId: null, linkedEventTitle: null, venueLabel: null,
    sourceKind: 'venue_category',
  };
}

const REFUSED = {
  ok: true as const,
  data: {
    places: [], posts: [] as DiscoveryEventPost[], nextCursor: null, total: 0, destination: 'Miami',
    sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 0 }, sessionId: null,
    refusal: { class: 'upstream_unavailable', code: 'feed_viewer_unresolved', route: 'GET /discovery/feed', coverage: 'nothing', failedSources: ['event_posts'] },
  },
};
const healthy = (posts: DiscoveryEventPost[]) => ({
  ok: true as const,
  data: {
    places: [], posts, nextCursor: null, total: posts.length, destination: 'Miami',
    sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: posts.length }, sessionId: 'sess-2',
  },
});

beforeEach(() => { jest.clearAllMocks(); });

describe('DiscoveryEventPostsRail — a pull reaches the rail (§97, DV-83)', () => {
  it('R1 a new refreshKey with the same place refetches, and a healthy answer replaces the refused copy', async () => {
    mockGetDiscoveryFeed.mockResolvedValue(REFUSED);
    const r = await render(<DiscoveryEventPostsRail destination="Miami" refreshKey={0} />);
    expect(await r.findByTestId('discovery-event-posts-rail-refused')).toBeTruthy();
    const before = mockGetDiscoveryFeed.mock.calls.length;

    mockGetDiscoveryFeed.mockResolvedValue(healthy([post('p1')]));
    await r.rerender(<DiscoveryEventPostsRail destination="Miami" refreshKey={1} />);
    expect(await r.findByTestId('post-stub-p1')).toBeTruthy();
    expect(mockGetDiscoveryFeed.mock.calls.length).toBeGreaterThan(before);
    expect(r.queryByTestId('discovery-event-posts-rail-refused')).toBeNull();
  });

  it('R2 CONTROL: re-rendering with the same refreshKey does not refetch', async () => {
    mockGetDiscoveryFeed.mockResolvedValue(REFUSED);
    const r = await render(<DiscoveryEventPostsRail destination="Miami" refreshKey={3} />);
    expect(await r.findByTestId('discovery-event-posts-rail-refused')).toBeTruthy();
    const before = mockGetDiscoveryFeed.mock.calls.length;

    await r.rerender(<DiscoveryEventPostsRail destination="Miami" refreshKey={3} />);
    await waitFor(() => expect(r.queryByTestId('discovery-event-posts-rail-refused')).not.toBeNull());
    expect(mockGetDiscoveryFeed.mock.calls.length).toBe(before);
  });
});
