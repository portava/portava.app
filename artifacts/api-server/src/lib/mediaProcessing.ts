/**
 * mediaProcessing — server-side image hardening for user uploads.
 *
 * Three jobs, all privacy/safety-first:
 *   1. sniffMedia()   — magic-number content sniffing. The Content-Type header
 *                       is client-declared and untrusted; the bytes decide.
 *   2. processImage() — re-encode via sharp: auto-orient from EXIF, cap the
 *                       longest edge, and (because sharp strips metadata by
 *                       default on re-encode) REMOVE ALL EXIF — including
 *                       embedded GPS. This is the fix for the audit's most
 *                       severe privacy finding: raw photos were stored with
 *                       capture coordinates intact, defeating the app's
 *                       location-privacy model.
 *   3. makeThumbnail() — real server-side thumbnail (until now thumbnails were
 *                       client-declared), so small cards stop fetching originals.
 *
 * Videos are NOT transcoded here (no ffmpeg in this tier) — they are sniffed
 * and size-capped only; that limitation is documented, not hidden.
 */
import sharp from "sharp";

export type SniffedKind = "image" | "video";

export interface SniffResult {
  kind: SniffedKind;
  mime: string;
  ext: string;
}

/** Magic-number sniff. Returns null when the bytes match no supported format. */
export function sniffMedia(buf: Buffer): SniffResult | null {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { kind: "image", mime: "image/png", ext: "png" };
  }
  // WebP: "RIFF"...."WEBP"
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { kind: "image", mime: "image/webp", ext: "webp" };
  }
  // MP4 / MOV / HEIC family: size box then "ftyp" at offset 4
  if (buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12).toLowerCase();
    if (brand.startsWith("hei") || brand.startsWith("mif")) {
      return { kind: "image", mime: "image/heic", ext: "heic" };
    }
    if (brand.startsWith("qt")) {
      return { kind: "video", mime: "video/quicktime", ext: "mov" };
    }
    return { kind: "video", mime: "video/mp4", ext: "mp4" };
  }
  return null;
}

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  mime: string;
  ext: string;
}

/** Longest-edge cap for stored originals. */
export const MAX_IMAGE_DIM = 2048;
/** Thumbnail longest edge. */
export const THUMBNAIL_DIM = 400;

/**
 * Re-encode an image: auto-orient (bakes EXIF orientation into pixels), cap
 * the longest edge, strip ALL metadata (EXIF/GPS/XMP — sharp default on
 * re-encode). Output format follows the sniffed input format (jpeg/png/webp);
 * HEIC inputs are converted to JPEG (HEIC decode support varies by libvips
 * build — callers should catch and apply their documented fallback policy).
 * Throws on corrupt/undecodable input — callers reject the upload.
 */
export async function processImage(
  input: Buffer,
  sniffed: SniffResult,
  maxDim: number = MAX_IMAGE_DIM,
): Promise<ProcessedImage> {
  let pipeline = sharp(input, { failOn: "error" })
    .rotate() // auto-orient from EXIF before the EXIF is stripped
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true });

  let mime = sniffed.mime;
  let ext = sniffed.ext;
  if (mime === "image/png") {
    pipeline = pipeline.png();
  } else if (mime === "image/webp") {
    pipeline = pipeline.webp({ quality: 82 });
  } else {
    // jpeg + heic → jpeg
    pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
    mime = "image/jpeg";
    ext = "jpg";
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, mime, ext };
}

/** JPEG thumbnail (longest edge THUMBNAIL_DIM) from an already-processed image. */
export async function makeThumbnail(processed: Buffer): Promise<ProcessedImage> {
  const { data, info } = await sharp(processed)
    .resize({ width: THUMBNAIL_DIM, height: THUMBNAIL_DIM, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, mime: "image/jpeg", ext: "jpg" };
}
