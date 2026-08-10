/**
 * Account-scoped storage tests for milestoneCelebrationStorage.ts — read
 * isolation between two accounts (per level), one-time legacy migration, and
 * the flag-OFF path staying byte-identical.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  legacyMilestoneStorageKey,
  scopedMilestoneStorageKey,
  resolveMilestoneStorageKey,
  _resetMigratedMilestoneAccountLevelPairs,
} from '../milestoneCelebrationStorage.ts';
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

describe('milestoneCelebrationStorage — account-scoped storage (flag on)', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestAccountScopedStorageFlag(true);
    _resetMigratedMilestoneAccountLevelPairs();
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
  });

  it('read isolation: account B never sees account A\'s "seen" marker for the same level', async () => {
    _setTestAccountId('user-a');
    const keyA = await resolveMilestoneStorageKey(storage, 100);
    assert.ok(keyA);
    await storage.setItem(keyA!, 'true');

    _setTestAccountId('user-b');
    const keyB = await resolveMilestoneStorageKey(storage, 100);
    assert.notEqual(keyA, keyB);
    assert.equal(await storage.getItem(keyB!), null);
  });

  it('resolves null (never the legacy key) when no account is resolvable', async () => {
    _setTestAccountId(null);
    const key = await resolveMilestoneStorageKey(storage, 1000);
    assert.equal(key, null);
  });

  it('migrates the legacy per-level marker to the signed-in account and deletes the legacy key', async () => {
    storage.store.set(legacyMilestoneStorageKey(10000), 'true');
    _setTestAccountId('user-a');

    const key = await resolveMilestoneStorageKey(storage, 10000);
    assert.equal(key, scopedMilestoneStorageKey(10000, 'user-a'));
    assert.equal(await storage.getItem(key!), 'true');
    assert.equal(storage.store.has(legacyMilestoneStorageKey(10000)), false, 'legacy key must be deleted after migration');
  });

  it('migration is per-level — migrating 100 does not touch the 1000 legacy key', async () => {
    storage.store.set(legacyMilestoneStorageKey(100), 'true');
    storage.store.set(legacyMilestoneStorageKey(1000), 'true');
    _setTestAccountId('user-a');

    await resolveMilestoneStorageKey(storage, 100);
    assert.equal(storage.store.has(legacyMilestoneStorageKey(100)), false);
    assert.equal(storage.store.has(legacyMilestoneStorageKey(1000)), true);
  });

  it('migration is idempotent — a second resolve does not re-read or clobber', async () => {
    storage.store.set(legacyMilestoneStorageKey(100), 'true');
    _setTestAccountId('user-a');
    await resolveMilestoneStorageKey(storage, 100);
    await storage.removeItem(scopedMilestoneStorageKey(100, 'user-a'));

    const key = await resolveMilestoneStorageKey(storage, 100);
    assert.equal(await storage.getItem(key!), null);
  });
});

describe('milestoneCelebrationStorage — flag OFF is byte-identical to legacy behavior', () => {
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
    const key = await resolveMilestoneStorageKey(storage, 1000);
    assert.equal(key, legacyMilestoneStorageKey(1000));
  });

  it('never creates a scoped key when the flag is off', async () => {
    const key = await resolveMilestoneStorageKey(storage, 1000);
    await storage.setItem(key!, 'true');
    assert.equal(storage.store.has(scopedMilestoneStorageKey(1000, 'user-a')), false);
  });
});
