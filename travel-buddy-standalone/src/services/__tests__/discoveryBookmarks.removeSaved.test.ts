/**
 * Unit tests for removeSaved — specifically the stale-filter-key cleanup
 * that clears the category filter when the last place is removed.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/discoveryBookmarks.removeSaved.test.ts
 *
 * Uses a fake StorageLike so the native AsyncStorage module is never required.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { removeSaved, _setTestStorage } from '../discoveryBookmarks.ts';

// The key that discoveryBookmarks clears when the last place is removed.
// Must stay in sync with CATEGORY_STORAGE_PREFIX + 'global' in
// savedPlacesMapFilterStorage.ts and GLOBAL_FILTER_KEY in discoveryBookmarks.ts.
const GLOBAL_FILTER_KEY = 'saved_places_map_cat_v1_global';
const BOOKMARKS_KEY = 'discovery_bookmarks_v1';

// ── Fake storage factory ───────────────────────────────────────────────────────

interface FakeStorage {
  store: Map<string, string>;
  removedKeys: string[];
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const store = new Map<string, string>(Object.entries(initial));
  const removedKeys: string[] = [];
  return {
    store,
    removedKeys,
    getItem(key: string): Promise<string | null> {
      return Promise.resolve(store.get(key) ?? null);
    },
    setItem(key: string, value: string): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
    removeItem(key: string): Promise<void> {
      store.delete(key);
      removedKeys.push(key);
      return Promise.resolve();
    },
  };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makePlace(id: string) {
  return { id, name: 'Test Place', category: 'food', type: null, address: null, savedAt: 1000, lat: null, lng: null };
}

function serialise(...ids: string[]): string {
  return JSON.stringify(ids.map(makePlace));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('removeSaved — stale filter key cleanup', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
  });

  it('clears the category filter key when the last place is removed', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1'));
    storage.store.set(GLOBAL_FILTER_KEY, 'food');

    await removeSaved('place-1');

    // The bookmarks list should now be empty
    const raw = storage.store.get(BOOKMARKS_KEY);
    assert.equal(raw, '[]');

    // The filter key must have been removed
    assert.ok(
      storage.removedKeys.includes(GLOBAL_FILTER_KEY),
      `expected removeItem(${GLOBAL_FILTER_KEY}) to be called but removedKeys was: ${JSON.stringify(storage.removedKeys)}`,
    );
  });

  it('does NOT clear the filter key when other places remain', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1', 'place-2'));
    storage.store.set(GLOBAL_FILTER_KEY, 'food');

    await removeSaved('place-1');

    // One place remains — filter key must be untouched
    assert.equal(
      storage.removedKeys.filter((k) => k === GLOBAL_FILTER_KEY).length,
      0,
      'removeItem should not be called for the filter key when places remain',
    );
    assert.equal(storage.store.get(GLOBAL_FILTER_KEY), 'food');
  });

  it('clears the filter key even when no filter was previously set', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1'));
    // No filter key in storage — removeItem should still be called (idempotent)

    await removeSaved('place-1');

    assert.ok(
      storage.removedKeys.includes(GLOBAL_FILTER_KEY),
      'removeItem should be called for the filter key regardless of whether it existed',
    );
  });

  it('removes the correct place and leaves the rest intact', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1', 'place-2', 'place-3'));

    await removeSaved('place-2');

    const stored = JSON.parse(storage.store.get(BOOKMARKS_KEY) ?? '[]') as Array<{ id: string }>;
    assert.deepEqual(
      stored.map((p) => p.id),
      ['place-1', 'place-3'],
    );
  });

  it('is a no-op for filter cleanup when the id is not in the list', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1'));
    storage.store.set(GLOBAL_FILTER_KEY, 'food');

    await removeSaved('nonexistent');

    // place-1 is still there so the list is non-empty — filter must not be cleared
    const stored = JSON.parse(storage.store.get(BOOKMARKS_KEY) ?? '[]') as Array<{ id: string }>;
    assert.equal(stored.length, 1);
    assert.equal(storage.removedKeys.filter((k) => k === GLOBAL_FILTER_KEY).length, 0);
  });

  it('propagates a setItem error and does NOT run the cleanup step', async () => {
    const removedKeys: string[] = [];
    const broken: FakeStorage = {
      store: new Map([[BOOKMARKS_KEY, serialise('place-1')]]),
      removedKeys,
      getItem: (k) => Promise.resolve(broken.store.get(k) ?? null),
      setItem: () => Promise.reject(new Error('disk full')),
      removeItem: (k) => { removedKeys.push(k); return Promise.resolve(); },
    };
    _setTestStorage(broken);

    await assert.rejects(() => removeSaved('place-1'), /disk full/);

    // Cleanup must NOT run — the caller's optimistic rollback owns the failed state
    assert.equal(removedKeys.length, 0);
  });

  it('filter cleanup does not propagate a removeItem rejection', async () => {
    const failing: FakeStorage = {
      store: new Map([[BOOKMARKS_KEY, serialise('place-1')]]),
      removedKeys: [],
      getItem: (k) => Promise.resolve(failing.store.get(k) ?? null),
      setItem: (_k, _v) => Promise.resolve(),
      removeItem: () => Promise.reject(new Error('remove failed')),
    };
    _setTestStorage(failing);

    // The primary removeSaved promise must resolve even if removeItem rejects
    await assert.doesNotReject(() => removeSaved('place-1'));
  });
});
