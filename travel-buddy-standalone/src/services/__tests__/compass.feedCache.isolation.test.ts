/**
 * Confirms that getCachedFeed() namespaces cache keys by userId so that one
 * user's personalised feed cannot bleed into another user's result.
 *
 * Run via the auto-discovered node:test runner:
 *   pnpm --filter travel-buddy-standalone test
 *
 * Uses _setStorageForTest() to inject a fake AsyncStorage that avoids the
 * React Native require() path entirely.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCachedFeed,
  setCachedFeed,
  _setStorageForTest,
  type CompassFeedResponse,
} from '../compass.ts';

// ── Fake storage ──────────────────────────────────────────────────────────────

function makeFakeStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    async getItem(k: string): Promise<string | null> {
      return store.get(k) ?? null;
    },
    async setItem(k: string, v: string): Promise<void> {
      store.set(k, v);
    },
    async removeItem(k: string): Promise<void> {
      store.delete(k);
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFeed(marker: string): CompassFeedResponse {
  return {
    sections: [
      {
        name: `section-${marker}`,
        total: 1,
        items: [
          {
            id: `item-${marker}`,
            type: 'place',
            category: 'food',
            title: `Title for ${marker}`,
          },
        ],
      },
    ],
    nextCursor: null,
    fallback: false,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('compass feed cache isolation', () => {
  let storage: ReturnType<typeof makeFakeStorage>;

  before(() => {
    storage = makeFakeStorage();
    _setStorageForTest(storage);
  });

  after(() => {
    _setStorageForTest(null);
  });

  it('getCachedFeed returns null for both users when the cache is empty', async () => {
    const resultA = await getCachedFeed('user-A');
    const resultB = await getCachedFeed('user-B');
    assert.equal(resultA, null, 'user-A cache should be empty initially');
    assert.equal(resultB, null, 'user-B cache should be empty initially');
  });

  it('getCachedFeed("user-A") returns user-A feed after both are written', async () => {
    const feedA = makeFeed('user-A');
    const feedB = makeFeed('user-B');

    await setCachedFeed('user-A', feedA);
    await setCachedFeed('user-B', feedB);

    const resultA = await getCachedFeed('user-A');
    assert.ok(resultA !== null, 'user-A should have a cached feed');
    assert.equal(
      resultA!.sections[0].name,
      'section-user-A',
      'user-A should get their own section name',
    );
    assert.equal(
      resultA!.sections[0].items[0].id,
      'item-user-A',
      'user-A should get their own item id',
    );
  });

  it('getCachedFeed("user-B") returns user-B feed after both are written', async () => {
    // Storage already populated from previous test; re-confirm user-B is isolated.
    const resultB = await getCachedFeed('user-B');
    assert.ok(resultB !== null, 'user-B should have a cached feed');
    assert.equal(
      resultB!.sections[0].name,
      'section-user-B',
      'user-B should get their own section name',
    );
    assert.equal(
      resultB!.sections[0].items[0].id,
      'item-user-B',
      'user-B should get their own item id',
    );
  });

  it('user-A feed does not contain any user-B data', async () => {
    const resultA = await getCachedFeed('user-A');
    assert.ok(resultA !== null);
    const json = JSON.stringify(resultA);
    assert.ok(
      !json.includes('user-B'),
      'user-A result must not contain any user-B identifiers',
    );
  });

  it('user-B feed does not contain any user-A data', async () => {
    const resultB = await getCachedFeed('user-B');
    assert.ok(resultB !== null);
    const json = JSON.stringify(resultB);
    assert.ok(
      !json.includes('user-A'),
      'user-B result must not contain any user-A identifiers',
    );
  });

  it('overwriting user-A cache does not affect user-B cache', async () => {
    const newFeedA = makeFeed('user-A-updated');
    await setCachedFeed('user-A', newFeedA);

    const resultB = await getCachedFeed('user-B');
    assert.ok(resultB !== null, 'user-B cache should still be present');
    assert.equal(
      resultB!.sections[0].items[0].id,
      'item-user-B',
      'user-B item id must be unchanged after user-A cache update',
    );

    const resultA = await getCachedFeed('user-A');
    assert.ok(resultA !== null, 'user-A cache should reflect the update');
    assert.equal(
      resultA!.sections[0].items[0].id,
      'item-user-A-updated',
      'user-A item id should reflect the new write',
    );
  });

  it('cache keys are stored under separate keys in storage', async () => {
    // Verify at the raw storage level that two distinct keys exist.
    const keysPresent = [...storage.store.keys()];
    const userAKey = keysPresent.find((k) => k.includes('user-A'));
    const userBKey = keysPresent.find((k) => k.includes('user-B'));
    assert.ok(userAKey !== undefined, 'a storage key for user-A must exist');
    assert.ok(userBKey !== undefined, 'a storage key for user-B must exist');
    assert.notEqual(userAKey, userBKey, 'user-A and user-B must use distinct storage keys');
  });
});
