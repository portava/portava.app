import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getServiceClient } from "../lib/supabase.js";
import { configuredMediaJobHandler } from "../lib/media/jobs/registry.js";
import { createMediaJobQueue, MediaJobError } from "../lib/media/jobs/queue.js";
import { mediaWorkerConfig, runMediaWorkerRuntime } from "../lib/media/jobs/runtime.js";

export async function runConfiguredMediaWorker(): Promise<void> {
  const config = mediaWorkerConfig();
  if (!config.enabled) {
    process.stdout.write(JSON.stringify({ state: "disabled", feature: "media_derivative_worker" }) + "\n");
    return;
  }
  const client = getServiceClient();
  if (!client) throw new MediaJobError("worker_database_unconfigured");
  const handler = await configuredMediaJobHandler(client);
  if (!handler) throw new MediaJobError("worker_handler_unconfigured");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runMediaWorkerRuntime(createMediaJobQueue(client, { timeoutMs: config.queueTimeoutMs }), handler, config, controller.signal,
      health => process.stdout.write(JSON.stringify({ ...health, kind: handler.kind, modelVersion: handler.modelVersion }) + "\n"));
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await handler.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runConfiguredMediaWorker().catch(error => {
    process.stderr.write(JSON.stringify({ state: "degraded", errorCode: error instanceof MediaJobError ? error.code : "worker_startup_failed" }) + "\n");
    process.exitCode = 1;
  });
}
