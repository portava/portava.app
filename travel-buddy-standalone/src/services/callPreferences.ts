/**
 * Call preferences service — GET/PUT /api/calls/preferences.
 * Server enforces these on every call attempt; this screen only edits them.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

export type WhoCanCall = 'people_i_message' | 'rab_contacts' | 'nobody';

export interface CallPreferences {
  whoCanCall: WhoCanCall;
  allowRentABuddyCalls: boolean;
  allowVideoCalls: boolean;
  incomingCallNotifications: boolean;
}

export interface CallPrefsResult {
  ok: boolean;
  data: CallPreferences | null;
  error?: string;
}

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }

async function api(path: string, method: 'GET' | 'PUT', body?: unknown): Promise<CallPrefsResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, error: 'Backend not configured' };
  const token = await freshApiToken();
  if (!token) return { ok: false, data: null, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, data: null, error: (json as any)?.message ?? `API ${res.status}` };
    return { ok: true, data: normalize((json as any)?.preferences) };
  } catch (e) {
    return { ok: false, data: null, error: e instanceof Error ? e.message : 'Network error' };
  }
}

function normalize(p: any): CallPreferences {
  return {
    whoCanCall: (p?.whoCanCall ?? 'people_i_message') as WhoCanCall,
    allowRentABuddyCalls: p?.allowRentABuddyCalls ?? true,
    allowVideoCalls: p?.allowVideoCalls ?? true,
    incomingCallNotifications: p?.incomingCallNotifications ?? true,
  };
}

export async function getCallPreferences(): Promise<CallPrefsResult> {
  return api('/api/calls/preferences', 'GET');
}

export async function updateCallPreferences(patch: Partial<CallPreferences>): Promise<CallPrefsResult> {
  return api('/api/calls/preferences', 'PUT', patch);
}
