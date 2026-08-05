/**
 * useNotifications — hooks for the Activity Center and notification bell.
 *
 * Polling interval respects app foreground state (same pattern as useMessaging).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  listNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  getRecentNotifications,
  getNotificationPreferences,
  updateNotificationPreferences,
  type AppNotification,
  type NotificationCategory,
  type NotificationPreferences,
  type CategoryPreference,
  type ListNotificationsParams,
} from '../services/notifications.ts';
import { getDeviceTimezone } from '../services/pushTokenService.ts';
import { freshToken } from '../services/apiToken.ts';
import { showNotificationToast } from '../components/NotificationToast.tsx';
import { _connectOnce } from './notificationStreamUtils.ts';
import { emitNotificationEvent, subscribeNotificationEvents } from '../services/notificationEvents.ts';

// Poll intervals are relaxed because the SSE-fed notification event bus
// (subscribeNotificationEvents) delivers realtime updates; polling is now a
// slow safety net for missed events.
const UNREAD_POLL_MS = 60_000;
const NOTIF_POLL_MS  = 120_000;
const SSE_RECONNECT_MS = 5_000;

// ── useNotifications ──────────────────────────────────────────────────────────

export function useNotifications(params: ListNotificationsParams = {}) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const offsetRef = useRef(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const limit = params.limit ?? 20;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    offsetRef.current = 0;
    const res = await listNotifications({ ...params, limit, offset: 0 });
    if (res.ok && res.data) {
      setNotifications(res.data.notifications);
      setTotal(res.data.total);
    } else {
      setError(res.message ?? 'Failed to load notifications');
    }
    setLoading(false);
  }, [JSON.stringify(params), limit]);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    const nextOffset = offsetRef.current + limit;
    if (nextOffset >= total) return;
    setLoadingMore(true);
    const res = await listNotifications({ ...params, limit, offset: nextOffset });
    if (res.ok && res.data) {
      setNotifications((prev) => [...prev, ...res.data!.notifications]);
      setTotal(res.data.total);
      offsetRef.current = nextOffset;
    }
    setLoadingMore(false);
  }, [params, limit, total, loadingMore]);

  const refetchFirstPage = useCallback(async () => {
    const res = await listNotifications({ ...params, limit, offset: 0 });
    if (res.ok && res.data) {
      setNotifications(res.data.notifications);
      setTotal(res.data.total);
      // The list now holds exactly page 1, so pagination must restart from 0 —
      // otherwise the next loadMore would skip the pages the replace dropped.
      offsetRef.current = 0;
    }
  }, [JSON.stringify(params), limit]);

  const silentPoll = useCallback(async () => {
    if (appStateRef.current !== 'active') return;
    await refetchFirstPage();
  }, [refetchFirstPage]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      appStateRef.current = next;
      if (next === 'active') silentPoll();
    });
    const timer = setInterval(silentPoll, NOTIF_POLL_MS);
    return () => { sub.remove(); clearInterval(timer); };
  }, [silentPoll]);

  // Realtime: refresh the list the moment a notification arrives on the bus.
  // No foreground guard — receiving an SSE event implies the stream is live.
  useEffect(() => {
    return subscribeNotificationEvents(() => { refetchFirstPage(); });
  }, [refetchFirstPage]);

  const markRead = useCallback(async (id: string) => {
    await markNotificationRead(id);
    setNotifications((prev) =>
      prev.map((n) => n.id === id ? { ...n, readAt: new Date().toISOString() } : n),
    );
  }, []);

  const markAllRead = useCallback(async (category?: NotificationCategory) => {
    await markAllNotificationsRead(category);
    const now = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((n) => (!n.readAt && (!category || n.category === category)) ? { ...n, readAt: now } : n),
    );
  }, []);

  const dismiss = useCallback(async (id: string) => {
    await dismissNotification(id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const unreadCount = notifications.filter((n) => !n.readAt).length;

  return { notifications, total, loading, error, loadingMore, unreadCount, reload, loadMore, markRead, markAllRead, dismiss };
}

// ── useUnreadNotificationCount ────────────────────────────────────────────────

export function useUnreadNotificationCount() {
  const [count, setCount] = useState(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const refresh = useCallback(async () => {
    const c = await getUnreadNotificationCount();
    setCount(c);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      appStateRef.current = next;
      if (next === 'active') refresh();
    });
    const timer = setInterval(() => {
      if (appStateRef.current === 'active') refresh();
    }, UNREAD_POLL_MS);
    return () => { sub.remove(); clearInterval(timer); };
  }, [refresh]);

  // Realtime: bump the badge immediately on a bus event, then reconcile with
  // the server count (the optimistic bump covers SSE→DB read lag).
  useEffect(() => {
    return subscribeNotificationEvents(() => {
      setCount((c) => c + 1);
      refresh();
    });
  }, [refresh]);

  return { count, refresh };
}

// ── useRecentNotifications (for bell popover) ─────────────────────────────────

export function useRecentNotifications() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  // Ids prepended optimistically from SSE payloads that the server hasn't
  // confirmed yet — preserved across reconciling refetches so a stale server
  // read (SSE→DB lag) can't silently drop a just-arrived notification.
  const optimisticIdsRef = useRef<Set<string>>(new Set());
  // Monotonic fetch sequence so an older refetch resolving late can't
  // overwrite the result of a newer one.
  const fetchSeqRef = useRef(0);

  /** Merge a server list with still-pending optimistic entries. */
  const applyServerList = useCallback((items: AppNotification[]) => {
    setNotifications((prev) => {
      const serverIds = new Set(items.map((n) => n.id));
      for (const id of optimisticIdsRef.current) {
        if (serverIds.has(id)) optimisticIdsRef.current.delete(id);
      }
      const pending = prev.filter((n) => optimisticIdsRef.current.has(n.id));
      return pending.length ? [...pending, ...items] : items;
    });
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const seq = ++fetchSeqRef.current;
    const items = await getRecentNotifications();
    if (seq === fetchSeqRef.current) applyServerList(items);
    setLoading(false);
  }, [applyServerList]);

  // Realtime: optimistically prepend the arriving notification (the SSE payload
  // carries the full record) so an open popover updates with zero latency, then
  // reconcile silently with the server (covers SSE→DB read lag). Mirrors the
  // optimistic bump pattern in useUnreadNotificationCount.
  useEffect(() => {
    return subscribeNotificationEvents((event) => {
      if (event.id) {
        setNotifications((prev) => {
          if (prev.some((n) => n.id === event.id)) return prev;
          optimisticIdsRef.current.add(event.id!);
          return [event as AppNotification, ...prev];
        });
      }
      const seq = ++fetchSeqRef.current;
      getRecentNotifications()
        .then((items) => { if (seq === fetchSeqRef.current) applyServerList(items); })
        .catch(() => { /* keep current list */ });
    });
  }, [applyServerList]);

  return { notifications, loading, reload };
}

// ── useNotificationStream ─────────────────────────────────────────────────────
// Connects to the SSE notification stream endpoint and fires in-app toast banners
// for every `notification.created` event received while the app is in the foreground.
// Uses XMLHttpRequest (React Native compatible; EventSource is not available).
// See notificationStreamUtils.ts for the testable _connectOnce helper.

export function useNotificationStream() {
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const parsedIdxRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const connect = useCallback(async () => {
    if (!activeRef.current) return;
    if (appStateRef.current !== 'active') return;

    let token: string | null;
    try {
      token = await freshToken();
    } catch {
      // freshToken threw (network error, Supabase client failure) — stop silently.
      return;
    }
    const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? null;

    xhrRef.current?.abort();
    parsedIdxRef.current = 0;

    const xhr = _connectOnce(token, base);
    if (!xhr) return;
    xhrRef.current = xhr;

    xhr.onprogress = () => {
      const text = xhr.responseText;
      const newChunk = text.slice(parsedIdxRef.current);
      parsedIdxRef.current = text.length;
      const lines = newChunk.split('\n');
      let eventName = '';
      let dataStr = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventName = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          dataStr = line.slice(6).trim();
        } else if (line === '' && eventName && dataStr) {
          if (eventName === 'notification.created') {
            try {
              const notification = JSON.parse(dataStr) as AppNotification;
              showNotificationToast(notification);
              emitNotificationEvent(notification as unknown as import('../services/notificationEvents.ts').NotificationCreatedEvent);
            } catch { /* ignore parse errors */ }
          }
          eventName = '';
          dataStr = '';
        }
      }
    };

    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4 && activeRef.current) {
        // Connection ended — schedule reconnect
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(connect, SSE_RECONNECT_MS);
      }
    };

    xhr.onerror = () => {
      if (!activeRef.current) return;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(connect, SSE_RECONNECT_MS);
    };

    xhr.send();
  }, []);

  useEffect(() => {
    activeRef.current = true;
    connect();

    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      appStateRef.current = next;
      if (next === 'active') {
        connect();
      } else {
        xhrRef.current?.abort();
        xhrRef.current = null;
      }
    });

    return () => {
      activeRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      xhrRef.current?.abort();
      xhrRef.current = null;
      sub.remove();
    };
  }, [connect]);
}

// ── useNotificationPreferences ────────────────────────────────────────────────

export function useNotificationPreferences() {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [categoryPreferences, setCategoryPreferences] = useState<CategoryPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getNotificationPreferences();
    if (res.ok && res.data) {
      setPreferences(res.data.preferences);
      setCategoryPreferences(res.data.categoryPreferences);
    } else {
      setError(res.message ?? 'Failed to load preferences');
    }
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const save = useCallback(async (
    patch: Partial<Omit<NotificationPreferences, 'userId'>> & {
      categoryPreferences?: CategoryPreference[];
    },
  ) => {
    setSaving(true);
    // Always sync the device's IANA timezone alongside preference saves so
    // quiet hours run in the user's local time without manual setup.
    const timezone = getDeviceTimezone();
    const body =
      timezone && (patch as { timezone?: string | null }).timezone === undefined
        ? { ...patch, timezone }
        : patch;
    const res = await updateNotificationPreferences(body);
    if (res.ok && res.data) {
      setPreferences(res.data.preferences ?? preferences);
    }
    setSaving(false);
    return res.ok;
  }, [preferences]);

  return { preferences, categoryPreferences, loading, saving, error, reload, save };
}
