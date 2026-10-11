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
import * as VideoThumbnails from 'expo-video-thumbnails';
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
    const resp = await fetch(await videoUriForUpload(media.uri, media.type === 'video', media.fileSize)); // §37 MD282: media.uri itself unless a compressor module is in the binary and switched on
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

  // The API server has no video transcoder in this tier (see mediaProcessing.ts),
  // so it never returns a thumbnailUrl for videos — every video grid tile would
  // render grey. Extract a frame on-device and upload it as a normal image so
  // the post gets a real poster, same as photos get server-side.
  let thumbnailUrl: string | null = (body as any)?.thumbnailUrl ?? null;
  if (!thumbnailUrl && media.type === 'video') {
    thumbnailUrl = await extractAndUploadVideoThumbnail(media.uri, token, (body as any)?.path ?? null);
  }

  return {
    ok: true,
    url,
    mediaType: mime,
    thumbnailUrl,
    width: (body as any)?.width ?? null,
    height: (body as any)?.height ?? null,
    processed: (body as any)?.processed ?? false,
  };
}

/**
 * Best-effort: grab a frame near the start of a local video file and hand it to
 * the server as THIS video's poster (§37, services/media/generalVideoPoster.ts):
 * stored at the video's derived poster path and recorded on its canonical row.
 * Against an API that predates that route it falls back to what this did
 * before — upload the frame as a plain image through /api/media/upload. Never
 * throws — a failed extraction just leaves thumbnailUrl null.
 */
async function extractAndUploadVideoThumbnail(videoUri: string, token: string, videoPath: string | null): Promise<string | null> {
  const extract = async (uri: string): Promise<string | null> => {
    try {
      return (await VideoThumbnails.getThumbnailAsync(uri, { time: 300 })).uri;
    } catch {
      return null;
    }
  };
  const outcome = await attachVideoPoster(videoPath, videoUri, deviceGeneralPosterDeps(apiBase(), token, extract));
  return outcome.thumbnailUrl;
}

/** Best-effort cleanup: remove an uploaded object if post creation later fails. */
export async function deleteUploadedMedia(publicUrl: string): Promise<void> {
  try {
    let path: string | null = null;
    // Format 1: bare storage path "post-media/<path>" (new format after bucket-privacy migration)
    if (publicUrl.startsWith('post-media/')) {
      path = publicUrl.slice('post-media/'.length);
    } else {
      // Format 2: legacy Supabase public URL ending with /post-media/<path>
      const marker = '/post-media/';
      const idx = publicUrl.indexOf(marker);
      if (idx !== -1) path = publicUrl.slice(idx + marker.length);
    }
    if (!path) return;
    await supabase.storage.from('post-media').remove([path]);
  } catch {
    // best-effort; ignore
  }
}

// §37 (census-media §22): the general-upload video poster. Imported at the TAIL
// so no line above moves (census-media cites this file by line); ESM hoists it.
import { attachVideoPoster, deviceGeneralPosterDeps } from './media/generalVideoPoster.ts';
// §37 MD282 (census-media §37): the device compression seam. At the TAIL for the same reason.
import { videoUriForUpload } from './media/videoCompression.ts';

// census-telegraph T223 (§16.2): resumable MESSAGE-media upload. At the TAIL so no cited line above moves; ESM hoists the imports.
import { uploadMessageMediaResumable } from './media/messageMediaResumable.ts';
import { deviceResumableTransport } from './media/uploadHttp.ts';

/**
 * uploadMedia, resumable: the same validation, the same device-side compression
 * seam, the same answer shape and the same video-poster step, but the bytes go
 * in 4 MiB parts to signed Storage URLs under `uploadId`, so calling this again
 * with the SAME id after a dropped connection resumes instead of restarting.
 * A server without the capability (3656's flag OFF) falls back to uploadMedia.
 */
export async function uploadMediaResumable(
  media: PickedMedia,
  uploadId: string,
  validateOpts?: ValidateMediaOptions,
  onProgress?: (fraction: number) => void,
  isCancelled?: () => boolean,
): Promise<MediaUploadResult> {
  if (!(_testConfiguredOverride ?? isSupabaseConfigured) || !apiBase()) return uploadMedia(media, validateOpts);
  const v = validateMedia(media, validateOpts);
  if (!v.ok) return { ok: false, url: null, mediaType: null, errorKind: v.kind, message: v.message };
  const token = _testTokenProvider ? await _testTokenProvider() : await freshApiToken();
  if (!token) return { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated', message: 'Please sign in to upload media' };
  const mime = media.mimeType ?? (media.type === 'video' ? 'video/mp4' : 'image/jpeg');
  let blob: Blob;
  try {
    blob = await (await fetch(await videoUriForUpload(media.uri, media.type === 'video', media.fileSize))).blob();
  } catch (e) {
    return { ok: false, url: null, mediaType: null, errorKind: 'read_failed', message: e instanceof Error ? e.message : 'Failed to read media file' };
  }
  const out = await uploadMessageMediaResumable(
    blob as unknown as { size: number; slice(start: number, end: number): unknown },
    mime, uploadId, deviceResumableTransport(),
    { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random, isCancelled },
    onProgress,
  );
  if (out.kind === 'unsupported') return uploadMedia(media, validateOpts);
  if (out.kind === 'failed') {
    return { ok: false, url: null, mediaType: null, errorKind: 'upload_failed', message: out.cancelled ? 'Upload cancelled' : out.message, detail: { retryable: out.retryable, resumable: true } };
  }
  let thumbnailUrl = out.media.thumbnailUrl;
  if (!thumbnailUrl && media.type === 'video') thumbnailUrl = await extractAndUploadVideoThumbnail(media.uri, token, out.media.path);
  return { ok: true, url: out.media.url, mediaType: mime, thumbnailUrl, width: out.media.width, height: out.media.height, processed: out.media.processed };
}
