/**
 * mediaProcessing — what the DEVICE does to a picked photo or video before any
 * byte of it is uploaded (Media spec §40 services/mediaProcessing.ts).
 *
 * THE SPLIT, AND WHY IT IS THIS ONE
 * The server re-encodes every image (EXIF/GPS stripped, longest edge capped at
 * 4096, lib/mediaProcessing.ts) and reads every video's duration and size from
 * its container (lib/videoProbe.ts). It has NO decoder, so two jobs can only be
 * done here, and one is only worth doing here:
 *
 *   1. VIDEO POSTER — a real frame, extracted on the device, is the only way a
 *      video postcard gets a thumbnail at all (§37 "Thumbnail generation").
 *   2. THE SERVER'S ENVELOPE, ENFORCED BEFORE THE UPLOAD — a photo larger than
 *      the server will KEEP (longest edge > 4096) or larger than it will ACCEPT
 *      (> 15 MB) is resized here, so a 48 MP original does not travel whole
 *      only to be resampled or refused on arrival. A photo INSIDE the envelope
 *      is left alone: the server keeps it at native resolution, and a second
 *      lossy encode on the device would spend quality the server means to keep.
 *   3. NORMALISED FACTS about the pick (MIME, kind, size, duration in SECONDS)
 *      — ImagePicker reports video duration in milliseconds and sometimes no
 *      file size; every composer re-derived both, differently.
 *
 * Native modules are imported LAZILY (inside the functions that need them) and
 * can be injected, so the policy runs under node:test with no react-native.
 * Every function here is fail-soft where the upload can proceed without it (a
 * poster), and fail-CLOSED where it cannot (a resize that was required but
 * failed returns an error — the oversized original is never sent in its place).
 */

/** Mirrors artifacts/api-server/src/lib/mediaProcessing.ts MAX_IMAGE_DIM — pinned by a drift test. */
export const SERVER_MAX_IMAGE_DIM = 4096;
/** Mirrors artifacts/api-server/src/lib/mediaPipeline.ts MEDIA_SIZE_LIMITS.image — pinned by a drift test. */
export const SERVER_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** JPEG quality for a REQUIRED on-device resize. Matches the capture quality every composer uses. */
export const RESIZE_QUALITY = 0.92;
/** Where in the clip the poster frame is taken: past the first (often black) frame. */
export const POSTER_TIME_MS = 300;

export interface PickedAssetLike {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  type?: string | null;
  /** ImagePicker reports this in MILLISECONDS. */
  duration?: number | null;
}

export interface NormalizedAsset {
  uri: string;
  mimeType: string;
  fileName: string;
  /** Null when the picker did not report it; resolve it from the bytes before reserving an upload. */
  fileSizeBytes: number | null;
  width: number | null;
  height: number | null;
  isVideo: boolean;
  /** Whole seconds, or null for a still / an unreported duration. */
  durationSeconds: number | null;
}

/** One normalised description of a picked asset, used by every upload path. */
export function normalizePickedAsset(picked: PickedAssetLike): NormalizedAsset {
  const isVideo = picked.type === 'video' || (typeof picked.mimeType === 'string' && picked.mimeType.startsWith('video/'));
  const mimeType = picked.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg');
  const ext = mimeType.split('/')[1] ?? (isVideo ? 'mp4' : 'jpg');
  const positive = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const durationMs = positive(picked.duration);
  return {
    uri: picked.uri,
    mimeType,
    fileName: picked.fileName ?? `upload.${ext}`,
    fileSizeBytes: positive(picked.fileSize),
    width: positive(picked.width),
    height: positive(picked.height),
    isVideo,
    durationSeconds: isVideo && durationMs != null ? Math.round(durationMs / 1000) : null,
  };
}

export type ImageUploadPlan =
  | { action: 'as_is' }
  | { action: 'resize'; resize: { width: number } | { height: number }; reason: 'exceeds_dimension' | 'exceeds_bytes' };

/**
 * Does this photo fit the server's envelope as it is?
 *
 * Over the dimension cap → scale the longest edge down TO the cap (exactly what
 * the server would have done). Over the byte cap only → scale to 70 % per side
 * (~half the pixels), which with the re-encode brings any phone photo under it.
 * Unknown dimensions with a known oversize → resize by bytes alone, by width.
 */
export function imageUploadPlan(width: number | null, height: number | null, fileSizeBytes: number | null): ImageUploadPlan {
  const w = width ?? 0;
  const h = height ?? 0;
  if (w > SERVER_MAX_IMAGE_DIM || h > SERVER_MAX_IMAGE_DIM) {
    return w >= h
      ? { action: 'resize', resize: { width: SERVER_MAX_IMAGE_DIM }, reason: 'exceeds_dimension' }
      : { action: 'resize', resize: { height: SERVER_MAX_IMAGE_DIM }, reason: 'exceeds_dimension' };
  }
  if (fileSizeBytes != null && fileSizeBytes > SERVER_MAX_IMAGE_BYTES) {
    if (w > 0 && h > 0) {
      return w >= h
        ? { action: 'resize', resize: { width: Math.round(w * 0.7) }, reason: 'exceeds_bytes' }
        : { action: 'resize', resize: { height: Math.round(h * 0.7) }, reason: 'exceeds_bytes' };
    }
    return { action: 'resize', resize: { width: SERVER_MAX_IMAGE_DIM / 2 }, reason: 'exceeds_bytes' };
  }
  return { action: 'as_is' };
}

// ── Native seams ──────────────────────────────────────────────────────────────

export type ManipulateFn = (
  uri: string,
  actions: Array<{ resize: { width?: number; height?: number } }>,
  options: { compress: number; format: 'jpeg' },
) => Promise<{ uri: string; width: number; height: number }>;

export type ThumbnailFn = (uri: string, options: { time: number; quality?: number }) => Promise<{ uri: string }>;

let _testManipulate: ManipulateFn | null = null;
let _testThumbnail: ThumbnailFn | null = null;

/** Test seam: inject image-manipulator / video-thumbnail stand-ins. Pass null to restore the real modules. */
export function _setTestMediaNatives(natives: { manipulate?: ManipulateFn | null; thumbnail?: ThumbnailFn | null }): void {
  if ('manipulate' in natives) _testManipulate = natives.manipulate ?? null;
  if ('thumbnail' in natives) _testThumbnail = natives.thumbnail ?? null;
}

async function manipulate(): Promise<ManipulateFn> {
  if (_testManipulate) return _testManipulate;
  const mod = await import('expo-image-manipulator');
  return (uri, actions, options) =>
    mod.manipulateAsync(uri, actions, { compress: options.compress, format: mod.SaveFormat.JPEG });
}

async function thumbnail(): Promise<ThumbnailFn> {
  if (_testThumbnail) return _testThumbnail;
  const mod = await import('expo-video-thumbnails');
  return (uri, options) => mod.getThumbnailAsync(uri, options);
}

export type PreparedImage =
  | { ok: true; asset: NormalizedAsset; resized: boolean }
  | { ok: false; message: string };

/**
 * Bring a photo inside the server's envelope. Videos pass through untouched —
 * there is no on-device transcoder in this app (§37 "Compression/transcoding"
 * is open for exactly that reason).
 *
 * FAIL-CLOSED: when a resize is REQUIRED and the manipulator fails, the result
 * is an error. The oversized original is never uploaded in its place — the
 * server would refuse it anyway, and a silent fallback would only move the
 * failure somewhere the user cannot see it.
 */
export async function prepareImageForUpload(asset: NormalizedAsset): Promise<PreparedImage> {
  if (asset.isVideo) return { ok: true, asset, resized: false };
  const plan = imageUploadPlan(asset.width, asset.height, asset.fileSizeBytes);
  if (plan.action === 'as_is') return { ok: true, asset, resized: false };
  try {
    const run = await manipulate();
    const out = await run(asset.uri, [{ resize: plan.resize }], { compress: RESIZE_QUALITY, format: 'jpeg' });
    return {
      ok: true,
      resized: true,
      asset: {
        ...asset,
        uri: out.uri,
        mimeType: 'image/jpeg',
        fileName: asset.fileName.replace(/\.[A-Za-z0-9]+$/, '') + '.jpg',
        // The re-encoded size is unknown until the bytes are read; the uploader resolves it.
        fileSizeBytes: null,
        width: out.width,
        height: out.height,
      },
    };
  } catch {
    return { ok: false, message: 'This photo is too large and could not be resized on your device. Try a smaller photo.' };
  }
}

/**
 * A poster frame for a video, as a local JPEG uri — or null. Never throws: a
 * video without a poster still posts (it shows the play placeholder, as every
 * video postcard did before this existed).
 */
export async function extractVideoPoster(videoUri: string): Promise<string | null> {
  try {
    const run = await thumbnail();
    const { uri } = await run(videoUri, { time: POSTER_TIME_MS, quality: 0.8 });
    return typeof uri === 'string' && uri.length > 0 ? uri : null;
  } catch {
    return null;
  }
}
