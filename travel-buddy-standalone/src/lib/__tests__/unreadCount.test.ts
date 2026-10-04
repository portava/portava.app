/**
 * unreadCount — a count or flag the server could not read is never shown as
 * 0 or false (census-media §47). node:test + node:assert only.
 * Run: node --import tsx/esm --test src/lib/__tests__/unreadCount.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNREAD_COUNT_MARK,
  countText,
  countSublabel,
  unreadCountLabel,
  stepCount,
  isKnownTrue,
  isKnownFalse,
} from '../unreadCount.ts';

test('1. an unread count draws the mark, never "0" and never nothing', () => {
  assert.equal(countText(null), UNREAD_COUNT_MARK);
  assert.equal(countSublabel(null), UNREAD_COUNT_MARK);
  assert.notEqual(UNREAD_COUNT_MARK, '0');
  assert.notEqual(UNREAD_COUNT_MARK, '');
});

test('2. a measured 0 and an absent count draw nothing (unchanged)', () => {
  assert.equal(countText(0), null);
  assert.equal(countText(undefined), null);
  assert.equal(countSublabel(0), '');
  assert.equal(countSublabel(undefined), '');
});

test('3. a measured count draws its compact number', () => {
  assert.equal(countText(7), '7');
  assert.equal(countText(1200), '1.2K');
  assert.equal(countSublabel(18), '18');
});

test('4. an optimistic step over an unread count stays unread', () => {
  assert.equal(stepCount(null, true), null);
  assert.equal(stepCount(null, false), null);
  assert.equal(stepCount(4, true), 5);
  assert.equal(stepCount(4, false), 3);
  assert.equal(stepCount(0, false), 0);
});

test('5. the accessibility label says the count is unavailable', () => {
  assert.equal(unreadCountLabel('Comment'), 'Comment, count unavailable');
});

test('6. an unread flag is neither known-true nor known-false', () => {
  assert.equal(isKnownTrue(null), false);
  assert.equal(isKnownFalse(null), false);
  assert.equal(isKnownTrue(undefined), false);
  assert.equal(isKnownFalse(undefined), false);
  assert.equal(isKnownTrue(true), true);
  assert.equal(isKnownFalse(false), true);
});
