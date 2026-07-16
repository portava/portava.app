/**
 * Shared authenticated fetch helpers for admin screens.
 *
 * Every admin surface (Schema Drift, Feature Flags, Hashtags, the Connected
 * Features drift badge, …) talks to the API server with the same pattern:
 * resolve the API base URL, refresh the Supabase session for a fresh access
 * token, and send it as a Bearer header. This module is the single source of
 * truth for that pattern so auth/token changes only need to happen once.
 */
import { supabase } from '../lib/supabase';

export type AdminApiResult<T> = { ok: boolean; data?: T; error?: string };

export function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Refresh the session (best effort) and return a current access token. */
export async function freshToken(): Promise<string | null> {
  try {
    const { data: refreshed } = await supabase.auth.refreshSession();
    const s = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
    return s?.access_token ?? null;
  } catch { return null; }
}

async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<AdminApiResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const opts: RequestInit = { headers };
    if (init?.method) opts.method = init.method;
    if (init?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(init.body);
    }
    const res = await fetch(`${apiBase()}${path}`, opts);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() as T };
  } catch (e: any) { return { ok: false, error: e?.message ?? 'Network error' }; }
}

/** Authenticated GET against the API server. */
export function adminGet<T>(path: string): Promise<AdminApiResult<T>> {
  return request<T>(path);
}

/** Authenticated PATCH with a JSON body against the API server. */
export function adminPatch<T>(path: string, body: unknown): Promise<AdminApiResult<T>> {
  return request<T>(path, { method: 'PATCH', body });
}
