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
  /** True when this user is an @Portava Official account. */
  isOfficial?: boolean;
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
  /** True when the viewer has already sent a follow request to this private account (status = pending). */
  friendRequestPending?: boolean;
  mutualCount?: number;
  reason?: string | null;
  /** True when this user holds a verified traveler status. */
  verified?: boolean;
  /** True when this user is an @Portava Official account. */
  isOfficial?: boolean;
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

/* ---------- My follow requests (incoming, pending) ---------- */

export interface FollowRequest {
  /** The friend_requests row ID — required for accept/decline calls. */
  requestId: string;
  /** The requesting user's profile ID. */
  requesterId: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  requestedAt: string;
}

/**
 * Returns pending incoming follow requests for private-account owners.
 * Backed by GET /api/me/friend-requests/incoming (existing endpoint).
 */
export async function getMyFollowRequests(): Promise<FollowResult<FollowRequest[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/me/friend-requests/incoming`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    const body = await res.json();
    // Reshape from friend-request format to FollowRequest
    const requests: FollowRequest[] = (body.requests ?? []).map((r: any) => ({
      requestId: r.requestId,
      requesterId: r.user?.id ?? '',
      handle: r.user?.handle ?? null,
      name: r.user?.name ?? null,
      avatarUrl: r.user?.avatarUrl ?? null,
      requestedAt: r.createdAt,
    }));
    return { ok: true, data: requests };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/**
 * Accept or decline an incoming follow request.
 * Uses the existing POST /api/friend-requests/:requestId/accept|decline endpoints.
 */
export async function respondToFollowRequest(
  requestId: string,
  action: 'accept' | 'decline',
): Promise<FollowResult<{ status: string }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(
      `${apiBase()}/api/friend-requests/${encodeURIComponent(requestId)}/${action}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
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

/* ---------- Mutual follows (people viewer follows who also follow the target) ---------- */

export interface MutualFollowUser {
  id: string;
  handle: string | null;
  /** display_name ?? name from profiles — ready for display */
  displayName: string | null;
  avatarUrl: string | null;
  verified?: boolean;
}

/**
 * Returns up to 20 users that both the current viewer and the target profile follow —
 * i.e. (viewer follows them) AND (they follow targetUserId).
 * Queries Supabase directly. Returns [] on any error / unauthenticated.
 */
export async function getMutualFollows(targetUserId: string): Promise<MutualFollowUser[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];
    const viewerUserId = user.id;
    if (viewerUserId === targetUserId) return [];

    // Step 1: IDs the viewer follows
    const { data: viewerFollowing, error: e1 } = await supabase
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', viewerUserId);
    if (e1 || !viewerFollowing || viewerFollowing.length === 0) return [];

    const viewerFollowingIds = viewerFollowing.map((r) => r.following_id as string);

    // Step 2: which of those also follow the target
    const { data: mutualRows, error: e2 } = await supabase
      .from('user_follows')
      .select('follower_id')
      .eq('following_id', targetUserId)
      .in('follower_id', viewerFollowingIds)
      .limit(20);
    if (e2 || !mutualRows || mutualRows.length === 0) return [];

    const mutualIds = mutualRows.map((r) => r.follower_id as string);

    // Step 3: fetch profile info for those users
    const { data: profiles, error: e3 } = await supabase
      .from('profiles')
      .select('id, handle, name, display_name, avatar_url, verified')
      .in('id', mutualIds);
    if (e3 || !profiles) return [];

    return profiles.map((p: any) => ({
      id: p.id as string,
      handle: (p.handle as string | null) ?? null,
      displayName: (p.display_name as string | null) ?? (p.name as string | null) ?? null,
      avatarUrl: (p.avatar_url as string | null) ?? null,
      verified: (p.verified as boolean) ?? false,
    }));
  } catch {
    return [];
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

/* ---------- Any user's followers / following (public, read-only) ---------- */

export async function getUserFollowers(userId: string): Promise<FollowResult<FollowUser[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  try {
    const token = await freshToken();
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/followers`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return { ok: true, data: [] };
    const body = await res.json();
    return { ok: true, data: body.users ?? [] };
  } catch {
    return { ok: true, data: [] };
  }
}

export async function getUserFollowing(userId: string): Promise<FollowResult<FollowUser[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  try {
    const token = await freshToken();
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/following`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return { ok: true, data: [] };
    const body = await res.json();
    return { ok: true, data: body.users ?? [] };
  } catch {
    return { ok: true, data: [] };
  }
}
