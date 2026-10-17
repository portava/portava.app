import { createHash } from "node:crypto";
import { z } from "zod";
import { deriveVisualEvidenceCandidates } from "./mediaVisionProvider.js";
import { IMAGE_UNDERSTANDING_PROVIDER, IMAGE_UNDERSTANDING_TIMEOUT_MS, imageUnderstandingJob, imageUnderstandingJobSchema, imageUnderstandingPolicy, imageUnderstandingRecognitionSchema, withImageUnderstandingSignal, type ImageUnderstandingContext, type ImageUnderstandingJob, type ImageUnderstandingResult } from "./imageUnderstandingContract.js";
import { acquireImageUnderstandingPixels } from "./imageUnderstandingPixels.js";
import { assertImageUnderstandingSource } from "./imageUnderstandingSource.js";
import type { ImageUnderstandingRunner } from "./imageUnderstandingLocal.js";
import { refused, type VendorAnswer } from "./vendorCommon.js";

export async function runImageUnderstandingJob(input: ImageUnderstandingContext & {
  job: ImageUnderstandingJob;
  signal: AbortSignal;
  runner: ImageUnderstandingRunner;
  isCurrentLease: () => Promise<boolean>;
  fetch?: typeof fetch;
}): Promise<VendorAnswer<ImageUnderstandingResult>> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), IMAGE_UNDERSTANDING_TIMEOUT_MS);
  const signal = AbortSignal.any([input.signal, deadline.signal]);
  const started = Date.now();
  let pixels: Buffer | undefined;
  try {
    return await withImageUnderstandingSignal(async (): Promise<VendorAnswer<ImageUnderstandingResult>> => {
    const job = imageUnderstandingJobSchema.parse(input.job);
    const source = job.source;
    const policy = imageUnderstandingPolicy(input.env ?? process.env, source.ownerId);
    if (!policy || policy !== job.consentVersion || job.key !== imageUnderstandingJob(source, policy).key) return refused("not_configured");
    const check = async () => {
      signal.throwIfAborted();
      if (await input.isCurrentLease() !== true) throw new Error("vision_lease_lost");
      return assertImageUnderstandingSource(input, source, signal);
    };
    const initial = await check();
    const acquired = await acquireImageUnderstandingPixels({ sc: input.sc, origin: (input.env ?? process.env).SUPABASE_URL ?? "", path: initial.pixelPath, mime: initial.mime, signal, fetch: input.fetch, beforeRead: async () => {
      if (JSON.stringify(initial) !== JSON.stringify(await check())) throw new Error("vision_source_changed");
    } });
    pixels = acquired.bytes;
    const beforeInference = await check();
    if (JSON.stringify(initial) !== JSON.stringify(beforeInference)) return refused("unsupported", "source_changed");
    const recognition = imageUnderstandingRecognitionSchema.parse(await input.runner.infer(pixels, signal));
    const beforePublication = await check();
    if (JSON.stringify(initial) !== JSON.stringify(beforePublication)) return refused("unsupported", "source_changed");
    const nowMs = Date.now();
    const signals = recognition.crowdLevel === null ? [] : [{ mediaId: source.postId, kind: "crowd_level", value: recognition.crowdLevel, confidence: recognition.confidence }];
    return { ok: true, value: {
      source, recognition, consentVersion: policy,
      candidates: deriveVisualEvidenceCandidates(IMAGE_UNDERSTANDING_PROVIDER, signals, new Set([source.postId])).candidates,
      pixelScope: source.mediaType === "video" ? "stored_poster" : "image",
      processedAt: new Date(nowMs).toISOString(), pixelSha256: createHash("sha256").update(pixels).digest("hex"),
      metrics: { inputBytes: acquired.inputBytes, normalizedBytes: pixels.length, elapsedMs: nowMs - started, estimatedExternalCostUsd: 0 },
    } };
    }, signal);
  } catch (error) {
    if (signal.aborted) return refused("timeout", "image_understanding_cancelled");
    if (error instanceof z.ZodError) return refused("invalid_answer", "vision_invalid_data");
    const terminal = new Set(["vision_not_authorized", "vision_storage_refused", "vision_source_refused", "vision_pixels_unavailable", "vision_consent_refused", "vision_lease_lost", "vision_source_changed", "vision_runtime_not_configured", "pixel_type_refused", "pixel_decode_refused", "pixel_size_refused", "pixel_output_refused", "empty_pixels", "storage_origin_refused", "storage_reference_refused", "storage_type_refused"]);
    return refused(error instanceof Error && terminal.has(error.message) ? "unsupported" : "error", "image_understanding_unavailable");
  } finally {
    clearTimeout(timer);
    pixels?.fill(0);
  }
}
