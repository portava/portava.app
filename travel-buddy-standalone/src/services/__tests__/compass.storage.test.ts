/**
 * Unit tests for getCachedFeed TTL expiry logic.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/compass.storage.test.ts
 *
 * Uses a fake AsyncStorage so no native module is required.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getCachedFeed, setCachedFeed, _setStorageForTest } from '../compass.ts';
import type { CompassFeedResponse } from '../compass.ts';

// ── Fake storage factory ──────────────────────────────────────────────────────

interface FakeStorage {
  store: Map<string, string>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    getItem(key: string): Promise<string | null> {
      return Promise.resolve(store.get(key) ?? null);
    },
    setItem(key: string, value: string): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
    removeItem(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FEED_CACHE_PREFIX = 'compass_feed_cache:';
const TEST_USER = 'user-abc';

const SAMPLE_FEED: CompassFeedResponse = {
  sections: [{ name: 'Top picks', items: [], total: 0 }],
  nextCursor: null,
  fallback: false,
};

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

// ── TTL expiry tests ──────────────────────────────────────────────────────────

describe('getCachedFeed — stale entry (older than 30 minutes)', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setStorageForTest(storage);
  });

  it('returns null when _cachedAt is exactly 30 minutes + 1 ms in the past', async () => {
    const staleAt = Date.now() - THIRTY_MINUTES_MS - 1;
    storage.store.set(
      `${FEED_CACHE_PREFIX}${TEST_USER}`,
      JSON.stringify({ feed: SAMPLE_FEED, _cachedAt: staleAt }),
    );

    const result = await getCachedFeed(TEST_USER);
    assert.equal(result, null, 'cache entry older than 30 min must be expired');
  });

  it('returns null when _cachedAt is far in the past (simulating an hour-old entry)', async () => {
    const veryStaleAt = Date.now() - 60 * 60 * 1000; // 1 hour ago
    storage.store.set(
      `${FEED_CACHE_PREFIX}${TEST_USER}`,
      JSON.stringify({ feed: SAMPLE_FEED, _cachedAt: veryStaleAt }),
    );

    const result = await getCachedFeed(TEST_USER);
    assert.equal(result, null, 'hour-old cache entry must be expired');
  });

  it('returns null when _cachedAt is missing (treated as 0 — effectively infinite age)', async () => {
    storage.store.set(
      `${FEED_CACHE_PREFIX}${TEST_USER}`,
      JSON.stringify({ feed: SAMPLE_FEED }),
    );

    const result = await getCachedFeed(TEST_USER);
    assert.equal(result, null, 'entry without _cachedAt must be expired');
  });
});

describe('getCachedFeed — fresh entry (within 30 minutes)', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setStorageForTest(storage);
  });

  it('returns the feed when _cachedAt is recent (just now)', async () => {
    const freshAt = Date.now();
    storage.store.set(
      `${FEED_CACHE_PREFIX}${TEST_USER}`,
      JSON.stringify({ feed: SAMPLE_FEED, _cachedAt: freshAt }),
    );

    const result = await getCachedFeed(TEST_USER);
    assert.notEqual(result, null, 'fresh cache entry must not be expired');
    assert.deepEqual(result, SAMPLE_FEED);
  });

  it('returns the feed when _cachedAt is 29 minutes ago', async () => {
    const recentAt = Date.now() - (THIRTY_MINUTES_MS - 60_000); // 29 min ago
    storage.store.set(
      `${FEED_CACHE_PREFIX}${TEST_USER}`,
      JSON.stringify({ feed: SAMPLE_FEED, _cachedAt: recentAt }),
    );

    const result = await getCachedFeed(TEST_USER);
    assert.notEqual(result, null, 'entry 29 min old must still be valid');
    assert.deepEqual(result, SAMPLE_FEED);
  });

  it('round-trips correctly via setCachedFeed then getCachedFeed', async () => {
    await setCachedFeed(TEST_USER, SAMPLE_FEED);
    const result = await getCachedFeed(TEST_USER);
    assert.notEqual(result, null, 'feed written by setCachedFeed must be readable immediately');
    assert.deepEqual(result, SAMPLE_FEED);
  });
});

describe('getCachedFeed — storage edge cases', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setStorageForTest(storage);
  });

  it('returns null when the cache key does not exist', async () => {
    const result = await getCachedFeed(TEST_USER);
    assert.equal(result, null);
  });

  it('returns null when the stored value is corrupt JSON', async () => {
    storage.store.set(`${FEED_CACHE_PREFIX}${TEST_USER}`, 'not-valid-json{{{');
    const result = await getCachedFeed(TEST_USER);
    assert.equal(result, null, 'corrupt JSON must not throw — must return null');
  });

  it('returns null when storage itself is unavailable', async () => {
    _setStorageForTest(null);
    const result = await getCachedFeed(TEST_USER);
    assert.equal(result, null, 'null storage must return null immediately');
  });
});
