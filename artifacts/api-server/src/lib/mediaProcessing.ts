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
  // WebM / Matroska: EBML header 1A 45 DF A3.
  //
  // Added because `video/webm` is in the postcard upload allowlist while this
  // sniffer did not recognise it — so once the postcard /complete path started
  // verifying real bytes for video (fail-closed, matching images), every
  // legitimate WebM upload would have been rejected as "not a video". Both
  // WebM and Matroska share this magic and telling them apart needs the DocType
  // element; the distinction is irrelevant here, where the only question is
  // whether the bytes are a video at all.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { kind: "video", mime: "video/webm", ext: "webm" };
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

/**
 * Longest-edge cap for stored originals.
 *
 * WHY 4096 AND NOT 3840
 * ---------------------
 * 3840 is the 4K UHD display width and is the obvious-looking choice, but it is
 * the wrong cap for a photo app, because it lands just BELOW the resolution
 * almost every real source arrives at:
 *
 *   iPhone / Galaxy 12MP   4032 × 3024
 *   Pixel 12.2MP           4080 × 3072
 *
 * Both exceed 3840 and both fit under 4096. A 3840 cap would therefore resample
 * essentially every phone photo the app receives — paying a full resize pass and
 * the softening that comes with it — to save 4.8% on the long edge. 4096 passes
 * them through at native resolution: `fit: "inside"` + `withoutEnlargement` makes
 * the resize a no-op, so the pixels are never resampled at all. The EXIF strip
 * and auto-orient still happen, because those come from the re-encode, not the
 * resize.
 *
 * 4096 also keeps the ladder on clean doublings — 4096 → 2048 was the old cap →
 * 1500 feed → 400 thumb — and leaves genuine zoom headroom on a 4K display for
 * the detail and fullscreen views, which load this asset.
 *
 * COST, STATED PLAINLY: stored originals grow up to 4096²/2048² = 4× in pixels.
 * That is a storage and per-upload CPU cost, not a bandwidth cost for viewers —
 * feeds read the 400px thumbnail and the 1500px variant, and only detail views
 * fetch this. It is also NOT an upload-size cost: see MAX_UPLOAD_IMAGE_BYTES.
 *
 * Quality stays at 82 (below). Raising the cap and the quality together would
 * multiply stored bytes twice over and make any regression — in perceived
 * quality or in storage spend — impossible to attribute to one of them.
 */
export const MAX_IMAGE_DIM = 4096;
/** Thumbnail longest edge. */
export const THUMBNAIL_DIM = 400;
/**
 * Feed-variant longest edge.
 *
 * WHY THIS EXISTS
 * ---------------
 * PostcardTile requests `?width=500`, but that parameter never reaches Storage:
 * `appStorageUrlInfo()` (lib/mediaUrl.ts) matches on `url.pathname` only and
 * documents "Query strings are ignored", and `/api/media/sign` runs every URL
 * through it before signing — so the param is stripped before the signed URL
 * exists. Since the buckets went private the Postcard Wall has been fetching
 * full 2048px originals and scaling them on-device.
 *
 * Fixed with a real derived asset rather than by forwarding the query param,
 * because a stored variant does not depend on Supabase's image-transform
 * feature being enabled, and it makes the contract an actual object that either
 * exists or does not.
 *
 * WHY 1500
 * --------
 * The tile asks for ~500pt. Phones in use are 2x or 3x DPR, so the densest
 * common case needs 500 × 3 = 1500 physical px. 1500 covers it exactly.
 *   - 1024 (2x only) is visibly soft on every 3x device.
 *   - 2048 is the status quo this replaces.
 *   - 1500² / 2048² ≈ 0.54, so roughly 46% fewer pixels than the original at
 *     the same quality setting.
 * Quality is deliberately held at the same 82 the original uses, so the saving
 * has exactly one axis (dimension) and this change cannot be confused with a
 * compression regression.
 *
 * The original is kept and remains what detail and fullscreen views load.
 */
export const FEED_DIM = 1500;

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

/**
 * Feed-sized variant (longest edge FEED_DIM) from an already-processed image.
 *
 * Same shape as makeThumbnail: it takes the ALREADY-PROCESSED buffer, so it
 * inherits the auto-orient and the full EXIF/GPS strip rather than re-deriving
 * them from the raw upload. Never call this with the raw buffer — that would
 * reintroduce the metadata this pipeline exists to remove.
 *
 * `withoutEnlargement` means a source smaller than FEED_DIM is re-encoded at its
 * own size rather than upscaled, so a small original yields a small variant
 * instead of a blurry large one.
 */
export async function makeFeedVariant(processed: Buffer): Promise<ProcessedImage> {
  const { data, info } = await sharp(processed)
    .resize({ width: FEED_DIM, height: FEED_DIM, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, mime: "image/jpeg", ext: "jpg" };
}

/**
 * Compute a 64-bit perceptual difference-hash (pHash) of an image buffer.
 *
 * Algorithm:
 *   1. Resize to 9×8 greyscale (9 columns → 8 horizontal differences per row,
 *      8 rows → 64 bits total).
 *   2. For each row, compare adjacent pixel pairs: bit = left > right ? 1 : 0.
 *   3. Pack the 64 bits into a 16-character lowercase hex string.
 *
 * Returns null (never throws) when sharp cannot decode the buffer — fail-soft
 * so a hash failure never blocks an upload or crashes the worker.
 *
 * @param input  Any image buffer accepted by sharp (jpeg, png, webp, etc.).
 */
export async function computePHash(input: Buffer): Promise<string | null> {
  try {
    // 9 cols × 8 rows greyscale raw pixels (72 bytes).
    const { data } = await sharp(input)
      .resize(9, 8, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Build 64-bit hash: 8 rows × 8 horizontal comparisons.
    let bits = "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left  = data[row * 9 + col];
        const right = data[row * 9 + col + 1];
        bits += left > right ? "1" : "0";
      }
    }

    // Pack 64 bits into 16 hex chars (4 bits per char).
    let hex = "";
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}
