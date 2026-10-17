export const IMAGE_VARIANTS_KIND = "image_variants" as const;
export const IMAGE_VARIANTS_PIPELINE = "sharp-responsive-v1";
export const IMAGE_VARIANTS_LIMITS = Object.freeze({ inputBytes: 8 * 1024 * 1024, pixels: 4096 * 4096,
  fileBytes: 8 * 1024 * 1024, outputBytes: 24 * 1024 * 1024, files: 8, encodeMs: 90_000, jobMs: 120_000 });
export const IMAGE_VARIANTS_SIZES = [320, 800, 1600] as const;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface ImageVariantSource {
  assetId: string;
  ownerUserId: string;
  sourceVersion: number;
  bucket: string;
  path: string;
  sizeBytes: number;
}
export interface ImageVariantsContext {
  job: Readonly<ImageVariantSource & { id: string; token: string; kind: string; modelVersion: string; targetLanguage?: string; revisionKey?: string }>;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
}
export interface ImageVariantFile {
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  mime: "image/jpeg" | "image/webp" | "image/avif";
}
export interface ImageVariantManifest {
  files: Record<string, ImageVariantFile>;
  width: number;
  height: number;
  sourceSha256: string;
  phash: string;
}
export interface EncodedImageVariants { manifest: ImageVariantManifest; buffers: Record<string, Buffer> }
export interface PublishedImageVariants extends ImageVariantManifest {
  source: ImageVariantSource;
  pipeline: string;
  token: string;
}
export function validSource(source: ImageVariantSource): boolean {
  return !!source && UUID.test(source.assetId) && UUID.test(source.ownerUserId) && source.bucket === "post-media" &&
    Number.isSafeInteger(source.sourceVersion) && source.sourceVersion > 0 && source.sourceVersion <= 2147483647 &&
    Number.isSafeInteger(source.sizeBytes) && source.sizeBytes > 0 && source.sizeBytes <= IMAGE_VARIANTS_LIMITS.inputBytes &&
    typeof source.path === "string" && source.path.length <= 1024 && source.path.startsWith(`${source.ownerUserId}/`) &&
    source.path.split("/").every(part => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..");
}
export function sameSource(left: ImageVariantSource, right: ImageVariantSource): boolean {
  return left.assetId === right.assetId && left.ownerUserId === right.ownerUserId && left.sourceVersion === right.sourceVersion &&
    left.bucket === right.bucket && left.path === right.path && left.sizeBytes === right.sizeBytes;
}
export function variantMime(filename: string): ImageVariantFile["mime"] | null {
  if (/^(thumb|feed)\.jpg$/.test(filename)) return "image/jpeg";
  const match = /^image-(320|800|1600)\.(webp|avif)$/.exec(filename);
  return match ? `image/${match[2]}` as ImageVariantFile["mime"] : null;
}
export function validManifest(value: unknown): value is ImageVariantManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as ImageVariantManifest;
  const dimension = (size: number) => Number.isInteger(size) && size > 0 && size <= 4096;
  if (!dimension(manifest.width) || !dimension(manifest.height) || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256) ||
      !/^[a-f0-9]{16}$/.test(manifest.phash) || !manifest.files || Array.isArray(manifest.files)) return false;
  const entries = Object.entries(manifest.files);
  return entries.length === IMAGE_VARIANTS_LIMITS.files && entries.every(([filename, file]) =>
    file && variantMime(filename) !== null && variantMime(filename) === file.mime && dimension(file.width) && dimension(file.height) &&
    file.width <= manifest.width && file.height <= manifest.height &&
    Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= IMAGE_VARIANTS_LIMITS.fileBytes && /^[a-f0-9]{64}$/.test(file.sha256)) &&
    entries.reduce((total, [, file]) => total + file.bytes, 0) <= IMAGE_VARIANTS_LIMITS.outputBytes;
}
export async function abortable<Value>(operation: PromiseLike<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(new Error("image variants cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
