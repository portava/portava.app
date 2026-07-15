/**
 * commentCountStore tests — node:test + node:assert only.
 * Verifies the emit / subscribe / snapshot behaviour of the store.
 * Run: node --import tsx/esm --test src/lib/commentCountStore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emitCommentCount,
  subscribeCommentCount,
  getCommentCountSnapshot,
} from './commentCountStore.ts';

// The store is a module-level singleton, so we need to drain listeners
// between tests to avoid cross-test interference.
// We do this by calling the returned unsubscribe from each subscription.

test('1. snapshot is empty before any emission', () => {
  const snap = getCommentCountSnapshot();
  assert.equal(snap.get('nonexistent-id'), undefined);
});

test('2. emitted count appears in snapshot', () => {
  emitCommentCount('post-aaa', 5);
  assert.equal(getCommentCountSnapshot().get('post-aaa'), 5);
});

test('3. emitting again overwrites the previous value', () => {
  emitCommentCount('post-bbb', 3);
  emitCommentCount('post-bbb', 7);
  assert.equal(getCommentCountSnapshot().get('post-bbb'), 7);
});

test('4. subscriber receives emissions in real time', () => {
  const received: Array<{ postId: string; count: number }> = [];
  const unsub = subscribeCommentCount((postId, count) => received.push({ postId, count }));

  emitCommentCount('post-ccc', 10);
  emitCommentCount('post-ccc', 11);

  assert.equal(received.length, 2);
  assert.equal(received[0].count, 10);
  assert.equal(received[1].count, 11);

  unsub();
});

test('5. unsubscribed listener receives no further notifications', () => {
  const received: number[] = [];
  const unsub = subscribeCommentCount((_id, count) => received.push(count));

  emitCommentCount('post-ddd', 1);
  unsub();
  emitCommentCount('post-ddd', 99);

  assert.equal(received.length, 1);
  assert.equal(received[0], 1);
});

test('6. multiple subscribers receive the same emission independently', () => {
  const a: number[] = [];
  const b: number[] = [];
  const unsubA = subscribeCommentCount((_id, c) => a.push(c));
  const unsubB = subscribeCommentCount((_id, c) => b.push(c));

  emitCommentCount('post-eee', 42);

  assert.deepEqual(a, [42]);
  assert.deepEqual(b, [42]);

  unsubA();
  unsubB();
});

test('7. snapshot is a ReadonlyMap — direct get works for any emitted post', () => {
  emitCommentCount('post-fff', 99);
  const snap = getCommentCountSnapshot();
  assert.equal(snap.get('post-fff'), 99);
  assert.equal(typeof snap.get, 'function');
});

test('8. zero is a valid count and is stored correctly', () => {
  emitCommentCount('post-ggg', 0);
  assert.equal(getCommentCountSnapshot().get('post-ggg'), 0);
});
