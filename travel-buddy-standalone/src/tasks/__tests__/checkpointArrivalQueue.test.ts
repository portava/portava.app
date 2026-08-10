/**
 * Account-scoped storage tests for checkpointArrivalQueue.ts (the pure logic
 * behind checkpointArrivalTask.ts's background geofence queue) — read
 * isolation, migration, the background-task "defer, never guess, never fall
 * back to the legacy key" contract, and flag-OFF byte-identical behavior.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCheckpointQueueKey, PENDING_ARRIVALS_STORE_KEY, _resetMigratedAccountIds,
  type CheckpointStorageLike,
} from '../checkpointArrivalQueue.ts';
import { _setTestAccountScopedStorageFlag } from '../../config/accountScopedStorageFlag.ts';
import { _setTestAccountId } from '../../services/accountId.ts';

function fakeStorage(): CheckpointStorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => Promise.resolve(store.get(key) ?? null),
    setItem: (key, value) => { store.set(key, value); return Promise.resolve(); },
    removeItem: (key) => { store.delete(key); return Promise.resolve(); },
  };
}

describe('checkpointArrivalQueue — account-scoped storage (flag on)', () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestAccountScopedStorageFlag(true);
    _resetMigratedAccountIds();
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
  });

  it('defers (returns null) when no account is resolvable — geofence task must do nothing, not guess', async () => {
    _setTestAccountId(null);
    const key = await resolveCheckpointQueueKey(storage);
    assert.equal(key, null);
  });

  it('never falls back to the legacy key when no account is resolvable, even if the legacy key has data', async () => {
    await storage.setItem(PENDING_ARRIVALS_STORE_KEY, JSON.stringify(['stop-1']));
    _setTestAccountId(null);
    const key = await resolveCheckpointQueueKey(storage);
    assert.equal(key, null, 'must defer, not resolve to PENDING_ARRIVALS_STORE_KEY');
  });

  it('read isolation: resolves to distinct keys per account', async () => {
    _setTestAccountId('user-a');
    const keyA = await resolveCheckpointQueueKey(storage);
    _setTestAccountId('user-b');
    const keyB = await resolveCheckpointQueueKey(storage);
    assert.notEqual(keyA, keyB);
  });

  it('migrates a queued-but-undrained legacy arrival to the signed-in account and deletes the legacy key', async () => {
    await storage.setItem(PENDING_ARRIVALS_STORE_KEY, JSON.stringify(['stop-legacy']));
    _setTestAccountId('user-a');
    const key = await resolveCheckpointQueueKey(storage);
    assert.ok(key);
    const raw = await storage.getItem(key!);
    assert.deepEqual(JSON.parse(raw!), ['stop-legacy']);
    assert.equal(storage.store.has(PENDING_ARRIVALS_STORE_KEY), false);
  });

  it('migration is idempotent — resolving twice does not re-migrate or clobber newly queued data', async () => {
    await storage.setItem(PENDING_ARRIVALS_STORE_KEY, JSON.stringify(['stop-legacy']));
    _setTestAccountId('user-a');
    const key = await resolveCheckpointQueueKey(storage);
    await storage.setItem(key!, JSON.stringify(['stop-legacy', 'stop-new']));

    const key2 = await resolveCheckpointQueueKey(storage);
    assert.equal(key2, key);
    const raw = await storage.getItem(key2!);
    assert.deepEqual(JSON.parse(raw!), ['stop-legacy', 'stop-new']);
  });
});

describe('checkpointArrivalQueue — flag OFF is byte-identical to legacy behavior', () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestAccountScopedStorageFlag(false);
    _setTestAccountId(null); // even with no session, flag-off must ignore account resolution entirely
    _resetMigratedAccountIds();
  });

  afterEach(() => {
    _setTestAccountScopedStorageFlag(null);
    _setTestAccountId(undefined);
  });

  it('always resolves to the legacy unscoped key, regardless of account id / session state', async () => {
    const key = await resolveCheckpointQueueKey(storage);
    assert.equal(key, PENDING_ARRIVALS_STORE_KEY);
  });

  it('never touches or creates a scoped key when the flag is off', async () => {
    await resolveCheckpointQueueKey(storage);
    assert.equal(storage.store.has('@travel_buddy/pending_checkpoint_arrivals_scoped_v1:user-a'), false);
  });
});
