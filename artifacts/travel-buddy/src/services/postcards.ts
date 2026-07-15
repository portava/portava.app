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
}

export type UploadProgressCallback = (progress: number) => void;

export interface UploadCancelRef {
  cancel?: () => void;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

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
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
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
      return { ok: false, message: (json as any)?.error ?? (json as any)?.message ?? `HTTP ${res.status}` };
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
      return { ok: false, message: (json as any)?.error ?? (json as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
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
): Promise<ApiResult<{ ok: boolean; mediaCount: number; hasVideo: boolean }>> {
  return apiPost(
    `/api/postcards/${encodeURIComponent(postId)}/media/${encodeURIComponent(mediaId)}/complete`,
    params,
  );
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
