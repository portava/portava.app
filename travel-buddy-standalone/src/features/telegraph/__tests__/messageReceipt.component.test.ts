/**
 * Telegraph §7.1, §7.3 and §7.4 on the client — receipts, and the unsend
 * affordance.
 *
 *   §7.3 "For direct chats, show Sent/Delivered/Seen. For groups, derive
 *         'Seen by N' …"
 *   §7.4 "A sender may unsend only while no eligible recipient has seen the
 *         message."
 *
 * The rule itself is the server's and is asserted in
 * `artifacts/api-server/src/test/telegraphLifecycle.test.ts`. What this file
 * settles is what the two chat surfaces derive and offer.
 *
 * ── WHY THIS FILE NO LONGER RENDERS A COMPONENT ─────────────────────────────
 * It used to mount a `MessageReceiptRow`. That component was real, tested and
 * MOUNTED NOWHERE: both chat screens already render their own receipt line, and
 * the unsend lives on the long-press sheet. Worse, the two functions it existed
 * to exercise — `receiptLabel` and `canOfferUnsend` — were called by nothing but
 * the component and this test, so §7.4's affordance rule was not actually
 * applied anywhere in the app: the sheet offered Unsend on every own message and
 * let the server refuse. The component is deleted, both functions are wired into
 * the long-press sheet, and what is tested here is the logic the app runs.
 *
 * ── THE FABRICATION THIS REPLACED ───────────────────────────────────────────
 * Both screens computed the receipt inline and both fabricated "Delivered":
 *
 *     const ageSecs = (Date.now() - new Date(msg.createdAt).getTime()) / 1000;
 *     return ageSecs > 3 ? 'delivered' : 'sent';
 *
 * A double tick shown because three seconds had elapsed, for a state §7.1 names
 * and this tree cannot produce — there is no per-device acknowledgement and no
 * `lastDeliveredSequence`. The rule now lives in one place, has no 'delivered'
 * branch, and the test asserts the OUTCOME SET rather than each case, so a new
 * branch cannot be added without failing here.
 *
 * SHOWN RED before commit (17 pass green), each mutation reverted:
 *   • `deriveReceiptState` restored to the fabricated rule verbatim, plus
 *     'delivered' for an unread group message
 *       -> 4 failed / 13 passed ("has no 'delivered' outcome at all", "an
 *          unread direct message is SENT however old it is", "no group member
 *          reading it leaves it SENT", "an unparseable timestamp is SENT,
 *          never SEEN")
 *   • `canOfferUnsend` returning true whenever a receipt exists
 *       -> 1 failed / 16 passed ("withdraws the offer once a recipient has
 *          seen it")
 *   • `receiptLabel` collapsed to a single `Seen by N` shape
 *       -> 2 failed / 15 passed ("an unseen message says Sent", "a DIRECT chat
 *          says Seen, with no count")
 */

// NOTE: intentional stub — lifecycleApi reaches lib/supabase, which builds a
// client at import time and fails outside an Expo runtime. Every function
// asserted below is the real module.
jest.mock('../../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: null }));
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'test-token' }));

import {
  canOfferUnsend,
  deriveReceiptState,
  deriveSeenBy,
  receiptLabel,
  unsendMessage,
  DELIVERED_UNAVAILABLE_CLIENT,
  type MessageReceipt,
} from '../lifecycle/lifecycleApi.ts';

function receipt(over: Partial<MessageReceipt> = {}): MessageReceipt {
  return {
    messageId: 'm1',
    status: 'SENT',
    delivered: null,
    deliveredUnavailableReason: DELIVERED_UNAVAILABLE_CLIENT,
    seenBy: 0,
    seenByUserIds: [],
    recipientCount: 1,
    ...over,
  };
}

describe('§7.3 — the receipt a sender sees', () => {
  it('an unseen message says Sent', () => {
    expect(receiptLabel(receipt())).toBe('Sent');
  });

  it('a DIRECT chat says Seen, with no count', () => {
    expect(receiptLabel(receipt({ seenBy: 1, recipientCount: 1, status: 'SEEN' }))).toBe('Seen');
  });

  it("a GROUP derives §7.3's 'Seen by N'", () => {
    expect(receiptLabel(receipt({ seenBy: 3, recipientCount: 5, status: 'SEEN' }))).toBe('Seen by 3');
  });

  it('never says Delivered, in any shape', () => {
    const labels = [
      receiptLabel(receipt()),
      receiptLabel(receipt({ seenBy: 1, recipientCount: 1, status: 'SEEN' })),
      receiptLabel(receipt({ seenBy: 2, recipientCount: 4, status: 'SEEN' })),
    ];
    for (const l of labels) expect(l).not.toMatch(/delivered/i);
  });

  it('carries the reason DELIVERED is absent rather than dropping it', () => {
    expect(receipt().deliveredUnavailableReason).toMatch(/no per-device acknowledgement/i);
    expect(receipt().delivered).toBeNull();
  });
});

describe('§7.4 — the affordance rule the app actually applies', () => {
  it('offers Unsend while nobody has seen it', () => {
    expect(canOfferUnsend(receipt())).toBe(true);
  });

  it('withdraws the offer once a recipient has seen it', () => {
    expect(canOfferUnsend(receipt({ seenBy: 1, status: 'SEEN' }))).toBe(false);
    expect(canOfferUnsend(receipt({ seenBy: 4, recipientCount: 9, status: 'SEEN' }))).toBe(false);
  });

  it('offers nothing at all without a receipt', () => {
    expect(canOfferUnsend(null)).toBe(false);
    expect(canOfferUnsend(undefined)).toBe(false);
  });

  it('POSTs to the thread-scoped unsend path with an empty body', async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    const calls: Array<[string, any]> = [];
    const realFetch = global.fetch;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ id: 'm1', unsent: true }) } as any;
    });
    try {
      const r = await unsendMessage('t1', 'm1');
      expect(r.ok).toBe(true);
      expect(calls[0][0]).toBe('https://api.test/api/threads/t1/messages/m1/unsend');
      expect(calls[0][1].method).toBe('POST');
      expect(JSON.parse(calls[0][1].body)).toEqual({});
    } finally {
      (global as any).fetch = realFetch;
      delete process.env.EXPO_PUBLIC_API_BASE_URL;
    }
  });

  it("surfaces the server's refusal message and count", async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    const realFetch = global.fetch;
    (global as any).fetch = jest.fn(async () => ({
      ok: false,
      json: async () => ({
        error: 'seen_by_recipient',
        message: '3 people have already seen this message, so it can no longer be unsent.',
        seenBy: 3,
      }),
    })) as any;
    try {
      const r = await unsendMessage('t1', 'm1');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('seen_by_recipient');
        // The count the server measured, not a softened "someone".
        expect(r.message).toContain('3 people');
        expect(r.seenBy).toBe(3);
      }
    } finally {
      (global as any).fetch = realFetch;
      delete process.env.EXPO_PUBLIC_API_BASE_URL;
    }
  });
});

describe('§7.1/§7.3 — DELIVERED was fabricated, and is gone', () => {
  const CREATED = '2026-05-01T20:00:00.000Z';
  const BEFORE = '2026-05-01T19:59:00.000Z';
  const AFTER = '2026-05-01T20:01:00.000Z';

  it('has no "delivered" outcome at all', () => {
    // Both chat screens used to return 'delivered' after three seconds. The
    // return type no longer contains it, and neither does any branch.
    const outcomes = new Set([
      deriveReceiptState({ createdAt: CREATED, otherLastReadAt: null }),
      deriveReceiptState({ createdAt: CREATED, otherLastReadAt: BEFORE }),
      deriveReceiptState({ createdAt: CREATED, otherLastReadAt: AFTER }),
      deriveReceiptState({ createdAt: CREATED, memberReads: [{ userId: 'a', lastReadAt: null }] }),
      deriveReceiptState({ createdAt: CREATED, memberReads: [{ userId: 'a', lastReadAt: AFTER }] }),
    ]);
    expect([...outcomes].sort()).toEqual(['read', 'sent']);
  });

  it('an unread direct message is SENT however old it is', () => {
    // The fabricated version returned 'delivered' for exactly this case.
    expect(deriveReceiptState({ createdAt: CREATED, otherLastReadAt: BEFORE })).toBe('sent');
    expect(deriveReceiptState({ createdAt: '2020-01-01T00:00:00.000Z', otherLastReadAt: null })).toBe('sent');
  });

  it('a direct message read past is SEEN', () => {
    expect(deriveReceiptState({ createdAt: CREATED, otherLastReadAt: AFTER })).toBe('read');
    expect(deriveReceiptState({ createdAt: CREATED, otherLastReadAt: CREATED })).toBe('read');
  });

  it('ONE group member reading it makes it SEEN', () => {
    const reads = [
      { userId: 'a', lastReadAt: BEFORE },
      { userId: 'b', lastReadAt: AFTER },
      { userId: 'c', lastReadAt: null },
    ];
    expect(deriveReceiptState({ createdAt: CREATED, memberReads: reads })).toBe('read');
  });

  it('no group member reading it leaves it SENT', () => {
    const reads = [
      { userId: 'a', lastReadAt: BEFORE },
      { userId: 'b', lastReadAt: null },
    ];
    expect(deriveReceiptState({ createdAt: CREATED, memberReads: reads })).toBe('sent');
  });

  it('counts "Seen by N" from measured reads, and returns null for none', () => {
    const reads = [
      { userId: 'a', lastReadAt: AFTER },
      { userId: 'b', lastReadAt: AFTER },
      { userId: 'c', lastReadAt: BEFORE },
    ];
    expect(deriveSeenBy(CREATED, reads)).toBe(2);
    // Not 0 — a receipt that reports an absence reads as an accusation.
    expect(deriveSeenBy(CREATED, [{ userId: 'a', lastReadAt: BEFORE }])).toBeNull();
    expect(deriveSeenBy(CREATED, [])).toBeNull();
  });

  it('an unparseable timestamp is SENT, never SEEN', () => {
    expect(deriveReceiptState({ createdAt: 'not a date', otherLastReadAt: AFTER })).toBe('sent');
    expect(deriveReceiptState({ createdAt: CREATED, otherLastReadAt: 'not a date' })).toBe('sent');
  });
});
