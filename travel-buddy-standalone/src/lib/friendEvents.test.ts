/**
 * friendEvents — the cross-surface friendship-change signal.
 *
 * Surfaces like My Friends and the request inbox subscribe so an
 * auto-accepted friend request elsewhere refreshes them without a
 * manual pull-to-refresh.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  onFriendsChanged,
  emitFriendsChanged,
  _friendListenerCount,
} from './friendEvents.ts';

describe('friendEvents bus', () => {
  test('emit notifies all subscribers', () => {
    let a = 0;
    let b = 0;
    const offA = onFriendsChanged(() => { a += 1; });
    const offB = onFriendsChanged(() => { b += 1; });
    emitFriendsChanged();
    assert.equal(a, 1);
    assert.equal(b, 1);
    offA();
    offB();
  });

  test('unsubscribe stops further notifications', () => {
    let calls = 0;
    const off = onFriendsChanged(() => { calls += 1; });
    emitFriendsChanged();
    off();
    emitFriendsChanged();
    assert.equal(calls, 1);
    assert.equal(_friendListenerCount(), 0);
  });

  test('a throwing subscriber does not block the rest', () => {
    let after = 0;
    const offBad = onFriendsChanged(() => { throw new Error('boom'); });
    const offGood = onFriendsChanged(() => { after += 1; });
    emitFriendsChanged();
    assert.equal(after, 1);
    offBad();
    offGood();
  });

  test('unsubscribing during emit is safe', () => {
    let second = 0;
    const offFirst = onFriendsChanged(() => { offFirst(); });
    const offSecond = onFriendsChanged(() => { second += 1; });
    emitFriendsChanged();
    assert.equal(second, 1);
    offSecond();
    assert.equal(_friendListenerCount(), 0);
  });
});
