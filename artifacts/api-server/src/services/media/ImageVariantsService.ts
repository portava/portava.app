import type { SupabaseClient } from "@supabase/supabase-js";
import { createImageVariantsAccess, imageSource, type ImageVariantsConfig } from "../../lib/media/imageVariants/canonical.js";
import { ImageVariantArtifacts } from "../../lib/media/imageVariants/artifacts.js";
import { createImageVariantsRuntime } from "../../lib/media/imageVariants/runtime.js";
import { abortable, IMAGE_VARIANTS_KIND, IMAGE_VARIANTS_PIPELINE, UUID, variantMime,
  type ImageVariantSource } from "../../lib/media/imageVariants/contracts.js";
import { imageVariantDescriptor, imageVariantPublication, sameImagePublication } from "../../lib/media/imageVariants/descriptor.js";

export class ImageVariantsReadError extends Error {
  constructor(readonly code: "not_found" | "feature_disabled" | "degraded_unavailable") { super(code); }
}
export type ImageVariantLookup = { reference: string } | { assetId: string; sourceVersion: number };

export function imageOriginalPath(reference: string, storageOrigin: string): string | null {
  if (!reference || reference.length > 4096 || /[\\\x00-\x20\x7f]/.test(reference)) return null;
  let path: string;
  if (reference.startsWith("post-media/")) path = reference.slice("post-media/".length);
  else {
    try {
      const origin = new URL(storageOrigin);
      const url = new URL(reference);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
          url.protocol !== "https:" || url.origin !== origin.origin || url.username || url.password || url.hash) return null;
      const rawPath = reference.slice(reference.indexOf("/", 8)).split(/[?#]/)[0];
      if (rawPath !== url.pathname) return null;
      const match = /^\/storage\/v1\/object\/(public|sign)\/post-media\/(.+)$/.exec(rawPath);
      if (!match || (match[1] === "public" ? !!url.search : url.searchParams.size !== 1 || !url.searchParams.get("token"))) return null;
      path = match[2];
    } catch { return null; }
  }
  const parts = path.split("/");
  return path.length <= 1024 && parts.length >= 2 && UUID.test(parts[0]) &&
    parts.every(part => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..") ? path : null;
}

export function createImageVariantsService(sc: SupabaseClient, configuration: ImageVariantsConfig,
  reader: Pick<ReturnType<typeof createImageVariantsRuntime>, "readFile"> = createImageVariantsRuntime(sc, configuration)) {
  const config = Object.freeze({ ...configuration });
  const access = createImageVariantsAccess(sc, config);
  const artifacts = new ImageVariantArtifacts(config.root);
  async function sourceFor(lookup: ImageVariantLookup, signal: AbortSignal): Promise<ImageVariantSource> {
    if (!config.enabled) throw new ImageVariantsReadError("feature_disabled");
    if (!await access.enabled(signal)) throw new ImageVariantsReadError("not_found");
    let source: ImageVariantSource | null;
    if ("reference" in lookup) {
      const path = imageOriginalPath(lookup.reference, config.storageOrigin);
      if (!path) throw new ImageVariantsReadError("not_found");
      const reply = await abortable(sc.from("media_assets").select("id,version,owner_user_id,storage_bucket,storage_path,size_bytes")
        .eq("storage_bucket", "post-media").eq("storage_path", path).limit(2).abortSignal(signal), signal);
      if (reply.error) throw new ImageVariantsReadError("degraded_unavailable");
      source = reply.data?.length === 1 ? imageSource(reply.data[0]) : null;
      if (source?.bucket !== "post-media" || source.path !== path) throw new ImageVariantsReadError("not_found");
    } else {
      if (!UUID.test(lookup.assetId) || !Number.isSafeInteger(lookup.sourceVersion) || lookup.sourceVersion < 1 || lookup.sourceVersion > 2147483647) throw new ImageVariantsReadError("not_found");
      source = imageSource(await access.row(lookup.assetId, signal));
      if (source?.assetId !== lookup.assetId || source.sourceVersion !== lookup.sourceVersion) throw new ImageVariantsReadError("not_found");
    }
    if (!source) throw new ImageVariantsReadError("not_found");
    return source;
  }
  async function authorized(source: ImageVariantSource, viewerId: string, signal: AbortSignal) {
    if (!await access.authorized(source, viewerId, signal) || await abortable(artifacts.revoked(source.assetId), signal)) throw new ImageVariantsReadError("not_found");
    signal.throwIfAborted();
  }
  async function ready(source: ImageVariantSource, signal: AbortSignal) {
    const reply = await abortable(sc.rpc("media_derivative_ready", {
      p_asset_id: source.assetId, p_source_version: source.sourceVersion, p_kind: IMAGE_VARIANTS_KIND,
      p_model_version: IMAGE_VARIANTS_PIPELINE, p_target_language: "", p_revision_key: "",
    }).abortSignal(signal), signal);
    if (reply.error) throw new ImageVariantsReadError("degraded_unavailable");
    if (reply.data === null) return null;
    const published = imageVariantPublication(reply.data, source);
    if (!published) throw new ImageVariantsReadError("degraded_unavailable");
    return published;
  }
  const bounded = (signal?: AbortSignal) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
  return {
    async descriptor(viewerId: string, lookup: ImageVariantLookup, parentSignal?: AbortSignal) {
      const signal = bounded(parentSignal);
      const source = await sourceFor(lookup, signal);
      await authorized(source, viewerId, signal);
      let output = await ready(source, signal);
      if (output) {
        const latest = await ready(source, signal);
        if (!latest || !sameImagePublication(output, latest)) output = null;
      }
      await authorized(source, viewerId, signal);
      return imageVariantDescriptor(source, output);
    },
    async readFile(viewerId: string, lookup: { assetId: string; sourceVersion: number }, filename: string, parentSignal?: AbortSignal) {
      if (!variantMime(filename)) throw new ImageVariantsReadError("not_found");
      const signal = bounded(parentSignal);
      const source = await sourceFor(lookup, signal);
      const output = await abortable(reader.readFile(viewerId, source, filename).then(result => {
        if (signal.aborted) { result?.bytes.fill(0); signal.throwIfAborted(); }
        return result;
      }), signal);
      if (!output) throw new ImageVariantsReadError("not_found");
      if (signal.aborted) { output.bytes.fill(0); signal.throwIfAborted(); }
      return output;
    },
  };
}
