/**
 * Unit tests for the Discovery map filter persistence helpers.
 *
 * Run via:
 *   node --import tsx/esm --test src/components/discovery/__tests__/DiscoveryMapView.filter.test.ts
 *
 * All six behaviours from the task spec are covered:
 *   1. Valid stored value ('traveler') is returned and passed to the setter
 *   2. Invalid stored value ('unknown') falls back to 'all'
 *   3. Missing key (null) falls back to 'all' gracefully
 *   4. AsyncStorage.getItem rejection falls back to 'all'
 *   5. setFilter calls AsyncStorage.setItem with the correct key + value
 *   6. AsyncStorage.setItem rejection does not propagate (fire-and-forget)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadMapFilter,
  saveMapFilter,
  FILTER_STORAGE_KEY,
} from '../discoverMapFilterStorage.ts';
import type { StorageLike } from '../discoverMapFilterStorage.ts';

// ── Fake AsyncStorage factory ──────────────────────────────────────────────────

function fakeStorage(opts: {
  getResult?: string | null;
  getError?: Error;
  setError?: Error;
}): StorageLike & { setItemCalls: Array<{ key: string; value: string }> } {
  const setItemCalls: Array<{ key: string; value: string }> = [];
  return {
    setItemCalls,
    getItem(_key: string): Promise<string | null> {
      if (opts.getError) return Promise.reject(opts.getError);
      return Promise.resolve(opts.getResult ?? null);
    },
    setItem(key: string, value: string): Promise<void> {
      setItemCalls.push({ key, value });
      if (opts.setError) return Promise.reject(opts.setError);
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
