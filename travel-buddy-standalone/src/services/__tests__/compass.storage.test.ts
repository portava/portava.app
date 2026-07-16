/**
 * compass.storage.test.ts
 *
 * Confirms getCachedFeed silently returns null when the stored JSON is
 * corrupted — it must not throw or propagate a parse error to the caller.
 *
 * Run with: node --import tsx/esm --test src/services/__tests__/compass.storage.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getCachedFeed, _setStorageForTest } from '../compass.ts';

/* ── helpers ──────────────────────────────────────────────────────────────── */

type FakeStore = {
  data: Map<string, string>;
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
};

function makeFakeStore(initial: Record<string, string> = {}): FakeStore {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async getItem(k) { return data.get(k) ?? null; },
    async setItem(k, v) { data.set(k, v); },
    async removeItem(k) { data.delete(k); },
  };
}

const CACHE_KEY_PREFIX = 'compass_feed_cache:';
const TEST_USER = 'user-abc';

/* ── tests ────────────────────────────────────────────────────────────────── */

describe('getCachedFeed — corrupted cache', () => {
  afterEach(() => {
    // Reset the storage injection so other tests are unaffected.
    _setStorageForTest(undefined);
  });

  it('returns null (not an exception) when stored value is not valid JSON', async () => {
    const store = makeFakeStore({ [`${CACHE_KEY_PREFIX}${TEST_USER}`]: 'THIS IS NOT JSON{{{' });
    _setStorageForTest(store);

    const result = await getCachedFeed(TEST_USER);

    assert.equal(result, null, 'expected null for corrupted JSON, got a non-null value');
  });

  it('returns null when stored value is an empty string', async () => {
    const store = makeFakeStore({ [`${CACHE_KEY_PREFIX}${TEST_USER}`]: '' });
    _setStorageForTest(store);

    const result = await getCachedFeed(TEST_USER);

    assert.equal(result, null);
  });

  it('returns null when stored value is a bare number (no .feed envelope)', async () => {
    const store = makeFakeStore({ [`${CACHE_KEY_PREFIX}${TEST_USER}`]: '42' });
    _setStorageForTest(store);

    // JSON.parse succeeds, but parsed.feed is undefined → must return null cleanly.
    const result = await getCachedFeed(TEST_USER);

    assert.equal(result, null);
  });

  it('returns null when storage is unavailable (null store)', async () => {
    _setStorageForTest(null);

    const result = await getCachedFeed(TEST_USER);

    assert.equal(result, null);
  });

  it('returns null when no entry exists for the user', async () => {
    const store = makeFakeStore({});
    _setStorageForTest(store);

    const result = await getCachedFeed(TEST_USER);

    assert.equal(result, null);
  });
});
