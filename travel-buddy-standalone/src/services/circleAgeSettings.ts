/**
 * Circle age settings service — typed wrappers over /api/circle-age-settings.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

export interface CircleAgeSettings {
  ageLimitEnabled: boolean;
  minAge: number | null;
  maxAge: number | null;
  /** Formatted label e.g. "Ages 21+", "Ages 18–30", "Under 35" */
  label: string | null;
  updatedAt: string | null;
}

export interface CircleAgeSettingsResult {
  ok: boolean;
  data: CircleAgeSettings | null;
  message?: string;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!isSupabaseConfigured) return {};
  const token = await freshApiToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export async function getMyCircleAgeSettings(): Promise<CircleAgeSettingsResult> {
  const base = apiBase();
  if (!base) return { ok: false, data: null, message: 'API not configured' };
  try {
    const headers = await authHeaders();
    const res = await fetch(`${base}/api/circle-age-settings`, { headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, message: (body as any).message ?? 'Failed to load circle age settings' };
    }
    const data = await res.json() as CircleAgeSettings;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: null, message: 'Network error' };
  }
}

export interface UpdateCircleAgeSettingsParams {
  ageLimitEnabled: boolean;
  minAge?: number | null;
  maxAge?: number | null;
}

export async function updateCircleAgeSettings(
  params: UpdateCircleAgeSettingsParams,
): Promise<CircleAgeSettingsResult> {
  const base = apiBase();
  if (!base) return { ok: false, data: null, message: 'API not configured' };
  try {
    const headers = { ...(await authHeaders()), 'Content-Type': 'application/json' };
    const res = await fetch(`${base}/api/circle-age-settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ageLimitEnabled: params.ageLimitEnabled,
        minAge: params.ageLimitEnabled ? (params.minAge ?? null) : null,
        maxAge: params.ageLimitEnabled ? (params.maxAge ?? null) : null,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, data: null, message: (body as any).message ?? 'Failed to update circle age settings' };
    return { ok: true, data: body as CircleAgeSettings };
  } catch (err) {
    return { ok: false, data: null, message: 'Network error' };
  }
}

export async function getCircleAgeSettings(ownerId: string): Promise<CircleAgeSettingsResult> {
  const base = apiBase();
  if (!base) return { ok: false, data: null, message: 'API not configured' };
  try {
    const headers = await authHeaders();
    const res = await fetch(`${base}/api/circle-age-settings/${ownerId}`, { headers });
    if (!res.ok) {
      return { ok: false, data: null, message: 'Failed to load circle age settings' };
    }
    const data = await res.json() as CircleAgeSettings;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: null, message: 'Network error' };
  }
}
