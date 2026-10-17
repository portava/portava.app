import type { SupabaseClient } from "@supabase/supabase-js";

export const MEDIA_JOB_KINDS = ["image_variants", "adaptive_video", "moderation", "vision", "embedding", "captions", "subtitle_translation", "dubbing"] as const;
export type MediaJobKind = typeof MEDIA_JOB_KINDS[number];
export interface MediaJobRequest {
  assetId: string;
  ownerUserId: string;
  sourceVersion: number;
  kind: MediaJobKind;
  modelVersion: string;
  targetLanguage?: string;
  revisionKey?: string;
}
export interface MediaJob extends MediaJobRequest {
  id: string;
  token: string;
  bucket: "post-media";
  path: string;
  sizeBytes: number;
  attempt: number;
  leaseUntil: string;
}
export interface MediaJobOutput {
  result: Record<string, unknown>;
  inputBytes?: number;
  outputBytes?: number;
}
export interface MediaJobCompletion {
  success: boolean;
  retryable?: boolean;
  errorCode?: string;
  processingMs: number;
  output?: MediaJobOutput;
}
export interface MediaJobQueue {
  enqueue(request: MediaJobRequest, signal?: AbortSignal): Promise<string | null>;
  claim(kind: MediaJobKind, modelVersion: string, limit: number, leaseSeconds: number, signal?: AbortSignal): Promise<MediaJob[]>;
  renew(job: MediaJob, leaseSeconds: number, signal?: AbortSignal): Promise<boolean>;
  finish(job: MediaJob, completion: MediaJobCompletion, signal?: AbortSignal): Promise<boolean>;
  recover(limit: number, signal?: AbortSignal): Promise<number>;
}

export const MEDIA_QUEUE_TIMEOUT_MS = 10000;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MODEL = /^[A-Za-z0-9._:/@+\-]{1,200}$/;
const LANGUAGE = /^(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)?$/;
const REVISION = /^(?:[a-f0-9]{64})?$/;
const ERROR = /^[a-z][a-z0-9_]{0,63}$/;

export class MediaJobError extends Error {
  constructor(public readonly code: string, public readonly retryable = false) {
    super(ERROR.test(code) ? code : "processing_failed");
    this.code = this.message;
    this.name = "MediaJobError";
  }
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export async function boundedMediaQueueOperation<Value>(
  operation: (signal: AbortSignal) => PromiseLike<Value>, signal?: AbortSignal, timeoutMs = MEDIA_QUEUE_TIMEOUT_MS,
): Promise<Value> {
  if (!integer(timeoutMs, 1, 30000)) throw new MediaJobError("invalid_queue_timeout");
  const controller = new AbortController();
  const stop = () => controller.abort(signal?.reason instanceof MediaJobError ? signal.reason : new MediaJobError("queue_cancelled", true));
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => controller.abort(new MediaJobError("queue_timeout", true)), timeoutMs);
  let refuse: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    refuse = () => reject(controller.signal.reason);
    if (controller.signal.aborted) refuse();
    else controller.signal.addEventListener("abort", refuse, { once: true });
  });
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    controller.signal.removeEventListener("abort", refuse);
  }
}

function validateRequest(request: MediaJobRequest): void {
  if (!UUID.test(request.assetId) || !UUID.test(request.ownerUserId)
    || !integer(request.sourceVersion, 1, 2147483647) || !MEDIA_JOB_KINDS.includes(request.kind)
    || !MODEL.test(request.modelVersion) || !LANGUAGE.test(request.targetLanguage ?? "")
    || !REVISION.test(request.revisionKey ?? "")) throw new MediaJobError("invalid_job_request");
}

export function decodeMediaJob(value: unknown): MediaJob {
  if (!value || typeof value !== "object") throw new MediaJobError("invalid_job_claim");
  const row = value as Record<string, unknown>;
  const request: MediaJobRequest = {
    assetId: String(row.asset_id ?? ""), ownerUserId: String(row.owner_user_id ?? ""),
    sourceVersion: Number(row.source_version), kind: row.kind as MediaJobKind,
    modelVersion: String(row.model_version ?? ""), targetLanguage: String(row.target_language ?? ""), revisionKey: String(row.revision_key ?? ""),
  };
  validateRequest(request);
  const sizeBytes = Number(row.source_bytes);
  if (!UUID.test(String(row.id)) || !UUID.test(String(row.lease_token)) || row.state !== "processing"
    || row.source_bucket !== "post-media" || typeof row.source_path !== "string" || !row.source_path || row.source_path.length > 2048
    || !integer(sizeBytes, 1, Number.MAX_SAFE_INTEGER) || !integer(row.attempts, 1, 5)
    || typeof row.lease_until !== "string" || !Number.isFinite(Date.parse(row.lease_until))) throw new MediaJobError("invalid_job_claim");
  return { ...request, id: String(row.id), token: String(row.lease_token), bucket: "post-media", path: row.source_path,
    sizeBytes, attempt: row.attempts, leaseUntil: row.lease_until };
}

function validateResult(output: MediaJobOutput | undefined): void {
  if (!output) return;
  if (!output.result || Array.isArray(output.result) || typeof output.result !== "object") throw new MediaJobError("invalid_job_result");
  let encoded: string;
  try { encoded = JSON.stringify(output.result); } catch { throw new MediaJobError("invalid_job_result"); }
  if (Buffer.byteLength(encoded) > 60000) throw new MediaJobError("job_result_too_large");
  for (const value of [output.inputBytes ?? 0, output.outputBytes ?? 0]) {
    if (!integer(value, 0, Number.MAX_SAFE_INTEGER)) throw new MediaJobError("invalid_job_metrics");
  }
}

// Top-level (not a closure) so every RPC name this queue sends is a string
// literal at a same-file call site — the shape the §29 conversation→Memory
// boundary scan (src/domain/telegraph/policies/conversationMemoryBoundary.ts,
// rpcNameCandidates) resolves. A closure wrapper is unresolvable there and
// fails closed as a possible memory-creating RPC.
async function mediaQueueRpc(client: SupabaseClient, name: string, timeoutMs: number | undefined, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  try {
    const answer = await boundedMediaQueueOperation(transportSignal => client.rpc(name, parameters).abortSignal(transportSignal), signal, timeoutMs);
    if (answer.error) throw new MediaJobError("queue_unavailable", true);
    return answer.data;
  } catch (error) {
    if (error instanceof MediaJobError) throw error;
    throw new MediaJobError("queue_unavailable", true);
  }
}

export function createMediaJobQueue(client: SupabaseClient, options: { timeoutMs?: number } = {}): MediaJobQueue {
  return {
    async enqueue(request, signal) {
      validateRequest(request);
      const result = await mediaQueueRpc(client, "media_derivative_enqueue", options.timeoutMs, { p_asset_id: request.assetId, p_owner_user_id: request.ownerUserId,
        p_source_version: request.sourceVersion, p_kind: request.kind, p_model_version: request.modelVersion,
        p_target_language: request.targetLanguage ?? "", p_revision_key: request.revisionKey ?? "" }, signal);
      if (result === null) return null;
      if (typeof result !== "string" || !UUID.test(result)) throw new MediaJobError("invalid_enqueue_response");
      return result;
    },
    async claim(kind, modelVersion, limit, leaseSeconds, signal) {
      if (!MEDIA_JOB_KINDS.includes(kind) || !MODEL.test(modelVersion) || !integer(limit, 1, 8) || !integer(leaseSeconds, 15, 900)) throw new MediaJobError("invalid_worker_bounds");
      const result = await mediaQueueRpc(client, "media_derivative_claim", options.timeoutMs, { p_kind: kind, p_model_version: modelVersion, p_limit: limit, p_lease_seconds: leaseSeconds }, signal);
      if (!Array.isArray(result) || result.length > limit) throw new MediaJobError("invalid_claim_response");
      const jobs = result.map(decodeMediaJob);
      if (jobs.some(job => job.kind !== kind || job.modelVersion !== modelVersion) || new Set(jobs.map(job => job.id)).size !== jobs.length) throw new MediaJobError("invalid_claim_response");
      return jobs;
    },
    async renew(job, leaseSeconds, signal) {
      if (!integer(leaseSeconds, 15, 900)) throw new MediaJobError("invalid_worker_bounds");
      return await mediaQueueRpc(client, "media_derivative_renew", options.timeoutMs, { p_job_id: job.id, p_lease_token: job.token, p_lease_seconds: leaseSeconds }, signal) === true;
    },
    async finish(job, completion, signal) {
      validateResult(completion.output);
      if (!integer(completion.processingMs, 0, Number.MAX_SAFE_INTEGER) || (completion.errorCode && !ERROR.test(completion.errorCode))) throw new MediaJobError("invalid_job_metrics");
      return await mediaQueueRpc(client, "media_derivative_finish", options.timeoutMs, { p_job_id: job.id, p_lease_token: job.token, p_success: completion.success,
        p_retryable: completion.retryable ?? false, p_error_code: completion.errorCode ?? null, p_processing_ms: completion.processingMs,
        p_input_bytes: completion.output?.inputBytes ?? 0, p_output_bytes: completion.output?.outputBytes ?? 0,
        p_result: completion.output?.result ?? null }, signal) === true;
    },
    async recover(limit, signal) {
      if (!integer(limit, 1, 1000)) throw new MediaJobError("invalid_recovery_bound");
      const result = await mediaQueueRpc(client, "media_derivative_recover", options.timeoutMs, { p_limit: limit }, signal);
      if (!integer(result, 0, limit)) throw new MediaJobError("invalid_recovery_response");
      return result;
    },
  };
}
