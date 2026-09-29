/**
 * useThreadMessages / useOutgoingRequestStatus — WP-08 (lane tm-telegraph).
 *
 *   TEL-F07  A recipient SEES an edit. `message.updated` already reached this
 *            hook, but the merge only accepted brand-new ids and pending
 *            translations, so an edited body (and its `edited` marker) stayed
 *            stale on the other person's screen until they left and re-opened
 *            the thread.
 *   TEL-F10  Coming back to the foreground catches the thread up at once
 *            instead of waiting for the next poll tick.
 *   TEL-F03  The sender's pending-request status carries the request id, which
 *            is what a Cancel control needs.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */

import { renderHook, act, waitFor, cleanup } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useThreadMessages, useOutgoingRequestStatus } from '../useMessaging.ts';

// NOTE: intentionally exhaustive — the real hook touches AsyncStorage. The
// return value is ONE stable object: reload() depends on `save`, and a fresh
// function per render would re-run the initial load on every render.
const mockSnapshotCache = { snapshot: null, save: () => {}, clear: () => {} };
jest.mock('../useSnapshotCache.ts', () => ({
  useSnapshotCache: () => mockSnapshotCache,
}));

// NOTE: intentionally exhaustive — SessionContext boots the Supabase client.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'me-1' }),
}));

const mockGetThreadMessages = jest.fn();
const mockGetOutgoing = jest.fn();
// NOTE: intentionally exhaustive — the real module imports the Supabase and
// API-token stack; these hooks only call the functions listed.
jest.mock('../../services/messaging.ts', () => ({
  getThreadMessages: (...a: unknown[]) => mockGetThreadMessages(...a),
  getOutgoingRequestStatus: (...a: unknown[]) => mockGetOutgoing(...a),
  sendMessage: jest.fn(),
  sendTyping: jest.fn(),
  markThreadRead: jest.fn(),
}));

const realtimeListeners: Array<(e: unknown) => void> = [];
// NOTE: intentionally exhaustive — the realtime service opens a stream on import.
jest.mock('../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: {
    subscribe: (l: (e: unknown) => void) => {
      realtimeListeners.push(l);
      return () => {};
    },
  },
}));

const appListeners: Array<(s: AppStateStatus) => void> = [];

const M = (id: string, body: string, editedAt: string | null = null) => ({
  id, threadId: 't-1', senderId: 'u-2', body, displayBody: body, createdAt: '2026-08-01T10:00:00Z',
  editedAt, deleted: false, msgType: 'text', subtype: null, translationStatus: null,
}) as any;

beforeEach(() => {
  jest.clearAllMocks();
  realtimeListeners.length = 0;
  appListeners.length = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, l: (s: AppStateStatus) => void) => {
    appListeners.push(l);
    return { remove: () => {} };
  }) as never);
});

afterEach(async () => {
  await act(async () => {});
  cleanup();
  jest.restoreAllMocks();
});

describe('useThreadMessages — edits reach the recipient (TEL-F07)', () => {
  it('replaces an existing message whose body was edited, carrying the edited marker', async () => {
    // The poll only runs in the foreground; the renderer's AppState starts elsewhere.
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
    mockGetThreadMessages.mockResolvedValueOnce({ ok: true, data: { threadId: 't-1', messages: [M('m-1', 'meet at 7')] } });
    const { result } = await renderHook(() => useThreadMessages('t-1'));
    await waitFor(() => expect(result.current.messages.map((m) => m.body)).toEqual(['meet at 7']));

    mockGetThreadMessages.mockResolvedValueOnce({
      ok: true, data: { threadId: 't-1', messages: [M('m-1', 'meet at 8', '2026-08-01T10:05:00Z')] },
    });
    await act(async () => {
      for (const l of realtimeListeners) l({ type: 'message.updated', threadId: 't-1', ts: 'x' });
    });
    await waitFor(() => expect(result.current.messages[0]).toMatchObject({ body: 'meet at 8', editedAt: '2026-08-01T10:05:00Z' }));
  });
});

describe('useThreadMessages — foreground return catches up now (TEL-F10)', () => {
  it('reads the thread as soon as the app comes back, not on the next poll tick', async () => {
    mockGetThreadMessages.mockResolvedValue({ ok: true, data: { threadId: 't-1', messages: [M('m-1', 'hi')] } });
    const { result } = await renderHook(() => useThreadMessages('t-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = mockGetThreadMessages.mock.calls.length;

    await act(async () => { for (const l of appListeners) l('background'); });
    await act(async () => { for (const l of appListeners) l('active'); });
    await waitFor(() => expect(mockGetThreadMessages.mock.calls.length).toBeGreaterThan(before), { timeout: 1500 });
  });
});

describe('useOutgoingRequestStatus — the request id a Cancel needs (TEL-F03)', () => {
  it('exposes the pending request id the server returned', async () => {
    mockGetOutgoing.mockResolvedValueOnce({ ok: true, data: { pending: true, requestId: 'req-7' } });
    const { result } = await renderHook(() => useOutgoingRequestStatus('u-9'));
    await waitFor(() => expect(result.current.pending).toBe(true));
    expect(result.current.requestId).toBe('req-7');
  });
});
