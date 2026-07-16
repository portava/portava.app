/**
 * Telegraph Chat Suggestions — mobile service layer.
 * Wraps all /api/threads/:threadId/telegraph/* endpoints.
 */

import { supabase } from '../lib/supabase';
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  try {
    return freshApiToken();
  } catch {
    return null;
  }
}

async function apiGet<T>(path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Network error' };
  }
}

async function apiPost<T>(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any).message ?? `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Network error' };
  }
}

async function apiPatch<T>(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any).message ?? `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Network error' };
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TelegraphSuggestion {
  id: string;
  intent_type: string;
  title: string;
  reason: string;
  category: string;
  action_type: 'add_to_plan' | 'create_meetup' | 'start_time_poll' | 'view_place';
  location_context: string | null;
  time_context: string | null;
  created_at: string;
  expires_at: string;
}

export interface MeetupPrefill {
  title: string;
  location: string;
  suggestedTime: string | null;
  tripId: string | null;
  threadId: string;
}

export interface TelegraphChatSettings {
  show_telegraph_dm: boolean;
  show_telegraph_trip: boolean;
  show_telegraph_circle: boolean;
}

// ── API calls ─────────────────────────────────────────────────────────────────

/**
 * Fetch active suggestions for a thread. Optionally pass the last sent
 * message text so the server can run intent detection and generate new cards.
 */
export async function getTelegraphSuggestions(
  threadId: string,
  lastMessage?: string,
): Promise<TelegraphSuggestion[]> {
  const qs = lastMessage
    ? `?message=${encodeURIComponent(lastMessage.slice(0, 200))}`
    : '';
  const res = await apiGet<{ suggestions: TelegraphSuggestion[] }>(
    `/api/threads/${threadId}/telegraph/suggestions${qs}`,
  );
  return res.data?.suggestions ?? [];
}

export async function dismissSuggestion(
  threadId: string,
  suggestionId: string,
): Promise<boolean> {
  const res = await apiPost(
    `/api/threads/${threadId}/telegraph/suggestions/${suggestionId}/dismiss`,
  );
  return res.ok;
}

export async function addSuggestionToPlan(
  threadId: string,
  suggestionId: string,
  tripId: string,
  opts?: { title?: string; dayDate?: string; startsAt?: string },
): Promise<{ ok: boolean; planItemId?: string; error?: string }> {
  const res = await apiPost<{ ok: boolean; planItem: { id: string; title: string } }>(
    `/api/threads/${threadId}/telegraph/suggestions/${suggestionId}/add-to-plan`,
    { tripId, ...opts },
  );
  return { ok: res.ok, planItemId: res.data?.planItem?.id, error: res.error };
}

export async function getSuggestionMeetupPrefill(
  threadId: string,
  suggestionId: string,
): Promise<MeetupPrefill | null> {
  const res = await apiPost<{ ok: boolean; prefill: MeetupPrefill }>(
    `/api/threads/${threadId}/telegraph/suggestions/${suggestionId}/create-meetup`,
  );
  return res.data?.prefill ?? null;
}

export async function startTimePoll(
  threadId: string,
  suggestionId: string,
  opts?: { options?: string[]; question?: string },
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const res = await apiPost<{ ok: boolean; messageId: string }>(
    `/api/threads/${threadId}/telegraph/suggestions/${suggestionId}/start-poll`,
    opts,
  );
  return { ok: res.ok, messageId: res.data?.messageId, error: res.error };
}

export async function updateTelegraphChatSettings(
  settings: Partial<TelegraphChatSettings>,
): Promise<boolean> {
  const res = await apiPatch('/api/me/telegraph-chat-settings', settings);
  return res.ok;
}
