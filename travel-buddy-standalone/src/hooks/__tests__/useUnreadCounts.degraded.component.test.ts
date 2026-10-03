/**
 * useUnreadCounts — a bucket the server could NOT count is not a zero.
 *
 * `GET /api/me/unread-counts` names, in `degraded`, every bucket whose read
 * failed (TELEGRAPH lane, 2026-10-03; server side pinned by
 * artifacts/api-server/src/test/telegraphInboxFailsLoud.test.ts). The numbers
 * stay numbers so an older client keeps working, but for a degraded bucket the
 * number is a placeholder. The hook used to copy every number into the badge,
 * so one failed notifications read cleared a badge that had been showing 4 —
 * a measured count overwritten by one nobody measured.
 *
 * WHAT TURNS THIS RED: setting a degraded bucket from the placeholder.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */

import { renderHook, act, cleanup } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { useUnreadCounts } from '../useMessaging.ts';

// NOTE: intentionally exhaustive — SessionContext boots the Supabase client.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'me-1' }),
}));

const mockGetUnreadCounts = jest.fn();
// NOTE: intentionally exhaustive — the real module imports the Supabase and
// API-token stack; this hook calls only getUnreadCounts.
jest.mock('../../services/messaging.ts', () => ({
  getUnreadCounts: (...a: unknown[]) => mockGetUnreadCounts(...a),
  markThreadRead: jest.fn(),
  markHighlightsViewed: jest.fn(),
}));

// NOTE: intentionally exhaustive — the realtime service opens a stream on import.
jest.mock('../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: { subscribe: () => () => {} },
}));

// The server's answer, as the next call will see it. Set, not queued: the hook
// may call more than once per step (mount, focus), and every call must see the
// same answer.
let mockAnswer: unknown = null;
const counts = (o: Record<string, unknown>) => ({ ok: true, data: { messages: 0, notifications: 0, meetups: 0, newHighlights: 0, ...o } });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUnreadCounts.mockImplementation(async () => mockAnswer);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((() => ({ remove: () => {} })) as never);
});

afterEach(async () => {
  await act(async () => {});
  cleanup();
  jest.restoreAllMocks();
});

async function mountWith(first: unknown) {
  mockAnswer = first;
  const h = await renderHook(() => useUnreadCounts());
  await act(async () => {});
  return h;
}

describe('useUnreadCounts — degraded buckets keep what was last measured', () => {
  it('a full answer sets every bucket', async () => {
    const h = await mountWith(counts({ messages: 3, notifications: 4, meetups: 1, newHighlights: 2 }));
    expect(h.result.current).toMatchObject({ messages: 3, notifications: 4, meetups: 1, newHighlights: 2 });
  });

  it('THE POINT: a bucket named in `degraded` is NOT overwritten by its placeholder zero', async () => {
    const h = await mountWith(counts({ messages: 3, notifications: 4, meetups: 1, newHighlights: 2 }));
    mockAnswer = counts({ messages: 5, notifications: 0, meetups: 0, newHighlights: 2, degraded: ['notifications', 'meetups'] });
    await act(async () => { await h.result.current.refresh(); });
    // The buckets that WERE counted move; the two that could not be counted hold.
    expect(h.result.current.messages).toBe(5);
    expect(h.result.current.notifications).toBe(4);
    expect(h.result.current.meetups).toBe(1);
    expect(h.result.current.newHighlights).toBe(2);
  });

  it.each(['messages', 'notifications', 'meetups', 'newHighlights'] as const)('the %s bucket is honoured on its own', async (bucket) => {
    const h = await mountWith(counts({ messages: 7, notifications: 7, meetups: 7, newHighlights: 7 }));
    mockAnswer = counts({ degraded: [bucket] });
    await act(async () => { await h.result.current.refresh(); });
    for (const b of ['messages', 'notifications', 'meetups', 'newHighlights'] as const) {
      expect([b, h.result.current[b]]).toEqual([b, b === bucket ? 7 : 0]);
    }
  });

  it('once the bucket can be counted again, its real number lands', async () => {
    const h = await mountWith(counts({ notifications: 4 }));
    mockAnswer = counts({ notifications: 0, degraded: ['notifications'] });
    await act(async () => { await h.result.current.refresh(); });
    expect(h.result.current.notifications).toBe(4);
    mockAnswer = counts({ notifications: 0 });
    await act(async () => { await h.result.current.refresh(); });
    expect(h.result.current.notifications).toBe(0);
  });

  it('CONTROL: a failed request changes nothing (as before)', async () => {
    const h = await mountWith(counts({ messages: 2 }));
    mockAnswer = { ok: false, data: null, errorKind: 'network_unreachable' };
    await act(async () => { await h.result.current.refresh(); });
    expect(h.result.current.messages).toBe(2);
  });
});
