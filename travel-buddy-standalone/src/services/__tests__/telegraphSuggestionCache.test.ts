/**
 * Account-scoped storage tests for telegraphSuggestionCache.ts (the pure
 * logic behind TelegraphSuggestionTray's per-thread suggestion cache) — read
 * isolation, migration, and flag-OFF byte-identical behavior.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTelegraphCacheKey, telegraphCacheKey, _resetMigratedThreadAccountPairs,
  type TelegraphCacheStorageLike,
} from '../telegraphSuggestionCache.ts';
import { _setTestAccountScopedStorageFlag } from '../../config/accountScopedStorageFlag.ts';
import { _setTestAccountId } from '../accountId.ts';

function fakeStorage(): TelegraphCacheStorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => Promise.resolve(store.get(key) ?? null),
    setItem: (key, value) => { store.set(key, value); return Promise.resolve(); },
    removeItem: (key) => { store.delete(key); return Promise.resolve(); },
  };
}

const THREAD = 'thread-123';

describe('telegraphSuggestionCache — account-scoped storage (flag on)', () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestAccountScopedStorageFlag(true);
    _resetMigratedThreadAccountPairs();
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
  });

  it('read isolation: resolves to distinct keys per account for the same thread', async () => {
    _setTestAccountId('user-a');
    const keyA = await resolveTelegraphCacheKey(storage, THREAD);
    _setTestAccountId('user-b');
    const keyB = await resolveTelegraphCacheKey(storage, THREAD);
    assert.notEqual(keyA, keyB);
  });

  it('resolves to null (cache miss) when no account is resolvable — never falls back to the legacy per-thread key', async () => {
    await storage.setItem(telegraphCacheKey(THREAD), JSON.stringify({ suggestions: [{ id: 's1' }], savedAt: Date.now() }));
    _setTestAccountId(null);
    const key = await resolveTelegraphCacheKey(storage, THREAD);
    assert.equal(key, null);
  });

  it('migrates the legacy per-thread cache to the signed-in account and deletes the legacy key', async () => {
    await storage.setItem(telegraphCacheKey(THREAD), JSON.stringify({ suggestions: [{ id: 's1' }], savedAt: Date.now() }));
    _setTestAccountId('user-a');
    const key = await resolveTelegraphCacheKey(storage, THREAD);
    assert.ok(key);
    const raw = await storage.getItem(key!);
    assert.ok(raw);
    assert.equal(storage.store.has(telegraphCacheKey(THREAD)), false);
  });

  it('migration is idempotent for the same (thread, account) pair', async () => {
    await storage.setItem(telegraphCacheKey(THREAD), JSON.stringify({ suggestions: [{ id: 's1' }], savedAt: Date.now() }));
    _setTestAccountId('user-a');
    const key1 = await resolveTelegraphCacheKey(storage, THREAD);
    await storage.setItem(key1!, JSON.stringify({ suggestions: [{ id: 's2' }], savedAt: Date.now() }));
    const key2 = await resolveTelegraphCacheKey(storage, THREAD);
    assert.equal(key1, key2);
    const raw = await storage.getItem(key2!);
    const parsed = JSON.parse(raw!);
    assert.equal(parsed.suggestions[0].id, 's2', 'must not be clobbered back to the legacy blob');
  });
});

describe('telegraphSuggestionCache — flag OFF is byte-identical to legacy behavior', () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestAccountScopedStorageFlag(false);
    _setTestAccountId(null);
    _resetMigratedThreadAccountPairs();
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
  });

  it('always resolves to the legacy per-thread key, regardless of account id / session state', async () => {
    const key = await resolveTelegraphCacheKey(storage, THREAD);
    assert.equal(key, telegraphCacheKey(THREAD));
  });

  it('never touches or creates a scoped key when the flag is off', async () => {
    await resolveTelegraphCacheKey(storage, THREAD);
    assert.equal(storage.store.has(`telegraph_suggestions_scoped_v1_${THREAD}_user-a`), false);
  });
});
