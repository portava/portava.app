/**
 * DiscoveryEventPostsRail — the client caller for GET /api/discovery/feed
 * (serve point 7).
 *
 * What this pins:
 *   • it calls getDiscoveryFeed for the destination with includePlaces=false
 *     (posts-only — the places baseline is left to GET /discovery)
 *   • it renders one DiscoveryEventPostCard per returned post
 *   • opening a post reports a 'discovery' rank outcome threaded with the
 *     feed's sessionId (the served rank context) — so the outcome upgrades the
 *     exact serve-point-7 impression this load wrote
 *   • no posts ⇒ it renders nothing (absence of posts is not an error)
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { DiscoveryEventPostsRail } from '../DiscoveryEventPostsRail.tsx';
import type { DiscoveryEventPost } from '../../../types/discovery.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockReportTap = jest.fn();
const mockUseRankOutcome = jest.fn(() => ({
  reportTap:  mockReportTap,
  reportSave: jest.fn(),
  reportJoin: jest.fn(),
  reportRsvp: jest.fn(),
}));
// NOTE: intentionally exhaustive — the real hook posts through fetch; these
// tests assert what the rail hands the hook (surface + sessionId) and which
// report it fires, never the wire (useRankOutcome.component.test.ts covers it).
jest.mock('../../../hooks/useRankOutcome', () => ({
  useRankOutcome: (...args: unknown[]) => mockUseRankOutcome(...(args as [])),
}));

const mockGetDiscoveryFeed = jest.fn();
// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals that crash under jest-expo; only the feed call is needed and
// its result is controlled per test.
jest.mock('../../../services/discovery', () => ({
  getDiscoveryFeed: (...args: unknown[]) => mockGetDiscoveryFeed(...(args as [])),
}));

// NOTE: intentionally exhaustive — a stub that surfaces the post id and invokes
// the outcome callback the way the real card does before navigating, so the
// rail's outcome wiring is observable without expo-router / expo-image.
jest.mock('../DiscoveryEventPostCard', () => ({
  DiscoveryEventPostCard: ({ post, onOpen }: { post: { id: string }; onOpen?: () => void }) => {
    const RN = require('react-native');
    return (
      <RN.Pressable testID={`post-stub-${post.id}`} onPress={() => onOpen?.()}>
        <RN.Text>{post.id}</RN.Text>
      </RN.Pressable>
    );
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function post(id: string): DiscoveryEventPost {
  return {
    id,
    authorId: `author-${id}`,
    content: `Live from ${id}`,
    mediaUrls: [],
    venueName: null,
    locationCity: 'Miami',
    publicLat: null,
    publicLng: null,
    createdAt: new Date().toISOString(),
    likeCount: 0,
    commentCount: 0,
    linkedEventId: null,
    linkedEventTitle: null,
    venueLabel: null,
    sourceKind: 'venue_category',
  };
}

function feedResult(posts: DiscoveryEventPost[], sessionId: string | null) {
  return {
    ok: true as const,
    data: {
      places: [],
      posts,
      nextCursor: null,
      total: posts.length,
      destination: 'Miami',
      sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: posts.length },
      sessionId,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryEventPostsRail', () => {
  it('fetches the feed posts-only and renders a card per post', async () => {
    mockGetDiscoveryFeed.mockResolvedValue(feedResult([post('p1'), post('p2')], 'sess-1'));

    const { getByTestId } = await render(<DiscoveryEventPostsRail destination="Miami" lat={25.77} lng={-80.19} />);

    await waitFor(() => expect(getByTestId('post-stub-p1')).toBeTruthy());
    expect(getByTestId('post-stub-p2')).toBeTruthy();

    expect(mockGetDiscoveryFeed).toHaveBeenCalledTimes(1);
    const arg = mockGetDiscoveryFeed.mock.calls[0][0];
    expect(arg.destination).toBe('Miami');
    expect(arg.includePlaces).toBe(false);
  });

  it("opening a post reports a 'discovery' tap outcome threaded with the feed sessionId", async () => {
    mockGetDiscoveryFeed.mockResolvedValue(feedResult([post('p1')], 'sess-xyz'));

    const { getByTestId } = await render(<DiscoveryEventPostsRail destination="Miami" />);
    await waitFor(() => expect(getByTestId('post-stub-p1')).toBeTruthy());

    // Once posts resolve, the hook is (re)constructed with the served context.
    expect(mockUseRankOutcome).toHaveBeenLastCalledWith({ surface: 'discovery', sessionId: 'sess-xyz' });

    fireEvent.press(getByTestId('post-stub-p1'));
    expect(mockReportTap).toHaveBeenCalledWith('p1');
  });

  it('renders nothing when the feed returns no posts', async () => {
    mockGetDiscoveryFeed.mockResolvedValue(feedResult([], 'sess-empty'));

    const { queryByTestId } = await render(<DiscoveryEventPostsRail destination="Miami" />);
    await waitFor(() => expect(mockGetDiscoveryFeed).toHaveBeenCalled());
    expect(queryByTestId('discovery-event-posts-rail')).toBeNull();
  });

  it('does not fetch when there is no destination and no coordinates', async () => {
    const { queryByTestId } = await render(<DiscoveryEventPostsRail destination={null} />);
    await waitFor(() => expect(queryByTestId('discovery-event-posts-rail')).toBeNull());
    expect(mockGetDiscoveryFeed).not.toHaveBeenCalled();
  });
});
