/**
 * locateFriendsTtl — the bounded choices the §12 UI offers.
 *
 * The one property that matters: no choice, and nothing the bound accepts, can
 * be a TTL the server would reject. §12 is "temporary and auto-expiring", and
 * the client's options must be a SUBSET of the server's `[1, 720]` window.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCATE_FRIENDS_TTL_MINUTES,
  LOCATE_FRIENDS_TTL_OPTIONS,
  MAX_SESSION_MINUTES,
  MIN_SESSION_MINUTES,
  isTtlWithinBound,
} from '../locateFriendsTtl.ts';
import { MAX_SESSION_MS } from '../locateFriends.ts';

describe('§12 · the TTL choices are bounded', () => {
  test('the ceiling is the server 12-hour cap, to the minute', () => {
    assert.equal(MAX_SESSION_MINUTES, 12 * 60);
    assert.equal(MAX_SESSION_MINUTES, Math.floor(MAX_SESSION_MS / 60_000));
    assert.ok(MIN_SESSION_MINUTES >= 1);
  });

  test('every offered option is an integer inside [MIN, MAX] — no option the server refuses', () => {
    assert.ok(LOCATE_FRIENDS_TTL_OPTIONS.length > 0);
    for (const opt of LOCATE_FRIENDS_TTL_OPTIONS) {
      assert.ok(Number.isInteger(opt.minutes), `${opt.label} not integer`);
      assert.ok(opt.minutes >= MIN_SESSION_MINUTES, `${opt.label} below floor`);
      assert.ok(opt.minutes <= MAX_SESSION_MINUTES, `${opt.label} above ceiling`);
      assert.ok(isTtlWithinBound(opt.minutes), `${opt.label} fails the bound`);
      assert.ok(opt.label.trim() !== '' && opt.accessibilityLabel.trim() !== '');
    }
  });

  test('the longest option reaches the ceiling — the UI can express the max', () => {
    const max = Math.max(...LOCATE_FRIENDS_TTL_OPTIONS.map((o) => o.minutes));
    assert.equal(max, MAX_SESSION_MINUTES);
  });

  test('the options are strictly increasing and unique', () => {
    const mins = LOCATE_FRIENDS_TTL_OPTIONS.map((o) => o.minutes);
    for (let i = 1; i < mins.length; i++) assert.ok(mins[i] > mins[i - 1], 'not increasing');
  });

  test('the default is itself a valid, offered choice', () => {
    assert.ok(isTtlWithinBound(DEFAULT_LOCATE_FRIENDS_TTL_MINUTES));
    assert.ok(LOCATE_FRIENDS_TTL_OPTIONS.some((o) => o.minutes === DEFAULT_LOCATE_FRIENDS_TTL_MINUTES));
  });

  test('the bound rejects everything the server would', () => {
    for (const bad of [0, -1, MAX_SESSION_MINUTES + 1, 720_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '120', null, undefined]) {
      assert.equal(isTtlWithinBound(bad as unknown), false, `accepted ${String(bad)}`);
    }
  });
});
