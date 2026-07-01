/**
 * Unit tests for listSaved() in discoveryBookmarks.
 *
 * Covers three paths:
 *   1. Unauthenticated / no token  → AsyncStorage fallback
 *   2. Authenticated + fetch ok    → API is authoritative; local cache updated
 *   3. Authenticated + fetch fails → AsyncStorage fallback (network / non-ok)
 *
 * Also verifies that the listId filter is applied correctly in both the API
 * and local-cache code paths.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/discoveryBookmarks.listSaved.test.ts
 *
 * Uses _setTestStorage() for fake AsyncStorage and _setTestToken() to control
 * the bearer token without loading the native supabase module.
 * globalThis.fetch is stubbed in suites that exercise the API path.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  listSaved,
  _setTestStorage,
  _setTestToken,
  type BookmarkedPlace,
} from '../discoveryBookmarks.ts';

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
    getItem: (key) => Promise.resolve(store.get(key) ?? null),
    setItem: (key, value) => { store.set(key, value); return Promise.resolve(); },
    removeItem: (key) => { store.delete(key); return Promise.resolve(); },
  };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makePlace(id: string, listId = 'global', savedAt = 1000): BookmarkedPlace {
  return {
    id,
    name: `Place ${id}`,
    category: 'food',
    type: null,
    address: null,
    savedAt,
    lat: null,
    lng: null,
    listId,
  };
}

function storeBookmarks(places: BookmarkedPlace[]): Record<string, string> {
  return { [BOOKMARKS_KEY]: JSON.stringify(places) };
}

// ── Fake fetch helpers ─────────────────────────────────────────────────────────

function okFetch(places: BookmarkedPlace[]) {
  return () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ places }),
    } as Response);
}

function failFetch(error = 'network error') {
  return () => Promise.reject(new Error(error));
}

function nonOkFetch(status = 500) {
  return () =>
    Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve({ error: 'server error' }),
    } as Response);
}

// ── Suite 1: unauthenticated / no token — AsyncStorage fallback ────────────────

describe('listSaved — unauthenticated: falls back to AsyncStorage', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
    _setTestToken(null); // simulate no session / unauthenticated
  });

  afterEach(() => {
    _setTestToken(undefined);
  });

  it('returns all places from AsyncStorage when token is null', async () => {
    const places = [makePlace('p1'), makePlace('p2')];
    storage.store.set(BOOKMARKS_KEY, JSON.stringify(places));

    const result = await listSaved();

    assert.equal(result.length, 2);
    assert.ok(result.some((p) => p.id === 'p1'));
    assert.ok(result.some((p) => p.id === 'p2'));
  });

  it('returns an empty array when AsyncStorage is empty', async () => {
    const result = await listSaved();
    assert.deepEqual(result, []);
  });

  it('applies the listId filter when reading from AsyncStorage', async () => {
    const places = [
      makePlace('p1', 'trip-a'),
      makePlace('p2', 'trip-b'),
      makePlace('p3', 'trip-a'),
    ];
    storage.store.set(BOOKMARKS_KEY, JSON.stringify(places));

    const result = await listSaved('trip-a');

    assert.equal(result.length, 2);
    assert.ok(result.every((p) => p.listId === 'trip-a'));
    assert.ok(result.some((p) => p.id === 'p1'));
    assert.ok(result.some((p) => p.id === 'p3'));
    assert.ok(!result.some((p) => p.id === 'p2'));
  });

  it('treats entries without listId as belonging to the global list', async () => {
    // Legacy v1 entries have no listId field
    const legacy = [
      { id: 'p1', name: 'Legacy', category: 'food', type: null, address: null, savedAt: 1000 },
    ] as BookmarkedPlace[];
    storage.store.set(BOOKMARKS_KEY, JSON.stringify(legacy));

    const globalResult = await listSaved('global');

    assert.equal(globalResult.length, 1, 'legacy entry should be returned for listId=global');
    assert.equal(globalResult[0].id, 'p1');
  });

  it('returns all entries across lists when no listId is specified', async () => {
    const places = [
      makePlace('p1', 'trip-a'),
      makePlace('p2', 'global'),
      makePlace('p3', 'trip-b'),
    ];
    storage.store.set(BOOKMARKS_KEY, JSON.stringify(places));

    const result = await listSaved();

    assert.equal(result.length, 3);
  });

  it('returns results sorted newest-first (by savedAt) from AsyncStorage', async () => {
    const places = [
      makePlace('p1', 'global', 100),
      makePlace('p2', 'global', 300),
      makePlace('p3', 'global', 200),
    ];
    storage.store.set(BOOKMARKS_KEY, JSON.stringify(places));

    const result = await listSaved();

    assert.deepEqual(
      result.map((p) => p.id),
      ['p2', 'p3', 'p1'],
      'should be sorted newest-first by savedAt',
    );
  });
});

// ── Suite 2: authenticated + fetch succeeds — API is authoritative ─────────────

describe('listSaved — authenticated: API path succeeds', () => {
  let storage: FakeStorage;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
    _setTestToken('valid-bearer-token');
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTestToken(undefined);
  });

  it('returns places from the API response when fetch succeeds', async () => {
    const apiPlaces = [makePlace('api-p1', 'global'), makePlace('api-p2', 'global')];
    (globalThis as { fetch: unknown }).fetch = okFetch(apiPlaces);

    const result = await listSaved();

    assert.equal(result.length, 2);
    assert.ok(result.some((p) => p.id === 'api-p1'));
    assert.ok(result.some((p) => p.id === 'api-p2'));
  });

  it('applies the listId filter to the API response', async () => {
    const apiPlaces = [
      makePlace('api-p1', 'trip-a'),
      makePlace('api-p2', 'trip-b'),
      makePlace('api-p3', 'trip-a'),
    ];
    (globalThis as { fetch: unknown }).fetch = okFetch(apiPlaces);

    const result = await listSaved('trip-a');

    assert.equal(result.length, 2);
    assert.ok(result.every((p) => p.listId === 'trip-a'));
    assert.ok(!result.some((p) => p.id === 'api-p2'));
  });

  it('updates AsyncStorage (local cache) with the full API response', async () => {
    // Seed stale local data that differs from the API
    storage.store.set(BOOKMARKS_KEY, JSON.stringify([makePlace('stale-p1')]));

    const apiPlaces = [makePlace('fresh-p1', 'trip-a'), makePlace('fresh-p2', 'trip-b')];
    (globalThis as { fetch: unknown }).fetch = okFetch(apiPlaces);

    await listSaved();

    const stored = JSON.parse(storage.store.get(BOOKMARKS_KEY) ?? '[]') as BookmarkedPlace[];
    assert.equal(stored.length, 2, 'local cache should be replaced with the full API list');
    assert.ok(stored.some((p) => p.id === 'fresh-p1'));
    assert.ok(stored.some((p) => p.id === 'fresh-p2'));
    assert.ok(!stored.some((p) => p.id === 'stale-p1'), 'stale local entry should be evicted');
  });

  it('stores the full unfiltered API list even when a listId filter is requested', async () => {
    // API returns places from multiple trips
    const apiPlaces = [
      makePlace('p1', 'trip-a'),
      makePlace('p2', 'trip-b'),
    ];
    (globalThis as { fetch: unknown }).fetch = okFetch(apiPlaces);

    // Request only trip-a
    const result = await listSaved('trip-a');

    // Caller gets filtered result
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'p1');

    // But the full list is persisted in local cache
    const stored = JSON.parse(storage.store.get(BOOKMARKS_KEY) ?? '[]') as BookmarkedPlace[];
    assert.equal(stored.length, 2, 'local cache should hold all places, not just the filtered view');
  });

  it('returns results sorted newest-first from the API response', async () => {
    const apiPlaces = [
      makePlace('p1', 'global', 100),
      makePlace('p2', 'global', 300),
      makePlace('p3', 'global', 200),
    ];
    (globalThis as { fetch: unknown }).fetch = okFetch(apiPlaces);

    const result = await listSaved();

    assert.deepEqual(
      result.map((p) => p.id),
      ['p2', 'p3', 'p1'],
      'API results should be sorted newest-first by savedAt',
    );
  });

  it('treats API entries without listId as belonging to the global list', async () => {
    const apiPlaces = [
      // No listId field — legacy shape
      { id: 'p1', name: 'Legacy', category: 'food', type: null, address: null, savedAt: 1000 } as BookmarkedPlace,
    ];
    (globalThis as { fetch: unknown }).fetch = okFetch(apiPlaces);

    const result = await listSaved('global');

    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'p1');
  });
});

// ── Suite 3: authenticated + fetch fails — AsyncStorage fallback ───────────────

describe('listSaved — authenticated: API fails, falls back to AsyncStorage', () => {
  let storage: FakeStorage;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
    _setTestToken('valid-bearer-token');
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTestToken(undefined);
  });

  it('falls back to AsyncStorage when fetch throws a network error', async () => {
    const localPlaces = [makePlace('local-p1', 'trip-a'), makePlace('local-p2', 'trip-a')];
    storage.store.set(BOOKMARKS_KEY, JSON.stringify(localPlaces));
    (globalThis as { fetch: unknown }).fetch = failFetch('connection refused');

    const result = await listSaved();

    assert.equal(result.length, 2, 'should return local data when network fails');
    assert.ok(result.some((p) => p.id === 'local-p1'));
    assert.ok(result.some((p) => p.id === 'local-p2'));
  });

  it('falls back to AsyncStorage when the API returns a non-ok status', async () => {
    const localPlaces = [makePlace('local-p1')];
    storage.store.set(BOOKMARKS_KEY, JSON.stringify(localPlaces));
    (globalThis as { fetch: unknown }).fetch = nonOkFetch(503);

    const result = await listSaved();

    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'local-p1');
  });

  it('applies the listId filter from AsyncStorage on network failure', async () => {
    const localPlaces = [
      makePlace('p1', 'trip-a'),
      makePlace('p2', 'trip-b'),
      makePlace('p3', 'trip-a'),
    ];
    storage.store.set(BOOKMARKS_KEY, JSON.stringify(localPlaces));
    (globalThis as { fetch: unknown }).fetch = failFetch('timeout');

    const result = await listSaved('trip-a');

    assert.equal(result.length, 2, 'listId filter must be applied to AsyncStorage fallback');
    assert.ok(result.every((p) => p.listId === 'trip-a'));
    assert.ok(!result.some((p) => p.id === 'p2'));
  });

  it('does NOT overwrite the local cache when the API fetch fails', async () => {
    const localPlaces = [makePlace('local-p1')];
    storage.store.set(BOOKMARKS_KEY, JSON.stringify(localPlaces));
    (globalThis as { fetch: unknown }).fetch = failFetch('server error');

    await listSaved();

    const stored = JSON.parse(storage.store.get(BOOKMARKS_KEY) ?? '[]') as BookmarkedPlace[];
    assert.equal(stored.length, 1, 'local cache must not be cleared when the API is unavailable');
    assert.equal(stored[0].id, 'local-p1');
  });

  it('does NOT overwrite the local cache when the API returns a non-ok status', async () => {
    const localPlaces = [makePlace('local-p1'), makePlace('local-p2')];
    storage.store.set(BOOKMARKS_KEY, JSON.stringify(localPlaces));
    (globalThis as { fetch: unknown }).fetch = nonOkFetch(500);

    await listSaved();

    const stored = JSON.parse(storage.store.get(BOOKMARKS_KEY) ?? '[]') as BookmarkedPlace[];
    assert.equal(stored.length, 2, 'local cache must be preserved on a non-ok API response');
  });

  it('returns an empty array when both the API fails and AsyncStorage is empty', async () => {
    // No data in local storage and network is down
    (globalThis as { fetch: unknown }).fetch = failFetch('no connection');

    const result = await listSaved();

    assert.deepEqual(result, []);
  });
});

// ── Suite 4: API success keeps local cache consistent ─────────────────────────

describe('listSaved — local cache is the authoritative offline store', () => {
  let storage: FakeStorage;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTestToken(undefined);
  });

  it('after a successful API fetch, a subsequent unauthenticated call returns the API data', async () => {
    // First call: authenticated, API succeeds
    _setTestToken('valid-token');
    const apiPlaces = [makePlace('api-p1', 'trip-a'), makePlace('api-p2', 'trip-b')];
    (globalThis as { fetch: unknown }).fetch = okFetch(apiPlaces);
    await listSaved();

    // Simulate app restart / token expiry — next call is unauthenticated
    _setTestToken(null);
    globalThis.fetch = originalFetch; // restore real fetch (won't be called)

    const result = await listSaved();

    assert.equal(result.length, 2, 'API data written to cache should survive a token expiry');
    assert.ok(result.some((p) => p.id === 'api-p1'));
    assert.ok(result.some((p) => p.id === 'api-p2'));
  });

  it('after a network failure, the previously cached data is still returned', async () => {
    // Seed local cache with known data (simulates a prior successful API call)
    const cached = [makePlace('cached-p1', 'trip-a'), makePlace('cached-p2', 'trip-a')];
    storage.store.set(BOOKMARKS_KEY, JSON.stringify(cached));

    // Network is now down
    _setTestToken('valid-token');
    (globalThis as { fetch: unknown }).fetch = failFetch('network gone');

    const result = await listSaved();

    assert.equal(result.length, 2);
    assert.ok(result.some((p) => p.id === 'cached-p1'));
    assert.ok(result.some((p) => p.id === 'cached-p2'));
  });
});
