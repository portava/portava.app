/**
 * useThreadMessages — optimistic message snapshot filter
 *
 * Confirms that reload() does NOT write optimistic (deliveryStatus: 'sending')
 * messages into the thread snapshot.  The guard inside reload():
 *
 *   const toCache = msgs.filter(
 *     (m) => m.deliveryStatus !== 'sending' && m.deliveryStatus !== 'failed',
 *   );
 *   saveSnapshot(toCache);
 *
 * must hold even when an in-flight send() has already appended a 'sending'
 * placeholder to the React message state.
 *
 * Coverage:
 *   1. After send() appends an optimistic placeholder, reload() only writes
 *      confirmed server messages to the snapshot — the 'sending' placeholder
 *      is not included.
 *   2. If the server response itself hypothetically carries a message whose
 *      deliveryStatus is 'sending' (a regression scenario), saveSnapshot still
 *      does not receive it.
 *   3. The snapshot save is still called with all confirmed server messages —
 *      the filter is surgical, not a blanket skip.
 *
 * Strategy:
 *   - useSnapshotCache is fully mocked; its `save` function is a jest.fn() spy
 *     so we can assert exactly what data reached AsyncStorage.
 *   - sendMessage is given a never-resolving Promise so the optimistic
 *     placeholder stays in the 'sending' state for the full test duration.
 *   - getThreadMessages is mocked to return a controlled server response.
 *
 * Run with: pnpm test:component
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useThreadMessages } from '../useMessaging.ts';
import type { Message } from '../../services/messaging.ts';

// ── useSnapshotCache ──────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — imports AsyncStorage + SessionContext; the
// real hook layer is not needed here: we drive snapshot state via the mock's
// return value so the effect never touches native storage.
jest.mock('../useSnapshotCache.ts', () => ({
  useSnapshotCache: jest.fn(),
}));

// ── SessionContext ────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — SessionContext boots the Supabase client
// which requires network/env vars unavailable in jest-expo.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: jest.fn(),
}));

// ── services/messaging ────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — imports the Supabase client and API token
// stack; pulling requireActual would trigger live network requests.
jest.mock('../../services/messaging.ts', () => ({
  getThreadMessages:            jest.fn(),
  sendMessage:                  jest.fn(),
  sendTyping:                   jest.fn(),
  getMessagePermission:         jest.fn(),
  sendMessageRequest:           jest.fn(),
  getIncomingMessageRequests:   jest.fn(),
  getOutgoingRequestStatus:     jest.fn(),
  acceptMessageRequest:         jest.fn(),
  declineMessageRequest:        jest.fn(),
  getMyThreads:                 jest.fn(),
  getUnreadCounts:              jest.fn(),
  markThreadRead:               jest.fn(),
  markHighlightsViewed:         jest.fn(),
  retryTranslation:             jest.fn(),
  getMyLanguageSettings:        jest.fn(),
  updateMyLanguageSettings:     jest.fn(),
}));

// ── telegraphRealtimeService ──────────────────────────────────────────────────
// NOTE: intentionally exhaustive — the realtime service opens a WebSocket
// connection on import; the mock prevents that from happening in CI.
jest.mock('../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: {
    subscribe: jest.fn(() => jest.fn()),
  },
}));

// ── Typed mock handles ────────────────────────────────────────────────────────

const { useSnapshotCache }               = require('../useSnapshotCache.ts');
const { useSession }                     = require('../../context/SessionContext.tsx');
const { getThreadMessages, sendMessage } = require('../../services/messaging.ts');

const mockUseSnapshotCache  = useSnapshotCache  as jest.Mock;
const mockUseSession        = useSession        as jest.Mock;
const mockGetThreadMessages = getThreadMessages as jest.Mock;
const mockSendMessage       = sendMessage       as jest.Mock;

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeConfirmedMessage(id: string, body = `body-${id}`): Message {
  return {
    id,
    clientId:           null,
    threadId:           'thread-1',
    senderId:           'user-server',
    senderHandle:       null,
    senderName:         null,
    senderAvatarUrl:    null,
    body,
    deleted:            false,
    createdAt:          '2025-01-01T10:00:00Z',
    editedAt:           null,
    displayBody:        body,
    originalBody:       body,
    originalLanguage:   null,
    translated:         false,
    translationStatus:  null,
    translationLabel:   null,
    canShowOriginal:    false,
    msgType:            'text',
    subtype:            null,
    replyToId:          null,
    replyToBody:        null,
    replyToSenderName:  null,
    deliveryStatus:     'sent',
  };
}

/**
 * Wraps messages in the shape getThreadMessages resolves with.
 * The hook calls `[...messages].reverse()` internally, so pass messages
 * in newest-first order; the hook will reverse them to oldest-first for state.
 */
function makeThreadResponse(messages: Message[]) {
  return {
    ok:   true,
    data: { messages: [...messages].reverse() },
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('useThreadMessages — optimistic message excluded from snapshot', () => {
  let saveSpy: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Authenticated user.
    mockUseSession.mockReturnValue({ userId: 'user-me', isAuthed: true });

    // Snapshot cache: no pre-existing snapshot; capture save() calls.
    saveSpy = jest.fn();
    mockUseSnapshotCache.mockReturnValue({
      snapshot: null,
      isStale:  false,
      save:     saveSpy,
      clear:    jest.fn(),
    });

    // Default server response: two confirmed messages.
    mockGetThreadMessages.mockResolvedValue(
      makeThreadResponse([makeConfirmedMessage('msg-1'), makeConfirmedMessage('msg-2')]),
    );

    // sendMessage never resolves — the optimistic placeholder stays 'sending'.
    mockSendMessage.mockReturnValue(new Promise(() => {}));
  });

  afterEach(async () => {
    // Drain residual async state updates to prevent cross-test bleed.
    await act(async () => {});
  });

  it('does not write the optimistic placeholder into the snapshot after reload()', async () => {
    const { result } = await renderHook(() => useThreadMessages('thread-1'));

    // Wait for the initial reload() to complete and save the snapshot.
    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1);
    }, { timeout: 1000 });

    // Verify the initial snapshot only has confirmed messages.
    const firstSave: Message[] = saveSpy.mock.calls[0][0];
    expect(firstSave.every((m) => m.deliveryStatus !== 'sending')).toBe(true);

    // Trigger send() — appends an optimistic placeholder ('sending') to React state.
    // sendMessage never resolves, so the placeholder stays 'sending' indefinitely.
    await act(async () => {
      void result.current.send('Hello from client');
    });

    // The optimistic message must now be visible in the hook's message state.
    await waitFor(() => {
      expect(
        result.current.messages.some((m) => m.deliveryStatus === 'sending'),
      ).toBe(true);
    }, { timeout: 500 });

    // Update the server response to include a new confirmed message.
    const confirmed3 = makeConfirmedMessage('msg-3');
    mockGetThreadMessages.mockResolvedValue(
      makeThreadResponse([makeConfirmedMessage('msg-1'), makeConfirmedMessage('msg-2'), confirmed3]),
    );
    saveSpy.mockClear();

    // Trigger reload() — this is the path under test.
    await act(async () => {
      await result.current.reload();
    });

    // saveSnapshot must have been called exactly once with only confirmed messages.
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const savedMessages: Message[] = saveSpy.mock.calls[0][0];

    // No 'sending' or 'failed' entries must be present.
    const optimisticInSnapshot = savedMessages.filter(
      (m) => m.deliveryStatus === 'sending' || m.deliveryStatus === 'failed',
    );
    expect(optimisticInSnapshot).toHaveLength(0);

    // All three confirmed server messages must be present.
    expect(savedMessages).toHaveLength(3);
    expect(savedMessages.map((m) => m.id)).toEqual(
      expect.arrayContaining(['msg-1', 'msg-2', 'msg-3']),
    );
  });

  it('filters a hypothetical server-returned sending message from the snapshot', async () => {
    // Simulate a regression where the server somehow echoes back a message
    // with deliveryStatus 'sending' — reload() must still filter it out.
    const confirmedMsg = makeConfirmedMessage('msg-ok');
    const rogueMsg: Message = {
      ...makeConfirmedMessage('msg-rogue'),
      deliveryStatus: 'sending' as const,
    };
    mockGetThreadMessages.mockResolvedValue(makeThreadResponse([confirmedMsg, rogueMsg]));

    await renderHook(() => useThreadMessages('thread-1'));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1);
    }, { timeout: 1000 });

    const savedMessages: Message[] = saveSpy.mock.calls[0][0];

    // The rogue 'sending' entry must not appear in the snapshot.
    expect(savedMessages.find((m) => m.id === 'msg-rogue')).toBeUndefined();
    // The confirmed entry must be present.
    expect(savedMessages.find((m) => m.id === 'msg-ok')).toBeDefined();
    expect(savedMessages.every((m) => m.deliveryStatus !== 'sending')).toBe(true);
  });

  it('saves all confirmed server messages — the filter is surgical, not a blanket skip', async () => {
    const messages = ['a', 'b', 'c', 'd', 'e'].map((id) => makeConfirmedMessage(id));
    mockGetThreadMessages.mockResolvedValue(makeThreadResponse(messages));

    await renderHook(() => useThreadMessages('thread-1'));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1);
    }, { timeout: 1000 });

    const savedMessages: Message[] = saveSpy.mock.calls[0][0];
    expect(savedMessages).toHaveLength(5);
    expect(savedMessages.every((m) => m.deliveryStatus === 'sent')).toBe(true);
  });
});
