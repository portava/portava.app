import { deriveVisualEvidenceCandidates, type MediaVisionProvider, type VisionIngestSubject, type VisualMediaRef, type VisualSceneSignal } from "./mediaVisionProvider.js";
import { IMAGE_UNDERSTANDING_PROVIDER, imageUnderstandingJob, imageUnderstandingPolicy, imageUnderstandingRecognitionSchema, imageUnderstandingResultSchema, imageUnderstandingSourceSchema, sameImageUnderstandingSource, withImageUnderstandingSignal, type ImageUnderstandingContext, type ImageUnderstandingSource, type ImageUnderstandingResult } from "./imageUnderstandingContract.js";
import { createImageUnderstandingStore } from "./imageUnderstandingStore.js";
import { assertImageUnderstandingSource } from "./imageUnderstandingSource.js";
import { refused, type VendorAnswer } from "./vendorCommon.js";

type VersionedSubject = VisionIngestSubject & { sourceVersion?: number | null };
type SceneInput = { items: VisualMediaRef[]; viewerId?: string };

export async function sourceForImageUnderstandingAttachment(ctx: ImageUnderstandingContext, attachment: any, assetId?: string): Promise<ImageUnderstandingSource> {
  if (!attachment) throw new Error("vision_attachment_missing");
  let query = ctx.sc.from("media_assets").select("id,version,owner_user_id,storage_bucket,storage_path,media_type,thumbnail_path");
  query = assetId ? query.eq("id", assetId) : query.eq("storage_bucket", attachment.storage_bucket).eq("storage_path", attachment.storage_path);
  const asset = await query.maybeSingle();
  if (asset.error || !asset.data) throw new Error("vision_asset_unavailable");
  return imageUnderstandingSourceSchema.parse({ assetId: asset.data.id, sourceVersion: asset.data.version, ownerId: asset.data.owner_user_id, postId: attachment.post_id, postMediaId: attachment.id, bucket: attachment.storage_bucket, path: attachment.storage_path, mediaType: asset.data.media_type, framePath: asset.data.media_type === "video" ? asset.data.thumbnail_path : null });
}

export async function readImageUnderstandingArtifact(inputContext: ImageUnderstandingContext, input: { viewerId: string; postMediaId: string }): Promise<VendorAnswer<ImageUnderstandingResult>> {
  const store = createImageUnderstandingStore(inputContext.sc);
  const ctx = { ...inputContext, jobs: inputContext.jobs ?? store, consentStillGranted: inputContext.consentStillGranted ?? store.consentStillGranted };
  const policy = imageUnderstandingPolicy(ctx.env ?? process.env, input.viewerId);
  if (!policy) return refused("not_configured");
  const signal = AbortSignal.timeout(10_000);
  try {
    return await withImageUnderstandingSignal(async (): Promise<VendorAnswer<ImageUnderstandingResult>> => {
      const attachment = await ctx.sc.from("post_media").select("id,post_id,user_id,storage_bucket,storage_path").eq("id", input.postMediaId).eq("user_id", input.viewerId).maybeSingle();
      if (attachment.error || !attachment.data) return refused("unsupported");
      const source = await sourceForImageUnderstandingAttachment(ctx, attachment.data);
      if (source.ownerId !== input.viewerId) return refused("unsupported");
      await assertImageUnderstandingSource(ctx, source, signal);
      const cached = await ctx.jobs.read(imageUnderstandingJob(source, policy).key);
      if (!cached) return refused("unsupported", "image_understanding_pending");
      const parsed = imageUnderstandingResultSchema.safeParse(cached);
      if (!parsed.success || !sameImageUnderstandingSource(source, parsed.data.source) || parsed.data.consentVersion !== policy || Date.parse(parsed.data.processedAt) > Date.now() + 1000 || parsed.data.pixelScope !== (source.mediaType === "image" ? "image" : "stored_poster")) return refused("invalid_answer");
      await assertImageUnderstandingSource(ctx, source, signal);
      return { ok: true, value: parsed.data };
    }, signal);
  } catch (error) {
    const denied = error instanceof Error && ["vision_consent_refused", "vision_not_authorized", "vision_source_refused", "vision_storage_refused", "vision_pixels_unavailable"].includes(error.message);
    return refused(signal.aborted ? "timeout" : denied ? "unsupported" : "error", "image_understanding_unavailable");
  }
}

export function createImageUnderstandingProvider(inputContext: ImageUnderstandingContext): Omit<MediaVisionProvider, "ingest" | "sceneSignals"> & {
  ingest(input: VersionedSubject): Promise<VendorAnswer<{ accepted: boolean; jobKey?: string }>>;
  sceneSignals(input: SceneInput): Promise<VendorAnswer<VisualSceneSignal[]>>;
} {
  const store = createImageUnderstandingStore(inputContext.sc);
  const ctx = { ...inputContext, jobs: inputContext.jobs ?? store, consentStillGranted: inputContext.consentStillGranted ?? store.consentStillGranted };
  return {
    name: IMAGE_UNDERSTANDING_PROVIDER,
    capabilities: { sceneSignals: true, similarMedia: false, ingest: true },
    async similarMedia() { return refused("unsupported", "similarity_is_a_separate_capability"); },
    async ingest(subject: VersionedSubject) {
      if (!ctx.jobs || !Number.isSafeInteger(subject.sourceVersion) || Number(subject.sourceVersion) < 1) return refused("not_configured");
      const signal = AbortSignal.timeout(10_000);
      try {
        return await withImageUnderstandingSignal(async (): Promise<VendorAnswer<{ accepted: boolean; jobKey?: string }>> => {
        const read = await ctx.sc.from("post_media").select("id,post_id,storage_bucket,storage_path").eq("storage_bucket", subject.bucket).eq("storage_path", subject.path).maybeSingle();
        if (read.error) return refused("error");
        const source = await sourceForImageUnderstandingAttachment(ctx, read.data, subject.assetId);
        if (source.sourceVersion !== subject.sourceVersion || source.mediaType !== subject.mediaType || source.framePath !== subject.framePath) return refused("unsupported", "source_generation_mismatch");
        await assertImageUnderstandingSource(ctx, source, signal);
        const policy = imageUnderstandingPolicy(ctx.env ?? process.env, source.ownerId)!;
        const job = imageUnderstandingJob(source, policy);
        const queued = await ctx.jobs.enqueue(job);
        if (queued.key !== job.key || !["queued", "exists"].includes(queued.state)) return refused("invalid_answer");
        return { ok: true, value: { accepted: true, jobKey: job.key } };
        }, signal);
      } catch { return refused(signal.aborted ? "timeout" : "error", "image_understanding_unavailable"); }
    },
    async sceneSignals(input: SceneInput) {
      if (!ctx.jobs || !input.viewerId || !imageUnderstandingPolicy(ctx.env ?? process.env, input.viewerId)) return refused("not_configured");
      if (!Array.isArray(input.items) || input.items.length > 50) return refused("unsupported");
      const signal = AbortSignal.timeout(10_000);
      const signals: VisualSceneSignal[] = [];
      try {
        return await withImageUnderstandingSignal(async (): Promise<VendorAnswer<VisualSceneSignal[]>> => {
        for (const item of input.items) {
          if (typeof item.mediaId !== "string" || !/^[0-9a-f-]{36}$/i.test(item.mediaId)) return refused("invalid_answer");
          const read = await ctx.sc.from("post_media").select("id,post_id,storage_bucket,storage_path").eq("post_id", item.mediaId).eq("sort_order", 0).maybeSingle();
          if (read.error) return refused("error");
          const source = await sourceForImageUnderstandingAttachment(ctx, read.data);
          if (source.ownerId !== input.viewerId) return refused("unsupported");
          await assertImageUnderstandingSource(ctx, source, signal);
          const policy = imageUnderstandingPolicy(ctx.env ?? process.env, source.ownerId)!;
          const result = await ctx.jobs.read(imageUnderstandingJob(source, policy).key);
          if (!result) return refused("unsupported", "image_understanding_pending");
          const recognition = imageUnderstandingRecognitionSchema.safeParse(result.recognition);
          const age = Date.now() - Date.parse(result.processedAt);
          if (!recognition.success || !sameImageUnderstandingSource(source, result.source) || result.consentVersion !== policy || !Number.isFinite(age) || age < -1000 || result.pixelScope !== (source.mediaType === "video" ? "stored_poster" : "image")) return refused("invalid_answer");
          await assertImageUnderstandingSource(ctx, source, signal);
          const raw = recognition.data.crowdLevel === null ? [] : [{ mediaId: item.mediaId, kind: "crowd_level", value: recognition.data.crowdLevel, confidence: recognition.data.confidence }];
          signals.push(...deriveVisualEvidenceCandidates(IMAGE_UNDERSTANDING_PROVIDER, raw, new Set([item.mediaId])).candidates);
        }
        return { ok: true, value: signals };
        }, signal);
      } catch { return refused(signal.aborted ? "timeout" : "error", "image_understanding_unavailable"); }
    },
  };
}
