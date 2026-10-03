/**
 * Telegraph §7.1–§7.3 / §30A.15 — the statuses one of the caller's own messages
 * may carry, and the words for them (`lifecycle/readState.ts`).
 *
 * §30A.15: "distinguish local unsent, server accepted, recipient offline,
 * receipt unavailable". What this file pins:
 *
 *   1. A FAILED receipts read is its own state — never "Sent", which is a claim
 *      that nobody has read the message. But a receipt already read as SEEN
 *      stays SEEN through a later failure: the read marker only moves forward.
 *   2. "Delivered" appears ONLY from an observed delivery (deliveredCount > 0),
 *      never from a timer or a guess — this screen once fabricated it.
 *   3. "Offline" is said only when the server could name ONE recipient, no
 *      connection took the message, and no other instance could have held one.
 *   4. The seen threshold is the newest message ON SCREEN that the server can
 *      check: not deleted, not optimistic.
 *   5. A read event only ever UPGRADES a receipt.
 */

import {
  applyReadToReceipts,
  deliveryFromPayload,
  isServerMessageId,
  ownMessageStatus,
  ownMessageStatusLabel,
  seenThreshold,
} from '../lifecycle/readState.ts';
import type { MessageReceipt } from '../lifecycle/lifecycleApi.ts';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const M3 = '33333333-3333-4333-8333-333333333333';

function receipt(over: Partial<MessageReceipt> = {}): MessageReceipt {
  return {
    messageId: M1, status: 'SENT', delivered: null, deliveredUnavailableReason: 'x',
    seenBy: 0, seenByUserIds: [], recipientCount: 1, ...over,
  };
}

describe('ownMessageStatus — every state is backed by something measured', () => {
  it('local states win: sending and failed are never dressed up', () => {
    expect(ownMessageStatus({ deliveryStatus: 'sending', receiptsState: 'ready' }).kind).toBe('sending');
    expect(ownMessageStatus({ deliveryStatus: 'failed', receiptsState: 'ready' }).kind).toBe('failed');
  });

  it('a SEEN receipt is Seen, with its count', () => {
    expect(ownMessageStatus({ receipt: receipt({ status: 'SEEN', seenBy: 2, recipientCount: 4 }), receiptsState: 'ready' }))
      .toEqual({ kind: 'seen', seenBy: 2, recipientCount: 4 });
  });

  it('THE POINT: a failed receipts read is "receipt unavailable", not "Sent"', () => {
    expect(ownMessageStatus({ receipt: receipt(), receiptsState: 'unavailable' }).kind).toBe('receipt_unavailable');
    expect(ownMessageStatus({ deliveryStatus: 'sent', receiptsState: 'unavailable' }).kind).toBe('receipt_unavailable');
  });

  it('a SEEN receipt survives a later failed read — the marker only moves forward', () => {
    expect(ownMessageStatus({ receipt: receipt({ status: 'SEEN', seenBy: 1 }), receiptsState: 'unavailable' }).kind).toBe('seen');
  });

  it('Delivered only from an OBSERVED delivery', () => {
    expect(ownMessageStatus({ receipt: receipt(), receiptsState: 'ready' }).kind).toBe('sent');
    expect(ownMessageStatus({
      receipt: receipt(), receiptsState: 'ready',
      delivery: { deliveredCount: 1, audienceCount: 1, crossInstance: false },
    }).kind).toBe('delivered');
  });

  it('"offline" only for ONE named recipient, delivered to nobody, on a single instance', () => {
    const offline = { deliveredCount: 0, audienceCount: 1, crossInstance: false };
    expect(ownMessageStatus({ receiptsState: 'ready', deliveryStatus: 'sent', delivery: offline }).kind).toBe('recipient_offline');
    // Another instance could hold the socket: a local zero is not "offline".
    expect(ownMessageStatus({ receiptsState: 'ready', deliveryStatus: 'sent', delivery: { ...offline, crossInstance: true } }).kind).toBe('sent');
    // A group: zero of three is not one person being offline.
    expect(ownMessageStatus({ receiptsState: 'ready', deliveryStatus: 'sent', delivery: { ...offline, audienceCount: 3 } }).kind).toBe('sent');
  });

  it('Seen needs BOTH a SEEN status and a named reader — an inconsistent receipt is not promoted', () => {
    // A SEEN status that counts nobody, and a SENT status that counts someone,
    // are both answers this screen cannot reconcile; neither may become "Seen".
    expect(ownMessageStatus({ receipt: receipt({ status: 'SEEN', seenBy: 0 }), receiptsState: 'ready' }).kind).toBe('sent');
    expect(ownMessageStatus({ receipt: receipt({ status: 'SENT', seenBy: 1 }), receiptsState: 'ready' }).kind).toBe('sent');
  });

  it('a read outranks a delivery: Seen beats Delivered', () => {
    expect(ownMessageStatus({
      receipt: receipt({ status: 'SEEN', seenBy: 1 }), receiptsState: 'ready',
      delivery: { deliveredCount: 1, audienceCount: 1, crossInstance: false },
    }).kind).toBe('seen');
  });
});

describe('ownMessageStatusLabel — the words', () => {
  it('says what each state is, and nothing more', () => {
    expect(ownMessageStatusLabel({ kind: 'sent' }, { isGroup: false })).toBe('Sent');
    expect(ownMessageStatusLabel({ kind: 'delivered' }, { isGroup: false })).toBe('Delivered');
    expect(ownMessageStatusLabel({ kind: 'recipient_offline' }, { isGroup: false })).toBe('Sent · they were offline');
    expect(ownMessageStatusLabel({ kind: 'receipt_unavailable' }, { isGroup: false })).toBe('Sent · read status unavailable');
  });

  it("§7.3's two shapes: a direct chat says Seen, a group says Seen by N", () => {
    expect(ownMessageStatusLabel({ kind: 'seen', seenBy: 1, recipientCount: 1 }, { isGroup: false })).toBe('Seen');
    expect(ownMessageStatusLabel({ kind: 'seen', seenBy: 3, recipientCount: 5 }, { isGroup: true })).toBe('Seen by 3');
    // A "group" with one other member is still one reader.
    expect(ownMessageStatusLabel({ kind: 'seen', seenBy: 1, recipientCount: 1 }, { isGroup: true })).toBe('Seen');
  });

  it('an unknown read status is never worded as a plain "Sent"', () => {
    expect(ownMessageStatusLabel({ kind: 'receipt_unavailable' }, { isGroup: true })).not.toBe('Sent');
  });
});

describe('seenThreshold — the newest message actually on screen that the server can check', () => {
  it('picks the newest server message', () => {
    expect(seenThreshold([
      { id: M1, createdAt: '2026-10-01T10:00:00.000Z' },
      { id: M2, createdAt: '2026-10-01T11:00:00.000Z' },
    ])).toBe(M2);
  });

  it('skips an optimistic message — it was never accepted, so nobody can have seen it', () => {
    expect(seenThreshold([
      { id: M1, createdAt: '2026-10-01T10:00:00.000Z' },
      { id: 'c_abc_123', createdAt: '2026-10-01T12:00:00.000Z', deliveryStatus: 'sending' },
      { id: 'client-1-x', createdAt: '2026-10-01T12:01:00.000Z', deliveryStatus: 'failed' },
    ])).toBe(M1);
  });

  it('a client id is skipped even when nothing marks it as sending, and a refused server id is skipped too', () => {
    // Each rule on its own: an optimistic id whose delivery status was never set,
    // and a server-shaped id the server refused (failed). Neither is a threshold.
    expect(seenThreshold([
      { id: M1, createdAt: '2026-10-01T10:00:00.000Z' },
      { id: 'c_abc_123', createdAt: '2026-10-01T12:00:00.000Z' },
    ])).toBe(M1);
    expect(seenThreshold([
      { id: M1, createdAt: '2026-10-01T10:00:00.000Z' },
      { id: M2, createdAt: '2026-10-01T12:00:00.000Z', deliveryStatus: 'failed' },
      { id: M3, createdAt: '2026-10-01T12:01:00.000Z', deliveryStatus: 'sending' },
    ])).toBe(M1);
  });

  it('skips a deleted message — the server refuses a tombstone as a threshold', () => {
    expect(seenThreshold([
      { id: M1, createdAt: '2026-10-01T10:00:00.000Z' },
      { id: M3, createdAt: '2026-10-01T13:00:00.000Z', deleted: true },
    ])).toBe(M1);
  });

  it('marks nothing from an empty (or failed) load', () => {
    expect(seenThreshold([])).toBeNull();
  });

  it('isServerMessageId tells a server id from a client id', () => {
    expect(isServerMessageId(M1)).toBe(true);
    expect(isServerMessageId('c_kq1_ab12cd34')).toBe(false);
    expect(isServerMessageId(null)).toBe(false);
  });
});

describe('deliveryFromPayload', () => {
  it('reads the server receipt', () => {
    expect(deliveryFromPayload({ messageId: M1, deliveredCount: 1, audienceCount: 1, crossInstance: false }))
      .toEqual({ messageId: M1, observation: { deliveredCount: 1, audienceCount: 1, crossInstance: false } });
  });

  it('a receipt that does not SAY it stayed on one instance is treated as though it may not have', () => {
    // "they were offline" rests on crossInstance === false. A payload that omits
    // the field (or garbles it) has not said so, and must not license the claim.
    expect(deliveryFromPayload({ messageId: M1, deliveredCount: 0, audienceCount: 1 })!.observation.crossInstance).toBe(true);
    expect(deliveryFromPayload({ messageId: M1, deliveredCount: 0, audienceCount: 1, crossInstance: 'no' })!.observation.crossInstance).toBe(true);
    expect(deliveryFromPayload({ messageId: M1, deliveredCount: 0, audienceCount: 1, crossInstance: false })!.observation.crossInstance).toBe(false);
  });

  it('refuses a payload it cannot attribute rather than guessing', () => {
    expect(deliveryFromPayload({ deliveredCount: 1, audienceCount: 1 })).toBeNull();
    expect(deliveryFromPayload({ messageId: M1, audienceCount: 1 })).toBeNull();
    expect(deliveryFromPayload(null)).toBeNull();
  });
});

describe('applyReadToReceipts — a read event only ever upgrades', () => {
  it('upgrades a crossed SENT receipt to SEEN, once per reader', () => {
    const before = new Map([[M1, receipt()]]);
    const after = applyReadToReceipts(before, 'u-2', () => true);
    expect(after.get(M1)).toMatchObject({ status: 'SEEN', seenBy: 1, seenByUserIds: ['u-2'] });
    const again = applyReadToReceipts(after, 'u-2', () => true);
    expect(again.get(M1)!.seenBy).toBe(1);
  });

  it('leaves a message the reader has not reached alone', () => {
    const before = new Map([[M1, receipt()]]);
    expect(applyReadToReceipts(before, 'u-2', () => false).get(M1)!.status).toBe('SENT');
  });
});
