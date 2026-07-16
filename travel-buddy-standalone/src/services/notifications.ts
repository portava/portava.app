/**
 * notifications.ts — typed client over the notifications API.
 *
 * Covers:
 *   - List notifications (paginated, filterable)
 *   - Unread count
 *   - Mark read / dismiss
 *   - Notification preferences (read + update)
 *   - Device registration (push token)
 */
import { supabase } from '../lib/supabase';

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

async function apiFetch<T>(
  path: string,
  opts?: RequestInit,
): Promise<{ ok: boolean; data: T | null; message?: string }> {
  const base = apiBase();
  if (!base) return { ok: false, data: null, message: 'API not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, message: 'Not authenticated' };

  try {
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts?.headers ?? {}),
      },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, data: null, message: (json as any)?.message ?? `HTTP ${res.status}` };
    return { ok: true, data: json as T };
  } catch (err: any) {
    return { ok: false, data: null, message: err?.message ?? 'Network error' };
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type NotificationCategory =
  | 'plans' | 'trips' | 'telegraph' | 'safe_return' | 'location' | 'trip_crew'
  | 'compass' | 'pulse' | 'passport' | 'hidden_gems' | 'trust' | 'airport' | 'admin'
  | 'rent_buddy';

export type NotificationPriority = 'urgent' | 'important' | 'normal' | 'low';

export interface AppNotification {
  id: string;
  userId: string;
  category: NotificationCategory;
  eventType: string;
  priority: NotificationPriority;
  title: string;
  body: string;
  actionUrl: string | null;
  imageUrl: string | null;
  sourceType: string | null;
  sourceId: string | null;
  actorId: string | null;
  metadata: Record<string, unknown>;
  privacyLevel: string;
  readAt: string | null;
  dismissedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface NotificationPreferences {
  userId: string;
  pushEnabled: boolean;
  emailEnabled: boolean;
  inAppEnabled: boolean;
  digestsEnabled: boolean;
  safetyOverride: boolean;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  messagePreviews: boolean;
  locationPreviews: boolean;
}

export interface CategoryPreference {
  category: NotificationCategory;
  inAppEnabled: boolean;
  pushEnabled: boolean;
  emailEnabled: boolean;
  digestEnabled: boolean;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export interface ListNotificationsParams {
  category?: NotificationCategory;
  priority?: NotificationPriority;
  unread?: boolean;
  limit?: number;
  offset?: number;
  since?: string;
}

export async function listNotifications(
  params: ListNotificationsParams = {},
): Promise<{ ok: boolean; data: { notifications: AppNotification[]; total: number } | null; message?: string }> {
  const qs = new URLSearchParams();
  if (params.category) qs.set('category', params.category);
  if (params.priority) qs.set('priority', params.priority);
  if (params.unread)   qs.set('unread', 'true');
  if (params.limit)    qs.set('limit', String(params.limit));
  if (params.offset)   qs.set('offset', String(params.offset));
  if (params.since)    qs.set('since', params.since);
  const q = qs.toString();
  return apiFetch(`/api/me/notifications${q ? `?${q}` : ''}`);
}

export async function getUnreadNotificationCount(): Promise<number> {
  const res = await apiFetch<{ unreadCount: number }>('/api/me/notifications/unread-count');
  return res.ok ? (res.data?.unreadCount ?? 0) : 0;
}

export async function markNotificationRead(notificationId: string): Promise<boolean> {
  const res = await apiFetch(`/api/me/notifications/${notificationId}/read`, { method: 'POST' });
  return res.ok;
}

export async function markAllNotificationsRead(category?: NotificationCategory): Promise<boolean> {
  const res = await apiFetch<{ marked: number }>('/api/me/notifications/read-all', {
    method: 'POST',
    body: category ? JSON.stringify({ category }) : JSON.stringify({}),
  });
  return res.ok;
}

export async function dismissNotification(notificationId: string): Promise<boolean> {
  const res = await apiFetch(`/api/me/notifications/${notificationId}/dismiss`, { method: 'POST' });
  return res.ok;
}

export async function getNotificationPreferences(): Promise<{
  ok: boolean;
  data: { preferences: NotificationPreferences; categoryPreferences: CategoryPreference[] } | null;
  message?: string;
}> {
  return apiFetch('/api/me/notification-preferences');
}

export async function updateNotificationPreferences(
  prefs: Partial<Omit<NotificationPreferences, 'userId'>> & {
    categoryPreferences?: Array<{
      category: NotificationCategory;
      inAppEnabled?: boolean;
      pushEnabled?: boolean;
      emailEnabled?: boolean;
      digestEnabled?: boolean;
    }>;
  },
): Promise<{ ok: boolean; data: any; message?: string }> {
  return apiFetch('/api/me/notification-preferences', {
    method: 'PUT',
    body: JSON.stringify(prefs),
  });
}

export async function registerDevice(pushToken: string, platform: 'expo' | 'apns' | 'fcm' = 'expo'): Promise<boolean> {
  const res = await apiFetch('/api/me/devices', {
    method: 'POST',
    body: JSON.stringify({ pushToken, platform }),
  });
  return res.ok;
}

export async function unregisterDevice(deviceId: string): Promise<boolean> {
  const res = await apiFetch(`/api/me/devices/${deviceId}`, { method: 'DELETE' });
  return res.ok;
}

/** Get up to 5 most recent notifications for the bell popover. */
export async function getRecentNotifications(): Promise<AppNotification[]> {
  const res = await listNotifications({ limit: 5 });
  return res.ok ? (res.data?.notifications ?? []) : [];
}
