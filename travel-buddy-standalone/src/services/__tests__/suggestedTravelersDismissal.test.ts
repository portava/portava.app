/**
 * Account-scoped storage tests for suggestedTravelersDismissal.ts — read
 * isolation between two accounts, one-time legacy migration, and the
 * flag-OFF path staying byte-identical.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DISMISSED_STORAGE_KEY,
  scopedDismissedKey,
  resolveSuggestedTravelersDismissedKey,
  _resetMigratedSuggestedTravelersAccountIds,
} from '../suggestedTravelersDismissal.ts';
import { _setTestAccountScopedStorageFlag } from '../../config/accountScopedStorageFlag.ts';
import { _setTestAccountId } from '../accountId.ts';

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

describe('suggestedTravelersDismissal — account-scoped storage (flag on)', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestAccountScopedStorageFlag(true);
    _resetMigratedSuggestedTravelersAccountIds();
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
  });

  it('read isolation: account B never sees account A\'s dismissed list', async () => {
    _setTestAccountId('user-a');
    const keyA = await resolveSuggestedTravelersDismissedKey(storage);
    assert.ok(keyA);
    await storage.setItem(keyA!, JSON.stringify([{ id: 'traveler-1', dismissedAt: Date.now() }]));

    _setTestAccountId('user-b');
    const keyB = await resolveSuggestedTravelersDismissedKey(storage);
    assert.notEqual(keyA, keyB);
    assert.equal(await storage.getItem(keyB!), null);
  });

  it('resolves null (never the legacy key) when no account is resolvable', async () => {
    _setTestAccountId(null);
    const key = await resolveSuggestedTravelersDismissedKey(storage);
    assert.equal(key, null);
  });

  it('migrates the legacy dismissed list to the signed-in account and deletes the legacy key', async () => {
    const legacy = JSON.stringify([{ id: 'traveler-1', dismissedAt: Date.now() }]);
    storage.store.set(DISMISSED_STORAGE_KEY, legacy);
    _setTestAccountId('user-a');

    const key = await resolveSuggestedTravelersDismissedKey(storage);
    assert.equal(key, scopedDismissedKey('user-a'));
    assert.equal(await storage.getItem(key!), legacy);
    assert.equal(storage.store.has(DISMISSED_STORAGE_KEY), false, 'legacy key must be deleted after migration');
  });

  it('migration is idempotent — a second resolve does not re-read or clobber', async () => {
    storage.store.set(DISMISSED_STORAGE_KEY, JSON.stringify([{ id: 'traveler-1', dismissedAt: Date.now() }]));
    _setTestAccountId('user-a');
    await resolveSuggestedTravelersDismissedKey(storage);
    const scoped = scopedDismissedKey('user-a');
    await storage.setItem(scoped, JSON.stringify([{ id: 'traveler-2', dismissedAt: Date.now() }]));

    const key = await resolveSuggestedTravelersDismissedKey(storage);
    const raw = await storage.getItem(key!);
    assert.ok(raw && raw.includes('traveler-2'));
  });
});

describe('suggestedTravelersDismissal — flag OFF is byte-identical to legacy behavior', () => {
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
    const key = await resolveSuggestedTravelersDismissedKey(storage);
    assert.equal(key, DISMISSED_STORAGE_KEY);
  });

  it('never creates a scoped key when the flag is off', async () => {
    const key = await resolveSuggestedTravelersDismissedKey(storage);
    await storage.setItem(key!, JSON.stringify([]));
    assert.equal(storage.store.has(scopedDismissedKey('user-a')), false);
  });

  it('pre-existing legacy dismissed list is untouched (no migration attempt) — same key, same value', async () => {
    const preUpgrade = JSON.stringify([{ id: 'pre-existing', dismissedAt: 12345 }]);
    storage.store.set(DISMISSED_STORAGE_KEY, preUpgrade);

    const key = await resolveSuggestedTravelersDismissedKey(storage);
    assert.equal(key, DISMISSED_STORAGE_KEY);
    assert.equal(await storage.getItem(key!), preUpgrade, 'must read the pre-existing list byte-identical');
    assert.equal(storage.store.has(scopedDismissedKey('user-a')), false, 'no scoped key may exist');
  });
});
