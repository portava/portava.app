/**
 * Posts service — typed client over the API SERVER (not supabase tables).
 *
 * Posts are written/read through the API server (service-role, server-side
 * authorization), mirroring how createTrip() works. The client NEVER writes
 * posts directly via supabase-js, and never sees the service-role key. We send
 * the user's Bearer access token; the server derives author_id from it.
 *
 * UI calls these functions; it never calls fetch or supabase for posts itself.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export type PostVisibility = 'public' | 'trip_only' | 'private';
export type PostStatus = 'active' | 'hidden' | 'reported' | 'deleted';

export interface PostAuthor {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
}

export interface PostRow {
  id: string;
  authorId: string;
  tripId: string | null;
  content: string;
  mediaUrls: string[];
  visibility: PostVisibility;
  status: PostStatus;
  createdAt: string;
  updatedAt: string;
  locationName?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
  author?: PostAuthor | null;
}

export type PostErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_member'
  | 'invalid_payload'
  | 'not_found'
  | 'db_error'
  | 'network_unreachable'
  | 'config_error';

export interface PostResult<T> {
  ok: boolean;
  data: T | null;
  errorKind?: PostErrorKind;
  message?: string;
}

function mapPost(r: any): PostRow {
  return {
    id: r.id,
    authorId: r.author_id,
    tripId: r.trip_id ?? null,
    content: r.content ?? '',
    mediaUrls: r.media_urls ?? [],
    visibility: r.visibility,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    locationName: r.location_name ?? null,
    locationCity: r.location_city ?? null,
    locationCountry: r.location_country ?? null,
    author: r.author
      ? { id: r.author.id, handle: r.author.handle, name: r.author.name, avatarUrl: r.author.avatarUrl ?? null }
      : null,
  };
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Fresh token, mirroring createTrip(): refresh then fall back to current session. */
async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

/** Map an API error envelope { error, message } to our typed result. */
function mapApiError<T>(status: number, body: any): PostResult<T> {
  const code = (body?.error as PostErrorKind) ?? 'db_error';
  const known: PostErrorKind[] = [
    'unauthenticated', 'forbidden', 'not_member', 'invalid_payload', 'not_found', 'db_error',
  ];
  const errorKind = known.includes(code) ? code : 'db_error';
  return { ok: false, data: null, errorKind, message: body?.message ?? `API ${status}` };
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

interface CreatePostInput {
  content?: string;
  mediaUrls?: string[];
  tripId?: string | null;
  visibility?: PostVisibility;
  // media + passport
  mediaType?: string | null;
  addToPassport?: boolean;
  // tagged location (what the user says)
  locationName?: string | null;
  locationPlaceId?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
  // current GPS at posting time (private; backend verifies)
  userGpsLat?: number | null;
  userGpsLng?: number | null;
  locationSource?: 'gps' | 'manual' | 'none';
}

export async function createPost(input: CreatePostInput): Promise<PostResult<PostRow>> {
  if (!isSupabaseConfigured) return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  if (!apiBase()) return { ok: false, data: null, errorKind: 'config_error', message: 'API base URL not set' };

  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated', message: 'Please sign in' };

  try {
    const res = await fetch(`${apiBase()}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        content: input.content ?? '',
        mediaUrls: input.mediaUrls ?? [],
        tripId: input.tripId ?? null,
        visibility: input.visibility ?? 'public',
        // media + passport
        mediaType: input.mediaType ?? null,
        addToPassport: input.addToPassport ?? true,
        // tagged location (NOTE: we never send location_verified — the server decides)
        locationName: input.locationName ?? null,
        locationPlaceId: input.locationPlaceId ?? null,
        locationCity: input.locationCity ?? null,
        locationCountry: input.locationCountry ?? null,
        locationLat: input.locationLat ?? null,
        locationLng: input.locationLng ?? null,
        // private GPS for server-side verification only
        userGpsLat: input.userGpsLat ?? null,
        userGpsLng: input.userGpsLng ?? null,
        locationSource: input.locationSource ?? 'none',
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return mapApiError<PostRow>(res.status, body);
    }
    return { ok: true, data: mapPost(await res.json()) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable', message: 'Network unavailable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown error' };
  }
}

/** Global feed: public standalone active posts. */
export async function listGlobalPosts(opts?: { limit?: number; before?: string }): Promise<PostResult<PostRow[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.before) params.set('before', opts.before);
  const qs = params.toString() ? `?${params.toString()}` : '';

  try {
    const res = await fetch(`${apiBase()}/api/posts${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return mapApiError<PostRow[]>(res.status, body);
    }
    const body = await res.json();
    return { ok: true, data: (body.posts ?? []).map(mapPost) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/** Following feed: public standalone posts from users the caller follows. */
export async function listFollowingFeed(opts?: { limit?: number; before?: string }): Promise<PostResult<PostRow[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  const params = new URLSearchParams({ feed: 'following' });
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.before) params.set('before', opts.before);

  try {
    const res = await fetch(`${apiBase()}/api/posts?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return mapApiError<PostRow[]>(res.status, body);
    }
    const body = await res.json();
    return { ok: true, data: (body.posts ?? []).map(mapPost) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/** Trip feed: posts for a trip (trip_only only returned to accepted members). */
export async function listTripPosts(tripId: string): Promise<PostResult<PostRow[]> & { isMember?: boolean }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/posts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return mapApiError<PostRow[]>(res.status, body);
    }
    const body = await res.json();
    return { ok: true, data: (body.posts ?? []).map(mapPost), isMember: Boolean(body.isMember) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

interface UpdatePostInput {
  content?: string;
  mediaUrls?: string[];
  visibility?: PostVisibility;
  status?: PostStatus;
}

export async function updatePost(postId: string, patch: UpdatePostInput): Promise<PostResult<PostRow>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/posts/${postId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return mapApiError<PostRow>(res.status, body);
    }
    return { ok: true, data: mapPost(await res.json()) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/** Soft delete (author only, enforced server-side). */
export async function deletePost(postId: string): Promise<PostResult<null>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/posts/${postId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 204) return { ok: true, data: null };
    const body = await res.json().catch(() => ({}));
    return mapApiError<null>(res.status, body);
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}
