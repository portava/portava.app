import { setTimeout as delay } from "node:timers/promises";
import type { MediaJobQueue } from "./queue.js";
import { MEDIA_QUEUE_TIMEOUT_MS, MediaJobError } from "./queue.js";
import { runMediaWorkerPass, type MediaJobHandler, type MediaWorkerPass } from "./worker.js";

export interface MediaWorkerRuntimeConfig {
  enabled: boolean;
  concurrency: number;
  leaseSeconds: number;
  pollMs: number;
  maxRssBytes: number;
  queueTimeoutMs?: number;
}
export interface MediaWorkerHealth {
  state: "disabled" | "ready" | "processing" | "backpressure" | "degraded" | "stopped";
  at: string;
  rssBytes: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  pass?: MediaWorkerPass;
  errorCode?: string;
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new MediaJobError("invalid_worker_configuration");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new MediaJobError("invalid_worker_configuration");
  return value;
}

export function mediaWorkerConfig(env: NodeJS.ProcessEnv = process.env): MediaWorkerRuntimeConfig {
  return {
    enabled: env.MEDIA_DERIVATIVE_WORKER_ENABLED === "true",
    concurrency: boundedInteger(env.MEDIA_WORKER_CONCURRENCY, 1, 1, 8),
    leaseSeconds: boundedInteger(env.MEDIA_WORKER_LEASE_SECONDS, 120, 15, 900),
    pollMs: boundedInteger(env.MEDIA_WORKER_POLL_MS, 10000, 100, 60000),
    maxRssBytes: boundedInteger(env.MEDIA_WORKER_MAX_RSS_MB, 1024, 128, 16384) * 1024 * 1024,
    queueTimeoutMs: boundedInteger(env.MEDIA_WORKER_QUEUE_TIMEOUT_MS, MEDIA_QUEUE_TIMEOUT_MS, 1, 30000),
  };
}

export async function runMediaWorkerRuntime(
  queue: MediaJobQueue, handler: MediaJobHandler, config: MediaWorkerRuntimeConfig, signal: AbortSignal,
  onHealth: (health: MediaWorkerHealth) => void,
  memoryUsage: () => number = () => process.memoryUsage().rss,
): Promise<void> {
  const report = (state: MediaWorkerHealth["state"], extras: Partial<MediaWorkerHealth> = {}) => {
    const cpu = process.cpuUsage();
    onHealth({ state, at: new Date().toISOString(), rssBytes: memoryUsage(), cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system, ...extras });
  };
  if (!config.enabled) { report("disabled"); return; }
  report("ready");
  while (!signal.aborted) {
    if (memoryUsage() > config.maxRssBytes) report("backpressure", { errorCode: "process_memory_limit" });
    else {
      report("processing");
      try {
        const pass = await runMediaWorkerPass(queue, handler, { ...config, signal });
        report(pass.lost || pass.cleanupFailed ? "degraded" : "ready", { pass });
      } catch (error) {
        report("degraded", { errorCode: error instanceof MediaJobError ? error.code : "worker_pass_failed" });
      }
    }
    try { await delay(config.pollMs, undefined, { signal }); } catch { break; }
  }
  report("stopped");
}
