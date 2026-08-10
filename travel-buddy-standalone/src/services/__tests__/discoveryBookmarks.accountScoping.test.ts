/**
 * Account-scoped storage tests for discoveryBookmarks.ts — read isolation
 * between two accounts, one-time legacy migration, and the flag-OFF path
 * staying byte-identical to pre-existing behavior.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  toggleSave, listSaved, removeSaved, _setTestStorage, _setTestToken,
  _resetMigratedBookmarksAccountIds,
} from '../discoveryBookmarks.ts';
import { _setTestAccountScopedStorageFlag } from '../../config/accountScopedStorageFlag.ts';
import { _setTestAccountId } from '../accountId.ts';

const BOOKMARKS_KEY = 'discovery_bookmarks_v1';

interface FakeStorage {
  store: Map<string, string>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function fakeStorage(): FakeStorage {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => Promise.resolve(store.get(key) ?? null),
    setItem: (key, value) => { store.set(key, value); return Promise.resolve(); },
    removeItem: (key) => { store.delete(key); return Promise.resolve(); },
  };
}

function makePlace(id: string) {
  return { id, name: 'Test Place', category: 'food', type: null, address: null, savedAt: 1000, lat: null, lng: null };
}

describe('discoveryBookmarks — account-scoped storage (flag on)', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
    _setTestToken(null); // unauthenticated — exercise local-only path, no fetch
    _setTestAccountScopedStorageFlag(true);
    _resetMigratedBookmarksAccountIds();
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
    _setTestToken(undefined);
  });

  it('read isolation: account A never sees account B\'s saved places', async () => {
    _setTestAccountId('user-a');
    await toggleSave(makePlace('a-place'));

    _setTestAccountId('user-b');
    await toggleSave(makePlace('b-place'));
    const bList = await listSaved();
    assert.equal(bList.length, 1);
    assert.equal(bList[0].id, 'b-place');

    _setTestAccountId('user-a');
    const aList = await listSaved();
    assert.equal(aList.length, 1);
    assert.equal(aList[0].id, 'a-place');
  });

  it('listSaved resolves to [] (not the legacy list) when no account is resolvable', async () => {
    storage.store.set(BOOKMARKS_KEY, JSON.stringify([makePlace('legacy-place')]));
    _setTestAccountId(null);
    const list = await listSaved();
    assert.deepEqual(list, []);
  });

  it('removeSaved throws instead of writing when no account is resolvable (never falls back to the legacy key)', async () => {
    _setTestAccountId(null);
    await assert.rejects(
      () => removeSaved('some-id'),
      /no account is signed in/,
    );
  });

  it('migrates the legacy blob to the signed-in account on first access and deletes the legacy key', async () => {
    storage.store.set(BOOKMARKS_KEY, JSON.stringify([makePlace('legacy-place')]));

    _setTestAccountId('user-a');
    const migrated = await listSaved();

    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].id, 'legacy-place');
    assert.equal(storage.store.has(BOOKMARKS_KEY), false, 'legacy key must be deleted after migration');
  });

  it('migration is idempotent — a second access does not duplicate or re-migrate', async () => {
    storage.store.set(BOOKMARKS_KEY, JSON.stringify([makePlace('legacy-place')]));
    _setTestAccountId('user-a');
    await listSaved();
    await toggleSave(makePlace('new-place'));
    const all = await listSaved();
    assert.equal(all.length, 2);
  });
});

describe('discoveryBookmarks — flag OFF is byte-identical to legacy behavior', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
    _setTestToken(null);
    _setTestAccountScopedStorageFlag(false);
    _setTestAccountId(null); // even with no session, flag-off must ignore account resolution entirely
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
    _setTestToken(undefined);
  });

  it('reads and writes the legacy unscoped key regardless of account id / session state', async () => {
    await toggleSave(makePlace('place-1'));
    const raw = storage.store.get(BOOKMARKS_KEY);
    assert.ok(raw, 'legacy key must be written to even though _setTestAccountId(null) simulates no session');

    const list = await listSaved();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'place-1');
  });

  it('never creates a scoped key when the flag is off', async () => {
    await toggleSave(makePlace('place-1'));
    const raw = storage.store.get('discovery_bookmarks_scoped_v1:user-a');
    assert.equal(raw, undefined);
  });

  it('pre-existing legacy data is untouched (no migration attempt) — same key, same value, appended to in place', async () => {
    const preUpgrade = JSON.stringify([makePlace('pre-existing-place')]);
    storage.store.set(BOOKMARKS_KEY, preUpgrade);

    const list = await listSaved();
    assert.equal(list.length, 1, 'listSaved must return the pre-existing bookmark unchanged');
    assert.equal(list[0].id, 'pre-existing-place');

    await toggleSave(makePlace('newly-added-place'));

    assert.equal(storage.store.has('discovery_bookmarks_scoped_v1:user-a'), false, 'no scoped key may exist');
    const finalRaw = storage.store.get(BOOKMARKS_KEY);
    assert.ok(finalRaw, 'legacy key must still be the live key');
    const finalParsed = JSON.parse(finalRaw!);
    const original = finalParsed.find((p: { id: string }) => p.id === 'pre-existing-place');
    assert.deepEqual(original, JSON.parse(preUpgrade)[0], 'the pre-existing entry must be byte-identical to what was written before this ran');
  });
});
