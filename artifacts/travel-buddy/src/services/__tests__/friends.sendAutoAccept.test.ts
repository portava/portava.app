/**
 * friends.sendAutoAccept.test.ts
 *
 * Unit tests for resolveSendFriendRequestOutcome — the pure decision applied
 * after a successful POST /users/:id/friend-request. The API auto-accepts when
 * the other user already had a pending incoming request to us, responding with
 * { status: "friends", autoAccepted: true }. The UI must jump straight to the
 * friends state instead of showing "Request Sent".
 *
 * Run:
 *   node --import tsx/esm --test src/services/__tests__/friends.sendAutoAccept.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSendFriendRequestOutcome } from '../friends.ts';

describe('resolveSendFriendRequestOutcome', () => {
  test('auto-accepted response → friends state, no requestId', () => {
    const out = resolveSendFriendRequestOutcome({ status: 'friends', autoAccepted: true });
    assert.equal(out.status, 'friends');
    assert.equal(out.requestId, undefined);
    assert.equal(out.autoAccepted, true);
  });

  test('status "friends" alone (autoAccepted flag missing) still resolves to friends', () => {
    const out = resolveSendFriendRequestOutcome({ status: 'friends' });
    assert.equal(out.status, 'friends');
    assert.equal(out.autoAccepted, true);
  });

  test('autoAccepted true alone (unexpected status) still resolves to friends', () => {
    const out = resolveSendFriendRequestOutcome({ status: 'pending', autoAccepted: true } as any);
    assert.equal(out.status, 'friends');
    assert.equal(out.autoAccepted, true);
  });

  test('normal pending response → outgoing_pending with requestId kept', () => {
    const out = resolveSendFriendRequestOutcome({ requestId: 'req-1', status: 'pending' });
    assert.equal(out.status, 'outgoing_pending');
    assert.equal(out.requestId, 'req-1');
    assert.equal(out.autoAccepted, false);
  });

  test('null/undefined data → outgoing_pending without requestId (defensive)', () => {
    for (const data of [null, undefined]) {
      const out = resolveSendFriendRequestOutcome(data);
      assert.equal(out.status, 'outgoing_pending');
      assert.equal(out.requestId, undefined);
      assert.equal(out.autoAccepted, false);
    }
  });

  test('autoAccepted false is not treated as friends', () => {
    const out = resolveSendFriendRequestOutcome({ requestId: 'req-2', status: 'pending', autoAccepted: false });
    assert.equal(out.status, 'outgoing_pending');
    assert.equal(out.requestId, 'req-2');
  });
});
