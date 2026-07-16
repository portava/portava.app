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

const UNREAD_POLL_MS = 15_000;
const NOTIF_POLL_MS  = 30_000;
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

  const silentPoll = useCallback(async () => {
    if (appStateRef.current !== 'active') return;
    const res = await listNotifications({ ...params, limit, offset: 0 });
    if (res.ok && res.data) {
      setNotifications(res.data.notifications);
      setTotal(res.data.total);
    }
  }, [JSON.stringify(params), limit]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      appStateRef.current = next;
      if (next === 'active') silentPoll();
    });
    const timer = setInterval(silentPoll, NOTIF_POLL_MS);
    return () => { sub.remove(); clearInterval(timer); };
  }, [silentPoll]);

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

  return { count, refresh };
}

// ── useRecentNotifications (for bell popover) ─────────────────────────────────

export function useRecentNotifications() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const items = await getRecentNotifications();
    setNotifications(items);
    setLoading(false);
  }, []);

  return { notifications, loading, reload };
}

// ── useNotificationStream ─────────────────────────────────────────────────────
// Connects to the SSE notification stream endpoint and fires in-app toast banners
// for every `notification.created` event received while the app is in the foreground.
// Uses XMLHttpRequest (React Native compatible; EventSource is not available).

export function useNotificationStream() {
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const parsedIdxRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const connect = useCallback(async () => {
    if (!activeRef.current) return;
    if (appStateRef.current !== 'active') return;

    const token = await freshToken();
    const base = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (!token || !base) return;

    xhrRef.current?.abort();
    parsedIdxRef.current = 0;

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;

    xhr.open('GET', `${base}/api/me/notifications/stream`, true);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Accept', 'text/event-stream');
    xhr.setRequestHeader('Cache-Control', 'no-cache');

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
