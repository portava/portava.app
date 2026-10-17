import sharp from "sharp";
import { createHash } from "node:crypto";
import { processImage, makeThumbnail, makeFeedVariant, computePHash, sniffMedia } from "../../mediaProcessing.js";
import { IMAGE_VARIANTS_LIMITS, IMAGE_VARIANTS_SIZES, validManifest, type EncodedImageVariants, type ImageVariantFile } from "./contracts.js";

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function encodeImageVariants(input: Buffer): Promise<EncodedImageVariants> {
  if (!input.length || input.length > IMAGE_VARIANTS_LIMITS.inputBytes) throw new Error("image input budget exceeded");
  const sniffed = sniffMedia(input);
  if (!sniffed || sniffed.kind !== "image" || !["image/jpeg", "image/png", "image/webp"].includes(sniffed.mime)) throw new Error("unsupported image input");
  const metadata = await sharp(input, { failOn: "warning", limitInputPixels: IMAGE_VARIANTS_LIMITS.pixels }).metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > IMAGE_VARIANTS_LIMITS.pixels ||
      (metadata.pages ?? 1) !== 1 || `image/${metadata.format}` !== sniffed.mime) throw new Error("unsafe image dimensions or frames");
  const normalized = await processImage(input, sniffed);
  const buffers: Record<string, Buffer> = {};
  const files: Record<string, ImageVariantFile> = {};
  let outputBytes = 0;
  function add(filename: string, buffer: Buffer, width: number, height: number, mime: ImageVariantFile["mime"]) {
    outputBytes += buffer.length;
    if (buffer.length > IMAGE_VARIANTS_LIMITS.fileBytes || outputBytes > IMAGE_VARIANTS_LIMITS.outputBytes) throw new Error("image output budget exceeded");
    buffers[filename] = buffer;
    files[filename] = { bytes: buffer.length, sha256: sha256(buffer), width, height, mime };
  }
  try {
    const thumb = await makeThumbnail(normalized.buffer);
    add("thumb.jpg", thumb.buffer, thumb.width, thumb.height, "image/jpeg");
    const feed = await makeFeedVariant(normalized.buffer);
    add("feed.jpg", feed.buffer, feed.width, feed.height, "image/jpeg");
    for (const size of IMAGE_VARIANTS_SIZES) {
      for (const format of ["webp", "avif"] as const) {
        const pipeline = sharp(normalized.buffer, { failOn: "warning", limitInputPixels: IMAGE_VARIANTS_LIMITS.pixels })
          .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true }).timeout({ seconds: 15 });
        const output = await (format === "webp" ? pipeline.webp({ quality: 82, effort: 3 }) : pipeline.avif({ quality: 50, effort: 2 }))
          .toBuffer({ resolveWithObject: true });
        add(`image-${size}.${format}`, output.data, output.info.width, output.info.height, `image/${format}`);
      }
    }
    const phash = await computePHash(normalized.buffer);
    const manifest = { files, width: normalized.width, height: normalized.height, sourceSha256: sha256(input), phash: phash ?? "" };
    if (!validManifest(manifest)) throw new Error("invalid encoded image manifest");
    return { manifest, buffers };
  } catch (error) {
    for (const bytes of Object.values(buffers)) bytes.fill(0);
    throw error;
  } finally { normalized.buffer.fill(0); }
}
