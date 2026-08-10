/**
 * Account-scoped storage tests for savedPlacesMapFilterStorage.ts's category
 * filter key — read isolation between two accounts, one-time legacy
 * migration, and the flag-OFF path staying byte-identical.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  categoryStorageKey,
  scopedCategoryStorageKey,
  resolveCategoryStorageKey,
  readRawCategoryFilter,
  saveCategoryFilter,
  _resetMigratedCategoryFilterPairs,
} from '../savedPlacesMapFilterStorage.ts';
import { _setTestAccountScopedStorageFlag } from '../../config/accountScopedStorageFlag.ts';
import { _setTestAccountId } from '../../services/accountId.ts';

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

describe('savedPlacesMapFilterStorage — account-scoped storage (flag on)', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestAccountScopedStorageFlag(true);
    _resetMigratedCategoryFilterPairs();
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
  });

  it('read isolation: account B never sees account A\'s category filter for the same listId', async () => {
    _setTestAccountId('user-a');
    const keyA = await resolveCategoryStorageKey(storage, 'global');
    assert.ok(keyA);
    saveCategoryFilter(storage, keyA!, 'Food');
    await Promise.resolve(); // let the fire-and-forget write land

    _setTestAccountId('user-b');
    const keyB = await resolveCategoryStorageKey(storage, 'global');
    assert.notEqual(keyA, keyB);
    const rawB = await readRawCategoryFilter(storage, keyB!);
    assert.equal(rawB, null);
  });

  it('resolves null (never the legacy key) when no account is resolvable', async () => {
    _setTestAccountId(null);
    const key = await resolveCategoryStorageKey(storage, 'global');
    assert.equal(key, null);
  });

  it('migrates the legacy per-list filter to the signed-in account and deletes the legacy key', async () => {
    storage.store.set(categoryStorageKey('global'), 'Food');
    _setTestAccountId('user-a');

    const key = await resolveCategoryStorageKey(storage, 'global');
    assert.equal(key, scopedCategoryStorageKey('global', 'user-a'));
    const raw = await readRawCategoryFilter(storage, key!);
    assert.equal(raw, 'Food');
    assert.equal(storage.store.has(categoryStorageKey('global')), false, 'legacy key must be deleted after migration');
  });

  it('migration is idempotent — a second resolve does not re-read or duplicate', async () => {
    storage.store.set(categoryStorageKey('global'), 'Food');
    _setTestAccountId('user-a');
    await resolveCategoryStorageKey(storage, 'global');
    saveCategoryFilter(storage, scopedCategoryStorageKey('global', 'user-a'), 'Museums');
    await Promise.resolve();

    const key = await resolveCategoryStorageKey(storage, 'global');
    const raw = await readRawCategoryFilter(storage, key!);
    assert.equal(raw, 'Museums');
  });
});

describe('savedPlacesMapFilterStorage — flag OFF is byte-identical to legacy behavior', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestAccountScopedStorageFlag(false);
    _setTestAccountId(null);
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
  });

  it('resolves the legacy unscoped key regardless of account/session state', async () => {
    const key = await resolveCategoryStorageKey(storage, 'global');
    assert.equal(key, categoryStorageKey('global'));
  });

  it('never creates a scoped key when the flag is off', async () => {
    const key = await resolveCategoryStorageKey(storage, 'global');
    saveCategoryFilter(storage, key!, 'Food');
    await Promise.resolve();
    assert.equal(storage.store.has(scopedCategoryStorageKey('global', 'user-a')), false);
  });
});
