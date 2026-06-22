/**
 * Highlights service — typed fetch wrappers for all highlight API endpoints.
 * Follows the freshToken / apiFetch pattern used by posts.ts and other services.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export type HighlightVisibility = 'public' | 'travelers_nearby' | 'circle_only' | 'trip_only' | 'private';

export interface HighlightAuthor {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
}

export interface Highlight {
  id: string;
  ownerId: string;
  mediaUrl: string;
  mediaType: string;
  videoDurationSeconds: number | null;
  caption: string | null;
  locationName: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  visibility: HighlightVisibility;
  expiresAt: string;
  createdAt: string;
  deletedAt: string | null;
  author: HighlightAuthor | null;
  viewCount: number;
  likeCount: number;
  viewedByMe: boolean;
  likedByMe: boolean;
}

export interface HighlightViewer {
  userId: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  viewedAt: string;
  likedByMe: boolean;
}

export type HighlightErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_payload'
  | 'db_error'
  | 'network_unreachable'
  | 'config_error';

export interface HighlightResult<T> {
  ok: boolean;
  data: T | null;
  errorKind?: HighlightErrorKind;
  message?: string;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

function mapApiError<T>(status: number, body: any): HighlightResult<T> {
  const code = (body?.error as HighlightErrorKind) ?? 'db_error';
  const known: HighlightErrorKind[] = [
    'unauthenticated', 'forbidden', 'not_found', 'invalid_payload', 'db_error',
  ];
  const errorKind = known.includes(code) ? code : 'db_error';
  return { ok: false, data: null, errorKind, message: body?.message ?? `API ${status}` };
}

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('network request failed') ||
    m.includes('networkerror') ||
    m.includes('load failed')
  );
}

function mapHighlight(r: any): Highlight {
  return {
    id: r.id,
    ownerId: r.owner_id,
    mediaUrl: r.media_url,
    mediaType: r.media_type,
    videoDurationSeconds: r.video_duration_seconds ?? null,
    caption: r.caption ?? null,
    locationName: r.location_name ?? null,
    locationCity: r.location_city ?? null,
    locationCountry: r.location_country ?? null,
    visibility: r.visibility,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    deletedAt: r.deleted_at ?? null,
    author: r.author
      ? { id: r.author.id, handle: r.author.handle, name: r.author.name, avatarUrl: r.author.avatarUrl ?? null }
      : null,
    viewCount: r.viewCount ?? 0,
    likeCount: r.likeCount ?? 0,
    viewedByMe: r.viewedByMe ?? false,
    likedByMe: r.likedByMe ?? false,
  };
}

export interface CreateHighlightInput {
  mediaUrl: string;
  mediaType: string;
  videoDurationSeconds?: number | null;
  caption?: string | null;
  locationName?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
  visibility?: HighlightVisibility;
  expiresInHours?: number;
}

export async function createHighlight(input: CreateHighlightInput): Promise<HighlightResult<Highlight>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        mediaUrl: input.mediaUrl,
        mediaType: input.mediaType,
        videoDurationSeconds: input.videoDurationSeconds ?? null,
        caption: input.caption ?? null,
        locationName: input.locationName ?? null,
        locationCity: input.locationCity ?? null,
        locationCountry: input.locationCountry ?? null,
        visibility: input.visibility ?? 'public',
        expiresInHours: input.expiresInHours ?? 24,
      }),
    });
    if (!res.ok) return mapApiError<Highlight>(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: mapHighlight(await res.json()) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/** Fetch active highlights for a specific user, filtered by viewer permissions. */
export async function fetchUserHighlights(userId: string): Promise<HighlightResult<Highlight[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/users/${userId}/highlights`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError<Highlight[]>(res.status, await res.json().catch(() => ({})));
    const body = await res.json();
    return { ok: true, data: (body.highlights ?? []).map(mapHighlight) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/**
 * Fetch active highlights visible to the current user.
 * Supports ?userId=, ?city=, ?tripId= filters.
 */
export async function fetchActiveHighlights(opts?: {
  userId?: string;
  city?: string;
  tripId?: string;
  limit?: number;
}): Promise<HighlightResult<Highlight[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  const params = new URLSearchParams();
  if (opts?.userId) params.set('userId', opts.userId);
  if (opts?.city) params.set('city', opts.city);
  if (opts?.tripId) params.set('tripId', opts.tripId);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  try {
    const res = await fetch(`${apiBase()}/api/highlights/active${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError<Highlight[]>(res.status, await res.json().catch(() => ({})));
    const body = await res.json();
    return { ok: true, data: (body.highlights ?? []).map(mapHighlight) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/** Idempotent mark-as-viewed. Best-effort — never blocks the UI. */
export async function markHighlightViewed(highlightId: string): Promise<void> {
  if (!isSupabaseConfigured || !apiBase()) return;
  const token = await freshToken();
  if (!token) return;
  fetch(`${apiBase()}/api/highlights/${highlightId}/view`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

export async function toggleHighlightLike(
  highlightId: string,
  liked: boolean,
): Promise<HighlightResult<{ likedByMe: boolean; likeCount: number }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}/like`, {
      method: liked ? 'DELETE' : 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

export async function fetchHighlightViewers(highlightId: string): Promise<HighlightResult<HighlightViewer[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}/viewers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError<HighlightViewer[]>(res.status, await res.json().catch(() => ({})));
    const body = await res.json();
    return {
      ok: true,
      data: (body.viewers ?? []).map((v: any) => ({
        userId: v.user_id,
        handle: v.handle,
        name: v.name,
        avatarUrl: v.avatar_url ?? null,
        viewedAt: v.viewed_at,
        likedByMe: v.liked ?? false,
      })),
    };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

/** Reply to a highlight — creates or returns a Telegraph DM thread. Returns threadId. */
export async function replyToHighlight(
  highlightId: string,
  message: string,
): Promise<HighlightResult<{ threadId: string }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) return mapApiError(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

export async function deleteHighlight(highlightId: string): Promise<HighlightResult<null>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 204) return { ok: true, data: null };
    return mapApiError<null>(res.status, await res.json().catch(() => ({})));
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

export async function reportHighlight(highlightId: string, reason: string): Promise<HighlightResult<null>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason }),
    });
    if (res.status === 204 || res.ok) return { ok: true, data: null };
    return mapApiError<null>(res.status, await res.json().catch(() => ({})));
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

/**
 * Batch-fetch active-highlight metadata for multiple users.
 * Returns a map: userId → { hasActive: boolean, allViewed: boolean, highlights: Highlight[] }
 * Used by HighlightRing to determine ring state.
 */
export async function fetchHighlightRingStates(
  userIds: string[],
  viewedIds: Set<string>,
): Promise<Map<string, { hasActive: boolean; allViewed: boolean; highlights: Highlight[] }>> {
  const result = new Map<string, { hasActive: boolean; allViewed: boolean; highlights: Highlight[] }>();
  if (userIds.length === 0) return result;

  // Fetch per-user highlights in parallel (batch of unique userIds)
  const uniqueIds = [...new Set(userIds)];
  const fetches = uniqueIds.map(async (uid) => {
    const r = await fetchUserHighlights(uid);
    const highlights = r.ok && r.data ? r.data : [];
    const hasActive = highlights.length > 0;
    const allViewed = hasActive && highlights.every((h) => viewedIds.has(h.id));
    return [uid, { hasActive, allViewed, highlights }] as const;
  });
  const entries = await Promise.all(fetches);
  for (const [uid, state] of entries) result.set(uid, state);
  return result;
}
