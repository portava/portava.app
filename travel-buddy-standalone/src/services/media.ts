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

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const ALLOWED_VIDEO_TYPES = ['video/mp4'];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB

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
  | 'upload_failed';

export interface MediaUploadResult {
  ok: boolean;
  url: string | null;
  mediaType: string | null;
  errorKind?: MediaErrorKind;
  message?: string;
  /** rich detail for debugging per spec (never fake "could not upload") */
  detail?: Record<string, unknown>;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export interface ValidateMediaOptions {
  /** Maximum allowed video duration in seconds. Applies to highlights (10s) and video postcards (10s). */
  maxVideoDurationSeconds?: number;
}

export function validateMedia(
  media: PickedMedia,
  opts?: ValidateMediaOptions,
): { ok: true } | { ok: false; kind: MediaErrorKind; message: string } {
  const mime = media.mimeType ?? (media.type === 'video' ? 'video/mp4' : 'image/jpeg');
  const isImage = ALLOWED_IMAGE_TYPES.includes(mime);
  const isVideo = ALLOWED_VIDEO_TYPES.includes(mime);
  if (!isImage && !isVideo) {
    return { ok: false, kind: 'invalid_type', message: `Unsupported media type: ${mime}` };
  }
  if (media.fileSize != null) {
    const max = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (media.fileSize > max) {
      return { ok: false, kind: 'too_large', message: `File too large (${Math.round(media.fileSize / 1024 / 1024)}MB; max ${Math.round(max / 1024 / 1024)}MB)` };
    }
  }
  if (isVideo && opts?.maxVideoDurationSeconds != null) {
    const duration = media.duration;
    if (duration != null && duration > opts.maxVideoDurationSeconds) {
      return {
        ok: false,
        kind: 'too_large',
        message: `Highlights and video Postcards can be up to ${opts.maxVideoDurationSeconds} seconds.`,
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
 */
export async function uploadMedia(media: PickedMedia): Promise<MediaUploadResult> {
  if (!(_testConfiguredOverride ?? isSupabaseConfigured)) {
    return { ok: false, url: null, mediaType: null, errorKind: 'config_error', message: 'Backend not configured' };
  }
  const base = apiBase();
  if (!base) {
    return { ok: false, url: null, mediaType: null, errorKind: 'config_error', message: 'API base URL not configured' };
  }

  const v = validateMedia(media);
  if (!v.ok) {
    return { ok: false, url: null, mediaType: null, errorKind: v.kind, message: v.message };
  }

  // Get a fresh bearer token (mirrors createPost / createTrip pattern).
  // _testTokenProvider bypasses supabase.auth in unit tests.
  let token: string | null;
  if (_testTokenProvider) {
    token = await _testTokenProvider();
  } else {
    const { data: refreshed } = await supabase.auth.refreshSession();
    const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
    token = session?.access_token ?? null;
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

  return { ok: true, url, mediaType: mime };
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
