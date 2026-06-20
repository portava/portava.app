/**
 * Media upload service. Uploads a picked image/video to the `post-media`
 * Supabase Storage bucket under the user's own folder, then returns the public
 * URL. The composer calls this BEFORE POST /api/posts; if upload fails, the post
 * is not created (and no fake URL is ever used).
 *
 * Path: post-media/{userId}/{uuid}.{ext}  (RLS lets a user write only their own
 * folder.)
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

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

function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'video/mp4': return 'mp4';
    default: return 'bin';
  }
}

function uuid(): string {
  // RFC4122-ish; crypto.randomUUID where available, else fallback.
  const g: any = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function validateMedia(media: PickedMedia): { ok: true } | { ok: false; kind: MediaErrorKind; message: string } {
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
  return { ok: true };
}

/**
 * Upload one picked media asset. Returns the public URL on success.
 * Steps: validate -> resolve current user -> fetch(uri)->blob -> storage.upload
 * -> getPublicUrl. Rich error detail on failure (no generic "could not upload").
 */
export async function uploadMedia(media: PickedMedia): Promise<MediaUploadResult> {
  if (!isSupabaseConfigured) {
    return { ok: false, url: null, mediaType: null, errorKind: 'config_error', message: 'Backend not configured' };
  }

  const v = validateMedia(media);
  if (!v.ok) {
    return { ok: false, url: null, mediaType: null, errorKind: v.kind, message: v.message };
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id ?? null;
  if (!userId) {
    return { ok: false, url: null, mediaType: null, errorKind: 'unauthenticated', message: 'Please sign in to upload media' };
  }

  const mime = media.mimeType ?? (media.type === 'video' ? 'video/mp4' : 'image/jpeg');
  const path = `${userId}/${uuid()}.${extFromMime(mime)}`;

  // Convert the local file URI to a Blob (Expo/web compatible).
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

  const { error: upErr } = await supabase.storage
    .from('post-media')
    .upload(path, blob, { contentType: mime, upsert: false });

  if (upErr) {
    return {
      ok: false, url: null, mediaType: null, errorKind: 'upload_failed',
      message: upErr.message,
      detail: {
        bucket: 'post-media',
        path,
        mimeType: mime,
        fileSize: media.fileSize ?? blob.size ?? null,
        statusCode: (upErr as any).statusCode ?? (upErr as any).status ?? null,
        userPresent: Boolean(userId),
      },
    };
  }

  const { data: pub } = supabase.storage.from('post-media').getPublicUrl(path);
  const url = pub?.publicUrl ?? null;
  if (!url) {
    return { ok: false, url: null, mediaType: null, errorKind: 'upload_failed', message: 'Uploaded but could not resolve public URL', detail: { path } };
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
