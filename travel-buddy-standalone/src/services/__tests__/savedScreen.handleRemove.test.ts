/**
 * Unit tests for the optimistic-remove + rollback helpers and the storage-level
 * removeSavedFromList function used by the Saved Places remove path.
 *
 * Part 1 — withOptimisticRemoveBool / withOptimisticRemoveThrow:
 *   Tests import the REAL utility functions from src/utils/optimisticRemove.ts.
 *   saved.tsx uses withOptimisticRemoveBool for handleDelete (deleteCollection
 *   returns false on error, never throws).
 *
 * Part 2 — removeSavedFromList (storage layer):
 *   Direct tests of the function used by useTripSavedPlaces.remove().
 *   removeSavedFromList reads/writes directly (bypassing silent-catch helpers)
 *   so any AsyncStorage failure propagates to the caller, enabling optimistic
 *   rollback and error toasts in the UI.
 *
 * Run via:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/savedScreen.handleRemove.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  withOptimisticRemoveBool,
  withOptimisticRemoveThrow,
} from '../../utils/optimisticRemove.ts';
import {
  removeSavedFromList,
  _setTestStorage,
  _setTestToken,
} from '../discoveryBookmarks.ts';

// ── Storage seam helpers ──────────────────────────────────────────────────────

const BOOKMARKS_KEY = 'discovery_bookmarks_v1';

interface FakeStorage {
  store: Map<string, string>;
  removedKeys: string[];
  failOnWrite: boolean;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const store = new Map<string, string>(Object.entries(initial));
  const removedKeys: string[] = [];
  const fs: FakeStorage = {
    store,
    removedKeys,
    failOnWrite: false,
    getItem: (key) => Promise.resolve(store.get(key) ?? null),
    setItem: (key, value) => {
      if (fs.failOnWrite) return Promise.reject(new Error('ENOSPC'));
      store.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      store.delete(key);
      removedKeys.push(key);
      return Promise.resolve();
    },
  };
  return fs;
}

function makeBookmark(id: string, listId = 'trip-1') {
  return { id, name: 'Test', category: 'food', type: null, address: null, savedAt: 1000, listId };
}

function serialise(...bookmarks: ReturnType<typeof makeBookmark>[]): string {
  return JSON.stringify(bookmarks);
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

interface Item { id: string; name: string }

function makeItems(...ids: string[]): Item[] {
  return ids.map((id) => ({ id, name: `Place ${id}` }));
}

const byId = (item: Item, target: Item) => item.id === target.id;

// ── withOptimisticRemoveBool — saved.tsx handleDelete pattern ─────────────────

describe('withOptimisticRemoveBool — optimistic remove + rollback (boolean return)', () => {
  it('removes the target item when deleteOp returns true', async () => {
    let items = makeItems('col-1', 'col-2', 'col-3');
    let error: string | null = null;

    await withOptimisticRemoveBool({
      target: { id: 'col-2', name: 'Place col-2' },
      getItems: () => items,
      setItems: (updated) => { items = updated; },
      match: byId,
      deleteOp: async (_t) => true,
      onError: (msg) => { error = msg; },
    });

    assert.deepEqual(items.map((i) => i.id), ['col-1', 'col-3']);
    assert.equal(error, null, 'no error should be set on success');
  });

  it('restores the full original list when deleteOp returns false', async () => {
    let items = makeItems('col-1', 'col-2');
    let error: string | null = null;
    const original = [...items];

    await withOptimisticRemoveBool({
      target: { id: 'col-1', name: 'Place col-1' },
      getItems: () => items,
      setItems: (updated) => { items = updated; },
      match: byId,
      deleteOp: async (_t) => false,
      onError: (msg) => { error = msg; },
    });

    assert.deepEqual(items, original, 'list must be fully restored after failed delete');
    assert.ok(error !== null, 'error message must be set');
    assert.ok(error!.length > 0, 'error message must be non-empty');
  });

  it('calls onError with the default message when deleteOp returns false', async () => {
    let items = makeItems('col-1');
    let error: string | null = null;

    await withOptimisticRemoveBool({
      target: { id: 'col-1', name: 'Place col-1' },
      getItems: () => items,
      setItems: (updated) => { items = updated; },
      match: byId,
      deleteOp: async (_t) => false,
      onError: (msg) => { error = msg; },
    });

    assert.ok(error !== null && error.length > 0, 'error toast message must be set on failure');
  });

  it('calls onError with a custom errorMessage when provided', async () => {
    let items = makeItems('col-1');
    let error: string | null = null;

    await withOptimisticRemoveBool({
      target: { id: 'col-1', name: 'Place col-1' },
      getItems: () => items,
      setItems: (updated) => { items = updated; },
      match: byId,
      deleteOp: async (_t) => false,
      onError: (msg) => { error = msg; },
      errorMessage: 'Custom error message',
    });

    assert.equal(error, 'Custom error message');
  });

  it('item is absent from the list during the async deleteOp call (optimistic update fires first)', async () => {
    let items = makeItems('col-1', 'col-2');
    let itemsDuringOp: Item[] = [];

    await withOptimisticRemoveBool({
      target: { id: 'col-1', name: 'Place col-1' },
      getItems: () => items,
      setItems: (updated) => { items = updated; },
      match: byId,
      deleteOp: async (_t) => {
        itemsDuringOp = [...items];
        return true;
      },
      onError: (_msg) => {},
    });

    assert.ok(
      !itemsDuringOp.some((i) => i.id === 'col-1'),
      'col-1 must already be gone from the list at the moment deleteOp executes',
    );
    assert.equal(itemsDuringOp.length, 1, 'only col-2 should remain during the async call');
  });

  it('leaves all other items intact when rollback fires', async () => {
    let items = makeItems('col-1', 'col-2', 'col-3');

    await withOptimisticRemoveBool({
      target: { id: 'col-2', name: 'Place col-2' },
      getItems: () => items,
      setItems: (updated) => { items = updated; },
      match: byId,
      deleteOp: async (_t) => false,
      onError: (_msg) => {},
    });

    assert.deepEqual(
      items.map((i) => i.id),
      ['col-1', 'col-2', 'col-3'],
      'all three items must be present after rollback',
    );
  });
});

// ── withOptimisticRemoveThrow — removeSaved throw-based pattern ────────────────

describe('withOptimisticRemoveThrow — optimistic remove + rollback (throw on error)', () => {
  it('removes the target item when deleteOp resolves', async () => {
    let items = makeItems('place-1', 'place-2');
    let error: string | null = null;

    await withOptimisticRemoveThrow({
      target: { id: 'place-1', name: 'Place place-1' },
      getItems: () => items,
      setItems: (updated) => { items = updated; },
      match: byId,
      deleteOp: async (_t) => { /* resolves cleanly */ },
      onError: (msg) => { error = msg; },
    });

    assert.deepEqual(items.map((i) => i.id), ['place-2']);
    assert.equal(error, null, 'no error on success');
  });

  it('restores the list when deleteOp throws (simulates removeSaved storage error)', async () => {
    let items = makeItems('place-1', 'place-2');
    let error: string | null = null;
    const snapshot = [...items];

    await withOptimisticRemoveThrow({
      target: { id: 'place-1', name: 'Place place-1' },
      getItems: () => items,
      setItems: (updated) => { items = updated; },
      match: byId,
      deleteOp: async (_t) => { throw new Error('disk full'); },
      onError: (msg) => { error = msg; },
    });

    assert.deepEqual(items, snapshot, 'list must be restored after throw-based rollback');
    assert.ok(error !== null, 'error message must be set after throw');
  });

  it('does not propagate the throw to the caller', async () => {
    let items = makeItems('place-1');

    await assert.doesNotReject(
      () =>
        withOptimisticRemoveThrow({
          target: { id: 'place-1', name: 'Place place-1' },
          getItems: () => items,
          setItems: (updated) => { items = updated; },
          match: byId,
          deleteOp: async (_t) => { throw new Error('network timeout'); },
          onError: (_msg) => {},
        }),
      'withOptimisticRemoveThrow must not rethrow the error to its caller',
    );
  });

  it('calls onError when deleteOp throws a network error', async () => {
    let items = makeItems('place-1');
    let error: string | null = null;

    await withOptimisticRemoveThrow({
      target: { id: 'place-1', name: 'Place place-1' },
      getItems: () => items,
      setItems: (updated) => { items = updated; },
      match: byId,
      deleteOp: async (_t) => { throw new Error('connection refused'); },
      onError: (msg) => { error = msg; },
    });

    assert.ok(error !== null && error.length > 0, 'error toast must be set when deleteOp throws');
  });

  it('item is absent from the list at the moment deleteOp throws (optimistic update fires first)', async () => {
    let items = makeItems('place-1', 'place-2');
    let itemsDuringOp: Item[] = [];

    await withOptimisticRemoveThrow({
      target: { id: 'place-1', name: 'Place place-1' },
      getItems: () => items,
      setItems: (updated) => { items = updated; },
      match: byId,
      deleteOp: async (_t) => {
        itemsDuringOp = [...items];
        throw new Error('storage error');
      },
      onError: (_msg) => {},
    });

    assert.ok(
      !itemsDuringOp.some((i) => i.id === 'place-1'),
      'place-1 must already be absent from the list at the moment deleteOp throws',
    );
    assert.equal(itemsDuringOp.length, 1, 'only place-2 should remain during the optimistic remove');
    assert.deepEqual(
      items.map((i) => i.id),
      ['place-1', 'place-2'],
      'rollback must restore the original two-item list',
    );
  });

  it('leaves a single-item list empty then fully restores it after rollback', async () => {
    let items = makeItems('place-1');
    let itemsDuringOp: Item[] = [];

    await withOptimisticRemoveThrow({
      target: { id: 'place-1', name: 'Place place-1' },
      getItems: () => items,
      setItems: (updated) => { items = updated; },
      match: byId,
      deleteOp: async (_t) => {
        itemsDuringOp = [...items];
        throw new Error('disk full');
      },
      onError: (_msg) => {},
    });

    assert.deepEqual(itemsDuringOp, [], 'list must be empty during the optimistic remove');
    assert.deepEqual(items.map((i) => i.id), ['place-1'], 'rollback must restore the single item');
  });
});

// ── removeSavedFromList — storage layer (used by useTripSavedPlaces.remove) ───
//
// These tests exercise the real removeSavedFromList function with a fake storage
// injected via _setTestStorage().  They verify:
//   1. List-scoped deletion — only the (id, listId) pair is removed; the same
//      place saved under a different listId is untouched.
//   2. Error propagation — AsyncStorage write failures are NOT swallowed
//      (unlike toggleSave/writeAll which catch and ignore them).  This is what
//      makes the optimistic rollback in useTripSavedPlaces.remove() triggerable
//      in production.

describe('removeSavedFromList — storage layer', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = fakeStorage();
    _setTestStorage(storage);
    _setTestToken(null); // no Supabase sync in tests
  });

  afterEach(() => {
    _setTestStorage(fakeStorage()); // reset to a clean empty storage
    _setTestToken(undefined);
  });

  it('removes only the (id, listId) pair and leaves other entries intact', async () => {
    const p1trip1 = makeBookmark('p1', 'trip-1');
    const p1trip2 = makeBookmark('p1', 'trip-2'); // same id, different list
    const p2trip1 = makeBookmark('p2', 'trip-1');
    storage.store.set(BOOKMARKS_KEY, serialise(p1trip1, p1trip2, p2trip1));

    await removeSavedFromList('p1', 'trip-1');

    const remaining = JSON.parse(storage.store.get(BOOKMARKS_KEY)!) as typeof p1trip1[];
    const ids = remaining.map((b) => `${b.id}:${b.listId}`);
    assert.deepEqual(ids, ['p1:trip-2', 'p2:trip-1'],
      'only the trip-1 entry for p1 should be removed');
  });

  it('removes the target when it is the only entry, leaving an empty list', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise(makeBookmark('p1', 'trip-1')));

    await removeSavedFromList('p1', 'trip-1');

    const remaining = JSON.parse(storage.store.get(BOOKMARKS_KEY)!) as unknown[];
    assert.equal(remaining.length, 0, 'storage must contain an empty array');
  });

  it('propagates AsyncStorage write errors so callers can trigger rollback', async () => {
    storage.store.set(BOOKMARKS_KEY, serialise(makeBookmark('p1', 'trip-1')));
    storage.failOnWrite = true;

    await assert.rejects(
      () => removeSavedFromList('p1', 'trip-1'),
      /ENOSPC/,
      'write error must propagate — callers rely on this to roll back optimistic UI',
    );
  });

  it('resolves cleanly when the key does not exist in storage (empty list is a no-op)', async () => {
    await assert.doesNotReject(
      () => removeSavedFromList('missing', 'trip-1'),
      'removing from an empty list must not throw',
    );
  });
});
