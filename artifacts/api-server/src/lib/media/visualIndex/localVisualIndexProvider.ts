import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { refused, type VendorAnswer } from "../vendors/vendorCommon.js";
import type { VisionIngestSubject, VisualMediaRef, VisualSimilarity } from "../vendors/mediaVisionProvider.js";
import { createCanonicalVisualAccess, readVisualConsent, type VisualSourceAccess } from "./canonicalVisualSource.js";
import { PostgresVisualIndex } from "./postgresVisualIndex.js";
import { LocalClipEncoder } from "./localClipEncoder.js";
import { VisualIndexError } from "./visualIndexError.js";
import { visualIndexWorkEnabled } from "./visualIndexPolicy.js";
import {
  generationKey, textQueryKey, sameSource, validSource, normalizeVector, UUID, VISUAL_MODEL_ID,
  MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_INDEX_RETENTION_MS, TEXT_QUERY_TTL_MS,
  type ClipEncoder, type ConsentGrant, type IndexedImage, type SourceIdentity, type VisualIndexStore,
  type VisualSource, type VisualIndexJob, type VisualJobContext,
} from "./contracts.js";

export interface VisualIndexContext { sc: SupabaseClient; env: NodeJS.ProcessEnv }

export interface VisualTextResult {
  kind: "text";
  key: string;
  viewerId: string;
  modelId: string;
  vector: number[];
  expiresAtMs: number;
}

export interface VisualIndexOptions {
  now?: () => number;
  enabled?: () => Promise<boolean>;
  consent?: (source: VisualSource) => Promise<ConsentGrant | null>;
  enqueue?: (job: VisualIndexJob) => Promise<{ accepted: boolean }>;
  readTextResult?: (viewerId: string, key: string) => Promise<VisualTextResult | null>;
  acquireImage?: (source: VisualSource, limits: { signal: AbortSignal; maxBytes: number; maxPixels: number }) => Promise<Buffer>;
  encoder?: ClipEncoder;
  access?: VisualSourceAccess;
  store?: VisualIndexStore;
}

function dependencies(ctx: VisualIndexContext, options: VisualIndexOptions) {
  return {
    now: options.now ?? Date.now,
    enabled: options.enabled ?? (() => visualIndexWorkEnabled(ctx)),
    consent: options.consent ?? ((source: VisualSource) => readVisualConsent(ctx.sc, source, true)),
    access: options.access ?? createCanonicalVisualAccess(ctx.sc),
    store: options.store ?? new PostgresVisualIndex(ctx.sc),
  };
}

function grantValid(grant: ConsentGrant | null, now: number): grant is ConsentGrant {
  return grant?.allowed === true && UUID.test(grant.revision) && Number.isSafeInteger(grant.expiresAtMs) && grant.expiresAtMs > now;
}

function imageJobKey(source: SourceIdentity, consentRevision: string): string {
  return generationKey(source, `${VISUAL_MODEL_ID}:${consentRevision}`);
}

export function createLocalVisualIndexProvider(ctx: VisualIndexContext, options: VisualIndexOptions = {}) {
  const deps = dependencies(ctx, options);
  const enqueue = options.enqueue ?? (async (job: VisualIndexJob) => {
    if (job.kind !== "media_visual_image") return { accepted: false };
    const current = await deps.access.read(job.source.assetId);
    if (!current || !sameSource(current, job.source)) return { accepted: false };
    const { data, error } = await ctx.sc.rpc("media_derivative_enqueue", { p_asset_id: job.source.assetId, p_owner_user_id: current.ownerId,
      p_source_version: job.source.sourceVersion, p_kind: "embedding", p_model_version: job.modelId, p_target_language: "", p_revision_key: job.key });
    return { accepted: !error && typeof data === "string" && UUID.test(data) };
  });

  async function authorized(entry: IndexedImage, viewerId: string, postId: string): Promise<boolean> {
    if (entry.modelId !== VISUAL_MODEL_ID || entry.expiresAtMs <= deps.now() || !validSource(entry.source)) return false;
    const current = await deps.access.read(entry.source.assetId);
    if (!current || !sameSource(entry.source, current)) return false;
    const grant = await deps.consent(current);
    if (!grantValid(grant, deps.now()) || grant.revision !== entry.consentRevision) return false;
    if (!(await deps.access.postIds(current)).includes(postId)) return false;
    if (!await deps.access.visible(viewerId, postId, current)) return false;
    const latest = await deps.access.read(entry.source.assetId);
    if (!latest || !sameSource(entry.source, latest) || latest.ownerId !== current.ownerId) return false;
    const latestGrant = await deps.consent(latest);
    return grantValid(latestGrant, deps.now()) && latestGrant.revision === entry.consentRevision
      && entry.expiresAtMs > deps.now() && (await deps.access.postIds(latest)).includes(postId);
  }

  async function candidates(viewerId: string, vector: number[], limit: number, seedPostId?: string, seedAssetId?: string) {
    const proposed = await deps.store.nearest(normalizeVector(vector), VISUAL_MODEL_ID, 200);
    const accepted = new Map<string, { score: number; entry: IndexedImage }>();
    for (const { entry, score } of proposed) {
      if (entry.source.assetId === seedAssetId || entry.modelId !== VISUAL_MODEL_ID || !Number.isFinite(score) || score < 0 || score > 1) continue;
      const current = await deps.access.read(entry.source.assetId);
      if (!current || !sameSource(entry.source, current)) continue;
      for (const postId of await deps.access.postIds(current)) {
        if (!UUID.test(postId) || postId === seedPostId || !(await authorized(entry, viewerId, postId))) continue;
        if ((accepted.get(postId)?.score ?? -1) < score) accepted.set(postId, { score, entry });
      }
    }
    const results: Array<VisualSimilarity & { entry: IndexedImage }> = [];
    for (const [postId, proposal] of [...accepted].sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))) {
      if (await authorized(proposal.entry, viewerId, postId)) results.push({ mediaId: postId, score: proposal.score, entry: proposal.entry });
      if (results.length === limit) break;
    }
    return results;
  }

  return {
    name: "local-clip-index",
    capabilities: Object.freeze({ sceneSignals: false, similarMedia: true, ingest: true }),
    async sceneSignals() { return refused("unsupported", "visual indexing does not produce scene claims"); },
    async ingest(input: VisionIngestSubject & { sourceVersion?: number | null }): Promise<VendorAnswer<{ accepted: boolean }>> {
      try {
        if (!await deps.enabled()) return refused("not_configured");
        const source = { assetId: input.assetId, sourceVersion: input.sourceVersion, bucket: input.bucket, path: input.path };
        if (input.mediaType !== "image" || !validSource(source)) return refused("unsupported");
        const current = await deps.access.read(source.assetId);
        if (!current || !sameSource(source, current)) return refused("invalid_answer");
        const grant = await deps.consent(current);
        if (!grantValid(grant, deps.now())) return refused("unsupported");
        const answer = await enqueue({ kind: "media_visual_image", key: imageJobKey(source, grant.revision), modelId: VISUAL_MODEL_ID,
          source, consentRevision: grant.revision, expiresAtMs: Math.min(grant.expiresAtMs, deps.now() + MAX_INDEX_RETENTION_MS) });
        return answer.accepted === true ? { ok: true, value: { accepted: true } } : refused("error");
      } catch { return refused("error", "visual index enqueue unavailable"); }
    },
    async similarMedia(input: { seed: VisualMediaRef; limit: number; viewerId?: string }): Promise<VendorAnswer<VisualSimilarity[]>> {
      try {
        if (!await deps.enabled()) return refused("not_configured");
        const viewerId = input.viewerId;
        if (!viewerId || !UUID.test(viewerId) || !UUID.test(input.seed.mediaId) || !Number.isSafeInteger(input.limit) || input.limit < 1) return refused("invalid_answer");
        const seedPostId = input.seed.mediaId;
        const entries = await deps.store.seed(seedPostId, VISUAL_MODEL_ID);
        let seed: IndexedImage | undefined;
        for (const entry of entries) { if (await authorized(entry, viewerId, seedPostId)) { seed = entry; break; } }
        if (!seed) return refused("unsupported", "seed is unavailable");
        const results = await candidates(viewerId, seed.vector, Math.min(input.limit, 60), seedPostId, seed.source.assetId);
        if (!await deps.enabled() || !await authorized(seed, viewerId, seedPostId)) return refused("unsupported");
        const current = await deps.store.current([seed, ...results.map(result => result.entry)]);
        if (current.length !== results.length + 1 || current.some(value => typeof value !== "boolean") || !current[0]) return refused("unsupported");
        return { ok: true, value: results.filter((_result, index) => current[index + 1]).map(({ mediaId, score }) => ({ mediaId, score })) };
      } catch { return refused("error", "visual search unavailable"); }
    },
    async textSearch(input: { viewerId: string; text: string; language: string; limit: number }): Promise<
      { state: "queued"; key: string } | { state: "ready"; results: VisualSimilarity[] } | { state: "refused" }
    > {
      try {
        if (!await deps.enabled() || !Number.isSafeInteger(input.limit) || input.limit < 1) return { state: "refused" };
        const key = textQueryKey(input.viewerId, input.text, input.language);
        const cached = await options.readTextResult?.(input.viewerId, key);
        if (cached) {
          if (cached.kind !== "text" || cached.key !== key || cached.viewerId !== input.viewerId || cached.modelId !== VISUAL_MODEL_ID ||
              !Number.isSafeInteger(cached.expiresAtMs) || cached.expiresAtMs <= deps.now() || cached.expiresAtMs > deps.now() + TEXT_QUERY_TTL_MS) return { state: "refused" };
          const results = await candidates(input.viewerId, cached.vector, Math.min(input.limit, 60));
          if (!await deps.enabled()) return { state: "refused" };
          const current = await deps.store.current(results.map(result => result.entry));
          if (current.length !== results.length || current.some(value => typeof value !== "boolean")) return { state: "refused" };
          return { state: "ready", results: results.filter((_result, index) => current[index]).map(({ mediaId, score }) => ({ mediaId, score })) };
        }
        const queued = await enqueue({ kind: "media_visual_text", key, modelId: VISUAL_MODEL_ID, viewerId: input.viewerId,
          text: input.text, language: "en", expiresAtMs: deps.now() + TEXT_QUERY_TTL_MS });
        return queued?.accepted === true ? { state: "queued", key } : { state: "refused" };
      } catch { return { state: "refused" }; }
    },
  };
}

export async function handleVisualIndexJob(
  ctx: VisualIndexContext, input: VisualIndexJob, lease: VisualJobContext, options: VisualIndexOptions = {},
): Promise<VisualTextResult | { kind: "image"; key: string; source: SourceIdentity; contentSha256: string; elapsedMs: number; inputBytes: number }> {
  const job = structuredClone(input);
  const deps = dependencies(ctx, options);
  const started = deps.now();
  const checkpoint = async () => {
    lease.signal.throwIfAborted();
    await lease.assertLease();
    if (!await deps.enabled()) throw new VisualIndexError("visual_index_disabled", "visual index disabled");
  };
  await checkpoint();
  if (job.modelId !== VISUAL_MODEL_ID) throw new VisualIndexError("visual_model_invalid", "visual model mismatch");
  const encoder = options.encoder ?? new LocalClipEncoder(ctx.env);
  if (encoder.modelId !== job.modelId) throw new VisualIndexError("visual_model_invalid", "visual encoder model mismatch");
  if (job.kind === "media_visual_text") {
    if (job.key !== textQueryKey(job.viewerId, job.text, job.language) || !Number.isSafeInteger(job.expiresAtMs) ||
        job.expiresAtMs <= deps.now() || job.expiresAtMs > deps.now() + TEXT_QUERY_TTL_MS) throw new VisualIndexError("visual_input_invalid", "invalid visual text job");
    const vector = normalizeVector(await encoder.text(job.text, lease.signal));
    await checkpoint();
    if (job.expiresAtMs <= deps.now()) throw new VisualIndexError("visual_job_expired", "visual text query expired");
    return { kind: "text", key: job.key, viewerId: job.viewerId, modelId: job.modelId, vector, expiresAtMs: job.expiresAtMs };
  }
  if (job.kind !== "media_visual_image" || !validSource(job.source) || !UUID.test(job.consentRevision) ||
      job.key !== imageJobKey(job.source, job.consentRevision) || !Number.isSafeInteger(job.expiresAtMs) || job.expiresAtMs <= deps.now()) {
    throw new VisualIndexError("visual_input_invalid", "invalid visual image job");
  }
  const checkSource = async (expected?: VisualSource) => {
    const current = await deps.access.read(job.source.assetId);
    if (!current || !sameSource(job.source, current) || (expected && (current.ownerId !== expected.ownerId || current.sizeBytes !== expected.sizeBytes))) {
      throw new VisualIndexError("visual_source_stale", "stale visual source");
    }
    const grant = await deps.consent(current);
    if (!grantValid(grant, deps.now()) || grant.revision !== job.consentRevision) throw new VisualIndexError("visual_consent_revoked", "visual consent unavailable");
    return { current: structuredClone(current), grant };
  };
  const before = await checkSource();
  if (!options.acquireImage) throw new VisualIndexError("visual_acquisition_unconfigured", "bounded authorized image acquisition is not configured");
  const bytes = await options.acquireImage(before.current, { signal: lease.signal, maxBytes: MAX_IMAGE_BYTES, maxPixels: MAX_IMAGE_PIXELS });
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.length !== before.current.sizeBytes) throw new VisualIndexError("visual_input_invalid", "invalid visual image bytes");
    await checkpoint();
    await checkSource(before.current);
    lease.signal.throwIfAborted();
    if (job.expiresAtMs <= deps.now()) throw new VisualIndexError("visual_job_expired", "visual job expired");
    const inputBytes = bytes.length;
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const vector = normalizeVector(await encoder.image(bytes, lease.signal));
    await checkpoint();
    const after = await checkSource(before.current);
    const expiresAtMs = Math.min(job.expiresAtMs, after.grant.expiresAtMs, deps.now() + MAX_INDEX_RETENTION_MS);
    if (expiresAtMs <= deps.now()) throw new VisualIndexError("visual_job_expired", "visual job expired");
    await deps.store.commit({ source: job.source, modelId: job.modelId, vector, contentSha256, expiresAtMs, consentRevision: job.consentRevision }, lease);
    try { await checkpoint(); } catch (error) { await deps.store.discard(job.source, lease); throw error; }
    return { kind: "image", key: job.key, source: job.source, contentSha256, elapsedMs: deps.now() - started, inputBytes };
  } finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
}
