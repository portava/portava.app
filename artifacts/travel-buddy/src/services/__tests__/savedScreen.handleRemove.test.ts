/**
 * Unit tests for the optimistic-remove + rollback pattern used in saved.tsx.
 *
 * The Saved screen (app/saved.tsx) uses a two-phase delete:
 *   1. Remove the item from local state immediately (optimistic).
 *   2. Call the async delete operation.
 *   3. If it fails: restore the previous list and show an error toast.
 *
 * This file tests that contract in pure Node.js without RNTL.
 * Two flavours of the pattern are covered:
 *   - boolean-return   (deleteCollection → returns false on error, no throw)
 *   - throw-based      (removeSaved → throws on AsyncStorage error)
 *
 * Run via:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/savedScreen.handleRemove.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers ────────────────────────────────────────────────────────────────────

interface Item { id: string; name: string }

/**
 * Inline simulation of the boolean-return handleDelete from saved.tsx.
 *
 * saved.tsx handleDelete:
 *   const prev = collections;
 *   setCollections(cs => cs.filter(c => c.id !== col.id));
 *   const ok = await deleteCollection(col.id);
 *   if (!ok) { setCollections(prev); showError("Couldn't delete..."); }
 */
async function handleDeleteBoolean(
  target: Item,
  getItems: () => Item[],
  setItems: (items: Item[]) => void,
  deleteOp: (id: string) => Promise<boolean>,
  onError: (msg: string) => void,
): Promise<void> {
  const prev = getItems();
  setItems(prev.filter((c) => c.id !== target.id));
  const ok = await deleteOp(target.id);
  if (!ok) {
    setItems(prev);
    onError("Couldn't delete — please try again.");
  }
}

/**
 * Inline simulation of the throw-based handleRemove pattern (removeSaved).
 *
 * handleRemove pattern (older saved-places screen):
 *   const prev = [...places];
 *   setPlaces(ps => ps.filter(p => p.id !== id));
 *   try { await removeSaved(id); }
 *   catch { setPlaces(prev); showError("Couldn't remove..."); }
 */
async function handleDeleteThrow(
  target: Item,
  getItems: () => Item[],
  setItems: (items: Item[]) => void,
  deleteOp: (id: string) => Promise<void>,
  onError: (msg: string) => void,
): Promise<void> {
  const prev = getItems();
  setItems(prev.filter((c) => c.id !== target.id));
  try {
    await deleteOp(target.id);
  } catch {
    setItems(prev);
    onError("Couldn't remove — please try again.");
  }
}

function makeItems(...ids: string[]): Item[] {
  return ids.map((id) => ({ id, name: `Place ${id}` }));
}

// ── Boolean-return flavour (current saved.tsx handleDelete) ────────────────────

describe('saved screen — boolean-return delete: optimistic remove + rollback', () => {
  it('removes the item from the list when deletion succeeds', async () => {
    let items = makeItems('col-1', 'col-2', 'col-3');
    let error: string | null = null;

    await handleDeleteBoolean(
      { id: 'col-2', name: 'Place col-2' },
      () => items,
      (updated) => { items = updated; },
      async (_id) => true,
      (msg) => { error = msg; },
    );

    assert.deepEqual(items.map((i) => i.id), ['col-1', 'col-3']);
    assert.equal(error, null, 'no error should be set on success');
  });

  it('restores the original list when deletion returns false', async () => {
    let items = makeItems('col-1', 'col-2');
    let error: string | null = null;
    const snapshot = [...items];

    await handleDeleteBoolean(
      { id: 'col-1', name: 'Place col-1' },
      () => items,
      (updated) => { items = updated; },
      async (_id) => false,
      (msg) => { error = msg; },
    );

    assert.deepEqual(items, snapshot, 'list must be restored to original after rollback');
    assert.ok(error !== null, 'an error message must be set');
    assert.ok(error!.length > 0, 'error message must be non-empty');
  });

  it('sets an error message when deletion fails', async () => {
    let items = makeItems('col-1');
    let error: string | null = null;

    await handleDeleteBoolean(
      { id: 'col-1', name: 'Place col-1' },
      () => items,
      (updated) => { items = updated; },
      async (_id) => false,
      (msg) => { error = msg; },
    );

    assert.ok(error !== null && error.length > 0, 'error toast message must be set on failure');
  });

  it('item is removed from the list during the async operation (optimistic update is immediate)', async () => {
    let items = makeItems('col-1', 'col-2');
    let itemsDuringOp: Item[] = [];

    await handleDeleteBoolean(
      { id: 'col-1', name: 'Place col-1' },
      () => items,
      (updated) => { items = updated; },
      async (_id) => {
        itemsDuringOp = [...items];
        return true;
      },
      (_msg) => {},
    );

    assert.ok(
      !itemsDuringOp.some((i) => i.id === 'col-1'),
      'col-1 must already be gone from the list when the async delete call executes',
    );
    assert.equal(itemsDuringOp.length, 1, 'only col-2 should remain during the async call');
  });

  it('does not disturb other items when a single entry is rolled back', async () => {
    let items = makeItems('col-1', 'col-2', 'col-3');
    let error: string | null = null;

    await handleDeleteBoolean(
      { id: 'col-2', name: 'Place col-2' },
      () => items,
      (updated) => { items = updated; },
      async (_id) => false,
      (msg) => { error = msg; },
    );

    assert.deepEqual(
      items.map((i) => i.id),
      ['col-1', 'col-2', 'col-3'],
      'all three items must be present after rollback',
    );
    assert.ok(error !== null);
  });
});

// ── Throw-based flavour (removeSaved — throws on AsyncStorage error) ───────────

describe('saved screen — throw-based delete (removeSaved): optimistic remove + rollback', () => {
  it('removes the item when removeSaved resolves', async () => {
    let items = makeItems('place-1', 'place-2');
    let error: string | null = null;

    await handleDeleteThrow(
      { id: 'place-1', name: 'Place place-1' },
      () => items,
      (updated) => { items = updated; },
      async (_id) => { /* resolves cleanly */ },
      (msg) => { error = msg; },
    );

    assert.deepEqual(items.map((i) => i.id), ['place-2']);
    assert.equal(error, null, 'no error on success');
  });

  it('restores the list when removeSaved throws (storage error)', async () => {
    let items = makeItems('place-1', 'place-2');
    let error: string | null = null;
    const snapshot = [...items];

    await handleDeleteThrow(
      { id: 'place-1', name: 'Place place-1' },
      () => items,
      (updated) => { items = updated; },
      async (_id) => { throw new Error('disk full'); },
      (msg) => { error = msg; },
    );

    assert.deepEqual(items, snapshot, 'list must be restored after throw-based rollback');
    assert.ok(error !== null, 'error message must be set after throw');
  });

  it('does not propagate the error to the caller (catch swallows it)', async () => {
    let items = makeItems('place-1');

    await assert.doesNotReject(
      () =>
        handleDeleteThrow(
          { id: 'place-1', name: 'Place place-1' },
          () => items,
          (updated) => { items = updated; },
          async (_id) => { throw new Error('network timeout'); },
          (_msg) => {},
        ),
      'handleDeleteThrow must not rethrow the storage/network error to its caller',
    );
  });

  it('sets an error message when removeSaved throws a network error', async () => {
    let items = makeItems('place-1');
    let error: string | null = null;

    await handleDeleteThrow(
      { id: 'place-1', name: 'Place place-1' },
      () => items,
      (updated) => { items = updated; },
      async (_id) => { throw new Error('connection refused'); },
      (msg) => { error = msg; },
    );

    assert.ok(error !== null && error.length > 0, 'error toast must be set when removeSaved throws');
  });

  it('item disappears from the list before the async throw (optimistic update fires first)', async () => {
    let items = makeItems('place-1', 'place-2');
    let itemsDuringOp: Item[] = [];

    await handleDeleteThrow(
      { id: 'place-1', name: 'Place place-1' },
      () => items,
      (updated) => { items = updated; },
      async (_id) => {
        itemsDuringOp = [...items];
        throw new Error('storage error');
      },
      (_msg) => {},
    );

    assert.ok(
      !itemsDuringOp.some((i) => i.id === 'place-1'),
      'place-1 must already be absent from the list at the moment removeSaved throws',
    );
    assert.equal(itemsDuringOp.length, 1);
  });

  it('leaves a single-item list empty then fully restores it after rollback', async () => {
    let items = makeItems('place-1');
    let itemsDuringOp: Item[] = [];

    await handleDeleteThrow(
      { id: 'place-1', name: 'Place place-1' },
      () => items,
      (updated) => { items = updated; },
      async (_id) => {
        itemsDuringOp = [...items];
        throw new Error('disk full');
      },
      (_msg) => {},
    );

    assert.deepEqual(itemsDuringOp, [], 'list must be empty during the optimistic remove');
    assert.deepEqual(items.map((i) => i.id), ['place-1'], 'rollback must restore the single item');
  });
});
