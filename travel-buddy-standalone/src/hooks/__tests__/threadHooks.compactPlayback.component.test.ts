/**
 * The thread hooks are compact playback's MESSAGE SOURCES — Telegraph §6.3,
 * census-telegraph T62, owner question Q-PB1's fail-closed default.
 *
 * WHAT THIS PINS, through the real hooks and the real store:
 *   useThreadMessages (DM / thread screen)
 *     1. A video the hook holds can be opened; with no hook mounted it cannot.
 *     2. A poll that brings the message back DELETED stops playback.
 *     3. The screen unmounting (the hook with it) stops playback.
 *   useGroupChat (trip / circle chat)
 *     4. A video the hook holds can be opened.
 *     5. A catch-up that brings the message back DELETED, with nothing new,
 *        reaches the thread AND stops playback. The merge used to return the
 *        previous array whenever no NEW id arrived, so a delete (or an edit)
 *        caught up after a reconnect was dropped on the floor.
 *     6. The viewer's own delete stops playback.
 *     7. Losing access (removed while away → no_access) stops playback.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */
import { renderHook, act, waitFor, cleanup } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useThreadMessages } from '../useMessaging.ts';
import { useGroupChat } from '../useGroupChat.ts';
import {
  _resetCompactPlaybackForTests,
  getCompactPlayback,
  lastPlaybackStopReason,
  openMessageVideo,
} from '../../features/telegraph/media/compactPlaybackStore.ts';

// NOTE: intentionally exhaustive — the real hook touches AsyncStorage. ONE
// stable object: reload() depends on `save`.
const mockSnapshotCache = { snapshot: null, save: () => {}, clear: () => {} };
jest.mock('../useSnapshotCache.ts', () => ({
  useSnapshotCache: () => mockSnapshotCache,
}));

// NOTE: intentionally exhaustive — SessionContext boots the Supabase client.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'me-1' }),
}));

const mockGetThreadMessages = jest.fn();
const mockGetTripChat = jest.fn();
const mockDeleteMessage = jest.fn();
// NOTE: intentionally exhaustive — the real module imports the Supabase and
// API-token stack; these hooks only call the functions listed.
jest.mock('../../services/messaging.ts', () => ({
  getThreadMessages: (...a: unknown[]) => mockGetThreadMessages(...a),
  resumeThreadMessages: jest.fn(),
  getTripChat: (...a: unknown[]) => mockGetTripChat(...a),
  getCircleChat: jest.fn(),
  sendMessage: jest.fn(),
  editThreadMessage: jest.fn(),
  deleteMessage: (...a: unknown[]) => mockDeleteMessage(...a),
  sendTyping: jest.fn(),
  markThreadRead: jest.fn(),
}));

const realtimeListeners: Array<(e: unknown) => void> = [];
const statusListeners: Array<(s: string) => void> = [];
// NOTE: intentionally exhaustive — the realtime service opens a stream on use.
jest.mock('../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: {
    subscribe: (l: (e: unknown) => void) => {
      realtimeListeners.push(l);
      return () => {};
    },
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

const REF = 'post-media/u-2/clip.mp4';
const TEXT = (id: string, createdAt = '2026-10-14T10:00:00Z') => ({
  id, threadId: 't-1', senderId: 'u-2', body: `body ${id}`, displayBody: `body ${id}`, createdAt,
  editedAt: null, deleted: false, msgType: 'text', subtype: null, translationStatus: null,
  mediaUrl: null, mediaType: null,
}) as any;
const VIDEO = (id: string, over: Record<string, unknown> = {}) => ({
  ...TEXT(id, '2026-10-14T10:01:00Z'), body: null, displayBody: null, msgType: 'media',
  mediaType: 'video', mediaUrl: REF, mediaThumbnailUrl: 'post-media/u-2/clip.jpg', ...over,
}) as any;
const TOMBSTONE = (id: string) => VIDEO(id, { deleted: true, mediaUrl: null, mediaType: null, mediaThumbnailUrl: null });

beforeEach(() => {
  jest.resetAllMocks();
  _resetCompactPlaybackForTests();
  realtimeListeners.length = 0;
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

describe('useThreadMessages as a message source', () => {
  async function openThread() {
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
    // Newest first, as the endpoint returns them.
    mockGetThreadMessages.mockResolvedValueOnce({ ok: true, data: { threadId: 't-1', messages: [VIDEO('m-1'), TEXT('m-0')] } });
    const hook = await renderHook(() => useThreadMessages('t-1'));
    await waitFor(() => expect(hook.result.current.messages.map((m) => m.id)).toEqual(['m-0', 'm-1']));
    return hook;
  }

  it('a video the thread holds opens; with no thread mounted it does not', async () => {
    expect(openMessageVideo({ mediaRef: REF })).toBe(false);
    await openThread();
    expect(openMessageVideo({ mediaRef: REF })).toBe(true);
    expect(getCompactPlayback()?.bindings[0]).toMatchObject({ threadId: 't-1', messageIds: ['m-1'] });
  });

  it('a poll that brings the message back deleted stops playback', async () => {
    const { result } = await openThread();
    expect(openMessageVideo({ mediaRef: REF })).toBe(true);
    mockGetThreadMessages.mockResolvedValueOnce({ ok: true, data: { threadId: 't-1', messages: [TOMBSTONE('m-1'), TEXT('m-0')] } });
    await act(async () => {
      for (const l of realtimeListeners) l({ type: 'message.updated', threadId: 't-1', ts: 'x' });
    });
    await waitFor(() => expect(result.current.messages.find((m) => m.id === 'm-1')?.deleted).toBe(true));
    expect(getCompactPlayback()).toBeNull();
    expect(lastPlaybackStopReason()).toBe('message_gone');
  });

  it('the screen unmounting stops playback', async () => {
    const { unmount } = await openThread();
    expect(openMessageVideo({ mediaRef: REF })).toBe(true);
    await act(async () => { unmount(); });
    expect(getCompactPlayback()).toBeNull();
    expect(lastPlaybackStopReason()).toBe('source_closed');
  });
});

describe('useGroupChat as a message source', () => {
  async function openChat() {
    mockGetTripChat.mockResolvedValueOnce({
      ok: true,
      data: { threadId: 't-1', threadType: 'trip', title: 'Lisbon', tripId: 'trip-9', circleOwnerId: null },
    });
    mockGetThreadMessages.mockResolvedValueOnce({ ok: true, data: { threadId: 't-1', messages: [VIDEO('m-1'), TEXT('m-0')] } });
    const hook = await renderHook(() => useGroupChat('trip', 'trip-9'));
    await waitFor(() => expect(hook.result.current.state).toBe('active'));
    return hook;
  }
  async function foregroundReturn() {
    await act(async () => { for (const l of [...appListeners]) l('background'); });
    await act(async () => { for (const l of [...appListeners]) l('active'); });
  }

  it('a video the chat holds opens', async () => {
    await openChat();
    expect(openMessageVideo({ mediaRef: REF })).toBe(true);
    expect(getCompactPlayback()?.bindings[0]).toMatchObject({ threadId: 't-1', messageIds: ['m-1'] });
  });

  it('a catch-up that brings the message back deleted — nothing new — reaches the chat and stops playback', async () => {
    const { result } = await openChat();
    expect(openMessageVideo({ mediaRef: REF })).toBe(true);
    mockGetThreadMessages.mockResolvedValueOnce({ ok: true, data: { threadId: 't-1', messages: [TOMBSTONE('m-1'), TEXT('m-0')] } });
    await foregroundReturn();
    await waitFor(() => expect(result.current.messages.find((m) => m.id === 'm-1')?.deleted).toBe(true));
    expect(getCompactPlayback()).toBeNull();
    expect(lastPlaybackStopReason()).toBe('message_gone');
  });

  it('a catch-up that brings back an edit — nothing new — reaches the chat', async () => {
    const { result } = await openChat();
    mockGetThreadMessages.mockResolvedValueOnce({
      ok: true, data: { threadId: 't-1', messages: [VIDEO('m-1'), { ...TEXT('m-0'), body: 'fixed', editedAt: '2026-10-14T10:05:00Z' }] },
    });
    await foregroundReturn();
    await waitFor(() => expect(result.current.messages.find((m) => m.id === 'm-0')).toMatchObject({ body: 'fixed' }));
  });

  it('a catch-up with nothing changed keeps the same array (no needless re-render)', async () => {
    const { result } = await openChat();
    const before = result.current.messages;
    mockGetThreadMessages.mockResolvedValueOnce({ ok: true, data: { threadId: 't-1', messages: [VIDEO('m-1'), TEXT('m-0')] } });
    await foregroundReturn();
    await waitFor(() => expect(mockGetThreadMessages).toHaveBeenCalledTimes(2));
    expect(result.current.messages).toBe(before);
  });

  it('the viewer\'s own delete stops playback', async () => {
    const { result } = await openChat();
    expect(openMessageVideo({ mediaRef: REF })).toBe(true);
    mockDeleteMessage.mockResolvedValueOnce({ ok: true, data: { id: 'm-1', deleted: true } });
    await act(async () => { await result.current.remove('m-1'); });
    expect(getCompactPlayback()).toBeNull();
    expect(lastPlaybackStopReason()).toBe('message_gone');
  });

  it('losing access (removed while away) stops playback', async () => {
    const { result } = await openChat();
    expect(openMessageVideo({ mediaRef: REF })).toBe(true);
    mockGetThreadMessages.mockResolvedValueOnce({ ok: false, data: null, errorKind: 'forbidden' });
    await foregroundReturn();
    await waitFor(() => expect(result.current.state).toBe('no_access'));
    expect(getCompactPlayback()).toBeNull();
    expect(lastPlaybackStopReason()).toBe('source_closed');
  });
});
