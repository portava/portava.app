import { IMAGE_VARIANTS_PIPELINE, sameSource, UUID, validManifest, validSource,
  type ImageVariantFile, type ImageVariantSource, type PublishedImageVariants } from "./contracts.js";

export interface ImageVariantDescriptorFile {
  filename: string;
  url: string;
  mime: ImageVariantFile["mime"];
  width: number;
  height: number;
  bytes: number;
}
export type ImageVariantDescriptor = {
  state: "ready";
  assetId: string;
  sourceVersion: number;
  width: number;
  height: number;
  variants: ImageVariantDescriptorFile[];
} | {
  state: "original";
  reason: "not_ready";
  assetId: string;
  sourceVersion: number;
  variants: [];
};

export function imageVariantPublication(value: unknown, source: ImageVariantSource): PublishedImageVariants | null {
  if (!validManifest(value) || Buffer.byteLength(JSON.stringify(value)) > 60_000) return null;
  const published = value as PublishedImageVariants;
  return published.pipeline === IMAGE_VARIANTS_PIPELINE && UUID.test(published.token) && validSource(published.source) && sameSource(published.source, source)
    ? published : null;
}

export function sameImagePublication(left: PublishedImageVariants, right: PublishedImageVariants): boolean {
  return left.token === right.token && left.width === right.width && left.height === right.height && left.sourceSha256 === right.sourceSha256 &&
    Object.entries(left.files).every(([filename, file]) => {
      const latest = right.files[filename];
      return !!latest && latest.sha256 === file.sha256 && latest.bytes === file.bytes && latest.mime === file.mime && latest.width === file.width && latest.height === file.height;
    });
}

export function imageVariantDescriptor(source: ImageVariantSource, output: PublishedImageVariants | null): ImageVariantDescriptor {
  const identity = { assetId: source.assetId, sourceVersion: source.sourceVersion };
  if (!output) return { state: "original", reason: "not_ready", ...identity, variants: [] };
  return { state: "ready", ...identity, width: output.width, height: output.height,
    variants: Object.entries(output.files).sort(([left], [right]) => left.localeCompare(right)).map(([filename, file]) => ({
      filename, url: `/api/media/image-variants/${source.assetId}/${source.sourceVersion}/${filename}`,
      mime: file.mime, width: file.width, height: file.height, bytes: file.bytes,
    })) };
}
