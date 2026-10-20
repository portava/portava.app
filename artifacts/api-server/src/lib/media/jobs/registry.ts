import type { SupabaseClient } from "@supabase/supabase-js";
import { adaptiveConfig, createAdaptiveQueueBridge } from "../adaptive/runtime.js";
import { createAdaptiveJobHandler } from "../adaptive/handler.js";
import type { MediaJobHandler } from "./worker.js";
import { MediaJobError } from "./queue.js";
import { createImageUnderstandingJobHandler } from "../vendors/imageUnderstandingHandler.js";
import { createVisualIndexJobHandler } from "../visualIndex/visualIndexJobHandler.js";
import { createConfiguredDubbingHandler } from "../dubbing/composition.js";
import { createConfiguredWhisperMediaJobHandler } from "../captions/runtime.js";
import { createImageVariantsJobHandler, imageVariantsConfigFromEnv } from "../imageVariants/runtime.js";
import { createConfiguredSubtitleTranslationHandler } from "../captions/configuredSubtitleTranslationHandler.js";

export type ConfiguredMediaJobHandler = MediaJobHandler & { close?(): void | Promise<void> };

export async function configuredMediaJobHandler(client: SupabaseClient, env: NodeJS.ProcessEnv = process.env): Promise<ConfiguredMediaJobHandler | null> {
  if (env.MEDIA_WORKER_KIND === "adaptive_video") {
    const config = adaptiveConfig(env);
    return config ? createAdaptiveJobHandler(client, config, createAdaptiveQueueBridge(client)) : null;
  }
  if (env.MEDIA_WORKER_KIND === "vision" && env.MEDIA_IMAGE_UNDERSTANDING_ENABLED === "true") {
    return createImageUnderstandingJobHandler({ sc: client, env, createJobError: (code, retryable) => new MediaJobError(code, retryable) });
  }
  if (env.MEDIA_WORKER_KIND === "embedding" && env.MEDIA_VISUAL_INDEX_ENABLED === "1") {
    return createVisualIndexJobHandler({ sc: client, env });
  }
  if (env.MEDIA_WORKER_KIND === "dubbing") return createConfiguredDubbingHandler(client, env);
  if (env.MEDIA_WORKER_KIND === "captions") return createConfiguredWhisperMediaJobHandler(client, env,
    (code, retryable) => new MediaJobError(code, retryable));
  if (env.MEDIA_WORKER_KIND === "subtitle_translation") return createConfiguredSubtitleTranslationHandler(client,
    (code, retryable) => new MediaJobError(code, retryable), env);
  if (env.MEDIA_WORKER_KIND === "image_variants" && env.MEDIA_IMAGE_VARIANTS_ENABLED === "1") {
    return createImageVariantsJobHandler(client, imageVariantsConfigFromEnv(env));
  }
  return null;
}
