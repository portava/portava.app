/**
 * liveShareRecipient.test.ts — how the trusted contact's live-share screen
 * reads GET /api/safe-return/live-share/:shareId (TRUST-F10), and what the
 * sharer is told when the contact could not be notified.
 *
 * The server keeps three answers apart (routes/safeReturn.ts): 404 = the share
 * is over (expired / stopped / not found), 403 = not shared with you, 503 =
 * could not be read, try again. A worried contact must never be told a share
 * "has ended" because a read failed.
 *
 * Run: node --import tsx/esm --test src/lib/__tests__/liveShareRecipient.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRecipientResponse, liveShareNoticeCopy } from '../liveShareRecipient.ts';

const share = {
  shareId: 's1', status: 'active', sharingUserName: 'Ana', approximateArea: 'Lisbon, Portugal',
  expiresAt: '2026-10-01T19:00:00Z', secondsRemaining: 1800,
};

describe('classifyRecipientResponse', () => {
  it('200 with a share is the share', () => {
    const r = classifyRecipientResponse(200, { ok: true, share });
    assert.equal(r.kind, 'ok');
    assert.equal(r.kind === 'ok' && r.share.approximateArea, 'Lisbon, Portugal');
  });
  it('404 is ended, and carries the server reason', () => {
    const r = classifyRecipientResponse(404, { error: 'not_found', message: 'Live share has expired' });
    assert.equal(r.kind, 'ended');
    assert.match(r.kind === 'ended' ? r.message : '', /expired/);
  });
  it('403 is forbidden, not ended', () => {
    assert.equal(classifyRecipientResponse(403, { error: 'forbidden', message: 'x' }).kind, 'forbidden');
  });
  it('feature_disabled (sent as a 404) is disabled, not ended', () => {
    assert.equal(classifyRecipientResponse(404, { error: 'feature_disabled', message: 'x' }).kind, 'disabled');
  });
  it('503, 500, a network failure and a 200 without a share are all retryable errors — never ended', () => {
    for (const [status, body] of [
      [503, { error: 'degraded_unavailable', message: 'This live share could not be loaded. Please try again.', retryable: true }],
      [500, {}],
      [null, null],
      [200, { ok: true }],
      [200, null],
    ] as const) {
      const r = classifyRecipientResponse(status, body);
      assert.equal(r.kind, 'error', `${status}`);
    }
  });
});

describe('liveShareNoticeCopy — what the sharer is told', () => {
  it('nothing when the contact was notified, or when an older server did not say', () => {
    assert.equal(liveShareNoticeCopy({ recipientNotified: true }, 'Ana'), null);
    assert.equal(liveShareNoticeCopy({}, 'Ana'), null);
  });
  it('a contact not on Portava is named as such', () => {
    assert.match(liveShareNoticeCopy({ recipientNotified: false, recipientNoticeReason: 'recipient_not_on_portava' }, 'Ana') ?? '', /Ana isn't on Portava/);
  });
  it('every other reason says only that they were not notified — never why (a block is not disclosed)', () => {
    for (const reason of ['blocked', 'suppressed', 'notice_failed', undefined]) {
      const copy = liveShareNoticeCopy({ recipientNotified: false, recipientNoticeReason: reason }, 'Ana') ?? '';
      assert.match(copy, /Ana wasn't notified/);
      assert.doesNotMatch(copy, /block/i);
    }
  });
});
