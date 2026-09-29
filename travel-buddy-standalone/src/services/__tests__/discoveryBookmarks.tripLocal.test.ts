/**
 * WP-10 (census-trips §77, WP10-D1): the local-only reads and writes the trip
 * saved-places merge relies on. listLocalSaved never asks the server;
 * ensureSavedInList only ever adds.
 * Run: node --import tsx/esm --test src/services/__tests__/discoveryBookmarks.tripLocal.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { listLocalSaved, ensureSavedInList, _setTestStorage, _setTestToken } from '../discoveryBookmarks.ts';

const KEY = 'discovery_bookmarks_v1';
let store: Map<string, string>;
let fetched = 0;

const b = (id: string, listId: string) => ({ id, name: id, category: 'food', type: null, address: null, savedAt: 1000, listId });

describe('discoveryBookmarks — trip-local helpers', () => {
  beforeEach(() => {
    store = new Map([[KEY, JSON.stringify([b('a', 't1'), b('b', 't2'), b('c', 't1')])]]);
    _setTestStorage({
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => { store.set(k, v); },
      removeItem: async (k) => { store.delete(k); },
    });
    // A token is set so that ANY server call would be attempted — and counted.
    _setTestToken('tok');
    fetched = 0;
    globalThis.fetch = (async () => { fetched += 1; return new Response('{"places":[]}', { status: 200 }); }) as typeof fetch;
  });

  it('listLocalSaved reads only this device, only this list', async () => {
    assert.deepEqual((await listLocalSaved('t1')).map((x) => x.id), ['a', 'c']);
    assert.equal(fetched, 0);
  });

  it('ensureSavedInList adds a missing copy once, never toggles an existing one off, and never calls the server', async () => {
    await ensureSavedInList(b('d', 't1'), 't1');
    await ensureSavedInList(b('d', 't1'), 't1');
    await ensureSavedInList(b('a', 't1'), 't1');
    const t1 = (await listLocalSaved('t1')).map((x) => x.id).sort();
    assert.deepEqual(t1, ['a', 'c', 'd']);
    assert.equal(fetched, 0);
  });
});
