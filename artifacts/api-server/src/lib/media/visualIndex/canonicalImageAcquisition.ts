import sharp from "sharp";
import { canonicalVisualSource, readVisualConsent } from "./canonicalVisualSource.js";
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, sameSource, type VisualSource } from "./contracts.js";
import type { VisualIndexContext } from "./localVisualIndexProvider.js";
import { assertVisualIndexOwnerActive, ownsVisualStorage, visualIndexWorkEnabled, withVisualAbort } from "./visualIndexPolicy.js";
import { VisualIndexError } from "./visualIndexError.js";

async function readBounded(response: Response, sizeBytes: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) !== sizeBytes)) ||
      ![null, "identity"].includes(response.headers.get("content-encoding"))) {
    void response.body?.cancel().catch(() => {});
    throw new Error("visual download refused");
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const chunks: Buffer[] = [];
  let total = 0;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await withVisualAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > sizeBytes) throw new VisualIndexError("visual_input_invalid", "visual byte limit exceeded");
      chunks.push(Buffer.from(next.value));
    }
    if (total !== sizeBytes) throw new VisualIndexError("visual_input_invalid", "visual byte size mismatch");
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener("abort", cancel); cancel();
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function verifyDecoded(bytes: Buffer, mime: string, maxPixels: number, signal: AbortSignal): Promise<void> {
  const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
  if (!format || mime !== `image/${format}`) throw new VisualIndexError("visual_input_invalid", "visual image type refused");
  signal.throwIfAborted();
  const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: maxPixels, animated: false }).timeout({ seconds: 3 });
  const cancel = () => decoder.destroy(new Error("visual decode cancelled"));
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const metadata = await withVisualAbort(decoder.metadata(), signal);
    if (metadata.format !== format || !metadata.width || !metadata.height || metadata.width * metadata.height > maxPixels || (metadata.pages ?? 1) !== 1) throw new VisualIndexError("visual_input_invalid", "visual image decode refused");
    const decoded = await withVisualAbort(decoder.rotate().resize({ width: 224, height: 224, fit: "inside", withoutEnlargement: true }).raw().toBuffer(), signal);
    decoded.fill(0); signal.throwIfAborted();
  } finally { signal.removeEventListener("abort", cancel); decoder.destroy(); }
}

export function createCanonicalVisualImageAcquirer(ctx: VisualIndexContext, options: { fetch?: typeof fetch } = {}) {
  return async (source: VisualSource, limits: { signal: AbortSignal; maxBytes: number; maxPixels: number }): Promise<Buffer> => {
    const signal = AbortSignal.any([limits.signal, AbortSignal.timeout(15_000)]);
    signal.throwIfAborted();
    if (!ownsVisualStorage(source) || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > MAX_IMAGE_BYTES ||
        !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || source.sizeBytes > limits.maxBytes ||
        !Number.isSafeInteger(limits.maxPixels) || limits.maxPixels < 1 || limits.maxPixels > MAX_IMAGE_PIXELS) throw new VisualIndexError("visual_input_invalid", "visual canonical input refused");
    const origin = new URL(ctx.env.SUPABASE_URL ?? "").origin;
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(origin) || ![origin, `${origin}/`].includes(ctx.env.SUPABASE_URL!)) throw new VisualIndexError("visual_configuration_invalid", "visual storage origin refused");
    let consentRevision: string | undefined;
    let expectedMime: string | undefined;
    const check = async () => {
      signal.throwIfAborted();
      if (!await visualIndexWorkEnabled(ctx)) throw new VisualIndexError("visual_index_disabled", "visual index disabled");
      signal.throwIfAborted();
      await assertVisualIndexOwnerActive(ctx.sc, source.ownerId);
      signal.throwIfAborted();
      const { data, error } = await ctx.sc.from("media_assets").select("id,version,owner_user_id,media_type,storage_bucket,storage_path,public_url,visibility,size_bytes,mime_type,processing_status,moderation_status,deleted_at,purge_status")
        .eq("id", source.assetId).abortSignal(signal).maybeSingle();
      const current = canonicalVisualSource(data);
      if (error) throw new Error("visual canonical source unavailable");
      if (!data || !current || !sameSource(current, source) || current.ownerId !== source.ownerId || current.sizeBytes !== source.sizeBytes || !ownsVisualStorage(current)) throw new VisualIndexError("visual_source_stale", "visual canonical source changed");
      const grant = await readVisualConsent(ctx.sc, current, true);
      if (!grant || grant.expiresAtMs <= Date.now() || (consentRevision && grant.revision !== consentRevision)) throw new VisualIndexError("visual_consent_revoked", "visual consent unavailable");
      if (!["image/jpeg", "image/png", "image/webp"].includes(data.mime_type) || (expectedMime && expectedMime !== data.mime_type)) throw new VisualIndexError("visual_input_invalid", "visual canonical type refused");
      consentRevision = grant.revision; expectedMime = data.mime_type;
      signal.throwIfAborted();
    };
    await withVisualAbort(check(), signal);
    const signed = await withVisualAbort(ctx.sc.storage.from("post-media").createSignedUrl(source.path, 15), signal);
    if (signed.error || typeof signed.data?.signedUrl !== "string" || signed.data.signedUrl.length > 10_000) throw new Error("visual storage signing failed");
    const url = new URL(signed.data.signedUrl);
    const expectedPath = `/storage/v1/object/sign/post-media/${source.path.split("/").map(encodeURIComponent).join("/")}`;
    if (url.origin !== origin || url.pathname !== expectedPath || url.username || url.password || url.hash ||
        url.searchParams.size !== 1 || !url.searchParams.get("token")) throw new Error("visual signed reference refused");
    await withVisualAbort(check(), signal);
    const response = await withVisualAbort((options.fetch ?? fetch)(url, { method: "GET", redirect: "error", signal, credentials: "omit", headers: { "Cache-Control": "no-store", "Accept-Encoding": "identity" } }), signal);
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mime !== expectedMime || (response.url && response.url !== url.href)) {
      void response.body?.cancel().catch(() => {}); throw new Error("visual response reference refused");
    }
    const bytes = await readBounded(response, source.sizeBytes, signal);
    try {
      await withVisualAbort(check(), signal);
      await verifyDecoded(bytes, mime!, limits.maxPixels, signal);
      await withVisualAbort(check(), signal);
      return bytes;
    } catch (error) { bytes.fill(0); throw error; }
  };
}
