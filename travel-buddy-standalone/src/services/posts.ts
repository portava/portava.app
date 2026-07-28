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
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

export type PostVisibility = 'public' | 'trip_only' | 'private';
export type PostStatus = 'active' | 'hidden' | 'reported' | 'deleted';

/** Delayed publish lifecycle status. */
export type DelayedPostStatus =
  | 'draft'
  | 'private'
  | 'pending_location_exit'
  | 'pending_delay'
  | 'pending_safety_review'
  | 'published'
  | 'canceled'
  | 'expired';

/** Location privacy mode for delayed geotag posts. */
export type LocationPrivacyMode =
  | 'none'
  | 'hidden'
  | 'city_only'
  | 'delayed_until_exit'
  | 'delayed_until_time'
  | 'trusted_circle_only';

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
  /** Structured ready media (url/type/dims + stamp_overlay) from feed + detail endpoints. */
  media?: import('../types/models').PostcardMediaItem[];
  visibility: PostVisibility;
  status: PostStatus;
  createdAt: string;
  updatedAt: string;
  locationName?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
  // Delayed geotag fields (public-safe — never exposes original_lat/lng)
  locationPrivacyMode?: LocationPrivacyMode | null;
  postStatus?: DelayedPostStatus | null;
  publicLat?: number | null;
  publicLng?: number | null;
  publicLocationLabel?: string | null;
  venueName?: string | null;
  geofenceRadiusMeters?: number | null;
  publishAfterExit?: boolean;
  publishAfterTime?: string | null;
  publishEligibleAt?: string | null;
  publishedAt?: string | null;
  locationSensitivityLevel?: string | null;
  author?: PostAuthor | null;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  likedByMe: boolean;
  savedByMe: boolean;
  saveCount: number;
  canLike: boolean;
  canComment: boolean;
  canShare: boolean;
  filterId: string;
  filterIntensity: number;
  mediaThumbnailUrl?: string | null;
  mediaDurationSeconds?: number | null;
  /** Editorial category (food, beach, nightlife, etc.) — null if untagged. */
  category?: string | null;
  /** @mention span annotations from the server whitelist. */
  tags: Array<{ type: 'user'; id: string; matchToken: string; startChar: number; endChar: number; isBlocked?: boolean; isDeleted?: boolean }>;
  /** #hashtag span annotations from the server whitelist. */
  hashtagUsages: Array<{ slug: string; hashtagId: string; startChar: number; endChar: number; isBlocked?: boolean }>;
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
    media: Array.isArray(r.media) ? r.media : undefined,
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
    likeCount: r.likeCount ?? r.like_count ?? 0,
    commentCount: r.commentCount ?? r.comment_count ?? 0,
    shareCount: r.shareCount ?? r.share_count ?? 0,
    likedByMe: r.likedByMe ?? false,
    savedByMe: r.savedByMe ?? false,
    saveCount: r.saveCount ?? r.save_count ?? 0,
    canLike: r.canLike ?? (r.visibility === 'public'),
    canComment: r.canComment ?? (r.visibility === 'public'),
    canShare: r.canShare ?? (r.visibility === 'public'),
    filterId: r.filter_id ?? 'original',
    filterIntensity: r.filter_intensity ?? 100,
    mediaThumbnailUrl: r.media_thumbnail_url ?? null,
    mediaDurationSeconds: r.media_duration_seconds ?? null,
    category: r.category ?? null,
    tags: r.tags ?? [],
    hashtagUsages: r.hashtagUsages ?? [],
    // Delayed geotag fields
    locationPrivacyMode: r.location_privacy_mode ?? null,
    postStatus: r.post_status ?? null,
    publicLat: r.public_lat ?? null,
    publicLng: r.public_lng ?? null,
    publicLocationLabel: r.public_location_label ?? null,
    venueName: r.venue_name ?? null,
    geofenceRadiusMeters: r.geofence_radius_meters ?? null,
    publishAfterExit: r.publish_after_exit ?? false,
    publishAfterTime: r.publish_after_time ?? null,
    publishEligibleAt: r.publish_eligible_at ?? null,
    publishedAt: r.published_at ?? null,
    locationSensitivityLevel: r.location_sensitivity_level ?? null,
  };
}

/** Subset of PostRow returned by GET /api/posts/pending. */
export interface PendingPostRow {
  id: string;
  content: string;
  locationName?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
  postStatus: DelayedPostStatus;
  locationPrivacyMode: LocationPrivacyMode;
  publishEligibleAt?: string | null;
  publishAfterTime?: string | null;
  geofenceRadiusMeters?: number | null;
}

function mapPendingPost(r: any): PendingPostRow {
  return {
    id: r.id,
    content: r.content ?? '',
    locationName: r.location_name ?? null,
    locationCity: r.location_city ?? null,
    locationCountry: r.location_country ?? null,
    locationLat: r.location_lat ?? null,
    locationLng: r.location_lng ?? null,
    postStatus: r.post_status,
    locationPrivacyMode: r.location_privacy_mode ?? 'none',
    publishEligibleAt: r.publish_eligible_at ?? null,
    publishAfterTime: r.publish_after_time ?? null,
    geofenceRadiusMeters: r.geofence_radius_meters ?? null,
  };
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Fresh token, mirroring createTrip(): refresh then fall back to current session. */
async function freshToken(): Promise<string | null> {
  return freshApiToken();
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
  // media filters
  filterId?: string;
  filterIntensity?: number;
  mediaThumbnailUrl?: string | null;
  mediaDurationSeconds?: number | null;
  // delayed geotag options
  locationPrivacyMode?: LocationPrivacyMode;
  publishAfterTime?: string | null;
  geofenceRadiusMeters?: number | null;
  venueName?: string | null;
  venueId?: string | null;
  /** Editorial category sent to the API (food, beach, nightlife, etc.). */
  category?: string | null;
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
        // media filters
        filterId: input.filterId ?? 'original',
        filterIntensity: input.filterIntensity ?? 100,
        mediaThumbnailUrl: input.mediaThumbnailUrl ?? null,
        mediaDurationSeconds: input.mediaDurationSeconds ?? null,
        // delayed geotag options
        locationPrivacyMode: input.locationPrivacyMode ?? undefined,
        publishAfterTime: input.publishAfterTime ?? null,
        geofenceRadiusMeters: input.geofenceRadiusMeters ?? null,
        venueName: input.venueName ?? null,
        venueId: input.venueId ?? null,
        category: input.category ?? null,
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

/** Fetch a single post by ID. Returns not_found when the post does not exist or is hidden from the caller. */
export async function getPostById(postId: string): Promise<PostResult<PostRow>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/posts/${encodeURIComponent(postId)}`, {
      headers: { Authorization: `Bearer ${token}` },
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

// ── Delayed geotag API functions ──────────────────────────────────────────────

/** Fetch the caller's pending posts (pending_location_exit / pending_delay / pending_safety_review). */
export async function getPendingPosts(): Promise<PostResult<PendingPostRow[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/posts/pending`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return mapApiError<PendingPostRow[]>(res.status, body);
    }
    const body = await res.json();
    return { ok: true, data: (body.posts ?? []).map(mapPendingPost) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/** Publish a pending post immediately, stripping all location fields. */
export async function publishWithoutLocation(postId: string): Promise<PostResult<PostRow>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/posts/${postId}/publish-now-without-location`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
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

/** Cancel a pending delayed-publish post. */
export async function cancelDelayedPublish(postId: string): Promise<PostResult<PostRow>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/posts/${postId}/cancel-delayed-publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
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

/** Change the location privacy mode on a pending post. */
export async function changeLocationPrivacy(
  postId: string,
  mode: LocationPrivacyMode,
  publishAfterTime?: string | null,
): Promise<PostResult<PostRow>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/posts/${postId}/location-privacy`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ locationPrivacyMode: mode, publishAfterTime: publishAfterTime ?? null }),
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

/** Notify the server that the device has exited a post's geofence. */
export async function exitGeofence(opts: {
  postId: string;
  lat: number;
  lng: number;
}): Promise<PostResult<{ eligibleAt: string | null }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/location/exit-geofence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ postId: opts.postId, lat: opts.lat, lng: opts.lng }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return mapApiError<{ eligibleAt: string | null }>(res.status, body);
    }
    const body = await res.json();
    return { ok: true, data: { eligibleAt: body.publishEligibleAt ?? null } };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

// ── Post saves ────────────────────────────────────────────────────────────────

export async function savePost(postId: string): Promise<{ ok: boolean; savedByMe: boolean; saveCount: number }> {
  const token = await freshToken();
  if (!token) return { ok: false, savedByMe: false, saveCount: 0 };
  try {
    const res = await fetch(`${apiBase()}/api/posts/${encodeURIComponent(postId)}/save`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, savedByMe: false, saveCount: 0 };
    const body = await res.json();
    return { ok: true, savedByMe: body.savedByMe ?? true, saveCount: body.saveCount ?? 0 };
  } catch {
    return { ok: false, savedByMe: false, saveCount: 0 };
  }
}

export async function unsavePost(postId: string): Promise<{ ok: boolean; savedByMe: boolean; saveCount: number }> {
  const token = await freshToken();
  if (!token) return { ok: false, savedByMe: true, saveCount: 0 };
  try {
    const res = await fetch(`${apiBase()}/api/posts/${encodeURIComponent(postId)}/save`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, savedByMe: true, saveCount: 0 };
    const body = await res.json();
    return { ok: true, savedByMe: body.savedByMe ?? false, saveCount: body.saveCount ?? 0 };
  } catch {
    return { ok: false, savedByMe: true, saveCount: 0 };
  }
}

/**
 * Report that a post's canonical place tag is incorrect.
 * Any authenticated user (except the post author) can submit a report.
 * Reason should be one of: 'wrong_location' | 'not_the_same_place' | 'duplicate'.
 */
export async function reportWrongPlace(
  postId: string,
  reason: string,
): Promise<{ ok: boolean; message?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Please sign in' };
  try {
    const res = await fetch(`${apiBase()}/api/posts/${encodeURIComponent(postId)}/wrong-place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason }),
    });
    if (res.status === 409) return { ok: false, message: 'You have already reported this place' };
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: (body as any).message ?? 'Could not submit report' };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: 'Network error — please try again' };
  }
}

/**
 * Hide a post from the caller's feeds. Idempotent — hiding a post twice is safe.
 * Returns true on success (the post was hidden), false on any error.
 */
export async function hidePost(postId: string): Promise<boolean> {
  const token = await freshToken();
  if (!token) return false;
  try {
    const res = await fetch(`${apiBase()}/api/posts/${encodeURIComponent(postId)}/hide`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
