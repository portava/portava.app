/**
 * useSnapshotCache.test.ts
 *
 * Unit tests for the pure helpers extracted from `useSnapshotCache.ts`:
 *
 *   _buildKey       — namespaces storage keys per-user (snap:v1:<name>:<userId>)
 *   _loadSnapshot   — reads + parses an entry; computes isStale from TTL
 *   _saveSnapshot   — serialises + writes; silently skips when JSON > 128 KB
 *   _clearSnapshot  — removes the namespaced entry from storage
 *
 * Coverage (per task spec):
 *   1. Per-user key isolation — two different userIds never share a snapshot
 *   2. TTL expiry — isStale=true when savedAt is older than ttlMs
 *   3. 128 KB write cap — save is a no-op when JSON exceeds the limit
 *   4. clear() removes the AsyncStorage entry (removeItem called with the right key)
 *
 * Strategy:
 *   The React hook layer (useEffect, useState, useCallback) is not exercised
 *   here — those require a renderer.  The four helpers above contain all the
 *   cache-correctness logic and are tested directly with an in-memory
 *   StorageLike fake, so no AsyncStorage module is needed.
 *
 * Run (auto-discovered by scripts/run-node-tests.mjs):
 *   node --import tsx/esm --test src/hooks/__tests__/useSnapshotCache.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _buildKey,
  _loadSnapshot,
  _saveSnapshot,
  _clearSnapshot,
  type StorageLike,
} from '../snapshotCacheUtils.ts';

// ── Fake in-memory storage ────────────────────────────────────────────────────

class FakeStorage implements StorageLike {
  private store = new Map<string, string>();
  readonly calls: { method: string; key: string; value?: string }[] = [];

  async getItem(key: string): Promise<string | null> {
    this.calls.push({ method: 'getItem', key });
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.calls.push({ method: 'setItem', key, value });
    this.store.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.calls.push({ method: 'removeItem', key });
    this.store.delete(key);
  }

  /** Directly seed a raw JSON string without going through _saveSnapshot. */
  seed(key: string, raw: string): void {
    this.store.set(key, raw);
  }

  /** Check whether a key is currently stored. */
  has(key: string): boolean {
    return this.store.has(key);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEntry<T>(data: T, savedAt: number): string {
  return JSON.stringify({ data, savedAt });
}

const NOW = 1_000_000_000_000; // fixed reference timestamp (ms)
const TTL = 60 * 60 * 1000;   // 1 hour in ms — matches the hook default

// ═══════════════════════════════════════════════════════════════════════════════
// 1. _buildKey — per-user key isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('_buildKey — per-user key isolation', () => {
  it('produces the correct snap:v1:<name>:<userId> format', () => {
    assert.equal(_buildKey('feed', 'user-a'), 'snap:v1:feed:user-a');
  });

  it('two different userIds produce different keys for the same hook name', () => {
    const keyA = _buildKey('feed', 'user-a');
    const keyB = _buildKey('feed', 'user-b');
    assert.notEqual(keyA, keyB,
      'different userIds must never share the same storage key');
  });

  it('same userId with different hook names produces different keys', () => {
    const keyFeed    = _buildKey('feed',    'user-a');
    const keyPlans   = _buildKey('plans',   'user-a');
    assert.notEqual(keyFeed, keyPlans);
  });

  it('key embeds the userId verbatim so switching users changes the key', () => {
    const key1 = _buildKey('compass', 'uid-1111');
    const key2 = _buildKey('compass', 'uid-2222');
    assert.ok(key1.includes('uid-1111'));
    assert.ok(key2.includes('uid-2222'));
    assert.notEqual(key1, key2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. _loadSnapshot — TTL expiry
// ═══════════════════════════════════════════════════════════════════════════════

describe('_loadSnapshot — TTL expiry', () => {
  let storage: FakeStorage;

  beforeEach(() => { storage = new FakeStorage(); });

  it('returns the data when the entry is within TTL (isStale=false)', async () => {
    const key = _buildKey('feed', 'user-a');
    // savedAt = NOW (age = 0 → well within TTL)
    storage.seed(key, makeEntry({ items: [1, 2, 3] }, NOW));

    const result = await _loadSnapshot<{ items: number[] }>(storage, key, TTL, NOW);

    assert.ok(result !== null, 'should return an entry, not null');
    assert.deepEqual(result.data.items, [1, 2, 3]);
    assert.equal(result.isStale, false, 'age=0 → isStale must be false');
  });

  it('returns isStale=false when age is exactly 1 ms less than ttlMs', async () => {
    const key = _buildKey('feed', 'user-a');
    const savedAt = NOW - TTL + 1; // age = TTL - 1 ms
    storage.seed(key, makeEntry('payload', savedAt));

    const result = await _loadSnapshot<string>(storage, key, TTL, NOW);

    assert.ok(result !== null);
    assert.equal(result.isStale, false, 'age < ttlMs → isStale must be false');
  });

  it('returns isStale=true when savedAt is older than ttlMs', async () => {
    const key = _buildKey('feed', 'user-a');
    const savedAt = NOW - TTL - 1; // age = TTL + 1 ms → stale
    storage.seed(key, makeEntry({ staleData: true }, savedAt));

    const result = await _loadSnapshot<{ staleData: boolean }>(storage, key, TTL, NOW);

    assert.ok(result !== null, 'stale data must still be returned (stale-while-revalidate)');
    assert.equal(result.isStale, true, 'age > ttlMs → isStale must be true');
    assert.equal(result.data.staleData, true, 'the data payload must still be present');
  });

  it('returns isStale=true when entry is exactly 1 ms past TTL', async () => {
    const key = _buildKey('feed', 'user-a');
    const savedAt = NOW - TTL - 1;
    storage.seed(key, makeEntry('old', savedAt));

    const result = await _loadSnapshot<string>(storage, key, TTL, NOW);

    assert.ok(result !== null);
    assert.equal(result.isStale, true, 'boundary: age = ttlMs+1 → isStale must be true');
  });

  it('returns null when no entry exists for the key', async () => {
    const key = _buildKey('feed', 'user-a');
    const result = await _loadSnapshot<unknown>(storage, key, TTL, NOW);
    assert.equal(result, null, 'missing entry → must return null');
  });

  it('returns null when the stored JSON is corrupt', async () => {
    const key = _buildKey('feed', 'user-a');
    storage.seed(key, '{ not valid JSON >>>');

    const result = await _loadSnapshot<unknown>(storage, key, TTL, NOW);
    assert.equal(result, null, 'corrupt entry → must return null, not throw');
  });

  it('user-a and user-b with the same hook name load independent entries', async () => {
    const keyA = _buildKey('plans', 'user-a');
    const keyB = _buildKey('plans', 'user-b');
    storage.seed(keyA, makeEntry({ owner: 'a' }, NOW));
    storage.seed(keyB, makeEntry({ owner: 'b' }, NOW));

    const resultA = await _loadSnapshot<{ owner: string }>(storage, keyA, TTL, NOW);
    const resultB = await _loadSnapshot<{ owner: string }>(storage, keyB, TTL, NOW);

    assert.ok(resultA !== null && resultB !== null);
    assert.equal(resultA.data.owner, 'a', 'user-a must get their own snapshot');
    assert.equal(resultB.data.owner, 'b', 'user-b must get their own snapshot');
  });

  it('loading user-a key returns null when only user-b key is stored', async () => {
    const keyA = _buildKey('feed', 'user-a');
    const keyB = _buildKey('feed', 'user-b');
    storage.seed(keyB, makeEntry({ secret: 'b-data' }, NOW));

    const result = await _loadSnapshot<unknown>(storage, keyA, TTL, NOW);
    assert.equal(result, null,
      'user-a must not see user-b\'s snapshot — key isolation must hold');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. _saveSnapshot — 128 KB write cap
// ═══════════════════════════════════════════════════════════════════════════════

describe('_saveSnapshot — 128 KB write cap', () => {
  let storage: FakeStorage;

  beforeEach(() => { storage = new FakeStorage(); });

  it('writes to storage when data is well within the 128 KB limit', async () => {
    _saveSnapshot(storage, 'feed', 'user-a', { small: true }, NOW);

    // setItem is fire-and-forget; give the promise a tick to settle
    await new Promise((r) => setImmediate(r));

    const setItemCalls = storage.calls.filter((c) => c.method === 'setItem');
    assert.equal(setItemCalls.length, 1, 'setItem must be called once for small data');
    assert.ok(setItemCalls[0].key.includes('user-a'));
  });

  it('does NOT call setItem when JSON exceeds the 128 KB limit', async () => {
    const MAX_BYTES = 128 * 1024;
    // Build a string just over 128 KB (the JSON wrapper adds ~20 bytes)
    const bigData = 'x'.repeat(MAX_BYTES + 100);
    _saveSnapshot(storage, 'feed', 'user-a', bigData, NOW);

    await new Promise((r) => setImmediate(r));

    const setItemCalls = storage.calls.filter((c) => c.method === 'setItem');
    assert.equal(setItemCalls.length, 0,
      'setItem must NOT be called when JSON length exceeds 128 KB');
  });

  it('does NOT call setItem when JSON is exactly at the limit + 1 byte', async () => {
    const MAX_BYTES = 128 * 1024;
    // {"data":"x...","savedAt":1000000000000} — overhead ~25 bytes
    const overhead = `{"data":"","savedAt":${NOW}}`.length;
    const paddedData = 'x'.repeat(MAX_BYTES - overhead + 1); // total = MAX_BYTES + 1
    _saveSnapshot(storage, 'feed', 'user-a', paddedData, NOW);

    await new Promise((r) => setImmediate(r));

    const setItemCalls = storage.calls.filter((c) => c.method === 'setItem');
    assert.equal(setItemCalls.length, 0,
      'setItem must be skipped when JSON is 1 byte over the limit');
  });

  it('writes data under a key namespaced to the given userId', async () => {
    _saveSnapshot(storage, 'compass', 'uid-xyz', { result: 42 }, NOW);
    await new Promise((r) => setImmediate(r));

    const setItemCalls = storage.calls.filter((c) => c.method === 'setItem');
    assert.equal(setItemCalls.length, 1);
    assert.equal(setItemCalls[0].key, 'snap:v1:compass:uid-xyz',
      'save must use the namespaced key that encodes both hook name and userId');
  });

  it('saves for user-a and user-b under separate keys — no cross-contamination', async () => {
    _saveSnapshot(storage, 'feed', 'user-a', { owner: 'a' }, NOW);
    _saveSnapshot(storage, 'feed', 'user-b', { owner: 'b' }, NOW);
    await new Promise((r) => setImmediate(r));

    const setItemCalls = storage.calls.filter((c) => c.method === 'setItem');
    assert.equal(setItemCalls.length, 2);
    const keys = setItemCalls.map((c) => c.key);
    assert.ok(keys.includes('snap:v1:feed:user-a'));
    assert.ok(keys.includes('snap:v1:feed:user-b'));
    assert.notEqual(keys[0], keys[1], 'each user must get their own storage key');
  });

  it('round-trips: saved data is retrievable via _loadSnapshot', async () => {
    const payload = { items: ['a', 'b', 'c'], count: 3 };
    _saveSnapshot(storage, 'feed', 'user-a', payload, NOW);
    await new Promise((r) => setImmediate(r));

    const key = _buildKey('feed', 'user-a');
    const result = await _loadSnapshot<typeof payload>(storage, key, TTL, NOW);

    assert.ok(result !== null);
    assert.deepEqual(result.data, payload);
    assert.equal(result.isStale, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. _clearSnapshot — removes the AsyncStorage entry
// ═══════════════════════════════════════════════════════════════════════════════

describe('_clearSnapshot — removes the storage entry', () => {
  let storage: FakeStorage;

  beforeEach(() => { storage = new FakeStorage(); });

  it('calls removeItem with the correct namespaced key', async () => {
    _clearSnapshot(storage, 'feed', 'user-a');
    await new Promise((r) => setImmediate(r));

    const removeCalls = storage.calls.filter((c) => c.method === 'removeItem');
    assert.equal(removeCalls.length, 1, 'removeItem must be called exactly once');
    assert.equal(removeCalls[0].key, 'snap:v1:feed:user-a',
      'removeItem key must be the namespaced snap:v1 key');
  });

  it('entry is absent from storage after clear', async () => {
    const key = _buildKey('feed', 'user-a');
    storage.seed(key, makeEntry({ items: [] }, NOW));
    assert.ok(storage.has(key), 'pre-condition: entry must exist before clear');

    _clearSnapshot(storage, 'feed', 'user-a');
    await new Promise((r) => setImmediate(r));

    assert.equal(storage.has(key), false, 'entry must be removed after clear');
  });

  it('subsequent _loadSnapshot returns null after clear', async () => {
    const key = _buildKey('plans', 'user-a');
    storage.seed(key, makeEntry({ plan: 'Bali' }, NOW));

    _clearSnapshot(storage, 'plans', 'user-a');
    await new Promise((r) => setImmediate(r));

    const result = await _loadSnapshot<unknown>(storage, key, TTL, NOW);
    assert.equal(result, null, '_loadSnapshot must return null after the entry is cleared');
  });

  it('only removes the entry for the specified userId — other users unaffected', async () => {
    const keyA = _buildKey('feed', 'user-a');
    const keyB = _buildKey('feed', 'user-b');
    storage.seed(keyA, makeEntry({ owner: 'a' }, NOW));
    storage.seed(keyB, makeEntry({ owner: 'b' }, NOW));

    _clearSnapshot(storage, 'feed', 'user-a');
    await new Promise((r) => setImmediate(r));

    assert.equal(storage.has(keyA), false, 'user-a entry must be removed');
    assert.equal(storage.has(keyB), true,  'user-b entry must remain untouched');
  });

  it('clear for user-a uses user-a\'s key — not user-b\'s key', async () => {
    _clearSnapshot(storage, 'feed', 'user-a');
    await new Promise((r) => setImmediate(r));

    const removeCalls = storage.calls.filter((c) => c.method === 'removeItem');
    const removedKey = removeCalls[0]?.key ?? '';
    assert.ok(removedKey.includes('user-a'),
      'clear must target the correct userId in the storage key');
    assert.ok(!removedKey.includes('user-b'),
      'clear must never touch another user\'s key');
  });

  it('is a no-op (does not throw) when no entry exists for the key', async () => {
    await assert.doesNotReject(async () => {
      _clearSnapshot(storage, 'nonexistent', 'user-a');
      await new Promise((r) => setImmediate(r));
    }, 'clear on a missing entry must not throw');
  });
});
