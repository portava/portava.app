/**
 * Featured badge data-path regression tests.
 *
 * Confirms featuredByPortava survives both adapter layers:
 *  1. mapServerFeedItem (Watch/Roam feed) — server shape → client MediaFeedItem
 *  2. pulsePostToFeedItem (Pulse feed) — PulsePost → PulseFeedItem
 *
 * Uses jest-expo (component test runner) so React Native module chains resolve.
 */

// ── Supabase / native module stubs ───────────────────────────────────────────
// NOTE: intentionally exhaustive — spreading requireActual pulls in native
// modules that crash the JS-only renderer; only the minimal auth/from surface
// is consumed transitively by pulse.ts and mediaFeed.ts under test here.
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) },
    from: jest.fn().mockReturnThis(),
  }),
}));
// NOTE: intentionally exhaustive — expo-secure-store requires native binaries;
// only getItemAsync/setItemAsync/deleteItemAsync are used in the auth chain.
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));
// NOTE: intentionally exhaustive — expo-router is only imported transitively;
// no router calls are exercised in these pure mapping tests.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

import { mapServerFeedItem } from '../../services/mediaFeed.ts';
import { pulsePostToFeedItem } from '../../services/pulse.ts';
import type { PulsePost } from '../../types/pulse.ts';

// ── Minimal server MediaFeedItem fixture ──────────────────────────────────────

function makeServerFeedItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    sourceType: 'post' as const,
    sourceId: 'post-1',
    caption: 'Hello',
    tags: [],
    createdAt: '2026-07-01T00:00:00Z',
    creator: {
      id: 'user-1',
      displayName: 'Tester',
      username: 'tester',
      avatarUrl: null,
      isVerified: false,
      isPrivate: false,
      relationshipStatus: 'none' as const,
      followersCount: null,
      followingCount: null,
      bio: null,
    },
    media: [],
    stats: { viewCount: 0, likeCount: 0, saveCount: 0, commentCount: 0, stampItCount: 0 },
    location: null,
    viewerState: { hasLiked: false, hasSaved: false, isFollowingCreator: false, hasFollowRequestPending: false },
    privacy: { isPrivate: false },
    moderation: { status: 'approved' },
    linkedEntity: null,
    locationVerified: false,
    ...overrides,
  };
}

// ── Minimal PulsePost fixture ─────────────────────────────────────────────────

function makePulsePost(overrides: Record<string, unknown> = {}): PulsePost {
  return {
    id: 'post-2',
    content: 'Pulse post',
    createdAt: '2026-07-01T00:00:00Z',
    authorId: 'user-2',
    author: { id: 'user-2', name: 'Traveler', avatarUrl: '', username: 'traveler' },
    media: [],
    mediaUrls: [],
    locationCity: 'Tokyo',
    visibility: 'public',
    likeCount: 0,
    commentCount: 0,
    likedByMe: false,
    savedByMe: false,
    canLike: true,
    canComment: true,
    canShare: true,
    spanTags: [],
    spanHashtags: [],
    ...overrides,
  } as unknown as PulsePost;
}

// ── mapServerFeedItem ─────────────────────────────────────────────────────────

describe('mapServerFeedItem — featuredByPortava field mapping', () => {
  it('carries featuredByPortava when the server includes it', () => {
    const mapped = mapServerFeedItem(makeServerFeedItem({ featuredByPortava: 'best_hidden_gem' }) as any);
    expect(mapped.featuredByPortava).toBe('best_hidden_gem');
  });

  it('returns null when featuredByPortava is absent from server response', () => {
    const mapped = mapServerFeedItem(makeServerFeedItem() as any);
    expect(mapped.featuredByPortava).toBeNull();
  });

  it('returns null when featuredByPortava is explicitly null', () => {
    const mapped = mapServerFeedItem(makeServerFeedItem({ featuredByPortava: null }) as any);
    expect(mapped.featuredByPortava).toBeNull();
  });
});

// ── pulsePostToFeedItem ───────────────────────────────────────────────────────

describe('pulsePostToFeedItem — featuredByPortava field mapping', () => {
  it('carries featuredByPortava when present on the PulsePost', () => {
    const item = pulsePostToFeedItem(makePulsePost({ featuredByPortava: 'best_video' }));
    expect(item.featuredByPortava).toBe('best_video');
  });

  it('returns null when featuredByPortava is absent from PulsePost', () => {
    const item = pulsePostToFeedItem(makePulsePost());
    expect(item.featuredByPortava).toBeNull();
  });
});
