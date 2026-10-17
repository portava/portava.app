import type { SupabaseClient } from "@supabase/supabase-js";
import { ADAPTIVE_KIND, ADAPTIVE_PIPELINE, type AdaptiveJobs, type AdaptiveLease } from "./jobs.js";
import { createSelfHostedAdaptive } from "./service.js";
import { ADAPTIVE_LIMITS, type AdaptiveConfig, type AdaptiveSource } from "./types.js";

export interface AdaptiveWorkerContext {
  job: Readonly<AdaptiveSource & { id: string; token: string; kind: string; modelVersion: string; targetLanguage?: string; revisionKey?: string }>;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
}

function lease(context: AdaptiveWorkerContext): AdaptiveLease {
  const job = context.job;
  if (job.kind !== ADAPTIVE_KIND || job.modelVersion !== ADAPTIVE_PIPELINE || job.targetLanguage || job.revisionKey) throw new Error("wrong adaptive pipeline identity");
  return { id: job.id, token: job.token, source: { assetId: job.assetId, sourceVersion: job.sourceVersion,
    bucket: job.bucket, path: job.path, sizeBytes: job.sizeBytes }, signal: context.signal, isCurrent: () => context.isCurrent() };
}

export function createAdaptiveJobHandler(sc: SupabaseClient, config: AdaptiveConfig, jobs: AdaptiveJobs,
  options: Parameters<typeof createSelfHostedAdaptive>[3] = {}) {
  const runtime = createSelfHostedAdaptive(sc, config, jobs, options);
  return {
    kind: ADAPTIVE_KIND as typeof ADAPTIVE_KIND,
    modelVersion: ADAPTIVE_PIPELINE,
    timeoutMs: ADAPTIVE_LIMITS.leaseMs - 30_000,
    async handle(context: AdaptiveWorkerContext) {
      const job = lease(context);
      const output = await runtime.processJob(job);
      return { result: { ...output }, inputBytes: job.source.sizeBytes,
        outputBytes: Object.values(output.files).reduce((total, file) => total + file.bytes, 0) };
    },
    async discard(context: AdaptiveWorkerContext, output: { result: Record<string, unknown> }) {
      if (typeof output.result.directory !== "string") throw new Error("invalid adaptive artifact");
      await runtime.discard(lease(context), { directory: output.result.directory });
    },
  };
}
