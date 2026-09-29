/**
 * meetupInvites.test.ts — invite-more and the meetup invites inbox (PLAT-F31).
 *
 * POST /api/meetups/:id/invites answers { invited, skipped, ineligible,
 * ageIneligible } (routes/meetups.ts); the organiser is told each outcome, so
 * a person who was not invited is never counted as invited.
 *
 * Run: node --import tsx/esm --test src/lib/__tests__/meetupInvites.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeInviteResult, inviteCandidateSource, canInviteMore, splitMeetupInbox,
} from '../meetupInvites.ts';

describe('summarizeInviteResult', () => {
  it('names every outcome the server reported', () => {
    assert.equal(
      summarizeInviteResult({ invited: ['a', 'b'], skipped: ['c'], ineligible: ['d'], ageIneligible: ['e'] }),
      "2 invited · 1 already invited · 1 can't be invited to this meetup · 1 outside the age limit",
    );
  });
  it('one invited, nothing else', () => {
    assert.equal(summarizeInviteResult({ invited: ['a'], skipped: [] }), '1 invited');
  });
  it('nobody invited is said, not hidden', () => {
    assert.equal(summarizeInviteResult({ invited: [], skipped: ['a'] }), 'Nobody new was invited · 1 already invited');
    assert.equal(summarizeInviteResult({ invited: [], skipped: [] }), 'Nobody new was invited');
  });
});

describe('inviteCandidateSource — the server only accepts in-scope invitees', () => {
  it('trip → trip members; circle → circle members; otherwise mutual friends', () => {
    assert.equal(inviteCandidateSource({ tripId: 't1', circleOwnerId: null }), 'trip');
    assert.equal(inviteCandidateSource({ tripId: null, circleOwnerId: 'c1' }), 'circle');
    assert.equal(inviteCandidateSource({ tripId: null, circleOwnerId: null }), 'friends');
  });
});

describe('canInviteMore', () => {
  it('only the creator, and not on a cancelled meetup', () => {
    assert.equal(canInviteMore({ isCreator: true, status: 'active' }), true);
    assert.equal(canInviteMore({ isCreator: true, status: 'confirmed' }), true);
    assert.equal(canInviteMore({ isCreator: true, status: 'cancelled' }), false);
    assert.equal(canInviteMore({ isCreator: false, status: 'active' }), false);
  });
});

describe('splitMeetupInbox', () => {
  it('pending invites and confirmed-time notices are separate lists', () => {
    const inv = (id: string, kind: 'invite' | 'confirmation') => ({ inviteId: id, kind }) as any;
    const r = splitMeetupInbox([inv('1', 'invite'), inv('2', 'confirmation'), inv('3', 'invite')]);
    assert.deepEqual(r.pending.map((i) => i.inviteId), ['1', '3']);
    assert.deepEqual(r.confirmations.map((i) => i.inviteId), ['2']);
  });
});
