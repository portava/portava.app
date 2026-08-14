/**
 * useNotifications event-bus integration tests.
 *
 * Run with: pnpm --dir travel-buddy-standalone test:component -- --testPathPattern=useNotifications.eventBus
 *
 * The in-app notification event bus (src/services/notificationEvents.ts) is fed
 * by the SSE stream. These tests confirm that the polling hooks also react to
 * bus events in realtime:
 *
 *  1. useUnreadNotificationCount bumps optimistically on a bus event, then
 *     reconciles with the server count.
 *  2. useNotifications (Activity Center list) re-fetches when a bus event fires.
 *  3. Unmounted hooks no longer react to bus events (unsubscribed on cleanup).
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';
import {
  useNotifications,
  useUnreadNotificationCount,
  useRecentNotifications,
} from '../useNotifications.ts';
import {
  emitNotificationEvent,
} from '../../services/notificationEvents.ts';
import {
  listNotifications,
  getUnreadNotificationCount,
  getRecentNotifications,
} from '../../services/notifications.ts'; // eslint-disable-line @typescript-eslint/no-unused-vars

// NOTE: intentionally exhaustive — the real module pulls in Supabase/network
// initialisation unavailable under Jest; the hooks under test only use the
// listed exports.
jest.mock('../../services/notifications.ts', () => ({
  listNotifications: jest.fn(),
  getUnreadNotificationCount: jest.fn(),
  markNotificationRead: jest.fn(),
  markAllNotificationsRead: jest.fn(),
  dismissNotification: jest.fn(),
  getRecentNotifications: jest.fn(),
  getNotificationPreferences: jest.fn(),
  updateNotificationPreferences: jest.fn(),
}));

// NOTE: intentionally exhaustive — the real module pulls in Supabase/network
// initialisation unavailable under Jest; the hooks under test only use the
// listed exports.
jest.mock('../../services/pushTokenService.ts', () => ({
  getDeviceTimezone: jest.fn(() => 'UTC'),
}));

// NOTE: intentionally exhaustive — the real module pulls in Supabase/network
// initialisation unavailable under Jest; the hooks under test only use the
// listed exports.
jest.mock('../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => null),
}));

// NOTE: intentionally exhaustive — the real module pulls in Supabase/network
// initialisation unavailable under Jest; the hooks under test only use the
// listed exports.
jest.mock('../../components/NotificationToast.tsx', () => ({
  showNotificationToast: jest.fn(),
}));

const mockList = listNotifications as jest.Mock;
const mockUnread = getUnreadNotificationCount as jest.Mock;
const mockRecent = getRecentNotifications as jest.Mock;

function notif(id: string, readAt: string | null = null) {
  return { id, category: 'social', eventType: 'x', title: 't', body: 'b', actionUrl: null, readAt, createdAt: new Date(0).toISOString() };
}

describe('useNotifications hooks — event-bus realtime updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockResolvedValue({ ok: true, data: { notifications: [notif('n1')], total: 1 } });
    mockUnread.mockResolvedValue(1);
    mockRecent.mockResolvedValue([notif('n1')]);
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it('useUnreadNotificationCount bumps immediately on a bus event, then reconciles with the server', async () => {
    const { result } = await renderHook(() => useUnreadNotificationCount());
    await waitFor(() => expect(result.current.count).toBe(1), { timeout: 500 });

    // Server now reports 2 unread; bus event fires.
    mockUnread.mockResolvedValue(2);
    await act(async () => {
      emitNotificationEvent({ id: 'n2' });
    });

    await waitFor(() => expect(result.current.count).toBe(2), { timeout: 500 });
    // refresh() was called to reconcile (initial mount + bus event = 2 calls).
    expect(mockUnread).toHaveBeenCalledTimes(2);
  });

  it('useNotifications re-fetches the list when a bus event fires', async () => {
    const { result } = await renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.notifications).toHaveLength(1), { timeout: 500 });
    const callsAfterMount = mockList.mock.calls.length;

    mockList.mockResolvedValue({ ok: true, data: { notifications: [notif('n2'), notif('n1')], total: 2 } });
    await act(async () => {
      emitNotificationEvent({ id: 'n2' });
    });

    await waitFor(() => expect(result.current.notifications).toHaveLength(2), { timeout: 500 });
    expect(mockList.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it('useRecentNotifications (bell popover) refreshes silently when a bus event fires', async () => {
    const { result } = await renderHook(() => useRecentNotifications());
    // Popover loads on demand.
    await act(async () => { await result.current.reload(); });
    expect(result.current.notifications).toHaveLength(1);

    mockRecent.mockResolvedValue([notif('n2'), notif('n1')]);
    await act(async () => {
      emitNotificationEvent({ id: 'n2' });
    });

    await waitFor(() => expect(result.current.notifications).toHaveLength(2), { timeout: 500 });
    // Silent refresh: loading must NOT flip back to true.
    expect(result.current.loading).toBe(false);
  });

  it('useRecentNotifications prepends the event payload instantly, before the refetch resolves', async () => {
    const { result } = await renderHook(() => useRecentNotifications());
    await act(async () => { await result.current.reload(); });
    expect(result.current.notifications).toHaveLength(1);

    // Refetch hangs (simulating SSE→DB read lag); the optimistic prepend must
    // land regardless.
    let resolveRecent!: (v: unknown) => void;
    mockRecent.mockReturnValue(new Promise((res) => { resolveRecent = res; }));
    await act(async () => {
      emitNotificationEvent(notif('n2'));
    });

    expect(result.current.notifications.map((n) => n.id)).toEqual(['n2', 'n1']);

    // Reconciling refetch resolves with the authoritative list.
    await act(async () => { resolveRecent([notif('n2'), notif('n1')]); });
    expect(result.current.notifications).toHaveLength(2);
  });

  it('useRecentNotifications keeps the optimistic entry when a stale refetch omits it', async () => {
    const { result } = await renderHook(() => useRecentNotifications());
    await act(async () => { await result.current.reload(); });

    // Server read lags behind SSE: reconciling refetch returns a stale list
    // that does not yet include n2.
    mockRecent.mockResolvedValue([notif('n1')]);
    await act(async () => {
      emitNotificationEvent(notif('n2'));
    });
    await act(async () => {});

    // The optimistic n2 must survive the stale overwrite.
    expect(result.current.notifications.map((n) => n.id)).toEqual(['n2', 'n1']);

    // A later refetch that includes n2 confirms it (no duplicate, server order).
    mockRecent.mockResolvedValue([notif('n2'), notif('n1')]);
    await act(async () => {
      emitNotificationEvent(notif('n3', null));
    });
    await act(async () => {});
    expect(result.current.notifications.filter((n) => n.id === 'n2')).toHaveLength(1);
  });

  it('useRecentNotifications does not duplicate a notification already in the list', async () => {
    const { result } = await renderHook(() => useRecentNotifications());
    await act(async () => { await result.current.reload(); });

    mockRecent.mockReturnValue(new Promise(() => { /* never resolves */ }));
    await act(async () => {
      emitNotificationEvent(notif('n1'));
    });

    expect(result.current.notifications.map((n) => n.id)).toEqual(['n1']);
  });

  it('useRecentNotifications stops reacting to bus events after unmount', async () => {
    const { result, unmount } = await renderHook(() => useRecentNotifications());
    await act(async () => { await result.current.reload(); });
    const callsBefore = mockRecent.mock.calls.length;

    await act(async () => { unmount(); });
    emitNotificationEvent({ id: 'n4' });
    await act(async () => {});

    expect(mockRecent.mock.calls.length).toBe(callsBefore);
  });

  it('stops reacting to bus events after unmount (unsubscribes on cleanup)', async () => {
    const { result, unmount } = await renderHook(() => useUnreadNotificationCount());
    await waitFor(() => expect(result.current.count).toBe(1), { timeout: 500 });
    const callsBefore = mockUnread.mock.calls.length;

    await act(async () => { unmount(); });
    emitNotificationEvent({ id: 'n3' });
    await act(async () => {});

    expect(mockUnread.mock.calls.length).toBe(callsBefore);
  });
});
