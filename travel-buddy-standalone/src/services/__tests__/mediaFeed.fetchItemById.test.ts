/**
 * fetchMediaFeedItemById — unit tests
 *
 * Verifies that:
 *   - a well-formed { item: ServerFeedItem } response is unwrapped and adapted
 *     correctly, including stampItCount from stats
 *   - a malformed response (missing `item` key) returns errorKind = 'server'
 *   - a 404 response returns errorKind = 'not_found'
 *   - an auth error (401) returns errorKind = 'auth'
 *   - missing stampItCount on legacy items defaults to 0
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/mediaFeed.fetchItemById.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchMediaFeedItemById,
  _setTestFreshToken,
  _clearTestFreshToken,
} from '../mediaFeed.ts';

// ── Minimal server-side item fixture ─────────────────────────────────────────

function makeServerItem(statsOverride: Record<string, number> = {}): Record<string, any> {
  return {
    id: 'post-abc',
    sourceType: 'post',
    sourceId: 'post-abc',
    caption: 'Hello world',
    tags: ['travel'],
    createdAt: '2026-01-01T00:00:00Z',
    creator: {
      id: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      isPrivate: false,
      isVerified: false,
      followersCount: 10,
      followingCount: 5,
      bio: null,
    },
    media: [
      {
        id: 'media-1',
        type: 'video',
        url: 'https://cdn.example.com/video.mp4',
        thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
        durationSeconds: 30,
        width: 1080,
        height: 1920,
        sortOrder: 0,
      },
    ],
    stats: {
      viewCount: 100,
      likeCount: 20,
      saveCount: 5,
      commentCount: 3,
      stampItCount: 7,
      ...statsOverride,
    },
    location: { name: 'Cebu', city: 'Cebu City', country: 'Philippines' },
    viewerState: {
      hasLiked: false,
      hasSaved: false,
      isFollowingCreator: false,
      hasFollowRequestPending: false,
    },
    privacy: { isPrivate: false },
    moderation: { status: 'active' },
    linkedEntity: null,
    locationVerified: true,
  };
}

// ── fetch stub helpers ────────────────────────────────────────────────────────

let origFetch: typeof globalThis.fetch;
let origApiBase: string | undefined;

function stubFetch(
  handler: (url: string) => { status: number; body: unknown },
): void {
  (globalThis as any).fetch = async (url: string) => {
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  origFetch = globalThis.fetch;
  origApiBase = (process.env as any).EXPO_PUBLIC_API_BASE_URL;
  (process.env as any).EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';
  _setTestFreshToken('tok-test');
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origApiBase === undefined) {
    delete (process.env as any).EXPO_PUBLIC_API_BASE_URL;
  } else {
    (process.env as any).EXPO_PUBLIC_API_BASE_URL = origApiBase;
  }
  _clearTestFreshToken();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('fetchMediaFeedItemById', () => {
  it('unwraps { item } wrapper and maps stampItCount from stats', async () => {
    stubFetch(() => ({ status: 200, body: { item: makeServerItem() } }));

    const result = await fetchMediaFeedItemById('post-abc');

    assert.equal(result.ok, true);
    assert.ok(result.data != null, 'data should be present');
    assert.equal(result.data!.id, 'post-abc');
    assert.equal(result.data!.stampItCount, 7, 'stampItCount must come from stats.stampItCount');
    assert.equal(result.data!.likeCount, 20);
    assert.equal(result.data!.saveCount, 5);
    assert.equal(result.data!.commentCount, 3);
    assert.equal(result.data!.creator.id, 'user-1');
    assert.equal(result.data!.creator.username, 'alice');
    assert.equal(result.data!.likedByMe, false);
    assert.equal(result.data!.savedByMe, false);
  });

  it('defaults stampItCount to 0 when absent from stats (legacy item)', async () => {
    const item = makeServerItem();
    delete (item.stats as any).stampItCount;

    stubFetch(() => ({ status: 200, body: { item } }));

    const result = await fetchMediaFeedItemById('post-abc');

    assert.equal(result.ok, true);
    assert.equal(result.data!.stampItCount, 0, 'absent stampItCount must default to 0');
  });

  it('returns errorKind=server when response body has no item key', async () => {
    stubFetch(() => ({ status: 200, body: { notAnItem: true } }));

    const result = await fetchMediaFeedItemById('post-abc');

    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'server');
  });

  it('returns errorKind=not_found on 404', async () => {
    stubFetch(() => ({ status: 404, body: { error: 'not_found' } }));

    const result = await fetchMediaFeedItemById('post-abc');

    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'not_found');
  });

  it('returns errorKind=auth on 401', async () => {
    stubFetch(() => ({ status: 401, body: { error: 'unauthorized' } }));

    const result = await fetchMediaFeedItemById('post-abc');

    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'auth');
  });
});
