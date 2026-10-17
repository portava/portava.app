import { boundedMediaQueueOperation, MEDIA_QUEUE_TIMEOUT_MS, MediaJobError, type MediaJob, type MediaJobKind, type MediaJobOutput, type MediaJobQueue } from "./queue.js";

export interface MediaJobContext {
  job: Readonly<MediaJob>;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
}
export interface MediaJobHandler {
  kind: MediaJobKind;
  modelVersion: string;
  timeoutMs: number;
  handle(context: MediaJobContext): Promise<MediaJobOutput>;
  discard(context: MediaJobContext, output: MediaJobOutput): Promise<void>;
}
export interface MediaWorkerOptions {
  enabled: boolean;
  concurrency: number;
  leaseSeconds: number;
  signal: AbortSignal;
  queueTimeoutMs?: number;
}
export interface MediaWorkerPass {
  claimed: number;
  completed: number;
  failed: number;
  lost: number;
  cleanupFailed: number;
  processingMs: number;
}

export async function runMediaWorkerPass(queue: MediaJobQueue, handler: MediaJobHandler, options: MediaWorkerOptions): Promise<MediaWorkerPass> {
  const summary: MediaWorkerPass = { claimed: 0, completed: 0, failed: 0, lost: 0, cleanupFailed: 0, processingMs: 0 };
  if (!options.enabled || options.signal.aborted) return summary;
  const queueTimeoutMs = options.queueTimeoutMs ?? MEDIA_QUEUE_TIMEOUT_MS;
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8
    || !Number.isInteger(options.leaseSeconds) || options.leaseSeconds < 15 || options.leaseSeconds > 900
    || !Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 1 || queueTimeoutMs > 30000
    || !Number.isInteger(handler.timeoutMs) || handler.timeoutMs < 1 || handler.timeoutMs > 600000) throw new MediaJobError("invalid_worker_bounds");
  await boundedMediaQueueOperation(signal => queue.recover(100, signal), options.signal, queueTimeoutMs);
  if (options.signal.aborted) return summary;
  const jobs = await boundedMediaQueueOperation(signal => queue.claim(handler.kind, handler.modelVersion, options.concurrency, options.leaseSeconds, signal), options.signal, queueTimeoutMs);
  summary.claimed = jobs.length;
  await Promise.all(jobs.map(async job => {
    const started = performance.now();
    const controller = new AbortController();
    const stop = () => controller.abort(new MediaJobError("worker_shutdown", true));
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
    let renewing: Promise<boolean> | null = null;
    const isCurrent = async (): Promise<boolean> => {
      if (controller.signal.aborted) return false;
      if (!renewing) renewing = boundedMediaQueueOperation(signal => queue.renew(job, options.leaseSeconds, signal), controller.signal, queueTimeoutMs)
        .catch(() => false).finally(() => { renewing = null; });
      const current = await renewing;
      if (!current) controller.abort(new MediaJobError("lease_lost", true));
      return current && !controller.signal.aborted;
    };
    const deadline = setTimeout(() => controller.abort(new MediaJobError("processing_timeout", true)), handler.timeoutMs);
    const heartbeat = setInterval(() => { void isCurrent(); }, Math.floor(options.leaseSeconds * 1000 / 3));
    const context: MediaJobContext = { job: Object.freeze({ ...job }), signal: controller.signal, isCurrent };
    let output: MediaJobOutput | undefined;
    let published = false;
    let publicationUncertain = false;
    try {
      if (!await isCurrent()) throw new MediaJobError("lease_lost", true);
      output = await handler.handle(context);
      if (!await isCurrent()) throw new MediaJobError("lease_lost", true);
      publicationUncertain = true;
      published = await boundedMediaQueueOperation(signal => queue.finish(job, { success: true, processingMs: Math.ceil(performance.now() - started), output }, signal), controller.signal, queueTimeoutMs);
      publicationUncertain = false;
      if (published) summary.completed += 1;
      else summary.lost += 1;
    } catch (error) {
      if (publicationUncertain) { summary.lost += 1; return; }
      const failure = controller.signal.aborted && controller.signal.reason instanceof MediaJobError ? controller.signal.reason
        : error instanceof MediaJobError ? error : new MediaJobError("processing_failed", true);
      try {
        const recorded = await boundedMediaQueueOperation(signal => queue.finish(job, { success: false, retryable: failure.retryable, errorCode: failure.code,
          processingMs: Math.ceil(performance.now() - started) }, signal), options.signal, queueTimeoutMs);
        if (recorded) summary.failed += 1;
        else summary.lost += 1;
      } catch { summary.lost += 1; }
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      options.signal.removeEventListener("abort", stop);
      controller.abort();
      if (renewing) await renewing;
      if (output && !published && !publicationUncertain) {
        try { await handler.discard(context, output); } catch { summary.cleanupFailed += 1; }
      }
      summary.processingMs += Math.ceil(performance.now() - started);
    }
  }));
  return summary;
}
