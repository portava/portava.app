import { z } from "zod";
import { createLocalImageUnderstandingRunner, type ImageUnderstandingRunner } from "./imageUnderstandingLocal.js";
import { createImageUnderstandingStore, IMAGE_UNDERSTANDING_QUEUE_MODEL, imageUnderstandingRevisionKey } from "./imageUnderstandingStore.js";
import { runImageUnderstandingJob } from "./imageUnderstandingJob.js";
import { IMAGE_UNDERSTANDING_TIMEOUT_MS, withImageUnderstandingSignal } from "./imageUnderstandingContract.js";

const leaseSchema = z.object({
  id: z.string().uuid(), assetId: z.string().uuid(), ownerUserId: z.string().uuid(),
  sourceVersion: z.number().int().positive(), bucket: z.literal("post-media"), path: z.string(),
  kind: z.literal("vision"), modelVersion: z.literal(IMAGE_UNDERSTANDING_QUEUE_MODEL), targetLanguage: z.literal(""),
  revisionKey: z.string().regex(/^[a-f0-9]{64}$/), token: z.string().uuid(), leaseUntil: z.string(),
});

type WorkerContext = { job: unknown; signal: AbortSignal; isCurrent(): Promise<boolean> };
type WorkerOutput = { result: Record<string, unknown>; inputBytes?: number; outputBytes?: number };

export function createImageUnderstandingJobHandler(input: { sc: any; env?: NodeJS.ProcessEnv; runner?: ImageUnderstandingRunner; fetch?: typeof fetch; createJobError(code: string, retryable: boolean): Error }) {
  const runner = input.runner ?? createLocalImageUnderstandingRunner(input.env);
  const store = createImageUnderstandingStore(input.sc);
  return {
    kind: "vision" as const,
    modelVersion: IMAGE_UNDERSTANDING_QUEUE_MODEL,
    timeoutMs: IMAGE_UNDERSTANDING_TIMEOUT_MS,
    close: () => runner.close(),
    async handle({ job: leasedJob, signal, isCurrent }: WorkerContext): Promise<WorkerOutput> {
      return withImageUnderstandingSignal(async () => {
        const parsed = leaseSchema.safeParse(leasedJob);
        if (!parsed.success) throw input.createJobError("vision_invalid_job", false);
        const lease = parsed.data;
        let job;
        try { job = await store.load(lease.id); } catch (error) {
          throw input.createJobError("vision_binding_unavailable", !(error instanceof z.ZodError));
        }
        if (!job || lease.assetId !== job.source.assetId || lease.ownerUserId !== job.source.ownerId || lease.sourceVersion !== job.source.sourceVersion || lease.bucket !== job.source.bucket || lease.path !== job.source.path || lease.revisionKey !== imageUnderstandingRevisionKey(job)) throw input.createJobError("vision_job_mismatch", false);
        const result = await runImageUnderstandingJob({ sc: input.sc, env: input.env, job, signal, runner, isCurrentLease: isCurrent, consentStillGranted: store.consentStillGranted, fetch: input.fetch });
        signal.throwIfAborted();
        if (!result.ok) throw input.createJobError(result.reason === "timeout" ? "vision_timeout" : "vision_processing_refused", result.reason === "timeout" || result.reason === "error");
        if (!await store.publish(lease.id, lease.token, result.value)) throw input.createJobError("vision_publication_refused", false);
        return { result: { artifactKey: job.key, publicationToken: lease.token }, inputBytes: result.value.metrics.inputBytes, outputBytes: Buffer.byteLength(JSON.stringify(result.value)) };
      }, signal);
    },
    async discard(context: WorkerContext, _output: WorkerOutput): Promise<void> {
      const lease = leaseSchema.parse(context.job);
      await store.discard(lease.id, lease.token);
    },
  };
}
