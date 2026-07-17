/**
 * Feed cache isolation — clearCachedFeed removes only the target user's
 * cached compass feed and ignores storage errors.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  setCachedFeed,
  getCachedFeed,
  clearCachedFeed,
  _setStorageForTest,
  type CompassFeedResponse,
} from '../compass.ts';

function makeMemoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    async setItem(k: string, v: string) { map.set(k, v); },
    async getItem(k: string) { return map.has(k) ? map.get(k)! : null; },
    async removeItem(k: string) { map.delete(k); },
  };
}

const feedFor = (name: string): CompassFeedResponse => ({
  sections: [{ name, items: [], total: 0 }],
  nextCursor: null,
  fallback: false,
});

let store: ReturnType<typeof makeMemoryStore>;

beforeEach(() => {
  store = makeMemoryStore();
  _setStorageForTest(store);
});

after(() => {
  _setStorageForTest(undefined);
});

test('clearCachedFeed removes the user key and leaves other users intact', async () => {
  await setCachedFeed('user-a', feedFor('a-section'));
  await setCachedFeed('user-b', feedFor('b-section'));

  await clearCachedFeed('user-a');

  assert.equal(store.map.has('compass_feed_cache:user-a'), false, 'user-a key should be removed');
  assert.equal(await getCachedFeed('user-a'), null);

  const b = await getCachedFeed('user-b');
  assert.ok(b, 'user-b feed should survive');
  assert.equal(b!.sections[0]!.name, 'b-section');
});

test('clearCachedFeed is a no-op for a missing key', async () => {
  await clearCachedFeed('never-cached');
  assert.equal(store.map.size, 0);
});

test('clearCachedFeed ignores storage errors', async () => {
  _setStorageForTest({
    async setItem() {},
    async getItem() { return null; },
    async removeItem() { throw new Error('disk full'); },
  });
  await assert.doesNotReject(clearCachedFeed('user-a'));
});

test('clearCachedFeed is a no-op when storage is unavailable', async () => {
  _setStorageForTest(null);
  await assert.doesNotReject(clearCachedFeed('user-a'));
});
