/**
 * Telegraph Intelligence Service Layer
 * API calls for: Daily Brief, Concierge Commands, Preferences, Feedback.
 *
 * Uses the same authedFetch / freshToken pattern as tripPlan.ts —
 * the token is fetched internally; callers do not need to pass it.
 */
import { Platform } from 'react-native';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

// AsyncStorage v2.x uses TurboModules (codegenNativeComponent) — not available on web.
// We lazy-require it only on native so the web bundle doesn't crash.
type AsyncStorageStub = { setItem(k: string, v: string): Promise<void>; getItem(k: string): Promise<string | null> };
const getStorage = (): AsyncStorageStub | null => {
  if (Platform.OS === 'web') return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@react-native-async-storage/async-storage').default as AsyncStorageStub;
};

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

const weatherKey = (tripId: string) => `weather_summary:${tripId}`;

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function authedFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshToken();
  return fetch(`${apiBase()}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

/* ── Daily Brief ──────────────────────────────────────────────────────────── */

export async function fetchDailyBrief(
  tripId: string,
  date?: string,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const qs = date ? `?date=${date}` : '';
    const res = await authedFetch(`/api/trips/${tripId}/daily-brief${qs}`);
    const data = await res.json();
    if (res.ok) {
      if (data.weatherSummary) {
        // Persist the latest summary so it survives Open-Meteo downtime
        getStorage()?.setItem(weatherKey(tripId), data.weatherSummary).catch(() => {});
      } else {
        // Open-Meteo unavailable — restore last known summary (best-effort)
        const cached = await getStorage()?.getItem(weatherKey(tripId));
        if (cached) data.weatherSummary = cached;
      }
    }
    return { ok: res.ok, data };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

export async function refreshDailyBrief(
  tripId: string,
  date?: string,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`/api/trips/${tripId}/daily-brief/refresh`, {
      method: 'POST',
      body: JSON.stringify(date ? { date } : {}),
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

export async function executeBriefAction(tripId: string, actionId: string): Promise<{ ok: boolean; data?: any }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false };
  try {
    const res = await authedFetch(`/api/trips/${tripId}/daily-brief/actions/${actionId}`, { method: 'POST' });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch {
    return { ok: false };
  }
}

export async function dismissBriefRecommendation(
  tripId: string,
  recommendationId: string,
  category: string,
): Promise<{ ok: boolean }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false };
  try {
    const res = await authedFetch(`/api/trips/${tripId}/daily-brief/dismiss/${recommendationId}`, {
      method: 'POST',
      body: JSON.stringify({ category }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

/* ── Concierge Commands ───────────────────────────────────────────────────── */

export async function sendConciergeCommand(
  text: string,
  opts?: {
    tripId?: string;
    destination?: string;
    meetupId?: string;
    meetupTime?: string;
    meetupLocation?: string;
  },
): Promise<{ ok: boolean; data?: any; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const body: Record<string, string | null | undefined> = {
      text,
      tripId: opts?.tripId ?? null,
      destination: opts?.destination,
    };
    if (opts?.meetupId) {
      body.meetupId = opts.meetupId;
      body.meetupTime = opts.meetupTime;
      body.meetupLocation = opts.meetupLocation;
    }
    const res = await authedFetch('/api/telegraph/commands', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

export async function confirmCommandAction(
  commandId: string,
  actionId: string,
): Promise<{ ok: boolean; data?: any }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false };
  try {
    const res = await authedFetch(`/api/telegraph/commands/${commandId}/confirm-action`, {
      method: 'POST',
      body: JSON.stringify({ actionId }),
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch {
    return { ok: false };
  }
}

export async function declineCommandAction(commandId: string): Promise<{ ok: boolean }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false };
  try {
    const res = await authedFetch(`/api/telegraph/commands/${commandId}/decline-action`, { method: 'POST' });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

/* ── Preferences ─────────────────────────────────────────────────────────── */

export async function fetchPreferences(): Promise<{ ok: boolean; data?: any; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch('/api/me/preferences');
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

export async function patchPreferences(patch: Record<string, any>): Promise<{ ok: boolean; data?: any }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false };
  try {
    const res = await authedFetch('/api/me/preferences', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch {
    return { ok: false };
  }
}

export async function resetLearnedPreferences(): Promise<{ ok: boolean }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false };
  try {
    const res = await authedFetch('/api/me/preferences/reset-learned', { method: 'POST' });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

/* ── Feedback ─────────────────────────────────────────────────────────────── */

export type FeedbackSignal = 'save' | 'add_to_plan' | 'more_like_this' | 'less_like_this' | 'not_for_me' | 'dismiss' | 'view' | 'share';

export async function sendFeedback(
  recommendationId: string,
  category: string,
  signal: FeedbackSignal,
  tripId?: string,
): Promise<{ ok: boolean }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false };
  try {
    const res = await authedFetch(`/api/telegraph/recommendations/${recommendationId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ category, signal, tripId: tripId ?? null }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
