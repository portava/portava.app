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
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { toggleSave, clearAllSaved, _setTestStorage, _setTestToken } from '../discoveryBookmarks.ts';
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

function serialiseWithListId(listId: string, ...ids: string[]): string {
  return JSON.stringify(ids.map((id) => ({ ...makePlace(id), listId })));
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
    storage.store.set(BOOKMARKS_KEY, serialiseWithListId(TRIP_ID, 'place-1'));
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
    storage.store.set(BOOKMARKS_KEY, serialiseWithListId(TRIP_ID, 'place-1'));

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

// ── Supabase sync-failure: local-first contract ────────────────────────────────
//
// These tests verify the "local-first" guarantee: AsyncStorage is written
// *before* the API fetch fires, so a network error or non-2xx response never
// reverts the user's wishlist changes.
//
// _setTestToken injects a fake bearer token so getAuthToken() returns a truthy
// string, which causes toggleSave / clearAllSaved to attempt the fetch call.
// globalThis.fetch is replaced with a stub that rejects or returns a non-ok
// response; the original is restored in afterEach.

describe('toggleSave — local state persists when Supabase sync fetch fails', () => {
  let storage: FakeStorage;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
    _setTestToken('fake-bearer-token'); // exercise the fetch code path
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTestToken(undefined); // restore real supabase auth for other suites
  });

  it('adds a place to local storage even when the POST fetch rejects (network error)', async () => {
    (globalThis as { fetch: unknown }).fetch = () => Promise.reject(new Error('network error'));

    const result = await toggleSave(makePlace('net-add'));

    assert.equal(result, true, 'toggleSave must return true (added)');
    const stored = JSON.parse(storage.store.get(BOOKMARKS_KEY) ?? '[]') as Array<{ id: string }>;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, 'net-add');
  });

  it('removes a place from local storage even when the DELETE fetch rejects', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('net-del'));
    (globalThis as { fetch: unknown }).fetch = () => Promise.reject(new Error('connection refused'));

    const result = await toggleSave(makePlace('net-del'));

    assert.equal(result, false, 'toggleSave must return false (removed)');
    const stored = JSON.parse(storage.store.get(BOOKMARKS_KEY) ?? '[]') as unknown[];
    assert.equal(stored.length, 0);
  });

  it('adds a place to local storage even when the POST fetch returns 500', async () => {
    (globalThis as { fetch: unknown }).fetch = () =>
      Promise.resolve({ ok: false, status: 500 } as Response);

    const result = await toggleSave(makePlace('srv-err'));

    assert.equal(result, true);
    const stored = JSON.parse(storage.store.get(BOOKMARKS_KEY) ?? '[]') as Array<{ id: string }>;
    assert.equal(stored[0].id, 'srv-err');
  });

  it('does not throw when the API call fails — error is absorbed', async () => {
    (globalThis as { fetch: unknown }).fetch = () => Promise.reject(new Error('timeout'));

    await assert.doesNotReject(() => toggleSave(makePlace('no-throw')));
  });
});

describe('clearAllSaved — local state cleared even when Supabase DELETE fails', () => {
  let storage: FakeStorage;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
    _setTestToken('fake-bearer-token');
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTestToken(undefined);
  });

  it('removes the bookmarks key from local storage even when fetch rejects', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise('a', 'b'));
    (globalThis as { fetch: unknown }).fetch = () => Promise.reject(new Error('network error'));

    await clearAllSaved();

    assert.ok(
      storage.removedKeys.includes(BOOKMARKS_KEY),
      'removeItem(BOOKMARKS_KEY) must be called before the fetch fires',
    );
    assert.equal(storage.store.get(BOOKMARKS_KEY), undefined);
  });

  it('removes the global filter key from local storage even when fetch rejects', async () => {
    storage.store.set(GLOBAL_FILTER_KEY, 'food');
    (globalThis as { fetch: unknown }).fetch = () => Promise.reject(new Error('network error'));

    await clearAllSaved();

    assert.ok(
      storage.removedKeys.includes(GLOBAL_FILTER_KEY),
      'removeItem(GLOBAL_FILTER_KEY) must be called regardless of API outcome',
    );
  });

  it('does not throw when the API DELETE returns a non-ok response', async () => {
    (globalThis as { fetch: unknown }).fetch = () =>
      Promise.resolve({ ok: false, status: 401 } as Response);

    await assert.doesNotReject(() => clearAllSaved());
  });

  it('does not throw when the API DELETE fetch rejects outright', async () => {
    (globalThis as { fetch: unknown }).fetch = () => Promise.reject(new Error('server down'));

    await assert.doesNotReject(() => clearAllSaved());
  });
});
