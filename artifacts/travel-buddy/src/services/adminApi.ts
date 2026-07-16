/**
 * Shared authenticated fetch helpers for admin screens.
 *
 * Every admin surface (Schema Drift, Feature Flags, Hashtags, Stamp Catalog,
 * Rent a Buddy admin, the Connected Features drift badge, …) talks to the API
 * server with the same pattern: resolve the API base URL, refresh the Supabase
 * session for a fresh access token, and send it as a Bearer header. This
 * module is the single source of truth for that pattern so auth/token changes
 * only need to happen once.
 */
import { supabase } from '../lib/supabase';

export type AdminApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface AdminRequestOptions {
  /** Map an HTTP 403 to the sentinel error string 'forbidden'. */
  treat403AsForbidden?: boolean;
}

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
  opts?: AdminRequestOptions,
): Promise<AdminApiResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const fetchOpts: RequestInit = { headers };
    if (init?.method) fetchOpts.method = init.method;
    if (init?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(init.body);
    }
    const res = await fetch(`${apiBase()}${path}`, fetchOpts);
    if (opts?.treat403AsForbidden && res.status === 403) {
      return { ok: false, error: 'forbidden' };
    }
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() as T };
  } catch (e: any) { return { ok: false, error: e?.message ?? 'Network error' }; }
}

/** Authenticated GET against the API server. */
export function adminGet<T>(path: string, opts?: AdminRequestOptions): Promise<AdminApiResult<T>> {
  return request<T>(path, undefined, opts);
}

/** Authenticated POST with an optional JSON body against the API server. */
export function adminPost<T>(path: string, body?: unknown, opts?: AdminRequestOptions): Promise<AdminApiResult<T>> {
  return request<T>(path, { method: 'POST', body }, opts);
}

/** Authenticated PATCH with a JSON body against the API server. */
export function adminPatch<T>(path: string, body: unknown, opts?: AdminRequestOptions): Promise<AdminApiResult<T>> {
  return request<T>(path, { method: 'PATCH', body }, opts);
}

/** Authenticated DELETE against the API server. */
export function adminDelete<T>(path: string, opts?: AdminRequestOptions): Promise<AdminApiResult<T>> {
  return request<T>(path, { method: 'DELETE' }, opts);
}
