/**
 * useGroupChat — WP-08 / TEL-F10: a member who was away catches up when they
 * come back, and a failed read is never shown as an empty chat.
 *
 * WHAT THIS PINS
 *   1. The realtime stream dropping and re-opening triggers ONE catch-up read
 *      of the thread, and what was said meanwhile appears.
 *   2. The app returning to the foreground triggers the same catch-up.
 *   3. The very first stream open is NOT a reconnect (the initial load covers it).
 *   4. A catch-up the server refuses as `forbidden` (the member was removed
 *      while away) flips the chat to no-access instead of leaving the old
 *      messages on screen as if nothing happened.
 *   5. A failed first message page is the ERROR state, not an empty chat —
 *      DV-83. (This restates a case in useGroupChat.threadShape that pinned the
 *      opposite; see the lane's decision TM-TEL-D5.)
 *   6. Editing goes through the canonical, history-keeping route
 *      (`editThreadMessage(threadId, messageId, body)`).
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */

import { renderHook, act, waitFor, cleanup } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useGroupChat } from '../useGroupChat.ts';

const mockGetTripChat = jest.fn();
const mockGetThreadMessages = jest.fn();
const mockEditThreadMessage = jest.fn();
const mockEditMessage = jest.fn();

// NOTE: intentionally exhaustive — the real module touches Supabase/network;
// the hook only calls the functions stubbed here.
jest.mock('../../services/messaging.ts', () => ({
  getTripChat: (...a: unknown[]) => mockGetTripChat(...a),
  getCircleChat: jest.fn(),
  getThreadMessages: (...a: unknown[]) => mockGetThreadMessages(...a),
  sendMessage: jest.fn(),
  editMessage: (...a: unknown[]) => mockEditMessage(...a),
  editThreadMessage: (...a: unknown[]) => mockEditThreadMessage(...a),
  deleteMessage: jest.fn(),
  sendTyping: jest.fn(),
}));

// NOTE: intentionally exhaustive — the hook only reads userId from useSession.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'me-1' }),
}));

const statusListeners: Array<(s: string) => void> = [];
// NOTE: intentionally exhaustive — the hook subscribes to events and to status.
jest.mock('../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: {
    subscribe: () => () => {},
    onStatus: (l: (s: string) => void) => {
      statusListeners.push(l);
      l('connecting');
      return () => {
        const i = statusListeners.indexOf(l);
        if (i >= 0) statusListeners.splice(i, 1);
      };
    },
    getStatus: () => 'connecting',
  },
}));

const appListeners: Array<(s: AppStateStatus) => void> = [];

const MSG = (id: string, createdAt: string) => ({
  id, threadId: 't-1', senderId: 'u-2', body: `body of ${id}`, createdAt,
  deleted: false, editedAt: null, msgType: 'text', subtype: null,
}) as any;

function emitStatus(s: string) {
  for (const l of [...statusListeners]) l(s);
}
function emitApp(s: AppStateStatus) {
  for (const l of [...appListeners]) l(s);
}

async function openChat() {
  mockGetTripChat.mockResolvedValueOnce({
    ok: true,
    data: { threadId: 't-1', threadType: 'trip', title: 'Lisbon', tripId: 'trip-9', circleOwnerId: null },
  });
  mockGetThreadMessages.mockResolvedValueOnce({
    ok: true, data: { threadId: 't-1', messages: [MSG('m-1', '2026-08-01T10:00:00Z')] },
  });
  const hook = await renderHook(() => useGroupChat('trip', 'trip-9'));
  await waitFor(() => expect(hook.result.current.state).toBe('active'));
  return hook;
}

describe('useGroupChat — catch-up on reconnect (TEL-F10)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    statusListeners.length = 0;
    appListeners.length = 0;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, l: (s: AppStateStatus) => void) => {
      appListeners.push(l);
      return { remove: () => { const i = appListeners.indexOf(l); if (i >= 0) appListeners.splice(i, 1); } };
    }) as never);
  });

  afterEach(async () => {
    await act(async () => {});
    cleanup();
    jest.restoreAllMocks();
  });

  it('re-reads the thread when the stream drops and comes back, and shows what was missed', async () => {
    const { result } = await openChat();
    expect(mockGetThreadMessages).toHaveBeenCalledTimes(1);

    mockGetThreadMessages.mockResolvedValueOnce({
      ok: true,
      data: { threadId: 't-1', messages: [MSG('m-2', '2026-08-01T11:00:00Z'), MSG('m-1', '2026-08-01T10:00:00Z')] },
    });
    await act(async () => { emitStatus('open'); });
    expect(mockGetThreadMessages).toHaveBeenCalledTimes(1); // first open is not a reconnect
    await act(async () => { emitStatus('polling'); });
    await act(async () => { emitStatus('open'); });

    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['m-1', 'm-2']));
    expect(mockGetThreadMessages).toHaveBeenCalledTimes(2);
    expect(mockGetThreadMessages).toHaveBeenLastCalledWith('t-1');
  });

  it('re-reads the thread when the app returns to the foreground', async () => {
    const { result } = await openChat();
    mockGetThreadMessages.mockResolvedValueOnce({
      ok: true,
      data: { threadId: 't-1', messages: [MSG('m-3', '2026-08-01T12:00:00Z'), MSG('m-1', '2026-08-01T10:00:00Z')] },
    });
    await act(async () => { emitApp('background'); });
    await act(async () => { emitApp('active'); });
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['m-1', 'm-3']));
  });

  it('a catch-up refused as forbidden moves the chat to no-access (the member was removed while away)', async () => {
    const { result } = await openChat();
    mockGetThreadMessages.mockResolvedValueOnce({ ok: false, data: null, errorKind: 'forbidden' });
    await act(async () => { emitApp('background'); });
    await act(async () => { emitApp('active'); });
    await waitFor(() => expect(result.current.state).toBe('no_access'));
  });

  it('a failed first message page is the error state, not an empty chat (DV-83)', async () => {
    mockGetTripChat.mockResolvedValueOnce({
      ok: true,
      data: { threadId: 't-3', threadType: 'trip', title: 'Trip', tripId: 'trip-9', circleOwnerId: null },
    });
    mockGetThreadMessages.mockResolvedValueOnce({ ok: false, data: null, errorKind: 'db_error' });
    const { result } = await renderHook(() => useGroupChat('trip', 'trip-9'));
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.messages).toEqual([]);
  });

  it('edits through the canonical history-keeping route, never the legacy one', async () => {
    const { result } = await openChat();
    mockEditThreadMessage.mockResolvedValueOnce({
      ok: true,
      data: { id: 'm-1', threadId: 't-1', body: 'fixed', editedAt: '2026-08-01T10:05:00Z', versionHistory: { recorded: true, version: 1 } },
    });
    await act(async () => { await result.current.edit('m-1', 'fixed'); });
    expect(mockEditThreadMessage).toHaveBeenCalledWith('t-1', 'm-1', 'fixed');
    expect(mockEditMessage).not.toHaveBeenCalled();
    expect(result.current.messages[0]).toMatchObject({ body: 'fixed', editedAt: '2026-08-01T10:05:00Z' });
  });
});
