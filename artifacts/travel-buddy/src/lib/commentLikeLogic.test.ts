/**
 * commentLikeLogic tests — node:test + node:assert only.
 * Verifies the optimistic like/unlike state computation.
 * Run: node --import tsx/esm --test src/lib/commentLikeLogic.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOptimisticLike } from './commentLikeLogic.ts';

test('1. liking an unliked comment increments count and sets likedByMe=true', () => {
  const result = computeOptimisticLike(false, 4);
  assert.equal(result.likedByMe, true);
  assert.equal(result.likeCount, 5);
});

test('2. unliking a liked comment decrements count and sets likedByMe=false', () => {
  const result = computeOptimisticLike(true, 5);
  assert.equal(result.likedByMe, false);
  assert.equal(result.likeCount, 4);
});

test('3. liking when count is 0 produces count=1', () => {
  const result = computeOptimisticLike(false, 0);
  assert.equal(result.likedByMe, true);
  assert.equal(result.likeCount, 1);
});

test('4. unliking when count is 1 produces count=0 (not negative)', () => {
  const result = computeOptimisticLike(true, 1);
  assert.equal(result.likedByMe, false);
  assert.equal(result.likeCount, 0);
});

test('5. unliking when count is already 0 clamps to 0 (defensive floor)', () => {
  const result = computeOptimisticLike(true, 0);
  assert.equal(result.likedByMe, false);
  assert.equal(result.likeCount, 0);
});

test('6. liking when count is large increments correctly', () => {
  const result = computeOptimisticLike(false, 9999);
  assert.equal(result.likedByMe, true);
  assert.equal(result.likeCount, 10000);
});

test('7. double like toggle is idempotent round-trip', () => {
  const after1 = computeOptimisticLike(false, 10);
  const after2 = computeOptimisticLike(after1.likedByMe, after1.likeCount);
  assert.equal(after2.likedByMe, false);
  assert.equal(after2.likeCount, 10);
});

test('8. result object has exactly the two expected keys', () => {
  const result = computeOptimisticLike(false, 3);
  assert.deepEqual(Object.keys(result).sort(), ['likeCount', 'likedByMe']);
});
