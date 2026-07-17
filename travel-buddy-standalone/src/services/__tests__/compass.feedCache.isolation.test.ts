/**
 * Feed-cache isolation under concurrent writes.
 *
 * Two users' feeds are written concurrently via Promise.all — the key
 * namespacing must hold under interleaving so neither entry is corrupted.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/compass.feedCache.isolation.test.ts
 *
 * Uses _setStorageForTest with a fake AsyncStorage that records write order.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCachedFeed,
  setCachedFeed,
  _setStorageForTest,
  type CompassFeedResponse,
} from '../compass.ts';

interface FakeStorage {
  store: Map<string, string>;
  writeOrder: Array<{ key: string; value: string }>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Fake AsyncStorage whose setItem defers the actual write by a macrotask,
 * so two concurrent setCachedFeed calls genuinely interleave. Records the
 * order writes landed in.
 */
function fakeStorage(): FakeStorage {
  const store = new Map<string, string>();
  const writeOrder: Array<{ key: string; value: string }> = [];
  return {
    store,
    writeOrder,
    getItem(key) {
      return Promise.resolve(store.get(key) ?? null);
    },
    setItem(key, value) {
      return new Promise((resolve) => {
        setTimeout(() => {
          writeOrder.push({ key, value });
          store.set(key, value);
          resolve();
        }, 0);
      });
    },
    removeItem(key) {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

function feed(marker: string): CompassFeedResponse {
  return {
    sections: [
      { name: `section-${marker}`, total: 1, items: [{ id: `item-${marker}`, type: 'post', category: 'food' }] },
    ],
    nextCursor: null,
    fallback: false,
  };
}

describe('compass feed cache — concurrent write isolation', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setStorageForTest(storage);
  });

  afterEach(() => {
    _setStorageForTest(undefined);
  });

  it('two concurrent setCachedFeed calls do not corrupt either entry', async () => {
    const feedA = feed('A');
    const feedB = feed('B');

    await Promise.all([
      setCachedFeed('user-A', feedA),
      setCachedFeed('user-B', feedB),
    ]);

    // Both writes actually landed (neither swallowed).
    assert.equal(storage.writeOrder.length, 2);
    const keys = storage.writeOrder.map((w) => w.key).sort();
    assert.deepEqual(keys, [
      'compass_feed_cache:user-A',
      'compass_feed_cache:user-B',
    ]);

    // Each user reads back exactly their own feed.
    const cachedA = await getCachedFeed('user-A');
    const cachedB = await getCachedFeed('user-B');
    assert.deepEqual(cachedA, feedA);
    assert.deepEqual(cachedB, feedB);

    // No cross-contamination: A's entry has no trace of B's data and vice versa.
    assert.equal(cachedA?.sections[0]?.items[0]?.id, 'item-A');
    assert.equal(cachedB?.sections[0]?.items[0]?.id, 'item-B');
  });

  it('reversed write-landing order still leaves both entries intact', async () => {
    // Delay user-A's write more than user-B's so B lands first.
    const originalSetItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      const delay = key.endsWith('user-A') ? 10 : 0;
      return new Promise((resolve) => {
        setTimeout(() => {
          storage.writeOrder.push({ key, value });
          storage.store.set(key, value);
          resolve();
        }, delay);
      });
    };
    void originalSetItem;

    const feedA = feed('A2');
    const feedB = feed('B2');
    await Promise.all([
      setCachedFeed('user-A', feedA),
      setCachedFeed('user-B', feedB),
    ]);

    assert.equal(storage.writeOrder[0]?.key, 'compass_feed_cache:user-B');
    assert.equal(storage.writeOrder[1]?.key, 'compass_feed_cache:user-A');

    assert.deepEqual(await getCachedFeed('user-A'), feedA);
    assert.deepEqual(await getCachedFeed('user-B'), feedB);
  });
});
