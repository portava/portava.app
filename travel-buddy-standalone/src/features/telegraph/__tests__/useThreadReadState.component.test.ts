/**
 * Telegraph §7.2 / §7.3 / §30A.15 — `useThreadReadState`, the read state both
 * chat screens now share.
 *
 * WHAT WAS BROKEN, and what each block below pins:
 *
 *   SEEN. The thread screen stamped "read" once, from a mount effect, and the
 *   trip/circle chat never did. A message that arrived while the person was
 *   looking stayed unread: their badge counted it and its sender saw "Sent".
 *   → marks the newest RENDERED message, only while focused and in the
 *     foreground, again when a newer one renders, never twice, and does not
 *     hammer a mark that failed.
 *
 *   RECEIPTS. Both screens read `last_read_at` once on open and never again.
 *   → re-read when the server says a read landed in THIS thread (and only this
 *     thread), and on a timer only while no realtime stream is open.
 *
 *   HONESTY. A failed receipts read rendered every message "Sent".
 *   → `receipt_unavailable`, while a receipt already SEEN stays SEEN.
 *
 *   DELIVERY. The server's live `message.delivered` was never consumed.
 *   → Delivered / "they were offline" from the server's own receipt.
 *
 *   RACES. A receipts answer for a thread that is no longer on screen is
 *   dropped instead of painted over the new one.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */

import { renderHook, act, waitFor, cleanup } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { useThreadReadState, RECEIPTS_FALLBACK_POLL_MS } from '../lifecycle/useThreadReadState.ts';

// ── Controllable focus ────────────────────────────────────────────────────────
const mockFocusBus = { focused: true, subs: new Set<() => void>() };
function setFocused(f: boolean) {
  mockFocusBus.focused = f;
  for (const s of [...mockFocusBus.subs]) s();
}
// NOTE: requireActual spread — only useFocusEffect is replaced, with a version
// a test can blur and refocus.
jest.mock('expo-router', () => {
  const actual = jest.requireActual('expo-router');
  const React = jest.requireActual('react');
  return {
    ...actual,
    useFocusEffect: (cb: () => (() => void) | void) => {
      React.useEffect(() => {
        let cleanupFn: (() => void) | null = null;
        const sync = () => {
          if (mockFocusBus.focused && !cleanupFn) {
            const c = cb();
            cleanupFn = typeof c === 'function' ? c : () => {};
          } else if (!mockFocusBus.focused && cleanupFn) {
            cleanupFn();
            cleanupFn = null;
          }
        };
        sync();
        mockFocusBus.subs.add(sync);
        return () => { mockFocusBus.subs.delete(sync); if (cleanupFn) cleanupFn(); };
      }, [cb]);
    },
  };
});

// ── Realtime ──────────────────────────────────────────────────────────────────
const mockRealtime = { listeners: new Set<(e: any) => void>(), status: 'open' as string };
function emit(evt: any) {
  for (const l of [...mockRealtime.listeners]) l(evt);
}
// NOTE: intentionally exhaustive — the hook subscribes to events and reads status.
jest.mock('../../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: {
    subscribe: (l: (e: any) => void) => { mockRealtime.listeners.add(l); return () => { mockRealtime.listeners.delete(l); }; },
    onStatus: () => () => {},
    getStatus: () => mockRealtime.status,
  },
}));

// ── The API and the badge broadcast ───────────────────────────────────────────
const mockFetchReceipts = jest.fn();
const mockMarkSeen = jest.fn();
const mockBroadcast = jest.fn();
// NOTE: intentional stub — lifecycleApi reaches lib/supabase, which builds a
// client at import time and fails outside an Expo runtime.
jest.mock('../../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: null }));
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'test-token' }));
jest.mock('../lifecycle/lifecycleApi.ts', () => ({
  ...jest.requireActual('../lifecycle/lifecycleApi.ts'),
  fetchReceipts: (...a: unknown[]) => mockFetchReceipts(...a),
  markSeen: (...a: unknown[]) => mockMarkSeen(...a),
}));
// NOTE: intentionally exhaustive — the hook only broadcasts a badge refresh.
jest.mock('../../../hooks/useMessaging.ts', () => ({
  broadcastUnreadCounts: (...a: unknown[]) => mockBroadcast(...a),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────
const T = 't0000000-0000-4000-8000-000000000001';
const T2 = 't0000000-0000-4000-8000-000000000002';
const ME = 'me-1';
const THEM = 'them-2';
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const msg = (n: number, senderId: string, at: string, over: Record<string, unknown> = {}) =>
  ({ id: id(n), senderId, createdAt: at, deleted: false, ...over });
const receipt = (n: number, over: Record<string, unknown> = {}) => ({
  messageId: id(n), status: 'SENT', delivered: null, deliveredUnavailableReason: 'x',
  seenBy: 0, seenByUserIds: [], recipientCount: 1, ...over,
});

const appListeners: Array<(s: AppStateStatus) => void> = [];
function emitApp(s: AppStateStatus) {
  for (const l of [...appListeners]) l(s);
}

async function mount(initial: { threadId?: string; messages: any[] }) {
  const hook = await renderHook(
    (p: { threadId: string; messages: any[] }) => useThreadReadState({ threadId: p.threadId, messages: p.messages, viewerId: ME }),
    { initialProps: { threadId: initial.threadId ?? T, messages: initial.messages } },
  );
  return hook;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockFocusBus.focused = true;
  mockFocusBus.subs.clear();
  mockRealtime.listeners.clear();
  mockRealtime.status = 'open';
  appListeners.length = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, l: (s: AppStateStatus) => void) => {
    appListeners.push(l);
    return { remove: () => { const i = appListeners.indexOf(l); if (i >= 0) appListeners.splice(i, 1); } };
  }) as never);
  mockMarkSeen.mockResolvedValue({ ok: true, data: { advanced: true, lastReadAt: null } });
  mockFetchReceipts.mockResolvedValue({ ok: true, data: { threadId: T, receipts: [] } });
});

afterEach(async () => {
  await act(async () => {});
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ── SEEN ──────────────────────────────────────────────────────────────────────

describe('seen — the newest message actually rendered, while the person is looking', () => {
  it('marks the newest rendered message through the message-anchored route', async () => {
    await mount({ messages: [msg(1, THEM, '2026-10-01T10:00:00Z'), msg(2, THEM, '2026-10-01T11:00:00Z')] });
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledWith(T, id(2)));
    expect(mockMarkSeen).toHaveBeenCalledTimes(1);
  });

  it('THE POINT: a message that arrives while the screen is open is marked too — not only on mount', async () => {
    const hook = await mount({ messages: [msg(1, THEM, '2026-10-01T10:00:00Z')] });
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledWith(T, id(1)));
    await act(async () => {
      hook.rerender({ threadId: T, messages: [msg(1, THEM, '2026-10-01T10:00:00Z'), msg(2, THEM, '2026-10-01T11:00:00Z')] });
    });
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledWith(T, id(2)));
  });

  it('never repeats a mark that succeeded', async () => {
    const msgs = [msg(1, THEM, '2026-10-01T10:00:00Z')];
    const hook = await mount({ messages: msgs });
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));
    await act(async () => { hook.rerender({ threadId: T, messages: [...msgs] }); });
    await act(async () => {});
    expect(mockMarkSeen).toHaveBeenCalledTimes(1);
  });

  it('a successful mark asks the unread badges to re-read', async () => {
    await mount({ messages: [msg(1, THEM, '2026-10-01T10:00:00Z')] });
    await waitFor(() => expect(mockBroadcast).toHaveBeenCalledWith(null));
  });

  it('§7.2: nothing is marked while the app is in the BACKGROUND; it is marked on return', async () => {
    const hook = await mount({ messages: [] });
    await act(async () => { emitApp('background'); });
    await act(async () => { hook.rerender({ threadId: T, messages: [msg(1, THEM, '2026-10-01T10:00:00Z')] }); });
    await act(async () => {});
    expect(mockMarkSeen).not.toHaveBeenCalled();
    await act(async () => { emitApp('active'); });
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledWith(T, id(1)));
  });

  it('nothing is marked while another screen covers this one; it is marked on refocus', async () => {
    const hook = await mount({ messages: [] });
    await act(async () => { setFocused(false); });
    await act(async () => { hook.rerender({ threadId: T, messages: [msg(1, THEM, '2026-10-01T10:00:00Z')] }); });
    await act(async () => {});
    expect(mockMarkSeen).not.toHaveBeenCalled();
    await act(async () => { setFocused(true); });
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledWith(T, id(1)));
  });

  it('nothing is marked from an empty (or failed) load', async () => {
    await mount({ messages: [] });
    await act(async () => {});
    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('a mark that failed is not hammered — it is retried when a newer message renders', async () => {
    mockMarkSeen.mockResolvedValue({ ok: false, error: 'network' });
    const msgs = [msg(1, THEM, '2026-10-01T10:00:00Z')];
    const hook = await mount({ messages: msgs });
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));
    await act(async () => { hook.rerender({ threadId: T, messages: [...msgs] }); });
    await act(async () => {});
    expect(mockMarkSeen).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
    await act(async () => { hook.rerender({ threadId: T, messages: [...msgs, msg(2, THEM, '2026-10-01T11:00:00Z')] }); });
    await waitFor(() => expect(mockMarkSeen).toHaveBeenLastCalledWith(T, id(2)));
  });

  it('a mark that failed is retried when the screen comes back into view', async () => {
    mockMarkSeen.mockResolvedValueOnce({ ok: false, error: 'network' });
    await mount({ messages: [msg(1, THEM, '2026-10-01T10:00:00Z')] });
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));
    await act(async () => { setFocused(false); });
    await act(async () => { setFocused(true); });
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(2));
    expect(mockMarkSeen).toHaveBeenLastCalledWith(T, id(1));
  });

  it('a realtime event is not a read: events alone never mark anything', async () => {
    await mount({ messages: [] });
    await act(async () => {
      emit({ type: 'message.created', threadId: T, payload: { messageId: id(9) } });
      emit({ type: 'read.updated', threadId: T, payload: { userId: THEM, lastReadAt: '2026-10-01T12:00:00Z' } });
      emit({ type: 'message.delivered', threadId: T, payload: { messageId: id(9), deliveredCount: 1, audienceCount: 1, crossInstance: false } });
    });
    await act(async () => {});
    expect(mockMarkSeen).not.toHaveBeenCalled();
  });
});

// ── RECEIPTS ──────────────────────────────────────────────────────────────────

describe('receipts — read from the server, re-read when a read lands', () => {
  it("reads receipts for the caller's own server messages only", async () => {
    await mount({
      messages: [
        msg(1, ME, '2026-10-01T10:00:00Z'),
        msg(2, THEM, '2026-10-01T10:30:00Z'),
        { id: 'c_local_1', senderId: ME, createdAt: '2026-10-01T11:00:00Z', deliveryStatus: 'sending' },
      ],
    });
    await waitFor(() => expect(mockFetchReceipts).toHaveBeenCalled());
    expect(mockFetchReceipts.mock.calls[0]).toEqual([T, [id(1)]]);
  });

  it('a SEEN receipt is Seen, and someone else\'s message has no status line', async () => {
    mockFetchReceipts.mockResolvedValue({ ok: true, data: { threadId: T, receipts: [receipt(1, { status: 'SEEN', seenBy: 1, seenByUserIds: [THEM] })] } });
    const mine = msg(1, ME, '2026-10-01T10:00:00Z');
    const theirs = msg(2, THEM, '2026-10-01T10:30:00Z');
    const hook = await mount({ messages: [mine, theirs] });
    await waitFor(() => expect(hook.result.current.statusFor(mine)).toEqual({ kind: 'seen', seenBy: 1, recipientCount: 1 }));
    expect(hook.result.current.statusFor(theirs)).toBeNull();
    expect(hook.result.current.readersFor(mine)).toEqual([THEM]);
  });

  it('THE POINT: a failed receipts read says "unavailable" — never a "Sent" nobody measured', async () => {
    mockFetchReceipts.mockResolvedValue({ ok: false, error: 'db_error' });
    const mine = msg(1, ME, '2026-10-01T10:00:00Z');
    const hook = await mount({ messages: [mine] });
    await waitFor(() => expect(hook.result.current.receiptsState).toBe('unavailable'));
    expect(hook.result.current.statusFor(mine)).toEqual({ kind: 'receipt_unavailable' });
    // And the long-press sheet gets no guessed receipt to offer Unsend from.
    expect(hook.result.current.receiptFor(mine)).toBeNull();
  });

  it('a SEEN receipt stays SEEN through a later failed read', async () => {
    mockFetchReceipts.mockResolvedValueOnce({ ok: true, data: { threadId: T, receipts: [receipt(1, { status: 'SEEN', seenBy: 1, seenByUserIds: [THEM] })] } });
    const mine = msg(1, ME, '2026-10-01T10:00:00Z');
    const hook = await mount({ messages: [mine] });
    await waitFor(() => expect(hook.result.current.statusFor(mine)?.kind).toBe('seen'));
    mockFetchReceipts.mockResolvedValue({ ok: false, error: 'db_error' });
    await act(async () => { emit({ type: 'message.seen', threadId: T, payload: {} }); });
    await waitFor(() => expect(hook.result.current.receiptsState).toBe('unavailable'));
    expect(hook.result.current.statusFor(mine)?.kind).toBe('seen');
  });

  it('after a failed refresh the long-press sheet gets only what cannot have gone stale: SEEN, never SENT', async () => {
    mockFetchReceipts.mockResolvedValueOnce({ ok: true, data: { threadId: T, receipts: [
      receipt(1), receipt(2, { status: 'SEEN', seenBy: 1, seenByUserIds: [THEM] }),
    ] } });
    const sent = msg(1, ME, '2026-10-01T10:00:00Z');
    const seen = msg(2, ME, '2026-10-01T10:01:00Z');
    const hook = await mount({ messages: [sent, seen] });
    await waitFor(() => expect(hook.result.current.receiptFor(sent)?.status).toBe('SENT'));
    mockFetchReceipts.mockResolvedValue({ ok: false, error: 'db_error' });
    await act(async () => { emit({ type: 'message.seen', threadId: T, payload: {} }); });
    await waitFor(() => expect(hook.result.current.receiptsState).toBe('unavailable'));
    expect(hook.result.current.receiptFor(sent)).toBeNull(); // may already have been read: no Unsend offered from it
    expect(hook.result.current.receiptFor(seen)?.status).toBe('SEEN');
  });

  it("a GROUP's read event waits for the refetch — it does not guess which members were eligible", async () => {
    mockFetchReceipts.mockResolvedValueOnce({ ok: true, data: { threadId: T, receipts: [receipt(1, { recipientCount: 3 })] } });
    const mine = msg(1, ME, '2026-10-01T10:00:00Z');
    const hook = await mount({ messages: [mine] });
    await waitFor(() => expect(hook.result.current.statusFor(mine)?.kind).toBe('sent'));
    mockFetchReceipts.mockReturnValue(new Promise(() => {}));
    await act(async () => { emit({ type: 'read.updated', threadId: T, payload: { userId: THEM, lastReadAt: '2026-10-01T10:05:00Z' } }); });
    expect(hook.result.current.statusFor(mine)?.kind).toBe('sent');
  });

  it("someone else's message never gets a status line, whatever its local delivery flag says", async () => {
    const theirs = msg(2, THEM, '2026-10-01T10:30:00Z', { deliveryStatus: 'sent' });
    const hook = await mount({ messages: [msg(1, ME, '2026-10-01T10:00:00Z'), theirs] });
    await waitFor(() => expect(hook.result.current.receiptsState).toBe('ready'));
    expect(hook.result.current.statusFor(theirs)).toBeNull();
  });

  it("switching threads forgets the previous thread's receipts at once", async () => {
    mockFetchReceipts.mockResolvedValueOnce({ ok: true, data: { threadId: T, receipts: [receipt(1, { status: 'SEEN', seenBy: 1, seenByUserIds: [THEM] })] } });
    mockFetchReceipts.mockImplementation(() => new Promise(() => {}));
    const mine = msg(1, ME, '2026-10-01T10:00:00Z');
    const hook = await mount({ threadId: T, messages: [mine] });
    await waitFor(() => expect(hook.result.current.statusFor(mine)?.kind).toBe('seen'));
    await act(async () => { hook.rerender({ threadId: T2, messages: [mine] }); });
    expect(hook.result.current.statusFor(mine)).toBeNull();
    expect(hook.result.current.readersFor(mine)).toEqual([]);
  });

  it('THE POINT: a read in THIS thread re-reads receipts; a read in another thread does not', async () => {
    const mine = msg(1, ME, '2026-10-01T10:00:00Z');
    const hook = await mount({ messages: [mine] });
    await waitFor(() => expect(mockFetchReceipts).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hook.result.current.receiptsState).toBe('ready'));
    await act(async () => { emit({ type: 'read.updated', threadId: T2, payload: { userId: THEM, lastReadAt: '2026-10-01T12:00:00Z' } }); });
    await new Promise((r) => setTimeout(r, 600));
    expect(mockFetchReceipts).toHaveBeenCalledTimes(1);
    mockFetchReceipts.mockResolvedValue({ ok: true, data: { threadId: T, receipts: [receipt(1, { status: 'SEEN', seenBy: 1, seenByUserIds: [THEM] })] } });
    await act(async () => { emit({ type: 'read.updated', threadId: T, payload: { userId: THEM, lastReadAt: '2026-10-01T12:00:00Z' } }); });
    await waitFor(() => expect(mockFetchReceipts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.statusFor(mine)?.kind).toBe('seen'));
  });

  it("a direct chat's read event shows Seen at once, before the refetch answers", async () => {
    mockFetchReceipts.mockResolvedValueOnce({ ok: true, data: { threadId: T, receipts: [receipt(1)] } });
    const mine = msg(1, ME, '2026-10-01T10:00:00Z');
    const hook = await mount({ messages: [mine] });
    await waitFor(() => expect(hook.result.current.statusFor(mine)?.kind).toBe('sent'));
    mockFetchReceipts.mockReturnValue(new Promise(() => {})); // the refetch never answers
    await act(async () => { emit({ type: 'read.updated', threadId: T, payload: { userId: THEM, lastReadAt: '2026-10-01T10:05:00Z' } }); });
    expect(hook.result.current.statusFor(mine)).toEqual({ kind: 'seen', seenBy: 1, recipientCount: 1 });
  });

  it('a read event that has not reached the message changes nothing', async () => {
    mockFetchReceipts.mockResolvedValueOnce({ ok: true, data: { threadId: T, receipts: [receipt(1)] } });
    const mine = msg(1, ME, '2026-10-01T10:00:00Z');
    const hook = await mount({ messages: [mine] });
    await waitFor(() => expect(hook.result.current.statusFor(mine)?.kind).toBe('sent'));
    mockFetchReceipts.mockReturnValue(new Promise(() => {}));
    await act(async () => { emit({ type: 'read.updated', threadId: T, payload: { userId: THEM, lastReadAt: '2026-10-01T09:00:00Z' } }); });
    expect(hook.result.current.statusFor(mine)?.kind).toBe('sent');
  });

  it('a receipt not read yet shows NOTHING rather than "Sent"', async () => {
    mockFetchReceipts.mockReturnValue(new Promise(() => {}));
    const mine = msg(1, ME, '2026-10-01T10:00:00Z');
    const hook = await mount({ messages: [mine] });
    await waitFor(() => expect(mockFetchReceipts).toHaveBeenCalled());
    expect(hook.result.current.statusFor(mine)).toBeNull();
  });

  it('THE RACE: an answer for a thread no longer on screen is dropped', async () => {
    let resolveA: (v: unknown) => void = () => {};
    mockFetchReceipts.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    mockFetchReceipts.mockImplementation(() => new Promise(() => {})); // thread B's read is still in flight
    const a = msg(1, ME, '2026-10-01T10:00:00Z');
    const b = msg(2, ME, '2026-10-01T10:00:00Z');
    const hook = await mount({ threadId: T, messages: [a] });
    await waitFor(() => expect(mockFetchReceipts).toHaveBeenCalledWith(T, [id(1)]));
    await act(async () => { hook.rerender({ threadId: T2, messages: [b] }); });
    await waitFor(() => expect(mockFetchReceipts).toHaveBeenCalledWith(T2, [id(2)]));
    await act(async () => { resolveA({ ok: true, data: { threadId: T, receipts: [receipt(1, { status: 'SEEN', seenBy: 1, seenByUserIds: [THEM] })] } }); });
    expect(hook.result.current.receiptsState).not.toBe('ready');
    expect(hook.result.current.statusFor(a)).toBeNull();
  });

  it('with NO realtime stream open, receipts are re-read on a timer; with one open, they are not', async () => {
    jest.useFakeTimers();
    mockRealtime.status = 'polling';
    const hook = await mount({ messages: [msg(1, ME, '2026-10-01T10:00:00Z')] });
    await act(async () => { jest.advanceTimersByTime(10); });
    const first = mockFetchReceipts.mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(1);
    await act(async () => { jest.advanceTimersByTime(RECEIPTS_FALLBACK_POLL_MS + 10); });
    expect(mockFetchReceipts.mock.calls.length).toBe(first + 1);
    mockRealtime.status = 'open';
    await act(async () => { jest.advanceTimersByTime(RECEIPTS_FALLBACK_POLL_MS + 10); });
    expect(mockFetchReceipts.mock.calls.length).toBe(first + 1);
    hook.unmount();
  });
});

// ── DELIVERY ──────────────────────────────────────────────────────────────────

describe("delivery — the server's own live receipt, and nothing invented", () => {
  it('a delivery receipt for this thread shows Delivered', async () => {
    const mine = msg(1, ME, '2026-10-01T10:00:00Z', { deliveryStatus: 'sent' });
    const hook = await mount({ messages: [mine] });
    await waitFor(() => expect(hook.result.current.receiptsState).toBe('ready'));
    expect(hook.result.current.statusFor(mine)?.kind).toBe('sent');
    await act(async () => {
      emit({ type: 'message.delivered', threadId: T, payload: { messageId: id(1), deliveredCount: 1, audienceCount: 1, crossInstance: false } });
    });
    expect(hook.result.current.statusFor(mine)?.kind).toBe('delivered');
  });

  it('a receipt that reached nobody says the recipient was offline', async () => {
    const mine = msg(1, ME, '2026-10-01T10:00:00Z', { deliveryStatus: 'sent' });
    const hook = await mount({ messages: [mine] });
    await waitFor(() => expect(hook.result.current.receiptsState).toBe('ready'));
    await act(async () => {
      emit({ type: 'message.delivered', threadId: T, payload: { messageId: id(1), deliveredCount: 0, audienceCount: 1, crossInstance: false } });
    });
    expect(hook.result.current.statusFor(mine)?.kind).toBe('recipient_offline');
  });

  it("another thread's delivery receipt is not this thread's", async () => {
    const mine = msg(1, ME, '2026-10-01T10:00:00Z', { deliveryStatus: 'sent' });
    const hook = await mount({ messages: [mine] });
    await waitFor(() => expect(hook.result.current.receiptsState).toBe('ready'));
    await act(async () => {
      emit({ type: 'message.delivered', threadId: T2, payload: { messageId: id(1), deliveredCount: 1, audienceCount: 1, crossInstance: false } });
    });
    expect(hook.result.current.statusFor(mine)?.kind).toBe('sent');
  });
});

// ── T295: the reader chips' faces come WITH the receipt ──────────────────────
// census-telegraph T295 (lane T, 2026-10-07): `useReaderAvatars` read
// `profiles.avatar_url` itself — the last raw read on the conversation surface.
// The receipts answer now carries `readerFaces` (the server applies the block and
// private-profile rule); the read state publishes it and the chips look it up.
describe('T295 — reader faces are the server\'s answer, not a profiles read', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useReaderAvatars } = require('../lifecycle/useReaderAvatars.ts') as typeof import('../lifecycle/useReaderAvatars.ts');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { _resetReaderFaces } = require('../lifecycle/readerFaces.ts') as typeof import('../lifecycle/readerFaces.ts');
  beforeEach(() => { _resetReaderFaces(); });

  it('a receipts answer\'s faces reach the chips; a face the server withholds is not drawn', async () => {
    mockFetchReceipts.mockResolvedValue({
      ok: true,
      data: { threadId: T, receipts: [receipt(1, { status: 'SEEN', seenBy: 2, seenByUserIds: [THEM, 'blocked-3'] })], readerFaces: { [THEM]: 'https://cdn.example/them.jpg', 'blocked-3': null } },
    });
    await mount({ messages: [msg(1, ME, '2026-10-01T10:00:00Z')] });
    await waitFor(() => expect(mockFetchReceipts).toHaveBeenCalled());
    const chips = await renderHook(() => useReaderAvatars([THEM, 'blocked-3']));
    await waitFor(() => expect(chips.result.current(THEM)).toBe('https://cdn.example/them.jpg'));
    expect(chips.result.current('blocked-3')).toBeNull();
  });

  it('a later answer that withholds a face (a block made since) takes it away', async () => {
    mockFetchReceipts.mockResolvedValueOnce({ ok: true, data: { threadId: T, receipts: [], readerFaces: { [THEM]: 'https://cdn.example/them.jpg' } } });
    const hook = await mount({ messages: [msg(1, ME, '2026-10-01T10:00:00Z')] });
    const chips = await renderHook(() => useReaderAvatars([THEM]));
    await waitFor(() => expect(chips.result.current(THEM)).toBe('https://cdn.example/them.jpg'));
    mockFetchReceipts.mockResolvedValueOnce({ ok: true, data: { threadId: T, receipts: [], readerFaces: { [THEM]: null } } });
    await act(async () => { hook.result.current.refreshReceipts(); });
    await waitFor(() => expect(chips.result.current(THEM)).toBeNull());
  });

  it('an answer from an older server (no readerFaces) draws no faces and breaks nothing', async () => {
    mockFetchReceipts.mockResolvedValue({ ok: true, data: { threadId: T, receipts: [] } });
    await mount({ messages: [msg(1, ME, '2026-10-01T10:00:00Z')] });
    await waitFor(() => expect(mockFetchReceipts).toHaveBeenCalled());
    const chips = await renderHook(() => useReaderAvatars([THEM]));
    expect(chips.result.current(THEM)).toBeNull();
  });
});
