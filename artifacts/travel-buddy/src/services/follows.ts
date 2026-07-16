/**
 * follows service — wraps the API server's follow endpoints.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
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
  followsYou: boolean;
  followersCount: number;
  followingCount: number;
}

export interface FollowUser {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  since: string;
  followsYou?: boolean;
  youFollow?: boolean;
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

/* ---------- Search users ---------- */

export interface TravelerSearchResult {
  id: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  followerCount: number;
  isFollowing: boolean;
  isPrivate: boolean;
  mutualCount?: number;
  reason?: string | null;
}

export async function searchUsers(query: string, limit = 20): Promise<FollowResult<TravelerSearchResult[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  const q = encodeURIComponent(query.trim());
  if (!q) return { ok: true, data: [] };

  try {
    const res = await fetch(
      `${apiBase()}/api/users/search?q=${q}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    const body = await res.json();
    return { ok: true, data: body.users ?? [] };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/* ---------- Suggested travelers (follow-back candidates) ---------- */

export async function clearSuggestionsSeen(): Promise<FollowResult<{ cleared: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/users/suggestions/seen`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error' };
    }
    return { ok: true, data: { cleared: true } };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

export async function getSuggestedTravelers(limit = 10): Promise<FollowResult<TravelerSearchResult[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(
      `${apiBase()}/api/users/suggestions?limit=${limit}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    const body = await res.json();
    return { ok: true, data: body.users ?? [] };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
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
