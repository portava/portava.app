/**
 * Derivative generation — produces the standard header sizes as WebP using sharp
 * (the same image tooling the rest of the server uses via mediaProcessing).
 *
 * Sizes match the spec's wide-landscape ladder. All are cover-cropped to a fixed
 * 16:9 so cards and heroes never letterbox.
 */
import sharp from "sharp";

export interface DerivativeSpec {
  key: "master" | "hero" | "card" | "thumbnail" | "share";
  width: number;
  height: number;
}

export const DERIVATIVE_SPECS: DerivativeSpec[] = [
  { key: "master", width: 1536, height: 1024 },
  { key: "hero", width: 1440, height: 810 },
  { key: "card", width: 960, height: 540 },
  { key: "thumbnail", width: 480, height: 270 },
  { key: "share", width: 1200, height: 630 },
];

export interface DerivativeOutput {
  key: DerivativeSpec["key"];
  buffer: Buffer;
  contentType: "image/webp";
  width: number;
  height: number;
}

/** Decode a data: URL or raw base64 into a Buffer. */
export function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(b64, "base64");
}

/**
 * Validate + convert a source image buffer into all derivative sizes as WebP.
 * Rejects malformed output (sharp throws) — caller treats that as invalid_output.
 */
export async function buildDerivatives(source: Buffer): Promise<DerivativeOutput[]> {
  // Probe first so we fail fast on non-images.
  await sharp(source).metadata();
  const out: DerivativeOutput[] = [];
  for (const spec of DERIVATIVE_SPECS) {
    const buffer = await sharp(source)
      .rotate()
      .resize({ width: spec.width, height: spec.height, fit: "cover", position: "attention" })
      .webp({ quality: 82 })
      .toBuffer();
    out.push({ key: spec.key, buffer, contentType: "image/webp", width: spec.width, height: spec.height });
  }
  return out;
}
