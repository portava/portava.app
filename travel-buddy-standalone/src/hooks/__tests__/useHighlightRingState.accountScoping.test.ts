/**
 * Account-scoped storage tests for highlightViewedStorage.ts (the module
 * useHighlightRingState.ts delegates to) — read isolation between two
 * accounts, one-time legacy migration, account-switch re-sync of the
 * in-memory singleton, and the flag-OFF path staying byte-identical.
 *
 * markViewed()/viewedHighlightIds are module-level singletons (by design —
 * one set per app run), so every test resets them via the test seams before
 * asserting.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  markViewed,
  viewedHighlightIds,
  initViewedIds as _initViewedIdsForTest,
  _resetMigratedHighlightViewedAccountIds,
  _resetHighlightViewedStateForTest,
  _setTestStorage,
} from '../../services/highlightViewedStorage.ts';
import { _setTestAccountScopedStorageFlag } from '../../config/accountScopedStorageFlag.ts';
import { _setTestAccountId } from '../../services/accountId.ts';

const LEGACY_KEY = '@highlight_viewed_ids_v1';
const futureExpiry = new Date(Date.now() + 60_000).toISOString();

function scopedKey(accountId: string): string {
  return `@highlight_viewed_ids_scoped_v1:${accountId}`;
}

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

describe('useHighlightRingState viewed-ids — account-scoped storage (flag on)', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
    _resetHighlightViewedStateForTest();
    _resetMigratedHighlightViewedAccountIds();
    _setTestAccountScopedStorageFlag(true);
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
    _resetHighlightViewedStateForTest();
    _setTestStorage(null);
  });

  it('read isolation: account B does not inherit account A\'s viewed highlight', async () => {
    _setTestAccountId('user-a');
    await _initViewedIdsForTest();
    markViewed('highlight-1', futureExpiry);
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(viewedHighlightIds.has('highlight-1'));
    assert.ok((await storage.getItem(scopedKey('user-a')) ?? '').includes('highlight-1'));

    // Switch accounts — a fresh load must re-sync from the new account's own
    // key, not keep serving account A's in-memory set.
    _setTestAccountId('user-b');
    await _initViewedIdsForTest();
    assert.equal(viewedHighlightIds.has('highlight-1'), false);
    assert.equal(await storage.getItem(scopedKey('user-b')), null);
  });

  it('persists under the per-account scoped key, not the legacy key', async () => {
    _setTestAccountId('user-a');
    await _initViewedIdsForTest();
    markViewed('highlight-1', futureExpiry);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(storage.store.has(LEGACY_KEY), false, 'flag on must never write the legacy key');
  });

  it('resolves with no persistence when no account is resolvable', async () => {
    _setTestAccountId(null);
    await _initViewedIdsForTest();
    markViewed('highlight-1', futureExpiry);
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(viewedHighlightIds.has('highlight-1'), 'still tracked in-memory');
    assert.equal(storage.store.has(LEGACY_KEY), false);
    assert.equal(storage.store.size, 0, 'nothing persisted when no account is resolvable');
  });

  it('migrates the legacy viewed-ids map to the signed-in account and deletes the legacy key', async () => {
    storage.store.set(LEGACY_KEY, JSON.stringify({ 'highlight-9': futureExpiry }));
    _setTestAccountId('user-a');

    await _initViewedIdsForTest();

    assert.ok(viewedHighlightIds.has('highlight-9'), 'migrated entry loaded into memory');
    const scopedRaw = await storage.getItem(scopedKey('user-a'));
    assert.ok(scopedRaw && scopedRaw.includes('highlight-9'));
    assert.equal(storage.store.has(LEGACY_KEY), false, 'legacy key must be deleted after migration');
  });

  it('migration is idempotent — a second load does not re-read or clobber', async () => {
    storage.store.set(LEGACY_KEY, JSON.stringify({ 'highlight-9': futureExpiry }));
    _setTestAccountId('user-a');
    await _initViewedIdsForTest();

    // Simulate the account's own scoped data changing after migration.
    await storage.setItem(scopedKey('user-a'), JSON.stringify({ 'highlight-2': futureExpiry }));
    _resetHighlightViewedStateForTest();
    await _initViewedIdsForTest();

    assert.ok(viewedHighlightIds.has('highlight-2'));
    assert.equal(viewedHighlightIds.has('highlight-9'), false, 'must not re-migrate stale legacy data over the account\'s current data');
  });
});

describe('useHighlightRingState viewed-ids — flag OFF is byte-identical to legacy behavior', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
    _resetHighlightViewedStateForTest();
    _setTestAccountScopedStorageFlag(false);
    _setTestAccountId(null);
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
    _resetHighlightViewedStateForTest();
    _setTestStorage(null);
  });

  it('markViewed persists to the legacy key when the flag is off', async () => {
    await _initViewedIdsForTest();
    markViewed('highlight-1', futureExpiry);
    await new Promise((r) => setTimeout(r, 0));
    const raw = await storage.getItem(LEGACY_KEY);
    assert.ok(raw && raw.includes('highlight-1'));
  });

  it('never creates a scoped key when the flag is off', async () => {
    await _initViewedIdsForTest();
    markViewed('highlight-1', futureExpiry);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(storage.store.has(scopedKey('user-a')), false);
  });

  it('pre-existing legacy viewed-ids map is untouched (no migration attempt) — same key, same value, merged in place', async () => {
    const preUpgrade = { 'pre-existing-highlight': futureExpiry };
    storage.store.set(LEGACY_KEY, JSON.stringify(preUpgrade));

    await _initViewedIdsForTest();
    assert.ok(viewedHighlightIds.has('pre-existing-highlight'), 'must load the pre-existing entry unchanged');
    assert.equal(storage.store.has(scopedKey('user-a')), false, 'no scoped key may exist');

    markViewed('highlight-new', futureExpiry);
    await new Promise((r) => setTimeout(r, 0));

    const finalRaw = await storage.getItem(LEGACY_KEY);
    assert.ok(finalRaw, 'legacy key must still be the live key');
    const finalParsed = JSON.parse(finalRaw!);
    assert.equal(finalParsed['pre-existing-highlight'], preUpgrade['pre-existing-highlight'], 'the pre-existing entry must be byte-identical to what was there before this ran');
  });
});
