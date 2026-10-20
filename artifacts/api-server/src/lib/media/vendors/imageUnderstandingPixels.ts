import sharp from "sharp";
import { IMAGE_UNDERSTANDING_MAX_BYTES, IMAGE_UNDERSTANDING_MAX_OUTPUT_BYTES, IMAGE_UNDERSTANDING_MAX_PIXELS } from "./imageUnderstandingContract.js";

export async function readBoundedImageUnderstandingBody(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (!response.ok || response.redirected || !response.body || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))) {
    void response.body?.cancel().catch(() => {});
    throw new Error("pixel_transport_refused");
  }
  if (signal.aborted) { void response.body.cancel().catch(() => {}); signal.throwIfAborted(); }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error("pixel_size_refused");
      chunks.push(Buffer.from(chunk.value));
    }
    if (size === 0) throw new Error("empty_pixels");
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

export async function prepareImageUnderstandingPixels(bytes: Buffer, mime: string, signal?: AbortSignal): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > IMAGE_UNDERSTANDING_MAX_BYTES) throw new Error("pixel_size_refused");
  const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
  if (!format || mime !== `image/${format}`) throw new Error("pixel_type_refused");
  signal?.throwIfAborted();
  const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: IMAGE_UNDERSTANDING_MAX_PIXELS, animated: false }).timeout({ seconds: 3 });
  const cancel = () => decoder.destroy(new Error("pixel_decode_cancelled"));
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const metadata = await decoder.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) throw new Error("pixel_decode_refused");
    const normalized = await decoder.rotate().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
    signal?.throwIfAborted();
    if (normalized.length > IMAGE_UNDERSTANDING_MAX_OUTPUT_BYTES) throw new Error("pixel_output_refused");
    return normalized;
  } finally {
    signal?.removeEventListener("abort", cancel);
    decoder.destroy();
  }
}

export type ImageUnderstandingStorageRead = {
  sc: any; origin: string; path: string; mime: string; signal: AbortSignal; beforeRead(): Promise<void>; fetch?: typeof fetch; expectedBytes?: number;
};

export async function readImageUnderstandingStorageBytes(input: ImageUnderstandingStorageRead): Promise<Buffer> {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(input.origin)) throw new Error("storage_origin_refused");
  if (input.expectedBytes !== undefined && (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1 || input.expectedBytes > IMAGE_UNDERSTANDING_MAX_BYTES)) throw new Error("pixel_size_refused");
  input.signal.throwIfAborted();
  await input.beforeRead();
  input.signal.throwIfAborted();
  const signed = await input.sc.storage.from("post-media").createSignedUrl(input.path, 15);
  input.signal.throwIfAborted();
  if (signed.error || typeof signed.data?.signedUrl !== "string") throw new Error("storage_signing_refused");
  const url = new URL(signed.data.signedUrl);
  const expectedPath = `/storage/v1/object/sign/post-media/${input.path.split("/").map(encodeURIComponent).join("/")}`;
  if (url.origin !== input.origin || url.username || url.password || url.hash || url.pathname !== expectedPath || !url.searchParams.get("token") || [...url.searchParams.keys()].some(key => key !== "token")) throw new Error("storage_reference_refused");
  await input.beforeRead();
  input.signal.throwIfAborted();
  const response = await (input.fetch ?? fetch)(url, { method: "GET", redirect: "error", signal: input.signal, headers: { "Cache-Control": "no-store" } });
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mime !== input.mime) { void response.body?.cancel().catch(() => {}); throw new Error("storage_type_refused"); }
  const raw = await readBoundedImageUnderstandingBody(response, IMAGE_UNDERSTANDING_MAX_BYTES, input.signal);
  if (input.expectedBytes !== undefined && raw.length !== input.expectedBytes) { raw.fill(0); throw new Error("pixel_size_refused"); }
  return raw;
}

export async function acquireImageUnderstandingPixels(input: ImageUnderstandingStorageRead): Promise<{ bytes: Buffer; inputBytes: number }> {
  const raw = await readImageUnderstandingStorageBytes(input);
  try {
    return { bytes: await prepareImageUnderstandingPixels(raw, input.mime, input.signal), inputBytes: raw.length };
  } finally {
    raw.fill(0);
  }
}
