/**
 * Unit tests for the Discovery map filter persistence helpers.
 *
 * Run via:
 *   node --import tsx/esm --test src/components/discovery/__tests__/DiscoveryMapView.filter.test.ts
 *
 * All six behaviours from the original task spec are covered, plus nine cache
 * behaviours added in the follow-up task:
 *   1. Valid stored value ('traveler') is returned and passed to the setter
 *   2. Invalid stored value ('unknown') falls back to 'all'
 *   3. Missing key (null) falls back to 'all' gracefully
 *   4. AsyncStorage.getItem rejection falls back to 'all'
 *   5. setFilter calls AsyncStorage.setItem with the correct key + value
 *   6. AsyncStorage.setItem rejection does not propagate (fire-and-forget)
 *
 * Cache / getCachedFilter tests:
 *   C1. getCachedFilter() returns null before any load/save
 *   C2. loadMapFilter with valid stored value → getCachedFilter() returns that value
 *   C3. loadMapFilter with invalid stored value → getCachedFilter() unchanged (not overwritten)
 *   C4. loadMapFilter rejection → getCachedFilter() unchanged
 *   C5. saveMapFilter → getCachedFilter() returns the saved value synchronously
 *   C6. removeMapFilter → getCachedFilter() returns null after call
 *   C7. removeMapFilter calls storage.removeItem with the correct key
 *   C8. Full lifecycle: save('traveler') → remove → getCachedFilter() === null
 *   C9. Full lifecycle: save('osm') → load → getCachedFilter() === 'osm'
 *
 * Round-trip integration tests:
 *   RT1. save → load confirms value → remove → load again returns 'all'
 *   RT2. wrong-key removeItem bug: demonstrates that storage still holds the
 *        value when the wrong key is deleted; correct removeMapFilter fixes it
 *   RT3. cache mirrors storage at every step of the full lifecycle
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadMapFilter,
  saveMapFilter,
  removeMapFilter,
  getCachedFilter,
  FILTER_STORAGE_KEY,
} from '../discoverMapFilterStorage.ts';
import type { StorageLike } from '../discoverMapFilterStorage.ts';

// ── Fake AsyncStorage factory ──────────────────────────────────────────────────

function fakeStorage(opts: {
  getResult?: string | null;
  getError?: Error;
  setError?: Error;
  removeError?: Error;
} = {}): StorageLike & {
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

// ── loadMapFilter ─────────────────────────────────────────────────────────────

describe('loadMapFilter', () => {
  it('1. returns a valid stored value without falling back', async () => {
    const storage = fakeStorage({ getResult: 'traveler' });
    const result = await loadMapFilter(storage);
    assert.equal(result, 'traveler');
  });

  it('1b. returns "osm" when that valid value is stored', async () => {
    const storage = fakeStorage({ getResult: 'osm' });
    const result = await loadMapFilter(storage);
    assert.equal(result, 'osm');
  });

  it('1c. returns "all" when "all" is explicitly stored', async () => {
    const storage = fakeStorage({ getResult: 'all' });
    const result = await loadMapFilter(storage);
    assert.equal(result, 'all');
  });

  it('2. falls back to "all" for an unrecognised stored value', async () => {
    const storage = fakeStorage({ getResult: 'unknown' });
    const result = await loadMapFilter(storage);
    assert.equal(result, 'all');
  });

  it('2b. falls back to "all" for an empty string stored value', async () => {
    const storage = fakeStorage({ getResult: '' });
    const result = await loadMapFilter(storage);
    assert.equal(result, 'all');
  });

  it('3. falls back to "all" when the key is missing (null)', async () => {
    const storage = fakeStorage({ getResult: null });
    const result = await loadMapFilter(storage);
    assert.equal(result, 'all');
  });

  it('4. falls back to "all" when getItem rejects', async () => {
    const storage = fakeStorage({ getError: new Error('storage unavailable') });
    const result = await loadMapFilter(storage);
    assert.equal(result, 'all');
  });

  it('reads from the correct storage key', async () => {
    let capturedKey: string | undefined;
    const storage: StorageLike = {
      getItem(key) {
        capturedKey = key;
        return Promise.resolve('traveler');
      },
      setItem() { return Promise.resolve(); },
      removeItem() { return Promise.resolve(); },
    };
    await loadMapFilter(storage);
    assert.equal(capturedKey, FILTER_STORAGE_KEY);
    assert.equal(capturedKey, 'discovery_map_filter');
  });
});

// ── saveMapFilter ─────────────────────────────────────────────────────────────

describe('saveMapFilter', () => {
  it('5. calls setItem with the correct storage key and filter value', async () => {
    const storage = fakeStorage({});
    saveMapFilter(storage, 'traveler');
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.setItemCalls.length, 1);
    assert.equal(storage.setItemCalls[0].key, FILTER_STORAGE_KEY);
    assert.equal(storage.setItemCalls[0].value, 'traveler');
  });

  it('5b. calls setItem with "osm" when that filter is chosen', async () => {
    const storage = fakeStorage({});
    saveMapFilter(storage, 'osm');
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.setItemCalls[0].value, 'osm');
  });

  it('5c. calls setItem with "all" when that filter is chosen', async () => {
    const storage = fakeStorage({});
    saveMapFilter(storage, 'all');
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.setItemCalls[0].value, 'all');
  });

  it('6. does not propagate a setItem rejection (fire-and-forget)', async () => {
    const storage = fakeStorage({ setError: new Error('disk full') });
    assert.doesNotThrow(() => saveMapFilter(storage, 'traveler'));
    await new Promise((r) => setImmediate(r));
  });

  it('6b. does not return a promise that the caller must handle', () => {
    const storage = fakeStorage({ setError: new Error('disk full') });
    const result = saveMapFilter(storage, 'traveler');
    assert.equal(result, undefined);
  });
});

// ── getCachedFilter / memory cache ────────────────────────────────────────────
//
// _memoryCache is module-level state, so each test resets it via removeMapFilter
// in beforeEach/afterEach to prevent ordering dependencies.

describe('getCachedFilter and memory cache', () => {
  beforeEach(() => {
    removeMapFilter(fakeStorage());
  });

  afterEach(() => {
    removeMapFilter(fakeStorage());
  });

  it('C1. returns null before any load or save', () => {
    assert.equal(getCachedFilter(), null);
  });

  it('C2. loadMapFilter with a valid stored value populates the cache', async () => {
    const storage = fakeStorage({ getResult: 'traveler' });
    await loadMapFilter(storage);
    assert.equal(getCachedFilter(), 'traveler');
  });

  it('C2b. loadMapFilter with "osm" populates the cache with "osm"', async () => {
    const storage = fakeStorage({ getResult: 'osm' });
    await loadMapFilter(storage);
    assert.equal(getCachedFilter(), 'osm');
  });

  it('C3. loadMapFilter with an invalid stored value leaves the cache unchanged', async () => {
    saveMapFilter(fakeStorage(), 'traveler');
    assert.equal(getCachedFilter(), 'traveler');
    const storage = fakeStorage({ getResult: 'unknown' });
    await loadMapFilter(storage);
    assert.equal(getCachedFilter(), 'traveler');
  });

  it('C3b. loadMapFilter with null stored value leaves the cache unchanged', async () => {
    saveMapFilter(fakeStorage(), 'osm');
    assert.equal(getCachedFilter(), 'osm');
    const storage = fakeStorage({ getResult: null });
    await loadMapFilter(storage);
    assert.equal(getCachedFilter(), 'osm');
  });

  it('C4. loadMapFilter rejection leaves the cache unchanged', async () => {
    saveMapFilter(fakeStorage(), 'traveler');
    assert.equal(getCachedFilter(), 'traveler');
    const storage = fakeStorage({ getError: new Error('io error') });
    await loadMapFilter(storage);
    assert.equal(getCachedFilter(), 'traveler');
  });

  it('C5. saveMapFilter updates the cache synchronously before setItem resolves', () => {
    const storage = fakeStorage({});
    saveMapFilter(storage, 'traveler');
    assert.equal(getCachedFilter(), 'traveler');
  });

  it('C5b. saveMapFilter with "osm" sets the cache to "osm" synchronously', () => {
    const storage = fakeStorage({});
    saveMapFilter(storage, 'osm');
    assert.equal(getCachedFilter(), 'osm');
  });

  it('C5c. saveMapFilter with "all" sets the cache to "all" synchronously', () => {
    const storage = fakeStorage({});
    saveMapFilter(storage, 'all');
    assert.equal(getCachedFilter(), 'all');
  });

  it('C6. removeMapFilter clears the cache to null', () => {
    const storage = fakeStorage({});
    saveMapFilter(storage, 'traveler');
    assert.equal(getCachedFilter(), 'traveler');
    removeMapFilter(storage);
    assert.equal(getCachedFilter(), null);
  });

  it('C8. full lifecycle: save → remove → getCachedFilter() === null', () => {
    const storage = fakeStorage({});
    saveMapFilter(storage, 'traveler');
    removeMapFilter(storage);
    assert.equal(getCachedFilter(), null);
  });

  it('C9. full lifecycle: save("osm") → load → getCachedFilter() === "osm"', async () => {
    const storage = fakeStorage({ getResult: 'osm' });
    saveMapFilter(storage, 'osm');
    await loadMapFilter(storage);
    assert.equal(getCachedFilter(), 'osm');
  });
});

// ── Stateful storage (for round-trip integration tests) ───────────────────────
//
// Unlike fakeStorage() whose getItem always returns a fixed value, statefulStorage
// reflects mutations: setItem stores a value, removeItem deletes it, getItem reads
// the current state. This lets a single test drive save → load → remove → load.

function statefulStorage(): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem(key) { return Promise.resolve(store.get(key) ?? null); },
    setItem(key, value) { store.set(key, value); return Promise.resolve(); },
    removeItem(key) { store.delete(key); return Promise.resolve(); },
  };
}

// ── Round-trip integration tests ───────────────────────────────────────────────

describe('round-trip integration', () => {
  beforeEach(() => { removeMapFilter(fakeStorage()); });
  afterEach(() => { removeMapFilter(fakeStorage()); });

  it('RT1. save → load confirms persisted value → remove → load returns "all"', async () => {
    const storage = statefulStorage();
    // Step 1: save 'traveler'
    saveMapFilter(storage, 'traveler');
    await new Promise((r) => setImmediate(r)); // let setItem settle
    // Step 2: load confirms the value was actually written to storage
    const afterSave = await loadMapFilter(storage);
    assert.equal(afterSave, 'traveler');
    // Step 3: remove
    removeMapFilter(storage);
    await new Promise((r) => setImmediate(r)); // let removeItem settle
    // Step 4: load confirms the value is gone — not a wrong-key removal
    const afterRemove = await loadMapFilter(storage);
    assert.equal(afterRemove, 'all');
  });

  it('RT1b. same round-trip with "osm" filter', async () => {
    const storage = statefulStorage();
    saveMapFilter(storage, 'osm');
    await new Promise((r) => setImmediate(r));
    assert.equal(await loadMapFilter(storage), 'osm');
    removeMapFilter(storage);
    await new Promise((r) => setImmediate(r));
    assert.equal(await loadMapFilter(storage), 'all');
  });

  it('RT2. demonstrates that a wrong-key removeItem leaves stale data; removeMapFilter uses the correct key', async () => {
    const storage = statefulStorage();
    saveMapFilter(storage, 'osm');
    await new Promise((r) => setImmediate(r));
    // Simulate a bug: remove a different key instead of the real storage key
    storage.store.delete('wrong_key');
    // The real key is still present — stale data survives wrong-key deletion
    const stillPresent = await loadMapFilter(storage);
    assert.equal(stillPresent, 'osm');
    // removeMapFilter uses FILTER_STORAGE_KEY — the correct key — so the value is gone
    removeMapFilter(storage);
    await new Promise((r) => setImmediate(r));
    assert.equal(await loadMapFilter(storage), 'all');
  });

  it('RT3. cache mirrors storage state at every step of the full lifecycle', async () => {
    const storage = statefulStorage();
    // Initially null
    assert.equal(getCachedFilter(), null);
    // After save: cache updated synchronously
    saveMapFilter(storage, 'traveler');
    assert.equal(getCachedFilter(), 'traveler');
    await new Promise((r) => setImmediate(r));
    // After load: cache still 'traveler' (load also sets cache on valid value)
    await loadMapFilter(storage);
    assert.equal(getCachedFilter(), 'traveler');
    // After remove: cache cleared to null and storage value is gone
    removeMapFilter(storage);
    assert.equal(getCachedFilter(), null);
    await new Promise((r) => setImmediate(r));
    // Reload after remove: returns 'all' (storage key was deleted)
    const afterRemove = await loadMapFilter(storage);
    assert.equal(afterRemove, 'all');
    // Cache stays null on fallback (only set when a valid stored value is found)
    assert.equal(getCachedFilter(), null);
  });
});

// ── removeMapFilter ───────────────────────────────────────────────────────────

describe('removeMapFilter', () => {
  beforeEach(() => {
    removeMapFilter(fakeStorage());
  });

  afterEach(() => {
    removeMapFilter(fakeStorage());
  });

  it('C7. calls storage.removeItem with the correct key', async () => {
    const storage = fakeStorage({});
    removeMapFilter(storage);
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.removeItemCalls.length, 1);
    assert.equal(storage.removeItemCalls[0], FILTER_STORAGE_KEY);
  });

  it('does not propagate a removeItem rejection (fire-and-forget)', async () => {
    const storage = fakeStorage({ removeError: new Error('disk error') });
    assert.doesNotThrow(() => removeMapFilter(storage));
    await new Promise((r) => setImmediate(r));
  });

  it('does not return a promise that the caller must handle', () => {
    const storage = fakeStorage({});
    const result = removeMapFilter(storage);
    assert.equal(result, undefined);
  });

  it('clears the cache even when removeItem rejects', async () => {
    const storage = fakeStorage({ removeError: new Error('disk error') });
    saveMapFilter(fakeStorage(), 'traveler');
    removeMapFilter(storage);
    await new Promise((r) => setImmediate(r));
    assert.equal(getCachedFilter(), null);
  });
});
