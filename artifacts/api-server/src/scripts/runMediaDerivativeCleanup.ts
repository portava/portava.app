import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { getServiceClient } from "../lib/supabase.js";
import { retryFailedMediaPurges } from "../services/media/MediaLifecycleService.js";
import { AdaptiveOrphanReconciler } from "../services/media/AdaptiveOrphanReconciler.js";
import { ImageVariantsOrphanReconciler } from "../services/media/ImageVariantsOrphanReconciler.js";
import { RetainedDubbingReconciler } from "../services/media/RetainedDubbingReconciler.js";
import { RetainedCaptionTranslationReconciler } from "../services/media/RetainedCaptionTranslationReconciler.js";

export async function runConfiguredMediaCleanup(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.MEDIA_DERIVATIVE_CLEANUP_ENABLED !== "true") {
    process.stdout.write(JSON.stringify({ state: "disabled", feature: "media_derivative_cleanup" }) + "\n");
    return;
  }
  const client = getServiceClient();
  if (!client) throw new Error("Cleanup database unconfigured");
  const controller = new AbortController();
  const stop = () => controller.abort();
  const reconciler = env.MEDIA_ADAPTIVE_ROOT ? new AdaptiveOrphanReconciler(client, env.MEDIA_ADAPTIVE_ROOT) : null;
  const imageReconciler = env.MEDIA_IMAGE_VARIANTS_ROOT ? new ImageVariantsOrphanReconciler(client, env.MEDIA_IMAGE_VARIANTS_ROOT) : null;
  const dubbingReconciler = new RetainedDubbingReconciler(client);
  const translationReconciler = new RetainedCaptionTranslationReconciler(client);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      let failed = false;
      try {
        const purge = await retryFailedMediaPurges(client, { signal: controller.signal, limit: 10, env });
        process.stdout.write(JSON.stringify({ state: purge.failed ? "degraded" : "ready", feature: "media_purge_retry", ...purge }) + "\n");
        failed ||= purge.failed > 0;
      } catch {
        if (controller.signal.aborted) break;
        failed = true;
        process.stderr.write(JSON.stringify({ state: "degraded", feature: "media_purge_retry", errorCode: "cleanup_unconfirmed" }) + "\n");
      }
      if (controller.signal.aborted) break;
      if (reconciler) {
        try {
          const orphan = await reconciler.runPass({ signal: controller.signal, limit: 50 });
          process.stdout.write(JSON.stringify({ state: orphan.failed ? "degraded" : "ready", feature: "adaptive_orphan_cleanup", ...orphan }) + "\n");
          failed ||= orphan.failed > 0;
        } catch {
          if (controller.signal.aborted) break;
          failed = true;
          process.stderr.write(JSON.stringify({ state: "degraded", feature: "adaptive_orphan_cleanup", errorCode: "cleanup_unconfirmed" }) + "\n");
        }
      }
      if (controller.signal.aborted) break;
      if (imageReconciler) {
        try {
          const image = await imageReconciler.runPass({ signal: controller.signal, limit: 25 });
          const state = image.failed ? "degraded" : !image.schemaInstalled ? "not_installed" : image.pageExhausted ? "ready" : "pending";
          process.stdout.write(JSON.stringify({ state, feature: "image_orphan_cleanup", ...image }) + "\n");
          failed ||= image.failed > 0;
        } catch {
          if (controller.signal.aborted) break;
          failed = true;
          process.stderr.write(JSON.stringify({ state: "degraded", feature: "image_orphan_cleanup", errorCode: "cleanup_unconfirmed" }) + "\n");
        }
      }
      if (controller.signal.aborted) break;
      try {
        const dubbing = await dubbingReconciler.runPass({ signal: controller.signal, limit: 25 });
        const debt = dubbing.failed > 0 || dubbing.unsettled > 0;
        const state = debt ? "degraded" : !dubbing.schemaInstalled ? "not_installed" : dubbing.pageExhausted ? "ready" : "pending";
        process.stdout.write(JSON.stringify({ state, feature: "retained_dubbing_cleanup", ...dubbing }) + "\n");
        failed ||= debt;
      } catch {
        if (controller.signal.aborted) break;
        failed = true;
        process.stderr.write(JSON.stringify({ state: "degraded", feature: "retained_dubbing_cleanup", errorCode: "cleanup_unconfirmed" }) + "\n");
      }
      if (controller.signal.aborted) break;
      try {
        const translation = await translationReconciler.runPass({ signal: controller.signal, limit: 25 });
        const debt = translation.failed > 0 || translation.unsettled > 0;
        const state = debt ? "degraded" : !translation.schemaInstalled ? "not_installed" : translation.pageExhausted ? "ready" : "pending";
        process.stdout.write(JSON.stringify({ state, feature: "retained_translation_cleanup", ...translation }) + "\n");
        failed ||= debt;
      } catch {
        if (controller.signal.aborted) break;
        failed = true;
        process.stderr.write(JSON.stringify({ state: "degraded", feature: "retained_translation_cleanup", errorCode: "cleanup_unconfirmed" }) + "\n");
      }
      if (process.argv.includes("--once")) { if (failed) process.exitCode = 1; break; }
      await delay(60000, undefined, { signal: controller.signal }).catch(() => {});
    } while (!controller.signal.aborted);
  } finally {
    controller.abort();
    await reconciler?.close();
    await imageReconciler?.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runConfiguredMediaCleanup().catch(() => {
    process.stderr.write(JSON.stringify({ state: "degraded", errorCode: "cleanup_startup_failed" }) + "\n");
    process.exitCode = 1;
  });
}
