/**
 * Posts service — typed client over the API SERVER (not supabase tables).
 *
 * Posts are written/read through the API server (service-role, server-side
 * authorization), mirroring how createTrip() works. The client NEVER writes
 * posts directly via supabase-js, and never sees the service-role key. We send
 * the user's Bearer access token; the server derives author_id from it.
 *
 * Media upload goes directly to Supabase Storage (authenticated client) to
 * avoid routing large files through the API server. The public URL is then
 * included in the createPost payload.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export type PostVisibility = 'public' | 'trip_only' | 'private';
export type PostStatus = 'active' | 'hidden' | 'reported' | 'deleted';

export interface PostAuthor {
  handle: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface PostRow {
  id: string;
  authorId: string;
  author?: PostAuthor;
  tripId: string | null;
  content: string;
  mediaUrls: string[];
  visibility: PostVisibility;
  status: PostStatus;
  createdAt: string;
  updatedAt: string;
}

export type PostErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_member'
  | 'invalid_payload'
  | 'not_found'
  | 'db_error'
  | 'network_unreachable'
  | 'config_error'
  | 'upload_failed';

export interface PostResult<T> {
  ok: boolean;
  data: T | null;
  errorKind?: PostErrorKind;
  message?: string;
}

function mapPost(r: any): PostRow {
  const p = r.profiles;
  return {
    id: r.id,
    authorId: r.author_id,
    author: p ? { handle: p.handle ?? '', name: p.name ?? null, avatarUrl: p.avatar_url ?? null } : undefined,
    tripId: r.trip_id ?? null,
    content: r.content ?? '',
    mediaUrls: r.media_urls ?? [],
    visibility: r.visibility,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Fresh token — refresh then fall back to current session. */
async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

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

/**
 * Upload a local file URI by proxying through the API server (POST /api/media/upload).
 * The API server uses the service-role key to upload to Supabase Storage, bypassing
 * storage RLS. The client never touches the service-role key; it sends its Bearer token.
 *
 * Returns the public URL on success.
 */
export async function uploadPostMedia(
  localUri: string,
  mimeType: string = 'image/jpeg',
): Promise<PostResult<string>> {
  if (!isSupabaseConfigured) {
    return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  }
  if (!apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error', message: 'API base URL not set' };
  }

  const token = await freshToken();
  if (!token) {
    return { ok: false, data: null, errorKind: 'unauthenticated', message: 'Please sign in to upload media' };
  }

  try {
    // Fetch the local file as a blob (works on both web and React Native with Expo)
    const fileRes = await fetch(localUri);
    if (!fileRes.ok) {
      return { ok: false, data: null, errorKind: 'upload_failed', message: `Could not read local file (${fileRes.status})` };
    }
    const blob = await fileRes.blob();

    // POST raw binary to our API server — it proxies to Supabase Storage with service role
    const res = await fetch(`${apiBase()}/api/media/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': mimeType,
        'Authorization': `Bearer ${token}`,
      },
      body: blob,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.message ?? `Upload failed (HTTP ${res.status})`;
      return { ok: false, data: null, errorKind: 'upload_failed', message: msg };
    }

    const body = await res.json();
    if (!body?.url) {
      return { ok: false, data: null, errorKind: 'upload_failed', message: 'Server returned no URL' };
    }
    return { ok: true, data: body.url };
  } catch (e) {
    if (isNetworkError(e)) {
      return { ok: false, data: null, errorKind: 'network_unreachable', message: 'Network unavailable' };
    }
    return { ok: false, data: null, errorKind: 'upload_failed', message: e instanceof Error ? e.message : 'Upload failed' };
  }
}

interface CreatePostInput {
  content?: string;
  mediaUrls?: string[];
  tripId?: string | null;
  visibility?: PostVisibility;
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

export async function listGlobalPosts(opts?: { limit?: number; before?: string }): Promise<PostResult<PostRow[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.before) params.set('before', opts.before);
  const qs = params.toString() ? `?${params.toString()}` : '';
  try {
    const res = await fetch(`${apiBase()}/api/posts${qs}`, { headers: { Authorization: `Bearer ${token}` } });
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

export async function listTripPosts(tripId: string): Promise<PostResult<PostRow[]> & { isMember?: boolean }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/posts`, { headers: { Authorization: `Bearer ${token}` } });
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
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown error' };
  }
}
