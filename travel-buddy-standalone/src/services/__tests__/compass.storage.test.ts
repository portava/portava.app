/**
 * compass feed cache — storage tests
 *
 * Exercises getCachedFeed() and setCachedFeed() with a working in-memory store.
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/compass.storage.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCachedFeed,
  setCachedFeed,
  _setStorageForTest,
  _resetStorageForTest,
  type CompassFeedResponse,
} from '../compass.ts';

// ── Fake AsyncStorage ─────────────────────────────────────────────────────────

function makeFakeStorage() {
  const store = new Map<string, string>();
  return {
    async setItem(k: string, v: string): Promise<void> { store.set(k, v); },
    async getItem(k: string): Promise<string | null> { return store.get(k) ?? null; },
    async removeItem(k: string): Promise<void> { store.delete(k); },
    /** Expose raw store for inspection in tests. */
    _store: store,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SAMPLE_FEED: CompassFeedResponse = {
  sections: [
    {
      name: 'Trending',
      total: 1,
      items: [
        {
          id: 'item-1',
          type: 'event',
          category: 'music',
          title: 'Jazz Night',
          score: 0.9,
        },
      ],
    },
  ],
  nextCursor: null,
  fallback: false,
};

// ── Setup / teardown ──────────────────────────────────────────────────────────

let fakeStorage: ReturnType<typeof makeFakeStorage>;

beforeEach(() => {
  fakeStorage = makeFakeStorage();
  _setStorageForTest(fakeStorage);
});

afterEach(() => {
  _resetStorageForTest();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('setCachedFeed / getCachedFeed — working storage', () => {
  it('getCachedFeed returns null before anything is stored', async () => {
    const result = await getCachedFeed('user-abc');
    assert.equal(result, null);
  });

  it('getCachedFeed returns the same feed object that was stored by setCachedFeed', async () => {
    await setCachedFeed('user-abc', SAMPLE_FEED);
    const result = await getCachedFeed('user-abc');

    assert.ok(result !== null, 'expected a cached feed, got null');
    assert.deepEqual(result, SAMPLE_FEED);
  });

  it('cache keys are user-scoped — a different userId returns null', async () => {
    await setCachedFeed('user-abc', SAMPLE_FEED);
    const result = await getCachedFeed('user-xyz');
    assert.equal(result, null, 'different userId must not see another user\'s cached feed');
  });

  it('overwrites a previous cache entry when setCachedFeed is called again for the same user', async () => {
    const updatedFeed: CompassFeedResponse = {
      ...SAMPLE_FEED,
      sections: [],
      fallback: true,
    };

    await setCachedFeed('user-abc', SAMPLE_FEED);
    await setCachedFeed('user-abc', updatedFeed);
    const result = await getCachedFeed('user-abc');

    assert.ok(result !== null);
    assert.equal(result.fallback, true, 'expected the updated feed entry');
    assert.equal(result.sections.length, 0);
  });
});

describe('getCachedFeed — TTL expiry', () => {
  it('returns null when the cached entry is older than 30 minutes', async () => {
    // Write a valid cache entry, then manually back-date _cachedAt in the store.
    await setCachedFeed('user-abc', SAMPLE_FEED);

    const key = `compass_feed_cache:user-abc`;
    const raw = fakeStorage._store.get(key);
    assert.ok(raw, 'expected a raw entry in the store after setCachedFeed');

    const parsed = JSON.parse(raw);
    // Shift _cachedAt to 31 minutes ago so the TTL check fires.
    parsed._cachedAt = Date.now() - (31 * 60 * 1000);
    fakeStorage._store.set(key, JSON.stringify(parsed));

    const result = await getCachedFeed('user-abc');
    assert.equal(result, null, 'stale cache entry (31 min old) must return null');
  });

  it('returns the feed when the cached entry is just within the 30-minute window', async () => {
    await setCachedFeed('user-abc', SAMPLE_FEED);

    const key = `compass_feed_cache:user-abc`;
    const raw = fakeStorage._store.get(key);
    assert.ok(raw);

    const parsed = JSON.parse(raw);
    // 29 minutes ago — still fresh.
    parsed._cachedAt = Date.now() - (29 * 60 * 1000);
    fakeStorage._store.set(key, JSON.stringify(parsed));

    const result = await getCachedFeed('user-abc');
    assert.ok(result !== null, 'cache entry 29 min old must still be returned');
    assert.deepEqual(result, SAMPLE_FEED);
  });
});
