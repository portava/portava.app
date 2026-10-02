/**
 * DiscoveryEventPostsRail — a PARTIAL feed whose event-post read failed says
 * so (census-discovery §94, lane W11-X2; DV-83, hunk §80.7; the wording is
 * register D-W10-S1-2's).
 *
 * The server now carries a failed event-post read on the feed's refusal
 * envelope as `failedSources: ["event_posts"]` (api-server
 * src/test/discoveryFeedEventPostsCoverage.test.ts). With the posts' own read
 * failing, a `coverage: "partial"` answer means the rail's list may be short:
 * D-W10-S1-2 says rows are kept, one line says the list may be incomplete, and
 * a partial answer with no rows is never the "nothing here" state (which, for
 * this rail, is rendering nothing at all).
 *
 * A partial that names only PLACE categories does not describe this rail: it
 * renders event posts only, and those were read in full.
 *
 * Round 2 (§94.10, register D-W11X2-11): a transport failure (U1: a 5xx, a
 * network failure, the request budget; U2: a rejected call) is not "nothing
 * live" either — it gets the rail's "couldn't check" line under its own testID.
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

function feed(posts: DiscoveryEventPost[], refusal?: { coverage: 'nothing' | 'partial'; failedSources?: string[]; code?: string }) {
  return {
    ok: true as const,
    data: {
      places: [], posts, nextCursor: null, total: posts.length, destination: 'Miami',
      sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: posts.length },
      sessionId: refusal?.coverage === 'nothing' ? null : 'sess-1',
      ...(refusal ? { refusal: { class: 'transient_db', code: refusal.code ?? 'feed_event_posts_read_failed', route: 'GET /discovery/feed', ...refusal } } : {}),
    },
  };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('DiscoveryEventPostsRail — a failed event-post read is not a complete list (§94, DV-83)', () => {
  it('P1. partial, event_posts failed, posts present: the posts are shown AND one line says the list may be incomplete', async () => {
    mockGetDiscoveryFeed.mockResolvedValue(feed([post('p1')], { coverage: 'partial', failedSources: ['event_posts'] }));
    const { findByTestId, getByTestId, queryByText, queryByTestId } = await render(<DiscoveryEventPostsRail destination="Miami" />);
    expect(await findByTestId('discovery-event-posts-rail-partial')).toBeTruthy();
    expect(getByTestId('post-stub-p1')).toBeTruthy();
    expect(queryByText('Some event posts couldn’t be loaded just now, so this list may be incomplete.')).not.toBeNull();
    expect(queryByTestId('discovery-event-posts-rail-refused')).toBeNull();
  });

  it('P2. partial, event_posts failed, NO posts: the partial-empty state, never silence', async () => {
    mockGetDiscoveryFeed.mockResolvedValue(feed([], { coverage: 'partial', failedSources: ['for_you', 'event_posts'], code: 'feed_places_read_failed' }));
    const { findByTestId, queryByText } = await render(<DiscoveryEventPostsRail destination="Miami" />);
    expect(await findByTestId('discovery-event-posts-rail-partial-empty')).toBeTruthy();
    expect(queryByText('Some event posts couldn’t be loaded just now')).not.toBeNull();
    expect(queryByText('This is on our side, not your filters. Try again in a moment.')).not.toBeNull();
  });

  it('P3. CONTROL: a partial naming only PLACE categories does not describe this rail — posts shown, no notice', async () => {
    mockGetDiscoveryFeed.mockResolvedValue(feed([post('p1')], { coverage: 'partial', failedSources: ['for_you'], code: 'feed_places_read_failed' }));
    const { findByTestId, queryByTestId } = await render(<DiscoveryEventPostsRail destination="Miami" />);
    expect(await findByTestId('post-stub-p1')).toBeTruthy();
    expect(queryByTestId('discovery-event-posts-rail-partial')).toBeNull();
    expect(queryByTestId('discovery-event-posts-rail-partial-empty')).toBeNull();
  });

  it('P4. CONTROL: coverage "nothing" is still the refused state, not the partial one', async () => {
    mockGetDiscoveryFeed.mockResolvedValue(feed([], { coverage: 'nothing', failedSources: ['event_posts'] }));
    const { findByTestId, queryByTestId } = await render(<DiscoveryEventPostsRail destination="Miami" />);
    expect(await findByTestId('discovery-event-posts-rail-refused')).toBeTruthy();
    expect(queryByTestId('discovery-event-posts-rail-partial')).toBeNull();
    expect(queryByTestId('discovery-event-posts-rail-partial-empty')).toBeNull();
  });

  it('P5. CONTROL: a healthy feed carries no notice', async () => {
    mockGetDiscoveryFeed.mockResolvedValue(feed([post('p1')]));
    const { findByTestId, queryByTestId } = await render(<DiscoveryEventPostsRail destination="Miami" />);
    expect(await findByTestId('post-stub-p1')).toBeTruthy();
    expect(queryByTestId('discovery-event-posts-rail-partial')).toBeNull();
  });

  it('P5b. CONTROL: an empty healthy feed still renders nothing', async () => {
    mockGetDiscoveryFeed.mockResolvedValue(feed([]));
    const { queryByTestId } = await render(<DiscoveryEventPostsRail destination="Lisbon" />);
    await waitFor(() => expect(mockGetDiscoveryFeed).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(queryByTestId('discovery-event-posts-rail')).toBeNull();
    expect(queryByTestId('discovery-event-posts-rail-partial-empty')).toBeNull();
    expect(queryByTestId('discovery-event-posts-rail-unavailable')).toBeNull();
  });

  // ── Round 2 (§94.10, register D-W11X2-11): a transport failure is not "nothing live" ──
  for (const [name, answer] of [
    ['a 5xx', { ok: false as const, error: 'HTTP 503' }],
    ['a network failure', { ok: false as const, error: 'Network error — check your connection' }],
    ['the request budget (timeout)', { ok: false as const, error: 'timeout' }],
  ] as const) {
    it(`U1. ${name} is the "couldn\u2019t check" line, not silence and not the refused state`, async () => {
      mockGetDiscoveryFeed.mockResolvedValue(answer);
      const { findByTestId, queryByTestId, queryByText } = await render(<DiscoveryEventPostsRail destination="Miami" />);
      expect(await findByTestId('discovery-event-posts-rail-unavailable')).toBeTruthy();
      expect(queryByText(/couldn't check what's live/i)).not.toBeNull();
      expect(queryByTestId('discovery-event-posts-rail-refused')).toBeNull();
    });
  }

  it('U2. a rejected call is the same "couldn\u2019t check" line', async () => {
    mockGetDiscoveryFeed.mockRejectedValue(new Error('boom'));
    const { findByTestId } = await render(<DiscoveryEventPostsRail destination="Miami" />);
    expect(await findByTestId('discovery-event-posts-rail-unavailable')).toBeTruthy();
  });

  it('U3. the "couldn\u2019t check" line clears once a later load answers', async () => {
    mockGetDiscoveryFeed.mockResolvedValueOnce({ ok: false as const, error: 'timeout' }).mockResolvedValueOnce(feed([post('p9')]));
    const view = await render(<DiscoveryEventPostsRail destination="Miami" refreshKey={0} />);
    expect(await view.findByTestId('discovery-event-posts-rail-unavailable')).toBeTruthy();
    await view.rerender(<DiscoveryEventPostsRail destination="Miami" refreshKey={1} />);
    expect(await view.findByTestId('post-stub-p9')).toBeTruthy();
    expect(view.queryByTestId('discovery-event-posts-rail-unavailable')).toBeNull();
  });
});
