/**
 * normalizeUpload.core — the one place a picked photo or video becomes something the server takes, without distorting it.
 *
 * WHY (owner's iPhone, 2026-10-22): nothing from an iPhone could be uploaded. Its camera roll is HEIC and HEVC `.MOV`,
 * the camera always records `.mov`, and the client accepted only JPEG/PNG/WebP and `video/mp4` — "Unsupported media
 * type" for every recording and every library pick. The server accepts JPEG/PNG/WebP and MP4/QuickTime/WebM but cannot
 * decode HEIC (routes/posts.ts), and caps images at 10 MB and videos at 50 MB.
 *
 * WHAT IT DOES
 *   - At the picker: `COMPATIBLE_LIBRARY_OPTIONS` asks iOS for a compatible copy — JPEG instead of HEIC, and H.264 MP4
 *     scaled to fit 1920×1080 instead of the HEVC original (AVAssetExportSession keeps the aspect ratio).
 *   - Photos: re-encoded on the device. Anything the server cannot take (HEIC/HEIF, TIFF, GIF stills…) becomes JPEG;
 *     PNG and WebP keep their format. The longest edge is capped at IMAGE_MAX_EDGE_PX and NEVER enlarged; only ONE
 *     dimension is handed to the manipulator, so the aspect ratio cannot change — no stretching, no cropping. If the
 *     result is over the size cap, the quality steps down (IMAGE_QUALITY_STEPS) until it fits; a PNG that will not fit
 *     falls back to JPEG. Re-encoding also strips EXIF, including GPS (as imageRender.ts already does for avatars).
 *   - Videos: the camera's `.mov` is labelled `video/quicktime`, which the server stores; `.m4v` is MP4. Length and
 *     size are then checked by `validateMedia` with the surface's own limits and stated in MB / seconds.
 *
 * WHAT IT DOES NOT DO: re-encode video on the device after picking — expo has no transcoder, so a recording longer or
 * larger than a surface allows is refused with its real numbers rather than shrunk.
 *
 * If re-encoding a photo FAILS the original is returned untouched, so `validateMedia` refuses what the server cannot
 * take (HEIC) with a clear message instead of an upload failing later.
 */
// Pure: the native seams are injected (NormalizeDeps); normalizeUpload.ts wires the real ones.
import { CAPTURE_QUALITY, IMAGE_MAX_SIZE_BYTES } from '../../constants/mediaLimits.ts';

/** Longest edge of an uploaded photo. 4096 keeps a 12 MP original whole and brings a 48 MP one down to ~12 MP. */
export const IMAGE_MAX_EDGE_PX = 4096;

/** JPEG/WebP quality, tried in order until the photo fits IMAGE_MAX_SIZE_BYTES. Starts at the app's capture quality. */
export const IMAGE_QUALITY_STEPS: readonly number[] = [CAPTURE_QUALITY, 0.85, 0.75, 0.65, 0.55];

/** The fields of a picked asset this module reads and writes — a subset of both ImagePickerAsset and PickedMedia. */
export interface UploadAsset {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  type?: string | null;
  duration?: number | null;
}

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export interface ImagePlan {
  format: ImageFormat;
  /** Exactly one dimension (the longest edge), or null when the photo is already within the cap. */
  resize: { width: number } | { height: number } | null;
}

const FORMAT_MIME: Record<ImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const FORMAT_EXT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };

export function isVideoAsset(asset: UploadAsset): boolean {
  return asset.type === 'video' || (asset.mimeType ?? '').startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(asset.fileName ?? asset.uri);
}

/** The resize that caps the LONGEST edge at `maxEdge` — never an enlargement, never two dimensions (so never a distortion). */
export function fitLongestEdge(width: number | null | undefined, height: number | null | undefined, maxEdge = IMAGE_MAX_EDGE_PX): ImagePlan['resize'] {
  if (!width || !height || width <= 0 || height <= 0) return null;
  if (Math.max(width, height) <= maxEdge) return null;
  return width >= height ? { width: maxEdge } : { height: maxEdge };
}

/** PNG and WebP keep their format; JPEG stays JPEG; anything the server cannot decode (HEIC, HEIF, TIFF, GIF…) becomes JPEG. */
export function planImage(asset: UploadAsset, maxEdge = IMAGE_MAX_EDGE_PX): ImagePlan {
  const mime = (asset.mimeType ?? '').toLowerCase();
  const ext = (asset.fileName ?? asset.uri).toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/)?.[1] ?? '';
  const format: ImageFormat = mime === 'image/png' || (!mime && ext === 'png') ? 'png'
    : mime === 'image/webp' || (!mime && ext === 'webp') ? 'webp'
    : 'jpeg';
  return { format, resize: fitLongestEdge(asset.width, asset.height, maxEdge) };
}

/** The MIME type the server stores a video under: the camera's `.mov` is QuickTime, `.m4v` is MP4. */
export function videoMimeFor(asset: UploadAsset): string {
  const mime = (asset.mimeType ?? '').toLowerCase();
  const name = (asset.fileName ?? asset.uri).toLowerCase();
  if (mime === 'video/quicktime' || mime === 'video/mov' || /\.mov(\?.*)?$/.test(name)) return 'video/quicktime';
  if (mime === 'video/mp4' || mime === 'video/x-m4v' || /\.(mp4|m4v)(\?.*)?$/.test(name)) return 'video/mp4';
  if (mime === 'video/webm' || /\.webm(\?.*)?$/.test(name)) return 'video/webm';
  return mime || 'video/mp4';
}

function renamed(fileName: string | null | undefined, ext: string): string | null {
  if (!fileName) return null;
  return /\.[A-Za-z0-9]+$/.test(fileName) ? fileName.replace(/\.[A-Za-z0-9]+$/, `.${ext}`) : `${fileName}.${ext}`;
}

/** The device seams (expo-image-manipulator, expo-file-system) — injected, so this file runs under plain node:test. */
export interface NormalizeDeps {
  /** expo-image-manipulator's manipulateAsync; its SaveFormat values ARE these strings. */
  manipulate: (uri: string, actions: Array<{ resize: { width: number } | { height: number } }>, options: { compress: number; format: ImageFormat }) => Promise<{ uri: string; width: number; height: number }>;
  /** Bytes of a local file, or null when it cannot be read (the size check is then left to the server). */
  fileSize: (uri: string) => Promise<number | null>;
  maxBytes?: number;
  maxEdge?: number;
}

/**
 * The asset as the server will take it. Same object shape back (any extra picker fields kept), with uri / mimeType /
 * fileName / fileSize / width / height replaced for a re-encoded photo, and a corrected mimeType for a video.
 */
export async function normalizeForUploadWith<T extends UploadAsset>(asset: T, deps: NormalizeDeps): Promise<T & UploadAsset> {
  if (isVideoAsset(asset)) return { ...asset, mimeType: videoMimeFor(asset) };

  const { manipulate, fileSize } = deps;
  const maxBytes = deps.maxBytes ?? IMAGE_MAX_SIZE_BYTES;
  const plan = planImage(asset, deps.maxEdge ?? IMAGE_MAX_EDGE_PX);
  const actions = plan.resize ? [{ resize: plan.resize }] : [];
  // A PNG that will not fit even losslessly is re-tried as JPEG; JPEG / WebP step their quality down.
  const attempts: Array<{ format: ImageFormat; quality: number }> = plan.format === 'png'
    ? [{ format: 'png', quality: 1 }, ...IMAGE_QUALITY_STEPS.map((quality) => ({ format: 'jpeg' as const, quality }))]
    : IMAGE_QUALITY_STEPS.map((quality) => ({ format: plan.format, quality }));

  let last: (T & UploadAsset) | null = null;
  try {
    for (const { format, quality } of attempts) {
      const out = await manipulate(asset.uri, actions, { compress: quality, format });
      const bytes = await fileSize(out.uri);
      last = {
        ...asset,
        uri: out.uri,
        width: out.width,
        height: out.height,
        mimeType: FORMAT_MIME[format],
        fileName: renamed(asset.fileName, FORMAT_EXT[format]),
        fileSize: bytes,
        type: 'image',
      };
      if (bytes == null || bytes <= maxBytes) return last;
    }
    return last ?? asset;
  } catch {
    // Re-encoding failed: hand back the original so validateMedia refuses what the server cannot take, by name.
    return asset;
  }
}
