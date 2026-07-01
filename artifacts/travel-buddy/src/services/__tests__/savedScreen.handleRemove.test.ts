/**
 * Unit tests for the optimistic-remove + rollback helpers used in saved.tsx.
 *
 * Tests import the REAL utility functions from src/utils/optimisticRemove.ts
 * (not inline copies) so this suite validates the same code path that the
 * Saved screen uses in production.
 *
 * saved.tsx uses withOptimisticRemoveBool for handleDelete (deleteCollection
 * returns false on error, never throws).
 *
 * Screens that call removeSaved() use withOptimisticRemoveThrow because
 * removeSaved() throws on AsyncStorage failure, enabling callers to roll back
 * and show an error toast.
 *
 * Run via:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/savedScreen.handleRemove.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  withOptimisticRemoveBool,
  withOptimisticRemoveThrow,
} from '../../utils/optimisticRemove.ts';

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
