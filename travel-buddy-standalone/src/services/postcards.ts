/**
 * Postcards service — mobile client for the structured media upload flow.
 *
 * Upload flow:
 *   1. createPostcard()      — POST /api/postcards (creates the post shell, returns postId)
 *   2. getUploadUrl()        — POST /api/postcards/:id/media/upload-url (reserve slot + signed URL)
 *   3. uploadToSignedUrl()   — PUT file directly to Supabase Storage (XHR with progress)
 *   4. completeUpload()      — POST /api/postcards/:id/media/:mediaId/complete (mark ready)
 *   5. deleteMedia()         — DELETE /api/postcards/:id/media/:mediaId (owner removal)
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

export type PostcardVisibility = 'public' | 'private' | 'trip_only';

export interface PostcardMediaItem {
  id: string;
  media_type: 'image' | 'video';
  url: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  sort_order: number;
  processing_status: 'pending' | 'ready' | 'failed';
}

export interface CreatePostcardParams {
  caption?: string;
  visibility?: PostcardVisibility;
  locationName?: string;
  locationCity?: string;
  locationCountry?: string;
  locationLat?: number;
  locationLng?: number;
  tripId?: string;
  /** Provider place reference (e.g. "nominatim:123") — stored as posts.location_place_id. */
  placeId?: string;
  /** Universal canonical location registry id from the GlobalPlacePicker resolution. */
  canonicalLocationId?: string;
  addToPassport?: boolean;
}

export interface UploadUrlParams {
  mimeType: string;
  fileSizeBytes: number;
}

export interface CompleteUploadParams {
  mimeType: string;
  fileSizeBytes: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  thumbnailPath?: string;
  /**
   * Optional passport-stamp overlay placement. The server validates
   * eligibility (earned or location-matching) and pins the artwork URL —
   * the client never sends artwork URLs. Ineligible stamps never block the
   * upload; the response carries stampOverlayApplied/stampOverlayError.
   */
  stampOverlay?: {
    stampDefinitionId: string;
    style?: 'original' | 'white' | 'dark' | 'watermark';
    x: number;
    y: number;
    scale: number;
    rotation?: number;
    opacity?: number;
  };
}

export type UploadProgressCallback = (progress: number) => void;

export interface UploadCancelRef {
  cancel?: () => void;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

/**
 * Convert a server error payload into text safe to show users.
 * sendError() on the API puts the machine code in `error` and (sometimes) a
 * human sentence in `message`; when message is omitted the server defaults it
 * to the code, so `message === code` means "no human text provided" and we
 * substitute a friendly fallback instead of surfacing a raw code like
 * "db_error" in the UI.
 */
const FRIENDLY_BY_CODE: Record<string, string> = {
  db_error: 'Something went wrong while saving. Please try again.',
  server_not_configured: 'The server is temporarily unavailable. Please try again shortly.',
  feature_disabled: 'Posting is temporarily disabled. Please try again later.',
  rate_limited: 'Too many requests — give it a moment and try again.',
  unauthenticated: 'Please sign in to continue.',
  forbidden: "You don't have access to this postcard.",
  not_found: "We couldn't find that postcard.",
  invalid_payload: "Something about this postcard isn't valid. Please review and try again.",
};

function readableError(json: unknown, status: number): string {
  const j = json as { error?: unknown; message?: unknown } | null;
  const code = typeof j?.error === 'string' ? j.error : undefined;
  const message = typeof j?.message === 'string' ? j.message : undefined;
  if (message && message !== code) return message;
  if (code && FRIENDLY_BY_CODE[code]) return FRIENDLY_BY_CODE[code];
  return `Something went wrong (${code ?? `HTTP ${status}`}). Please try again.`;
}

export const POSTCARD_ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];
export const POSTCARD_ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
export const POSTCARD_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const POSTCARD_MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export function validatePostcardMedia(
  mimeType: string,
  fileSizeBytes: number,
): { ok: true } | { ok: false; reason: 'mime' | 'size'; message: string } {
  const isImage = POSTCARD_ALLOWED_IMAGE_TYPES.includes(mimeType);
  const isVideo = POSTCARD_ALLOWED_VIDEO_TYPES.includes(mimeType);
  if (!isImage && !isVideo) {
    return { ok: false, reason: 'mime', message: `Unsupported type: ${mimeType}` };
  }
  const max = isVideo ? POSTCARD_MAX_VIDEO_BYTES : POSTCARD_MAX_IMAGE_BYTES;
  if (fileSizeBytes > max) {
    return {
      ok: false,
      reason: 'size',
      message: `File too large (${Math.round(fileSizeBytes / 1024 / 1024)}MB; max ${Math.round(max / 1024 / 1024)}MB)`,
    };
  }
  return { ok: true };
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, message: 'Backend not configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Please sign in to continue' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: readableError(json, res.status) };
    }
    return { ok: true, data: json as T };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}

async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, message: 'Backend not configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Please sign in to continue' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: readableError(json, res.status) };
    }
    return { ok: true, data: json as T };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}

async function apiDelete(path: string): Promise<ApiResult<unknown>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, message: 'Backend not configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Please sign in to continue' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: readableError(json, res.status) };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}

/**
 * Discard an abandoned postcard shell.
 *
 * Step 1 creates a REAL posts row — `status: 'active'` with the author's chosen
 * visibility — before a single byte has been uploaded. Every step after it can
 * fail or be cancelled, and nothing reaped the shell when they did: the server's
 * sweep-orphans job collects orphaned `post_media` rows only and never touches
 * the posts row. The result was an empty, publicly-visible post on the author's
 * profile for every failed or cancelled attempt.
 *
 * Best-effort by design: this runs on a path that is ALREADY failing, so it must
 * never surface a second error or block the composer from resetting. A shell
 * that survives a failed discard is the old behaviour, not a new problem.
 */
export async function discardPostcardShell(postId: string): Promise<void> {
  await apiDelete(`/api/posts/${encodeURIComponent(postId)}`).catch(() => undefined);
}

/** Step 1 — create the post shell. Returns the postId for subsequent steps. */
export async function createPostcard(
  params: CreatePostcardParams,
): Promise<ApiResult<{ id: string }>> {
  return apiPost('/api/postcards', {
    caption:         params.caption,
    visibility:      params.visibility ?? 'public',
    locationName:    params.locationName,
    locationCity:    params.locationCity,
    locationCountry: params.locationCountry,
    locationLat:     params.locationLat,
    locationLng:     params.locationLng,
    tripId:          params.tripId,
    placeId:         params.placeId,
    canonicalLocationId: params.canonicalLocationId,
    addToPassport:   params.addToPassport ?? true,
  });
}

/** Step 2 — reserve a media slot and get a signed upload URL. */
export async function getUploadUrl(
  postId: string,
  params: UploadUrlParams,
): Promise<ApiResult<{ mediaId: string; uploadUrl: string; path: string }>> {
  return apiPost(
    `/api/postcards/${encodeURIComponent(postId)}/media/upload-url`,
    params,
  );
}

/**
 * Step 3 — PUT the file body directly to the Supabase Storage signed URL.
 * Uses XMLHttpRequest for upload-progress events.
 * Pass a cancelRef; setting cancelRef.cancel() aborts the XHR.
 */
export function uploadToSignedUrl(
  signedUrl: string,
  fileUri: string,
  mimeType: string,
  onProgress?: UploadProgressCallback,
  cancelRef?: UploadCancelRef,
): Promise<{ ok: boolean; message?: string }> {
  return new Promise(async (resolve) => {
    let blob: Blob;
    try {
      const resp = await fetch(fileUri);
      blob = await resp.blob();
    } catch (e) {
      resolve({ ok: false, message: e instanceof Error ? e.message : 'Failed to read file' });
      return;
    }

    const xhr = new XMLHttpRequest();

    if (cancelRef) {
      cancelRef.cancel = () => {
        xhr.abort();
      };
    }

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    });

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, message: `Upload failed (HTTP ${xhr.status})` });
      }
    };

    xhr.onerror = () => resolve({ ok: false, message: 'Network error during upload' });
    xhr.onabort = () => resolve({ ok: false, message: 'Upload cancelled' });

    xhr.open('PUT', signedUrl);
    xhr.setRequestHeader('Content-Type', mimeType);
    xhr.send(blob);
  });
}

/** Step 4 — tell the server the upload is done; it marks status=ready and updates counts. */
export async function completeUpload(
  postId: string,
  mediaId: string,
  params: CompleteUploadParams,
): Promise<ApiResult<{
  ok: boolean;
  mediaCount: number;
  hasVideo: boolean;
  /** Present only when a stampOverlay was requested. */
  stampOverlayApplied?: boolean;
  stampOverlayError?: string;
}>> {
  return apiPost(
    `/api/postcards/${encodeURIComponent(postId)}/media/${encodeURIComponent(mediaId)}/complete`,
    params,
  );
}

/**
 * Stamps the current user may place on a postcard photo: their earned stamps
 * plus universal stamps suggested for the tagged location. Server-filtered to
 * approved + active artwork and the user's own inventory.
 */
export async function getStampOverlayOptions(params: {
  city?: string | null;
  country?: string | null;
  q?: string;
} = {}): Promise<ApiResult<{
  suggested: import('../lib/stampOverlay').StampOverlayOption[];
  earned: import('../lib/stampOverlay').StampOverlayOption[];
}>> {
  const qs = new URLSearchParams();
  if (params.city) qs.set('city', params.city);
  if (params.country) qs.set('country', params.country);
  if (params.q) qs.set('q', params.q);
  const suffix = qs.toString();
  return apiGet(`/api/postcards/stamp-overlay-options${suffix ? `?${suffix}` : ''}`);
}

/** Remove one media item from a postcard (owner-only). */
export async function deleteMedia(
  postId: string,
  mediaId: string,
): Promise<ApiResult<unknown>> {
  return apiDelete(
    `/api/postcards/${encodeURIComponent(postId)}/media/${encodeURIComponent(mediaId)}`,
  );
}
