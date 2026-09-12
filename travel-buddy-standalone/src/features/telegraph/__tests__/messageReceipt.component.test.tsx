/**
 * Telegraph §7.3 and §7.4, rendered.
 *
 *   §7.3 "For direct chats, show Sent/Delivered/Seen. For groups, derive
 *         'Seen by N' …"
 *   §7.4 "A sender may unsend only while no eligible recipient has seen the
 *         message."
 *
 * The rule itself is the server's and is asserted in
 * `artifacts/api-server/src/test/telegraphLifecycle.test.ts`. What this file
 * settles is what a sender is shown and offered:
 *
 *   - DIRECT says "Seen"; a GROUP says "Seen by N" — §7.3's two shapes;
 *   - nothing ever says "Delivered", because nothing on this deployment knows
 *     whether it was, and the reason travels on the accessibility label rather
 *     than being silently dropped;
 *   - the Unsend affordance is present while unseen and GONE once seen — which
 *     is how a sender learns §7.4 — and a refusal that arrives anyway is shown
 *     in the server's own words, not paraphrased;
 *   - a receipt that has not been read yet renders NOTHING. "Sent" would be a
 *     state nobody measured.
 *
 * No Modal here, so this file is free of TESTING.md Rule 6.
 *
 * The last describe block is about a DELETION. Both chat screens computed the
 * receipt inline and both fabricated "Delivered" — `ageSecs > 3 ? 'delivered' :
 * 'sent'`, a double tick shown because three seconds had elapsed, for a state
 * §7.1 names and this tree cannot produce. The rule now lives in one place,
 * has no 'delivered' branch, and is asserted here.
 *
 * SHOWN RED before commit (18 pass green), each mutation reverted:
 *   • `canOfferUnsend` returning true whenever a receipt exists
 *       -> 1 failed / 10 passed ("hides Unsend once a recipient has seen it")
 *   • `receiptLabel` collapsed to a single `Seen by N` shape
 *       -> 2 failed / 9 passed ("an unseen message says Sent", "a DIRECT chat
 *          says Seen, with no count")
 *   • the `if (!receipt) return null` guard replaced with a synthesised
 *     all-zero receipt — i.e. "assume Sent"
 *       -> 1 failed / 10 passed ("renders nothing until a receipt has actually
 *          been read")
 *   • `deriveReceiptState` restored to the FABRICATED rule verbatim —
 *     `ageSecs > 3 ? 'delivered' : 'sent'`, plus 'delivered' for an unread
 *     group message
 *       -> 4 failed / 14 passed ("has no 'delivered' outcome at all", "an
 *          unread direct message is SENT however old it is", "no group member
 *          reading it leaves it SENT", "an unparseable timestamp is SENT,
 *          never SEEN")
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — lifecycleApi reaches lib/supabase, which builds a
// client at import time and fails outside an Expo runtime. Every decision the
// component and the label functions make is the real module.
jest.mock('../../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: null }));
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'test-token' }));

import { MessageReceiptRow } from '../lifecycle/MessageReceiptRow.tsx';
import {
  canOfferUnsend,
  deriveReceiptState,
  deriveSeenBy,
  receiptLabel,
  unsendMessage,
  type MessageReceipt,
} from '../lifecycle/lifecycleApi.ts';

const REASON =
  'No delivery signal exists on this deployment: there is no per-device ' +
  'acknowledgement and no lastDeliveredSequence column, so DELIVERED cannot be ' +
  'reported as true or false.';

function receipt(over: Partial<MessageReceipt> = {}): MessageReceipt {
  return {
    messageId: 'm1',
    status: 'SENT',
    delivered: null,
    deliveredUnavailableReason: REASON,
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

  it('never says Delivered, and carries the reason instead', async () => {
    await render(<MessageReceiptRow threadId="t1" messageId="m1" receipt={receipt()} />);
    const node = screen.getByTestId('telegraph-receipt-m1');
    expect(String(node.props.children)).not.toMatch(/delivered/i);
    expect(node.props.accessibilityLabel).toContain('DELIVERED cannot be');
  });

  it('renders nothing until a receipt has actually been read', async () => {
    await render(<MessageReceiptRow threadId="t1" messageId="m1" receipt={null} />);
    expect(screen.queryByTestId('telegraph-receipt-m1')).toBeNull();
    // Crucially, not "Sent" either — an unknown state is not a measured one.
    expect(screen.queryByText('Sent')).toBeNull();
  });
});

describe('§7.4 — the unsend affordance teaches the rule', () => {
  it('offers Unsend while nobody has seen it', async () => {
    expect(canOfferUnsend(receipt())).toBe(true);
    await render(<MessageReceiptRow threadId="t1" messageId="m1" receipt={receipt()} />);
    expect(screen.getByTestId('telegraph-unsend-m1')).toBeTruthy();
  });

  it('hides Unsend once a recipient has seen it', async () => {
    expect(canOfferUnsend(receipt({ seenBy: 1, status: 'SEEN' }))).toBe(false);
    await render(
      <MessageReceiptRow threadId="t1" messageId="m1" receipt={receipt({ seenBy: 1, status: 'SEEN' })} />,
    );
    expect(screen.queryByTestId('telegraph-unsend-m1')).toBeNull();
  });

  it('offers nothing at all without a receipt', () => {
    expect(canOfferUnsend(null)).toBe(false);
    expect(canOfferUnsend(undefined)).toBe(false);
  });

  it('reports an unsend upward when the server allows it', async () => {
    const onUnsent = jest.fn();
    const unsend = jest.fn().mockResolvedValue({ ok: true, data: { id: 'm1', unsent: true } });
    await render(
      <MessageReceiptRow
        threadId="t1"
        messageId="m1"
        receipt={receipt()}
        onUnsent={onUnsent}
        unsend={unsend as any}
      />,
    );
    fireEvent.press(screen.getByTestId('telegraph-unsend-m1'));
    await waitFor(() => expect(onUnsent).toHaveBeenCalledWith('m1'));
    expect(unsend).toHaveBeenCalledWith('t1', 'm1');
  });

  it("shows the server's refusal verbatim when a read beat the press", async () => {
    const onUnsent = jest.fn();
    const unsend = jest.fn().mockResolvedValue({
      ok: false,
      error: 'seen_by_recipient',
      message: '3 people have already seen this message, so it can no longer be unsent.',
      seenBy: 3,
    });
    await render(
      <MessageReceiptRow
        threadId="t1"
        messageId="m1"
        receipt={receipt()}
        onUnsent={onUnsent}
        unsend={unsend as any}
      />,
    );
    fireEvent.press(screen.getByTestId('telegraph-unsend-m1'));
    await waitFor(() => expect(screen.getByTestId('telegraph-unsend-refused-m1')).toBeTruthy());
    // The count the server measured, not a softened "someone".
    expect(String(screen.getByTestId('telegraph-unsend-refused-m1').props.children)).toContain('3 people');
    expect(onUnsent).not.toHaveBeenCalled();
  });
});

describe('§7 — the request the real module builds', () => {
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
