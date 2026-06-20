/**
 * follows service — wraps the API server's follow endpoints.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('network request failed') ||
    m.includes('err_address_unreachable') ||
    m.includes('networkerror') ||
    m.includes('load failed')
  );
}

export interface FollowResult<T> {
  ok: boolean;
  data: T | null;
  errorKind?: string;
  message?: string;
}

export interface FollowStatus {
  userId: string;
  isFollowing: boolean;
  followersCount: number;
  followingCount: number;
}

export interface FollowUser {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  since: string;
}

/* ---------- Follow ---------- */

export async function followUser(userId: string): Promise<FollowResult<{ following: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/follow`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/* ---------- Unfollow ---------- */

export async function unfollowUser(userId: string): Promise<FollowResult<{ following: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/follow`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/* ---------- Follow status ---------- */

export async function getFollowStatus(userId: string): Promise<FollowResult<FollowStatus>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(
      `${apiBase()}/api/users/${encodeURIComponent(userId)}/follow-status`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/* ---------- My following list ---------- */

export async function getMyFollowing(): Promise<FollowResult<FollowUser[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/me/following`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: true, data: [] };
    const body = await res.json();
    return { ok: true, data: body.users ?? [] };
  } catch {
    return { ok: true, data: [] };
  }
}

/* ---------- My followers list ---------- */

export async function getMyFollowers(): Promise<FollowResult<FollowUser[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/me/followers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: true, data: [] };
    const body = await res.json();
    return { ok: true, data: body.users ?? [] };
  } catch {
    return { ok: true, data: [] };
  }
}
