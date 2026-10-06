/**
 * useThreadMessages — notifyTyping sends TRANSITIONS, throttled (census T239,
 * re-verification R3, 2026-10-06).
 *
 * THE DEFECT. Under a constrained connection the conversation screen calls
 * `notifyTyping(false)` on every keystroke (typing notifications follow the
 * data-saver ladder, app/messages/[id].tsx), and the hook sent
 * `POST /threads/:id/typing {typing:false}` EVERY time — only the "is typing"
 * edge was throttled. The ladder meant to shed typing traffic multiplied it:
 * one request per keystroke, all saying the same thing.
 *
 * Pinned: "stopped" is sent only when "typing" was the last thing this device
 * said (one POST per state transition); "typing" stays at most one per 2 s; so
 * neither edge exceeds one POST per throttle window, however fast the keys.
 */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useThreadMessages } from '../useMessaging.ts';

// NOTE: intentionally exhaustive — imports AsyncStorage + SessionContext; the
// snapshot layer is not under test. ONE stable object: a fresh `save` per
// render would re-fire the hook's effects forever.
jest.mock('../useSnapshotCache.ts', () => {
  const cache = { snapshot: null, isStale: false, save: jest.fn(), clear: jest.fn() };
  return { useSnapshotCache: () => cache };
});

// NOTE: intentionally exhaustive — SessionContext boots the Supabase client
// which requires network/env vars unavailable in jest-expo.
jest.mock('../../context/SessionContext.tsx', () => {
  const session = { userId: 'user-me', isAuthed: true };
  return { useSession: () => session };
});

// NOTE: intentionally exhaustive — imports the Supabase client and API token
// stack; pulling requireActual would trigger live network requests.
jest.mock('../../services/messaging.ts', () => ({
  getThreadMessages:            jest.fn(async () => ({ ok: true, data: { messages: [] } })),
  sendMessage:                  jest.fn(),
  sendTyping:                   jest.fn(async () => undefined),
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

// NOTE: intentionally exhaustive — the realtime service opens a WebSocket
// connection on import; the mock prevents that from happening in CI.
jest.mock('../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: {
    subscribe: jest.fn(() => jest.fn()),
  },
}));

const { sendTyping, getThreadMessages } = require('../../services/messaging.ts');
const mockSendTyping = sendTyping as jest.Mock;
const mockGetThreadMessages = getThreadMessages as jest.Mock;

// The throttle reads Date.now(). The clock is frozen only AFTER the hook has
// mounted: RNTL's waitFor measures its own timeout with the same clock.
const realNow = Date.now;
let clock = 0;

beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(async () => {
  Date.now = realNow;
  await act(async () => {});
});

async function mounted() {
  const hook = await renderHook(() => useThreadMessages('thread-1'));
  await waitFor(() => expect(mockGetThreadMessages).toHaveBeenCalled());
  clock = realNow();
  Date.now = () => clock;
  return hook;
}
const posts = () => mockSendTyping.mock.calls.map((c) => c[1] as boolean);

describe('R3: a constrained connection sends no typing POST per keystroke', () => {
  it('"not typing" on every keystroke, never having said "typing": NO request at all', async () => {
    const { result } = await mounted();
    for (let i = 0; i < 20; i++) {
      await act(async () => { result.current.notifyTyping(false); });
      clock += 150;
    }
    expect(posts()).toEqual([]);
  });

  it('the connection turns constrained mid-message: ONE "stopped", then silence', async () => {
    const { result } = await mounted();
    await act(async () => { result.current.notifyTyping(true); });
    for (let i = 0; i < 20; i++) {
      clock += 150;
      await act(async () => { result.current.notifyTyping(false); });
    }
    expect(posts()).toEqual([true, false]);
  });

  it('"typing" stays throttled to one per 2 s, and a stop after it is sent once', async () => {
    const { result } = await mounted();
    for (let i = 0; i < 10; i++) {
      await act(async () => { result.current.notifyTyping(true); });
      clock += 150; // 1.5 s of keystrokes
    }
    expect(posts()).toEqual([true]);
    clock += 600; // past the 2 s window
    await act(async () => { result.current.notifyTyping(true); });
    expect(posts()).toEqual([true, true]);
    await act(async () => { result.current.notifyTyping(false); });
    await act(async () => { result.current.notifyTyping(false); });
    expect(posts()).toEqual([true, true, false]);
  });

  it('flapping (type a letter, delete it, again…) is at most one POST per edge per 2 s window', async () => {
    const { result } = await mounted();
    for (let i = 0; i < 40; i++) {
      await act(async () => { result.current.notifyTyping(i % 2 === 0); });
      clock += 100; // 4 s in all
    }
    const sent = posts();
    // 4 s of flapping: two "typing" windows, each followed by one "stopped".
    expect(sent.filter((t) => t === true).length).toBeLessThanOrEqual(2);
    expect(sent.filter((t) => t === false).length).toBeLessThanOrEqual(2);
    // A "stopped" is only ever a transition: it follows a "typing", never another "stopped".
    sent.forEach((t, i) => { if (t === false) expect(sent[i - 1]).toBe(true); });
  });
});
