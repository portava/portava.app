import type { SupabaseClient } from "@supabase/supabase-js";
import { ImageVariantArtifacts } from "./artifacts.js";
import { createImageVariantsAccess, createImageVariantsAcquirer, imageSource, type ImageVariantsConfig } from "./canonical.js";
import { encodeImageVariantsIsolated } from "./isolatedEncoder.js";
import { abortable, IMAGE_VARIANTS_KIND, IMAGE_VARIANTS_LIMITS, IMAGE_VARIANTS_PIPELINE, sameSource, UUID, validManifest, validSource,
  type ImageVariantSource, type ImageVariantsContext, type PublishedImageVariants } from "./contracts.js";

export interface ImageVariantsQueue {
  enqueue(request: ImageVariantSource & { kind: typeof IMAGE_VARIANTS_KIND; modelVersion: string }, signal?: AbortSignal): Promise<string | null>;
}
export interface ImageVariantsOptions {
  queue?: ImageVariantsQueue;
  fetch?: typeof fetch;
  metric?: (event: { name: string; elapsedMs: number; inputBytes: number; outputBytes: number }) => void;
}

function sourceFrom(context: ImageVariantsContext): ImageVariantSource {
  const job = context.job;
  const source = { assetId: job.assetId, ownerUserId: job.ownerUserId, sourceVersion: job.sourceVersion, bucket: job.bucket, path: job.path, sizeBytes: job.sizeBytes };
  if (!validSource(source) || !UUID.test(job.id) || !UUID.test(job.token) || job.kind !== IMAGE_VARIANTS_KIND ||
      job.modelVersion !== IMAGE_VARIANTS_PIPELINE || job.targetLanguage || job.revisionKey) throw new Error("invalid image variants job");
  return Object.freeze(source);
}
function published(value: unknown, source: ImageVariantSource): PublishedImageVariants | null {
  if (!validManifest(value)) return null;
  const output = value as PublishedImageVariants;
  if (output.pipeline !== IMAGE_VARIANTS_PIPELINE || !UUID.test(output.token) || !validSource(output.source) || !sameSource(output.source, source)) return null;
  return output;
}

export function imageVariantsConfigFromEnv(env: Record<string, string | undefined>): ImageVariantsConfig {
  return { enabled: env.MEDIA_IMAGE_VARIANTS_ENABLED === "1", root: env.MEDIA_IMAGE_VARIANTS_ROOT ?? "",
    storageOrigin: env.SUPABASE_URL ?? "",
    encoderEntrypoint: new URL(import.meta.url.endsWith(".ts") ? "./encoderChild.ts" : "./encoderChild.js", import.meta.url) };
}

// Top-level (not a closure) so every RPC name sent here is a string literal at
// a same-file call site — the shape the §29 conversation→Memory boundary scan
// (src/domain/telegraph/policies/conversationMemoryBoundary.ts, rpcNameCandidates)
// resolves. A closure wrapper is unresolvable there and fails closed as a
// possible memory-creating RPC.
async function imageQueueRpc(sc: SupabaseClient, name: string, parameters: Record<string, unknown>, signal: AbortSignal) {
  const answer = await abortable(sc.rpc(name, parameters).abortSignal(signal), signal);
  if (answer.error) throw new Error("image queue unavailable");
  return answer.data;
}

export function createImageVariantsRuntime(sc: SupabaseClient, configuration: ImageVariantsConfig, options: ImageVariantsOptions = {}) {
  const config = Object.freeze({ ...configuration, enabled: configuration.enabled === true });
  const access = createImageVariantsAccess(sc, config);
  const artifacts = new ImageVariantArtifacts(config.root);
  const acquire = createImageVariantsAcquirer(sc, config, access, options.fetch);
  let working = false;
  const handler = {
    kind: IMAGE_VARIANTS_KIND,
    modelVersion: IMAGE_VARIANTS_PIPELINE,
    timeoutMs: IMAGE_VARIANTS_LIMITS.jobMs,
    async handle(context: ImageVariantsContext) {
      const source = sourceFrom(context);
      const token = context.job.token;
      if (working) throw new Error("image worker concurrency exceeded");
      working = true;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(IMAGE_VARIANTS_LIMITS.jobMs)]);
      const started = Date.now();
      let input: Buffer | undefined;
      let encoded: Awaited<ReturnType<typeof encodeImageVariantsIsolated>> | undefined;
      let written = false;
      let returned = false;
      const current = async () => {
        signal.throwIfAborted();
        if (!await abortable(context.isCurrent(), signal) || !await access.current(source, signal) || await artifacts.revoked(source.assetId)) throw new Error("image generation or lease unavailable");
        signal.throwIfAborted();
      };
      try {
        await current();
        input = await acquire(source, signal, current);
        await current();
        encoded = await encodeImageVariantsIsolated(input, signal, { entrypoint: config.encoderEntrypoint });
        await current();
        await artifacts.write(source, token, encoded, current);
        written = true;
        await current();
        const result: PublishedImageVariants = { ...encoded.manifest, source, pipeline: IMAGE_VARIANTS_PIPELINE, token };
        const outputBytes = Object.values(result.files).reduce((total, file) => total + file.bytes, 0);
        try { options.metric?.({ name: "image_variants_encoded", elapsedMs: Date.now() - started, inputBytes: source.sizeBytes, outputBytes }); } catch {}
        returned = true;
        return { result: { ...result }, inputBytes: source.sizeBytes, outputBytes };
      } finally {
        try {
          if (written && !returned) await artifacts.discard(source, token);
        } finally {
          input?.fill(0);
          if (encoded) for (const bytes of Object.values(encoded.buffers)) bytes.fill(0);
          working = false;
        }
      }
    },
    async discard(context: ImageVariantsContext, output: { result: Record<string, unknown> }) {
      const source = sourceFrom(context);
      const result = published(output.result, source);
      if (!result || result.token !== context.job.token) throw new Error("refusing another image lease cleanup");
      await artifacts.discard(source, result.token);
    },
  };
  async function enqueue(source: ImageVariantSource, parentSignal?: AbortSignal): Promise<string | null> {
    const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(10_000)]);
    if (!options.queue || !await access.current(source, signal) || await artifacts.revoked(source.assetId)) return null;
    return await abortable(options.queue.enqueue({ ...source, kind: IMAGE_VARIANTS_KIND, modelVersion: IMAGE_VARIANTS_PIPELINE }, signal), signal);
  }
  async function ready(source: ImageVariantSource, signal: AbortSignal) {
    return published(await imageQueueRpc(sc, "media_derivative_ready", { p_asset_id: source.assetId, p_source_version: source.sourceVersion,
      p_kind: IMAGE_VARIANTS_KIND, p_model_version: IMAGE_VARIANTS_PIPELINE, p_target_language: "", p_revision_key: "" }, signal), source);
  }
  async function readFile(viewerId: string, source: ImageVariantSource, filename: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const signal = AbortSignal.timeout(15_000);
    if (!validSource(source) || !await access.authorized(source, viewerId, signal) || await artifacts.revoked(source.assetId)) return null;
    const output = await ready(source, signal);
    if (!output) return null;
    const bytes = await artifacts.read(output, filename);
    if (!bytes) return null;
    try {
      const latest = await ready(source, signal);
      if (!latest || latest.token !== output.token || latest.files[filename]?.sha256 !== output.files[filename]?.sha256 ||
          !await access.authorized(source, viewerId, signal) || await artifacts.revoked(source.assetId)) { bytes.fill(0); return null; }
      return { bytes, mime: output.files[filename].mime };
    } catch (error) { bytes.fill(0); throw error; }
  }
  async function eraseSource(source: ImageVariantSource): Promise<void> {
    if (!validSource(source)) throw new Error("invalid image erase identity");
    const signal = AbortSignal.timeout(15_000);
    const row = await access.row(source.assetId, signal);
    const canonical = imageSource(row);
    if (!row || !canonical || !sameSource(canonical, source) || (row.deleted_at === null && !["pending", "failed", "completed"].includes(row.purge_status))) throw new Error("image source must be tombstoned before erase");
    await artifacts.erase(source.assetId, async () => {
      if (await imageQueueRpc(sc, "media_derivative_cancel_asset", { p_asset_id: source.assetId }, signal) !== true) throw new Error("image cancellation unconfirmed");
    });
  }
  return { handler, enqueue, readFile, eraseSource };
}

export function createImageVariantsJobHandler(sc: SupabaseClient, config: ImageVariantsConfig, options: ImageVariantsOptions = {}) {
  return createImageVariantsRuntime(sc, config, options).handler;
}
