/**
 * Safe Return mobile service layer.
 * All network calls go through EXPO_PUBLIC_API_BASE_URL (the API server proxy).
 * Auth token comes from the shared refresh-first helper — same pattern as trips.ts.
 */
import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function authHeader(): Promise<string | null> {
  try {
    return freshApiToken();
  } catch {
    return null;
  }
}

async function apiFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const token = await authHeader();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> ?? {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
    return res.json();
  } catch {
    return { error: 'network_error' };
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SafeReturnSessionEvents {
  alertsSent: number;
  missedCount: number;
  liveShareStarted: number;
  liveShareStopped: number;
}

export interface SafeReturnSession {
  id: string;
  status: 'pending' | 'active' | 'safe' | 'missed' | 'cancelled';
  escalationLevel: number;
  timerStartAt: string | null;
  timerEndAt: string | null;
  trustedCircleEnabled: boolean;
  liveShareEnabled: boolean;
  notifyHostEnabled: boolean;
  notifyTripCrewEnabled: boolean;
  planItemId: string | null;
  tripId: string | null;
  triggerReason: string | null;
  emergencyNote: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Per-session event counts, included in history responses. */
  events?: SafeReturnSessionEvents;
}

export interface SafeReturnContactInput {
  contactUserId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  contactMethod: 'in_app' | 'sms' | 'email';
  canReceiveLiveLocation?: boolean;
}

export interface TrustedContact {
  userId: string;
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
}

export interface SuggestionResult {
  suggest: boolean;
  reasons: string[];
  reasonText: string | null;
  confidence: 'low' | 'medium' | 'high';
  featureEnabled?: boolean;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function getSuggestion(planItemId: string): Promise<SuggestionResult | null> {
  const data = await apiFetch(`/api/me/safe-return/suggest/${planItemId}`);
  if (data?.error) return null;
  return data as SuggestionResult;
}

export async function createSession(opts: {
  timerMinutes?: number | null;
  escalationLevel?: 0 | 1 | 2 | 3;
  trustedCircleEnabled?: boolean;
  liveShareEnabled?: boolean;
  notifyHostEnabled?: boolean;
  notifyTripCrewEnabled?: boolean;
  emergencyNote?: string | null;
  planItemId?: string | null;
  tripId?: string | null;
  contacts?: SafeReturnContactInput[];
}): Promise<{ ok: boolean; session?: SafeReturnSession; error?: string }> {
  return apiFetch('/api/me/safe-return/sessions', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export async function startSession(sessionId: string): Promise<{ ok: boolean; session?: SafeReturnSession; error?: string }> {
  return apiFetch(`/api/me/safe-return/sessions/${sessionId}/start`, { method: 'POST' });
}

export async function getActiveSession(): Promise<{ session: SafeReturnSession | null; featureEnabled?: boolean }> {
  const data = await apiFetch('/api/me/safe-return/sessions/active');
  return { session: data?.session ?? null, featureEnabled: data?.featureEnabled };
}

export async function extendTimer(sessionId: string, minutes: number): Promise<{ ok: boolean; session?: SafeReturnSession; error?: string }> {
  return apiFetch(`/api/me/safe-return/sessions/${sessionId}/extend`, {
    method: 'POST',
    body: JSON.stringify({ minutes }),
  });
}

export async function confirmSafe(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  return apiFetch(`/api/me/safe-return/sessions/${sessionId}/confirm`, { method: 'POST' });
}

export async function cancelSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  return apiFetch(`/api/me/safe-return/sessions/${sessionId}/cancel`, { method: 'POST' });
}

export async function startLiveShare(
  sessionId: string,
  opts: { recipientContactId: string; durationMinutes?: number },
): Promise<{ ok: boolean; share?: { id: string; expiresAt: string | null }; error?: string }> {
  return apiFetch(`/api/me/safe-return/sessions/${sessionId}/live-share/start`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export interface SessionContact {
  id: string;
  contactUserId: string | null;
  contactName: string | null;
  canReceiveLiveLocation: boolean;
}

export async function getSessionContacts(sessionId: string): Promise<SessionContact[]> {
  const data = await apiFetch(`/api/me/safe-return/sessions/${sessionId}/contacts`);
  return data?.contacts ?? [];
}

export async function stopLiveShare(sessionId: string, shareId: string): Promise<{ ok: boolean; error?: string }> {
  return apiFetch(`/api/me/safe-return/sessions/${sessionId}/live-share/stop`, {
    method: 'POST',
    body: JSON.stringify({ shareId }),
  });
}

export async function getHistory(limit = 20): Promise<{ sessions: SafeReturnSession[]; featureEnabled?: boolean }> {
  const data = await apiFetch(`/api/me/safe-return/history?limit=${limit}`);
  return { sessions: data?.sessions ?? [], featureEnabled: data?.featureEnabled };
}

export async function getTrustedContacts(): Promise<TrustedContact[]> {
  const data = await apiFetch('/api/me/safe-return/trusted-contacts');
  return data?.contacts ?? [];
}
