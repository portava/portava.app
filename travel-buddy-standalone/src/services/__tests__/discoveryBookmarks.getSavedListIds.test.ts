/**
 * Unit tests for getSavedListIds — pre-populates saved state in TripWishlistPicker.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/discoveryBookmarks.getSavedListIds.test.ts
 *
 * Uses a fake StorageLike so the native AsyncStorage module is never required.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSavedListIds, _setTestStorage } from '../discoveryBookmarks.ts';

const BOOKMARKS_KEY = 'discovery_bookmarks_v1';

// ── Fake storage factory ───────────────────────────────────────────────────────

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

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeEntry(placeId: string, listId?: string) {
  return {
    id: placeId,
    name: 'Test Place',
    category: 'food',
    type: null,
    address: null,
    savedAt: 1000,
    lat: null,
    lng: null,
    ...(listId !== undefined ? { listId } : {}),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('getSavedListIds — basic lookups', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
  });

  it('returns an empty Set when no bookmarks exist', async () => {
    const result = await getSavedListIds('place-1');
    assert.equal(result.size, 0);
  });

  it('returns an empty Set when the place is not in any list', async () => {
    storage.store.set(
      BOOKMARKS_KEY,
      JSON.stringify([makeEntry('place-other', 'trip-a')]),
    );
    const result = await getSavedListIds('place-1');
    assert.equal(result.size, 0);
  });

  it('returns the listId when the place appears in exactly one trip', async () => {
    storage.store.set(
      BOOKMARKS_KEY,
      JSON.stringify([makeEntry('place-1', 'trip-a')]),
    );
    const result = await getSavedListIds('place-1');
    assert.ok(result.has('trip-a'), 'expected trip-a in result');
    assert.equal(result.size, 1);
  });

  it('returns all listIds when the place appears in multiple trips', async () => {
    storage.store.set(
      BOOKMARKS_KEY,
      JSON.stringify([
        makeEntry('place-1', 'trip-a'),
        makeEntry('place-1', 'trip-b'),
        makeEntry('place-1', 'trip-c'),
      ]),
    );
    const result = await getSavedListIds('place-1');
    assert.ok(result.has('trip-a'), 'expected trip-a');
    assert.ok(result.has('trip-b'), 'expected trip-b');
    assert.ok(result.has('trip-c'), 'expected trip-c');
    assert.equal(result.size, 3);
  });

  it('does not include listIds from entries for a different place', async () => {
    storage.store.set(
      BOOKMARKS_KEY,
      JSON.stringify([
        makeEntry('place-1', 'trip-a'),
        makeEntry('place-2', 'trip-b'),
        makeEntry('place-3', 'trip-c'),
      ]),
    );
    const result = await getSavedListIds('place-1');
    assert.ok(result.has('trip-a'), 'expected trip-a for place-1');
    assert.ok(!result.has('trip-b'), 'trip-b belongs to place-2 — must not appear');
    assert.ok(!result.has('trip-c'), 'trip-c belongs to place-3 — must not appear');
    assert.equal(result.size, 1);
  });
});

describe('getSavedListIds — legacy entries (no listId)', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
  });

  it('treats a legacy entry without a listId field as belonging to "global"', async () => {
    storage.store.set(
      BOOKMARKS_KEY,
      JSON.stringify([makeEntry('place-1')]),
    );
    const result = await getSavedListIds('place-1');
    assert.ok(result.has('global'), 'legacy entry without listId must map to "global"');
    assert.equal(result.size, 1);
  });

  it('handles a mix of legacy (no listId) and trip-scoped entries for the same place', async () => {
    storage.store.set(
      BOOKMARKS_KEY,
      JSON.stringify([
        makeEntry('place-1'),
        makeEntry('place-1', 'trip-a'),
      ]),
    );
    const result = await getSavedListIds('place-1');
    assert.ok(result.has('global'), 'legacy entry should resolve to "global"');
    assert.ok(result.has('trip-a'), 'trip-scoped entry should appear');
    assert.equal(result.size, 2);
  });
});

describe('getSavedListIds — trip-scope isolation', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
  });

  it('saving to trip A does not make the place appear in trip B', async () => {
    storage.store.set(
      BOOKMARKS_KEY,
      JSON.stringify([makeEntry('place-1', 'trip-a')]),
    );
    const resultA = await getSavedListIds('place-1');
    assert.ok(resultA.has('trip-a'), 'place should appear in trip-a');
    assert.ok(!resultA.has('trip-b'), 'place must NOT appear in trip-b');
  });

  it('independent saves to trip A and trip B are both reflected correctly', async () => {
    storage.store.set(
      BOOKMARKS_KEY,
      JSON.stringify([
        makeEntry('place-1', 'trip-a'),
        makeEntry('place-1', 'trip-b'),
      ]),
    );
    const result = await getSavedListIds('place-1');
    assert.ok(result.has('trip-a'));
    assert.ok(result.has('trip-b'));
    assert.equal(result.size, 2);
  });

  it('saving place X to trip A does not affect getSavedListIds for place Y', async () => {
    storage.store.set(
      BOOKMARKS_KEY,
      JSON.stringify([
        makeEntry('place-X', 'trip-a'),
        makeEntry('place-Y', 'trip-b'),
      ]),
    );
    const resultX = await getSavedListIds('place-X');
    const resultY = await getSavedListIds('place-Y');

    assert.ok(resultX.has('trip-a'));
    assert.ok(!resultX.has('trip-b'), 'trip-b must not bleed into place-X results');

    assert.ok(resultY.has('trip-b'));
    assert.ok(!resultY.has('trip-a'), 'trip-a must not bleed into place-Y results');
  });

  it('returns a Set (not an Array) — callers use .has() not .includes()', async () => {
    storage.store.set(
      BOOKMARKS_KEY,
      JSON.stringify([makeEntry('place-1', 'trip-a')]),
    );
    const result = await getSavedListIds('place-1');
    assert.ok(result instanceof Set, 'return type must be a Set');
  });

  it('handles corrupt JSON in storage gracefully — returns empty Set', async () => {
    storage.store.set(BOOKMARKS_KEY, 'not-valid-json{{{');
    const result = await getSavedListIds('place-1');
    assert.ok(result instanceof Set);
    assert.equal(result.size, 0);
  });
});
