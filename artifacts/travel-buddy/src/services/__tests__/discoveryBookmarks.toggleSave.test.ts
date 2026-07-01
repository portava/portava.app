/**
 * Unit tests for toggleSave — specifically the optional listId parameter and
 * the stale-filter-key cleanup that clears the category filter when the last
 * place is removed.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/discoveryBookmarks.toggleSave.test.ts
 *
 * Uses a fake StorageLike so the native AsyncStorage module is never required.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { toggleSave, _setTestStorage } from '../discoveryBookmarks.ts';
import { categoryStorageKey } from '../../components/savedPlacesMapFilterStorage.ts';

const GLOBAL_FILTER_KEY = categoryStorageKey('global');
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

describe('toggleSave — add/remove behaviour', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
  });

  it('adds a place and returns true', async () => {
    const result = await toggleSave(makePlace('place-1'));
    assert.equal(result, true);

    const stored = JSON.parse(storage.store.get(BOOKMARKS_KEY) ?? '[]') as Array<{ id: string }>;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, 'place-1');
  });

  it('removes an existing place and returns false', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1'));

    const result = await toggleSave(makePlace('place-1'));
    assert.equal(result, false);

    const stored = JSON.parse(storage.store.get(BOOKMARKS_KEY) ?? '[]') as Array<{ id: string }>;
    assert.equal(stored.length, 0);
  });

  it('adding a place that already exists is idempotent (treated as a remove-then-add? no — treated as remove)', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1'));

    const result = await toggleSave(makePlace('place-1'));
    // Existing → removed
    assert.equal(result, false);
  });
});

describe('toggleSave — stale filter key cleanup (default listId = global)', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
  });

  it('clears the global filter key when the last place is removed (no listId arg)', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1'));
    storage.store.set(GLOBAL_FILTER_KEY, 'food');

    await toggleSave(makePlace('place-1'));

    assert.ok(
      storage.removedKeys.includes(GLOBAL_FILTER_KEY),
      `expected removeItem(${GLOBAL_FILTER_KEY}) to be called but removedKeys was: ${JSON.stringify(storage.removedKeys)}`,
    );
  });

  it('does NOT clear the filter key when other places remain', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1', 'place-2'));
    storage.store.set(GLOBAL_FILTER_KEY, 'food');

    await toggleSave(makePlace('place-1'));

    assert.equal(
      storage.removedKeys.filter((k) => k === GLOBAL_FILTER_KEY).length,
      0,
      'removeItem should not be called for the filter key when places remain',
    );
    assert.equal(storage.store.get(GLOBAL_FILTER_KEY), 'food');
  });

  it('clears the filter key even when no filter was previously set', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1'));

    await toggleSave(makePlace('place-1'));

    assert.ok(
      storage.removedKeys.includes(GLOBAL_FILTER_KEY),
      'removeItem should be called for the global filter key regardless of whether it existed',
    );
  });

  it('does NOT clear the filter key when adding a place', async () => {
    storage.store.set(GLOBAL_FILTER_KEY, 'food');

    await toggleSave(makePlace('place-new'));

    assert.equal(
      storage.removedKeys.filter((k) => k === GLOBAL_FILTER_KEY).length,
      0,
      'removeItem must not be called when adding a place',
    );
  });
});

describe('toggleSave — stale filter key cleanup with trip-specific listId', () => {
  let storage: FakeStorage;
  const TRIP_ID = 'trip-abc-123';
  const TRIP_FILTER_KEY = categoryStorageKey(TRIP_ID);

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
  });

  it('clears the trip filter key (not the global one) when the last place is removed', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1'));
    storage.store.set(TRIP_FILTER_KEY, 'beach');
    storage.store.set(GLOBAL_FILTER_KEY, 'food');

    await toggleSave(makePlace('place-1'), TRIP_ID);

    assert.ok(
      storage.removedKeys.includes(TRIP_FILTER_KEY),
      `expected removeItem(${TRIP_FILTER_KEY}) to be called`,
    );
    // Global filter key must be untouched — only the trip's key is cleared
    assert.equal(
      storage.removedKeys.filter((k) => k === GLOBAL_FILTER_KEY).length,
      0,
      'removeItem must NOT be called for the global filter key when a trip listId is provided',
    );
    assert.equal(storage.store.get(GLOBAL_FILTER_KEY), 'food');
  });

  it('does NOT clear the trip filter key when other places remain', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1', 'place-2'));
    storage.store.set(TRIP_FILTER_KEY, 'beach');

    await toggleSave(makePlace('place-1'), TRIP_ID);

    assert.equal(
      storage.removedKeys.filter((k) => k === TRIP_FILTER_KEY).length,
      0,
      'removeItem should not be called for the trip filter key when places remain',
    );
    assert.equal(storage.store.get(TRIP_FILTER_KEY), 'beach');
  });

  it('clears the correct trip filter key even when no filter was set', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('place-1'));

    await toggleSave(makePlace('place-1'), TRIP_ID);

    assert.ok(
      storage.removedKeys.includes(TRIP_FILTER_KEY),
      'removeItem should be called for the trip filter key regardless of whether it existed',
    );
  });

  it('does NOT clear any filter key when adding a place with a trip listId', async () => {
    storage.store.set(TRIP_FILTER_KEY, 'beach');

    await toggleSave(makePlace('place-new'), TRIP_ID);

    assert.equal(
      storage.removedKeys.filter((k) => k === TRIP_FILTER_KEY).length,
      0,
      'removeItem must not be called when adding a place',
    );
  });
});
