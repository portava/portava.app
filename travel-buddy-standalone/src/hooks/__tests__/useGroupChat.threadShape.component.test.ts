/**
 * useGroupChat — thread-shape compatibility coverage.
 *
 * GET /trips/:tripId/chat (and the circle equivalent) is served by two
 * competing server handlers; the winning one returns a FLAT payload
 * ({ threadId, threadType, title, tripId, circleOwnerId }) with no thread
 * object and no messages array. The hook previously required data.thread and
 * flipped every trip/circle chat into the error state. These tests pin the
 * client-side fix: both shapes load — the flat shape synthesizes the
 * GroupThread and pulls the first message page via getThreadMessages
 * (endpoint returns newest-first; the hook reverses into chronological
 * order), while the nested shape keeps its original single-call path.
 *
 * NOTE: named `.component.test.ts` (not `.test.ts`) so Jest's
 * `test:component` pattern picks it up — renderHook needs the jest-expo
 * renderer, not node:test.
 */

import { renderHook, act, waitFor, cleanup } from '@testing-library/react-native';
import { useGroupChat } from '../useGroupChat.ts';

const mockGetTripChat = jest.fn();
const mockGetCircleChat = jest.fn();
const mockGetThreadMessages = jest.fn();

// NOTE: intentionally exhaustive — the real module touches Supabase/network;
// the hook only calls the functions stubbed here.
jest.mock('../../services/messaging.ts', () => ({
  getTripChat: (...a: unknown[]) => mockGetTripChat(...a),
  getCircleChat: (...a: unknown[]) => mockGetCircleChat(...a),
  getThreadMessages: (...a: unknown[]) => mockGetThreadMessages(...a),
  sendMessage: jest.fn(),
  editMessage: jest.fn(),
  deleteMessage: jest.fn(),
  sendTyping: jest.fn(),
}));

// NOTE: intentionally exhaustive — the hook only reads userId from useSession.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'me-1' }),
}));

// NOTE: intentionally exhaustive — subscribe must return an unsubscribe fn
// (plain function, not jest.fn, so resetAllMocks cannot wipe the impl).
jest.mock('../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: { subscribe: () => () => {} },
}));

const MSG = (id: string, createdAt: string) => ({
  id,
  threadId: 't-1',
  senderId: 'u-2',
  body: `body of ${id}`,
  createdAt,
  deleted: false,
  editedAt: null,
  msgType: 'text',
  subtype: null,
}) as any;

describe('useGroupChat — accepts both /chat payload shapes', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  afterEach(async () => {
    await act(async () => {});
    cleanup();
  });

  it('flat trip shape: synthesizes the thread and fetches the first message page', async () => {
    mockGetTripChat.mockResolvedValueOnce({
      ok: true,
      data: { threadId: 't-1', threadType: 'trip', title: 'Lisbon Crew', tripId: 'trip-9', circleOwnerId: null },
    });
    // Endpoint order is newest-first; the hook must reverse to chronological.
    mockGetThreadMessages.mockResolvedValueOnce({
      ok: true,
      data: { threadId: 't-1', messages: [MSG('m-2', '2026-08-02T10:00:00Z'), MSG('m-1', '2026-08-01T10:00:00Z')] },
    });

    const { result } = await renderHook(() => useGroupChat('trip', 'trip-9'));

    await waitFor(() => expect(result.current.state).toBe('active'));
    expect(mockGetTripChat).toHaveBeenCalledWith('trip-9');
    expect(mockGetThreadMessages).toHaveBeenCalledWith('t-1');
    expect(result.current.thread).toMatchObject({
      id: 't-1',
      threadType: 'trip',
      title: 'Lisbon Crew',
      tripId: 'trip-9',
      circleOwnerId: null,
      memberAccess: 'active',
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
  });

  it('flat circle shape: synthesizes the thread with the circle owner id', async () => {
    mockGetCircleChat.mockResolvedValueOnce({
      ok: true,
      data: { threadId: 't-5', threadType: 'circle', title: 'My Circle', tripId: null, circleOwnerId: 'owner-3' },
    });
    mockGetThreadMessages.mockResolvedValueOnce({ ok: true, data: { threadId: 't-5', messages: [] } });

    const { result } = await renderHook(() => useGroupChat('circle', 'owner-3'));

    await waitFor(() => expect(result.current.state).toBe('active'));
    expect(mockGetCircleChat).toHaveBeenCalledWith('owner-3');
    expect(result.current.thread).toMatchObject({
      id: 't-5',
      threadType: 'circle',
      circleOwnerId: 'owner-3',
      memberAccess: 'active',
    });
    expect(result.current.messages).toEqual([]);
  });

  it('nested {thread, messages} shape still loads without a second fetch', async () => {
    mockGetTripChat.mockResolvedValueOnce({
      ok: true,
      data: {
        thread: {
          id: 't-2', threadType: 'trip', tripId: 'trip-9', circleOwnerId: null,
          title: 'Nested Thread', status: 'active', lastMessageAt: null,
          createdAt: null, memberAccess: 'active',
        },
        messages: [MSG('m-1', '2026-08-01T10:00:00Z')],
      },
    });

    const { result } = await renderHook(() => useGroupChat('trip', 'trip-9'));

    await waitFor(() => expect(result.current.state).toBe('active'));
    expect(result.current.thread?.id).toBe('t-2');
    expect(result.current.messages.map((m) => m.id)).toEqual(['m-1']);
    expect(mockGetThreadMessages).not.toHaveBeenCalled();
  });

  it('flat shape with a failed message-page fetch still opens the chat (empty list)', async () => {
    mockGetTripChat.mockResolvedValueOnce({
      ok: true,
      data: { threadId: 't-3', threadType: 'trip', title: 'Trip', tripId: 'trip-9', circleOwnerId: null },
    });
    mockGetThreadMessages.mockResolvedValueOnce({ ok: false, data: null, errorKind: 'db_error' });

    const { result } = await renderHook(() => useGroupChat('trip', 'trip-9'));

    await waitFor(() => expect(result.current.state).toBe('active'));
    expect(result.current.thread?.id).toBe('t-3');
    expect(result.current.messages).toEqual([]);
  });

  it('payload with neither thread nor threadId flips to the error state', async () => {
    mockGetTripChat.mockResolvedValueOnce({ ok: true, data: null });

    const { result } = await renderHook(() => useGroupChat('trip', 'trip-9'));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.thread).toBeNull();
  });
});
