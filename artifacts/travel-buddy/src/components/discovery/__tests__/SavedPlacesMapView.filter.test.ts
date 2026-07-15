/**
 * Unit tests for the SavedPlacesMapView category-filter persistence helpers.
 *
 * Run via:
 *   node --import tsx/esm --test src/components/discovery/__tests__/SavedPlacesMapView.filter.test.ts
 *
 * All six behaviours from the task spec are covered:
 *   1. Valid stored value is returned when the category exists in the list
 *   2. Invalid stored value falls back to null
 *   3. null from storage falls back to null
 *   4. AsyncStorage.getItem rejection falls back to null
 *   5. saveCategoryFilter calls setItem with the correct key and value
 *   6. AsyncStorage.setItem rejection does not propagate
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCategoryFilter,
  saveCategoryFilter,
  categoryStorageKey,
  readRawCategoryFilter,
  CATEGORY_STORAGE_PREFIX,
} from '../../savedPlacesMapFilterStorage.ts';
import type { StorageLike } from '../../savedPlacesMapFilterStorage.ts';

// ── Fake AsyncStorage factory ──────────────────────────────────────────────────

function fakeStorage(opts: {
  getResult?: string | null;
  getError?: Error;
  setError?: Error;
  removeError?: Error;
}): StorageLike & {
  setItemCalls: Array<{ key: string; value: string }>;
  removeItemCalls: string[];
} {
  const setItemCalls: Array<{ key: string; value: string }> = [];
  const removeItemCalls: string[] = [];
  return {
    setItemCalls,
    removeItemCalls,
    getItem(_key: string): Promise<string | null> {
      if (opts.getError) return Promise.reject(opts.getError);
      return Promise.resolve(opts.getResult ?? null);
    },
    setItem(key: string, value: string): Promise<void> {
      setItemCalls.push({ key, value });
      if (opts.setError) return Promise.reject(opts.setError);
      return Promise.resolve();
    },
    removeItem(key: string): Promise<void> {
      removeItemCalls.push(key);
      if (opts.removeError) return Promise.reject(opts.removeError);
      return Promise.resolve();
    },
  };
}

const TEST_KEY = categoryStorageKey('global');
const CATEGORIES = ['food', 'nightlife', 'beaches', '__uncategorized__'];

// ── categoryStorageKey ────────────────────────────────────────────────────────

describe('categoryStorageKey', () => {
  it('builds the correct key from a listId', () => {
    assert.equal(categoryStorageKey('global'), `${CATEGORY_STORAGE_PREFIX}global`);
    assert.equal(categoryStorageKey('trip-123'), `${CATEGORY_STORAGE_PREFIX}trip-123`);
  });
});

// ── loadCategoryFilter ────────────────────────────────────────────────────────

describe('loadCategoryFilter', () => {
  it('1. returns a valid stored value that is present in categories', async () => {
    const storage = fakeStorage({ getResult: 'food' });
    const result = await loadCategoryFilter(storage, TEST_KEY, CATEGORIES);
    assert.equal(result, 'food');
  });

  it('1b. returns the uncategorized sentinel when it is stored and present', async () => {
    const storage = fakeStorage({ getResult: '__uncategorized__' });
    const result = await loadCategoryFilter(storage, TEST_KEY, CATEGORIES);
    assert.equal(result, '__uncategorized__');
  });

  it('2. falls back to null for a value not in the categories list', async () => {
    const storage = fakeStorage({ getResult: 'unknown_category' });
    const result = await loadCategoryFilter(storage, TEST_KEY, CATEGORIES);
    assert.equal(result, null);
  });

  it('2b. falls back to null for an empty string stored value', async () => {
    const storage = fakeStorage({ getResult: '' });
    const result = await loadCategoryFilter(storage, TEST_KEY, CATEGORIES);
    assert.equal(result, null);
  });

  it('2c. falls back to null when categories list is empty (stale key)', async () => {
    const storage = fakeStorage({ getResult: 'food' });
    const result = await loadCategoryFilter(storage, TEST_KEY, []);
    assert.equal(result, null);
  });

  it('3. falls back to null when the key is missing (null)', async () => {
    const storage = fakeStorage({ getResult: null });
    const result = await loadCategoryFilter(storage, TEST_KEY, CATEGORIES);
    assert.equal(result, null);
  });

  it('4. falls back to null when getItem rejects', async () => {
    const storage = fakeStorage({ getError: new Error('storage unavailable') });
    const result = await loadCategoryFilter(storage, TEST_KEY, CATEGORIES);
    assert.equal(result, null);
  });

  it('reads from the supplied storage key', async () => {
    let capturedKey: string | undefined;
    const storage: StorageLike = {
      getItem(key) {
        capturedKey = key;
        return Promise.resolve('food');
      },
      setItem() { return Promise.resolve(); },
      removeItem() { return Promise.resolve(); },
    };
    await loadCategoryFilter(storage, TEST_KEY, CATEGORIES);
    assert.equal(capturedKey, TEST_KEY);
    assert.equal(capturedKey, 'saved_places_map_cat_v1_global');
  });
});

// ── readRawCategoryFilter ──────────────────────────────────────────────────────

describe('readRawCategoryFilter', () => {
  it('returns the raw stored string without categories validation', async () => {
    const storage = fakeStorage({ getResult: 'beach' });
    const result = await readRawCategoryFilter(storage, TEST_KEY);
    assert.equal(result, 'beach');
  });

  it('demonstrates the race condition fix: loadCategoryFilter fails with stale snapshot, readRaw survives', async () => {
    const storage = fakeStorage({ getResult: 'beach' });
    // Simulate: categories=[] at effect time (initial render, data not loaded yet)
    const categoriesAtCallTime: string[] = [];
    // Old approach — validates against stale snapshot → discards valid category
    const oldResult = await loadCategoryFilter(storage, TEST_KEY, categoriesAtCallTime);
    assert.equal(oldResult, null); // 'beach' was discarded ← the bug

    // New approach — reads raw value; validation happens against latest categories
    const raw = await readRawCategoryFilter(storage, TEST_KEY);
    const categoriesNow = ['food', 'beach']; // categories after data arrived
    const survived = raw && categoriesNow.includes(raw) ? raw : null;
    assert.equal(survived, 'beach'); // 'beach' survives ← the fix
  });

  it('returns null for a missing key (null from storage)', async () => {
    const storage = fakeStorage({ getResult: null });
    const result = await readRawCategoryFilter(storage, TEST_KEY);
    assert.equal(result, null);
  });

  it('returns null for an empty string stored value', async () => {
    const storage = fakeStorage({ getResult: '' });
    const result = await readRawCategoryFilter(storage, TEST_KEY);
    assert.equal(result, null);
  });

  it('returns null when getItem rejects', async () => {
    const storage = fakeStorage({ getError: new Error('storage unavailable') });
    const result = await readRawCategoryFilter(storage, TEST_KEY);
    assert.equal(result, null);
  });

  it('reads from the supplied storage key', async () => {
    let capturedKey: string | undefined;
    const storage: StorageLike = {
      getItem(key) { capturedKey = key; return Promise.resolve('food'); },
      setItem() { return Promise.resolve(); },
      removeItem() { return Promise.resolve(); },
    };
    await readRawCategoryFilter(storage, TEST_KEY);
    assert.equal(capturedKey, TEST_KEY);
  });
});

// ── saveCategoryFilter ────────────────────────────────────────────────────────

describe('saveCategoryFilter', () => {
  it('5. calls setItem with the correct storage key and category value', async () => {
    const storage = fakeStorage({});
    saveCategoryFilter(storage, TEST_KEY, 'nightlife');
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.setItemCalls.length, 1);
    assert.equal(storage.setItemCalls[0].key, TEST_KEY);
    assert.equal(storage.setItemCalls[0].value, 'nightlife');
  });

  it('5b. calls setItem with the uncategorized sentinel value', async () => {
    const storage = fakeStorage({});
    saveCategoryFilter(storage, TEST_KEY, '__uncategorized__');
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.setItemCalls[0].value, '__uncategorized__');
  });

  it('5c. calls removeItem (not setItem) when category is null ("All")', async () => {
    const storage = fakeStorage({});
    saveCategoryFilter(storage, TEST_KEY, null);
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.setItemCalls.length, 0);
    assert.equal(storage.removeItemCalls.length, 1);
    assert.equal(storage.removeItemCalls[0], TEST_KEY);
  });

  it('6. does not propagate a setItem rejection (fire-and-forget)', async () => {
    const storage = fakeStorage({ setError: new Error('disk full') });
    assert.doesNotThrow(() => saveCategoryFilter(storage, TEST_KEY, 'food'));
    await new Promise((r) => setImmediate(r));
  });

  it('6b. does not return a promise that the caller must handle', () => {
    const storage = fakeStorage({ setError: new Error('disk full') });
    const result = saveCategoryFilter(storage, TEST_KEY, 'food');
    assert.equal(result, undefined);
  });

  it('6c. does not propagate a removeItem rejection when category is null', async () => {
    const storage = fakeStorage({ removeError: new Error('disk full') });
    assert.doesNotThrow(() => saveCategoryFilter(storage, TEST_KEY, null));
    await new Promise((r) => setImmediate(r));
  });

  it('removeItem receives the exact key for listId "global"', async () => {
    const storage = fakeStorage({});
    const key = categoryStorageKey('global');
    saveCategoryFilter(storage, key, null);
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.removeItemCalls.length, 1);
    assert.equal(storage.removeItemCalls[0], 'saved_places_map_cat_v1_global');
  });

  it('removeItem receives the exact key for a custom listId "trip-123"', async () => {
    const storage = fakeStorage({});
    const key = categoryStorageKey('trip-123');
    saveCategoryFilter(storage, key, null);
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.removeItemCalls.length, 1);
    assert.equal(storage.removeItemCalls[0], 'saved_places_map_cat_v1_trip-123');
  });
});
