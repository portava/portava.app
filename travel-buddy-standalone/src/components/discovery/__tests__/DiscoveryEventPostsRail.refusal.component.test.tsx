/**
 * DiscoveryEventPostsRail — a REFUSED feed must not produce exposure attribution.
 *
 * OWNER RULING, 2026-09-14: "...exclude failed responses from exposure
 * accounting. A distinguishable response body alone is insufficient if consumers
 * still treat it as successful empty data."
 *
 * The server half of that is `logServeUnlessRefused` (api-server
 * src/lib/discoveryRefusal.ts): a refused response writes no `rank_events`
 * impression row, so it never enters `content_distribution_stats.
 * eligible_impressions` — the exposure DENOMINATOR.
 *
 * This file is the client half, and it is a different claim. The rail does not
 * write impressions; it reports OUTCOMES, and it threads the feed's per-load
 * `sessionId` into `useRankOutcome` so POST /rank-events/outcome upgrades THE
 * IMPRESSION THIS LOAD WROTE rather than the most-recent 'discovery' impression
 * across all serve points (the module header of DiscoveryEventPostsRail.tsx
 * records why that distinction exists).
 *
 * A refused load wrote NO impression. If the client keeps that load's sessionId
 * anyway, an outcome reported against it is a funnel numerator with no
 * denominator behind it — the mirror image of the server-side defect, and just
 * as invisible in the aggregate.
 *
 * Reachable from the Explore tab: ForYouTab renders this rail under
 * "Live from events".
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { DiscoveryEventPostsRail } from '../DiscoveryEventPostsRail.tsx';
import type { DiscoveryEventPost } from '../../../types/discovery.ts';

const mockReportTap = jest.fn();
const mockUseRankOutcome = jest.fn(() => ({
  reportTap:  mockReportTap,
  reportSave: jest.fn(),
  reportJoin: jest.fn(),
  reportRsvp: jest.fn(),
}));
// NOTE: intentionally exhaustive — the real hook posts through fetch; this file
// asserts what the rail HANDS the hook (surface + sessionId), never the wire.
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

// NOTE: intentionally exhaustive — a stub that surfaces the post id, so the
// rail's wiring is observable without expo-router / expo-image.
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

function post(id: string): DiscoveryEventPost {
  return {
    id, authorId: `author-${id}`, content: `Live from ${id}`, mediaUrls: [],
    venueName: null, locationCity: 'Miami', publicLat: null, publicLng: null,
    createdAt: new Date().toISOString(), likeCount: 0, commentCount: 0,
    linkedEventId: null, linkedEventTitle: null, venueLabel: null,
    sourceKind: 'venue_category',
  };
}

/** What `getDiscoveryFeed` hands back — including its refusal handling. */
function feedResult(
  posts: DiscoveryEventPost[],
  sessionId: string | null,
  refusal?: { class: string; code: string; route: string; coverage: 'nothing' | 'partial' },
) {
  return {
    ok: true as const,
    data: {
      places: [], posts, nextCursor: null, total: posts.length, destination: 'Miami',
      sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: posts.length },
      sessionId,
      ...(refusal ? { refusal } : {}),
    },
  };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('DiscoveryEventPostsRail — refused feeds and exposure attribution', () => {
  it('holds NO session id after a coverage:"nothing" refusal', async () => {
    // getDiscoveryFeed nulls the sessionId for a refused load (see its doc
    // comment). This asserts the rail actually carries that null into the
    // outcome hook rather than substituting one of its own.
    mockGetDiscoveryFeed.mockResolvedValue(
      feedResult([], null, {
        class: 'upstream_unavailable', code: 'nominatim_http_429',
        route: 'GET /discovery/feed', coverage: 'nothing',
      }),
    );

    await render(<DiscoveryEventPostsRail destination="Miami" />);
    await waitFor(() => expect(mockGetDiscoveryFeed).toHaveBeenCalled());

    expect(mockUseRankOutcome).toHaveBeenLastCalledWith({ surface: 'discovery', sessionId: null });
  });

  it('POSITIVE CONTROL: a real serve DOES hand the hook its session id', async () => {
    // Without this, `sessionId: null` above would also pass if the rail had
    // stopped threading the session entirely — which would silently break
    // outcome attribution on every healthy load, the exact bug the sessionId
    // was introduced to fix.
    mockGetDiscoveryFeed.mockResolvedValue(feedResult([post('p1')], 'sess-real'));

    const { getByTestId } = await render(<DiscoveryEventPostsRail destination="Miami" />);
    await waitFor(() => expect(getByTestId('post-stub-p1')).toBeTruthy());

    expect(mockUseRankOutcome).toHaveBeenLastCalledWith({ surface: 'discovery', sessionId: 'sess-real' });
  });

  it('a PARTIAL refusal that still served posts KEEPS its session id', async () => {
    // Those posts really were served and really are exposure; the server logged
    // them. Dropping the attribution here would under-count the funnel — the
    // same corruption in the other direction.
    mockGetDiscoveryFeed.mockResolvedValue(
      feedResult([post('p1')], 'sess-partial', {
        class: 'transient_db', code: 'feed_places_read_failed',
        route: 'GET /discovery/feed', coverage: 'partial',
      }),
    );

    const { getByTestId } = await render(<DiscoveryEventPostsRail destination="Miami" />);
    await waitFor(() => expect(getByTestId('post-stub-p1')).toBeTruthy());

    expect(mockUseRankOutcome).toHaveBeenLastCalledWith({ surface: 'discovery', sessionId: 'sess-partial' });
  });
});
