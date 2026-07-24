/**
 * Media upload service. Uploads a picked image/video through the API server's
 * POST /api/media/upload endpoint (service-role key, bypasses Storage RLS),
 * then returns the public URL. The composer calls this BEFORE POST /api/posts;
 * if upload fails, the post is not created (and no fake URL is ever used).
 *
 * NOTE: We deliberately do NOT write to Supabase Storage directly from the
 * client. The Supabase project uses an ECC P-256 JWT key; PostgREST / Storage
 * cannot fully resolve auth.uid() from it, so user-key uploads fail RLS.
 * The API server calls auth.getUser(token) (Auth endpoint, not PostgREST) to
 * verify identity, then uploads with the service-role key — same pattern as
 * trip / post creation.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import {
  VIDEO_MAX_SIZE_BYTES,
  IMAGE_MAX_SIZE_BYTES,
  VIDEO_MAX_DURATION_SECONDS,
  ACCEPTED_VIDEO_TYPES,
  ACCEPTED_IMAGE_TYPES,
  type VideoSurface,
} from '../constants/mediaLimits.ts';

// ---------------------------------------------------------------------------
// Test-only injection slots — let unit tests bypass supabase at the boundary.
// Never set in production.
// ---------------------------------------------------------------------------
let _testTokenProvider: (() => Promise<string | null>) | null = null;
/** Inject a fake token provider for unit tests. Pass null to reset. */
export function _setTestTokenProvider(fn: (() => Promise<string | null>) | null): void {
  _testTokenProvider = fn;
}

let _testConfiguredOverride: boolean | null = null;
/** Override the isSupabaseConfigured check for unit tests. Pass null to reset. */
export function _setTestConfiguredOverride(v: boolean | null): void {
  _testConfiguredOverride = v;
}

/** @deprecated Use ACCEPTED_IMAGE_TYPES from constants/mediaLimits.ts */
export const ALLOWED_IMAGE_TYPES = [...ACCEPTED_IMAGE_TYPES];
/** @deprecated Use ACCEPTED_VIDEO_TYPES from constants/mediaLimits.ts */
export const ALLOWED_VIDEO_TYPES = [...ACCEPTED_VIDEO_TYPES];
/** @deprecated Use IMAGE_MAX_SIZE_BYTES from constants/mediaLimits.ts */
export const MAX_IMAGE_BYTES = IMAGE_MAX_SIZE_BYTES;
/** @deprecated Use VIDEO_MAX_SIZE_BYTES from constants/mediaLimits.ts */
export const MAX_VIDEO_BYTES = VIDEO_MAX_SIZE_BYTES;

export interface PickedMedia {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  type?: 'image' | 'video' | string | null;
  /** Video duration in seconds (from ImagePicker asset.duration / 1000). null for images. */
  duration?: number | null;
}

export type MediaErrorKind =
  | 'config_error'
  | 'unauthenticated'
  | 'invalid_type'
  | 'too_large'
  | 'read_failed'
  | 'upload_failed'
  | 'rate_limited'
  | 'invalid_payload';

export interface MediaUploadResult {
  ok: boolean;
  url: string | null;
  mediaType: string | null;
  errorKind?: MediaErrorKind;
  message?: string;
  /** rich detail for debugging per spec (never fake "could not upload") */
  detail?: Record<string, unknown>;
  /** Server-generated thumbnail URL (null when not yet processed or not applicable). */
  thumbnailUrl?: string | null;
  /** Intrinsic width of the uploaded media in pixels (null when unavailable). */
  width?: number | null;
  /** Intrinsic height of the uploaded media in pixels (null when unavailable). */
  height?: number | null;
  /** True when the server has finished post-processing (thumbnails, transcoding). */
  processed?: boolean;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export interface ValidateMediaOptions {
  /**
   * Maximum allowed video duration in seconds. Takes precedence over `surface`.
   * Kept for backwards compatibility — prefer `surface` for new callers.
   */
  maxVideoDurationSeconds?: number;
  /**
   * Named surface — looks up VIDEO_MAX_DURATION_SECONDS[surface] as the
   * duration limit. Ignored when maxVideoDurationSeconds is also set.
   * Defaults to the old highlight limit (10 s) if neither is provided.
   */
  surface?: VideoSurface;
}

export function validateMedia(
  media: PickedMedia,
  opts?: ValidateMediaOptions,
): { ok: true } | { ok: false; kind: MediaErrorKind; message: string } {
  const mime = media.mimeType ?? (media.type === 'video' ? 'video/mp4' : 'image/jpeg');
  const isImage = (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(mime);
  const isVideo = (ACCEPTED_VIDEO_TYPES as readonly string[]).includes(mime);
  if (!isImage && !isVideo) {
    return { ok: false, kind: 'invalid_type', message: `Unsupported media type: ${mime}` };
  }
  if (media.fileSize != null) {
    const max = isVideo ? VIDEO_MAX_SIZE_BYTES : IMAGE_MAX_SIZE_BYTES;
    if (media.fileSize > max) {
      return { ok: false, kind: 'too_large', message: `File too large (${Math.round(media.fileSize / 1024 / 1024)}MB; max ${Math.round(max / 1024 / 1024)}MB)` };
    }
  }
  if (isVideo) {
    // Resolve duration limit: explicit opt > surface lookup > legacy default (10s)
    const maxDuration =
      opts?.maxVideoDurationSeconds ??
      (opts?.surface != null ? VIDEO_MAX_DURATION_SECONDS[opts.surface] : undefined) ??
      VIDEO_MAX_DURATION_SECONDS.highlight;

    const duration = media.duration;
    if (duration != null && duration > maxDuration) {
      return {
        ok: false,
        kind: 'too_large',
        message: `Video can be up to ${maxDuration} seconds for this surface.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Upload one picked media asset via POST /api/media/upload (API server,
 * service-role key — bypasses Storage RLS). Returns the public URL on success.
 * Steps: validate → get bearer token → fetch(uri)→blob → POST binary to API →
 * parse { url, path }. Rich error detail on failure.
 *
 * @param validateOpts  Surface-specific validation options (e.g. `{ surface: 'event' }`).
 *   When omitted, the legacy highlight limit (10 s) is applied for backward compatibility.
 */
export async function uploadMedia(media: PickedMedia, validateOpts?: ValidateMediaOptions): Promise<MediaUploadResult> {
  if (!(_testConfiguredOverride ?? isSupabaseConfigured)) {
    return { ok: false, url: null, mediaType: null, errorKind: 'config_error', message: 'Backend not configured' };
  }
  const base = apiBase();
  if (!base) {
    return { ok: false, url: null, mediaType: null, errorKind: 'config_error', message: 'API base URL not configured' };
  }

  const v = validateMedia(media, validateOpts);
  if (!v.ok) {
    return { ok: false, url: null, mediaType: null, errorKind: v.kind, message: v.message };
  }

  // Get a fresh bearer token (mirrors createPost / createTrip pattern).
  // _testTokenProvider bypasses supabase.auth in unit tests.
  let token: string | null;
  if (_testTokenProvider) {
    token = await _testTokenProvider();
  } else {
    token = await freshApiToken();
  }
  if (!token) {
    return { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated', message: 'Please sign in to upload media' };
  }

  const mime = media.mimeType ?? (media.type === 'video' ? 'video/mp4' : 'image/jpeg');

  // Read the local file URI into a Blob (Expo/web compatible).
  let blob: Blob;
  try {
    const resp = await fetch(media.uri);
    blob = await resp.blob();
  } catch (e) {
    return {
      ok: false, url: null, mediaType: null, errorKind: 'read_failed',
      message: e instanceof Error ? e.message : 'Failed to read media file',
      detail: { uri: media.uri, mime },
    };
  }

  // POST the raw binary to the API server — it uploads with service-role key.
  let apiRes: Response;
  try {
    apiRes = await fetch(`${base}/api/media/upload`, {
      method: 'POST',
      headers: { 'Content-Type': mime, Authorization: `Bearer ${token}` },
      body: blob,
    });
  } catch (e) {
    return {
      ok: false, url: null, mediaType: null, errorKind: 'upload_failed',
      message: e instanceof Error ? e.message : 'Network error during upload',
    };
  }

  if (!apiRes.ok) {
    const body = await apiRes.json().catch(() => ({}));
    // 401 means the session is invalid (expired, revoked, or user deleted).
    // Surface it as 'unauthenticated' so the composer can redirect to sign-in.
    if (apiRes.status === 401) {
      return { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated', message: 'Session expired — please sign in again.' };
    }
    // 429 or explicit rate_limited code from the server.
    if (apiRes.status === 429 || (body as any)?.error === 'rate_limited') {
      return {
        ok: false, url: null, mediaType: null, errorKind: 'rate_limited',
        message: (body as any)?.message ?? 'Too many uploads — please wait a moment and try again.',
      };
    }
    // invalid_payload: the file was unreadable or malformed on the server side.
    if ((body as any)?.error === 'invalid_payload') {
      return {
        ok: false, url: null, mediaType: null, errorKind: 'invalid_payload',
        message: (body as any)?.message ?? "This file couldn't be read — try a different photo.",
      };
    }
    return {
      ok: false, url: null, mediaType: null, errorKind: 'upload_failed',
      message: (body as any)?.message ?? `Upload failed (HTTP ${apiRes.status})`,
      detail: { status: apiRes.status, mimeType: mime, fileSize: media.fileSize ?? blob.size },
    };
  }

  const body = await apiRes.json().catch(() => ({}));
  const url: string | null = (body as any)?.url ?? null;
  if (!url) {
    return { ok: false, url: null, mediaType: null, errorKind: 'upload_failed', message: 'Upload succeeded but no URL returned' };
  }

  return {
    ok: true,
    url,
    mediaType: mime,
    thumbnailUrl: (body as any)?.thumbnailUrl ?? null,
    width: (body as any)?.width ?? null,
    height: (body as any)?.height ?? null,
    processed: (body as any)?.processed ?? false,
  };
}

/** Best-effort cleanup: remove an uploaded object if post creation later fails. */
export async function deleteUploadedMedia(publicUrl: string): Promise<void> {
  try {
    // publicUrl ends with /storage/v1/object/public/post-media/<path>
    const marker = '/post-media/';
    const idx = publicUrl.indexOf(marker);
    if (idx === -1) return;
    const path = publicUrl.slice(idx + marker.length);
    await supabase.storage.from('post-media').remove([path]);
  } catch {
    // best-effort; ignore
  }
}
