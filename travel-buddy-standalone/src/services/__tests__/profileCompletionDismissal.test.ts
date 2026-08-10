/**
 * Account-scoped storage tests for profileCompletionDismissal.ts — read
 * isolation between two accounts, one-time legacy migration, and the
 * flag-OFF path staying byte-identical.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DISMISSED_STORAGE_KEY,
  scopedDismissedKey,
  resolveProfileCompletionDismissedKey,
  _resetMigratedProfileCompletionAccountIds,
} from '../profileCompletionDismissal.ts';
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

describe('profileCompletionDismissal — account-scoped storage (flag on)', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestAccountScopedStorageFlag(true);
    _resetMigratedProfileCompletionAccountIds();
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
  });

  it('read isolation: account B never sees account A\'s dismissal', async () => {
    _setTestAccountId('user-a');
    const keyA = await resolveProfileCompletionDismissedKey(storage);
    assert.ok(keyA);
    await storage.setItem(keyA!, '1');

    _setTestAccountId('user-b');
    const keyB = await resolveProfileCompletionDismissedKey(storage);
    assert.notEqual(keyA, keyB);
    assert.equal(await storage.getItem(keyB!), null);
  });

  it('resolves null (never the legacy key) when no account is resolvable', async () => {
    _setTestAccountId(null);
    const key = await resolveProfileCompletionDismissedKey(storage);
    assert.equal(key, null);
  });

  it('migrates the legacy dismissal to the signed-in account and deletes the legacy key', async () => {
    storage.store.set(DISMISSED_STORAGE_KEY, '1');
    _setTestAccountId('user-a');

    const key = await resolveProfileCompletionDismissedKey(storage);
    assert.equal(key, scopedDismissedKey('user-a'));
    assert.equal(await storage.getItem(key!), '1');
    assert.equal(storage.store.has(DISMISSED_STORAGE_KEY), false, 'legacy key must be deleted after migration');
  });

  it('migration is idempotent — a second resolve does not re-read or clobber', async () => {
    storage.store.set(DISMISSED_STORAGE_KEY, '1');
    _setTestAccountId('user-a');
    await resolveProfileCompletionDismissedKey(storage);
    await storage.removeItem(scopedDismissedKey('user-a'));

    const key = await resolveProfileCompletionDismissedKey(storage);
    // Second call must not re-read the (already deleted) legacy key.
    assert.equal(await storage.getItem(key!), null);
  });
});

describe('profileCompletionDismissal — flag OFF is byte-identical to legacy behavior', () => {
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
    const key = await resolveProfileCompletionDismissedKey(storage);
    assert.equal(key, DISMISSED_STORAGE_KEY);
  });

  it('never creates a scoped key when the flag is off', async () => {
    const key = await resolveProfileCompletionDismissedKey(storage);
    await storage.setItem(key!, '1');
    assert.equal(storage.store.has(scopedDismissedKey('user-a')), false);
  });

  it('pre-existing legacy dismissal is untouched (no migration attempt) — same key, same value', async () => {
    storage.store.set(DISMISSED_STORAGE_KEY, '1');

    const key = await resolveProfileCompletionDismissedKey(storage);
    assert.equal(key, DISMISSED_STORAGE_KEY);
    assert.equal(await storage.getItem(key!), '1', 'must read the pre-existing value byte-identical');
    assert.equal(storage.store.has(scopedDismissedKey('user-a')), false, 'no scoped key may exist');
  });
});
