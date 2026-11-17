import { managedMediaJson, ManagedMediaError } from "../managedMediaRequest.js";
import type { ImageUnderstandingRunner } from "./imageUnderstandingLocal.js";
import { IMAGE_UNDERSTANDING_MODEL, IMAGE_UNDERSTANDING_REVISION, IMAGE_UNDERSTANDING_TAXONOMY, IMAGE_UNDERSTANDING_MAX_OUTPUT_BYTES, imageUnderstandingRecognitionSchema } from "./imageUnderstandingContract.js";

export function createManagedImageUnderstandingRunner(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): ImageUnderstandingRunner {
  const pending = new Set<AbortController>();
  let closed = false;
  return {
    close() { closed = true; for (const controller of pending) controller.abort(); pending.clear(); },
    async infer(bytes, signal) {
      signal.throwIfAborted();
      if (closed) throw new ManagedMediaError("vision_inference_stopped");
      const endpoint = env.MEDIA_VISION_HF_ENDPOINT ?? "";
      const token = env.MEDIA_VISION_HF_TOKEN ?? "";
      // Only dedicated HF endpoints; no arbitrary URLs, redirects, query strings or userinfo.
      if (!/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\.endpoints\.huggingface\.cloud\/?$/.test(endpoint)
        || !token || /\s/.test(token)) throw new ManagedMediaError("vision_runtime_not_configured");
      if (bytes.length < 4 || bytes.length > IMAGE_UNDERSTANDING_MAX_OUTPUT_BYTES || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new ManagedMediaError("pixel_type_refused");
      const controller = new AbortController();
      pending.add(controller);
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const raw = await managedMediaJson({ url: new URL(endpoint).href, authorization: `Bearer ${token}`, contentType: "application/json",
          body: JSON.stringify({ protocol: "portava-vision-v1", modelId: IMAGE_UNDERSTANDING_MODEL, modelRevision: IMAGE_UNDERSTANDING_REVISION, taxonomyVersion: IMAGE_UNDERSTANDING_TAXONOMY, imageBase64: bytes.toString("base64") }),
          signal: controller.signal, timeoutMs: 60000, maxResponseBytes: 16384, fetch: fetchImpl });
        signal.throwIfAborted();
        if (!raw || typeof raw !== "object" || Object.keys(raw).sort().join(",") !== "ok,value" || (raw as { ok: unknown }).ok !== true) throw new ManagedMediaError("vision_inference_refused");
        return imageUnderstandingRecognitionSchema.parse((raw as { value: unknown }).value);
      } finally { pending.delete(controller); signal.removeEventListener("abort", abort); }
    },
  };
}
