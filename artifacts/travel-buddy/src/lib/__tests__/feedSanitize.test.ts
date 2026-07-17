/**
 * Feed hygiene tests — guards the Pulse wall FlatList invariants:
 *   (a) keyExtractor always gets a non-empty unique string id,
 *   (b) duplicate posts are filtered before reaching the list,
 *   (c) newer posts found by a background refresh land in the pending buffer
 *       instead of replacing the currently displayed list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFeedRows, splitPendingPosts } from '../feedSanitize.ts';

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

test('sanitizeFeedRows drops rows with null/undefined/empty ids', () => {
  const rows = [
    row('a'),
    { id: '' },
    { id: null } as any,
    { id: undefined } as any,
    null,
    undefined,
    row('b'),
  ];
  const out = sanitizeFeedRows(rows as any);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
  // keyExtractor invariant: every surviving id is a non-empty string
  for (const r of out) {
    assert.equal(typeof r.id, 'string');
    assert.ok(r.id.length > 0);
    assert.ok(String(r.id).length > 0);
  }
});

test('sanitizeFeedRows de-duplicates by id, first occurrence wins', () => {
  const out = sanitizeFeedRows([
    row('a', { v: 1 }),
    row('b'),
    row('a', { v: 2 }),
    row('b'),
    row('c'),
  ]);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal((out[0] as any).v, 1); // first occurrence kept
});

test('splitPendingPosts buffers new posts as pending when a list is displayed', () => {
  const current = [row('p3'), row('p2'), row('p1')];
  const fetched = [row('p5'), row('p4'), row('p3'), row('p2')];
  const { pending, replace } = splitPendingPosts(current, fetched);
  assert.equal(replace, null); // current list is NOT replaced mid-scroll
  assert.deepEqual(pending.map((r) => r.id), ['p5', 'p4']);
});

test('splitPendingPosts replaces outright when nothing is displayed yet', () => {
  const { pending, replace } = splitPendingPosts([], [row('a'), row('a'), { id: '' } as any, row('b')]);
  assert.deepEqual(pending, []);
  assert.deepEqual(replace?.map((r) => r.id), ['a', 'b']); // sanitized too
});

test('splitPendingPosts returns empty pending when fetch has nothing new', () => {
  const current = [row('p2'), row('p1')];
  const { pending, replace } = splitPendingPosts(current, [row('p2'), row('p1')]);
  assert.equal(replace, null);
  assert.deepEqual(pending, []);
});
