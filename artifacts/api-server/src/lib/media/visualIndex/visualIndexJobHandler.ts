import { createCanonicalVisualAccess, readVisualConsent } from "./canonicalVisualSource.js";
import { handleVisualIndexJob, type VisualIndexContext, type VisualIndexOptions } from "./localVisualIndexProvider.js";
import { PostgresVisualIndex } from "./postgresVisualIndex.js";
import { generationKey, sameSource, UUID, VISUAL_MODEL_ID } from "./contracts.js";
import { createCanonicalVisualImageAcquirer } from "./canonicalImageAcquisition.js";
import { VisualIndexError } from "./visualIndexError.js";

interface EmbeddingJobContext {
  job: Readonly<{
    id: string; token: string; assetId: string; ownerUserId: string; sourceVersion: number;
    bucket: string; path: string; sizeBytes: number; modelVersion: string; kind: string; revisionKey?: string;
  }>;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
}

export function createVisualIndexJobHandler(ctx: VisualIndexContext, options: VisualIndexOptions & { fetch?: typeof fetch } = {}) {
  const access = options.access ?? createCanonicalVisualAccess(ctx.sc);
  const store = options.store ?? new PostgresVisualIndex(ctx.sc);
  const workerOptions = { ...options, acquireImage: options.acquireImage ?? createCanonicalVisualImageAcquirer(ctx, { fetch: options.fetch }) };
  return {
    kind: "embedding" as const,
    modelVersion: VISUAL_MODEL_ID,
    timeoutMs: 100_000,
    async handle(context: EmbeddingJobContext) {
      const { job, signal } = context;
      if (job.kind !== "embedding" || job.modelVersion !== VISUAL_MODEL_ID || !UUID.test(job.id) || !UUID.test(job.token)) throw new VisualIndexError("visual_claim_invalid", "invalid embedding claim");
      const source = await access.read(job.assetId);
      if (!source || !sameSource(source, job) || source.ownerId !== job.ownerUserId || source.sizeBytes !== job.sizeBytes) throw new VisualIndexError("visual_source_stale", "stale embedding claim");
      const grant = await (options.consent ?? ((current) => readVisualConsent(ctx.sc, current, true)))(source);
      if (!grant || job.revisionKey !== generationKey(source, `${VISUAL_MODEL_ID}:${grant.revision}`)) throw new VisualIndexError("visual_consent_revoked", "stale embedding consent");
      const result = await handleVisualIndexJob(ctx, { kind: "media_visual_image", key: job.revisionKey, modelId: job.modelVersion,
        source, consentRevision: grant.revision, expiresAtMs: grant.expiresAtMs }, {
        signal, jobId: job.id, leaseToken: job.token,
        async assertLease() { if (!await context.isCurrent()) throw new VisualIndexError("visual_lease_lost", "embedding lease lost", true); },
      }, workerOptions);
      if (result.kind !== "image") throw new VisualIndexError("visual_result_invalid", "invalid embedding result");
      return { result: { assetId: source.assetId, sourceVersion: source.sourceVersion, modelVersion: VISUAL_MODEL_ID,
        indexLeaseToken: job.token, contentSha256: result.contentSha256 }, inputBytes: result.inputBytes, outputBytes: 512 * 4 };
    },
    async discard(context: EmbeddingJobContext, _output: { result: Record<string, unknown> }) {
      await store.discard(context.job, { jobId: context.job.id, leaseToken: context.job.token });
    },
  };
}
