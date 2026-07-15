/**
 * Push Retry Worker
 *
 * Polls the push_retry_queue table every POLL_INTERVAL_MS and attempts to
 * re-deliver any push notifications whose next_retry_at is in the past.
 *
 * Designed to be started once during server initialisation.  If the service
 * client is not yet available the worker will silently skip a tick rather than
 * crash, so it is safe to start before the first authenticated request.
 */

import { logger as rootLogger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import { PushRetryQueue } from "./pushRetryQueue.js";

const logger = rootLogger.child({ service: "PushRetryWorker" });

const POLL_INTERVAL_MS = 5_000;

let _timer: ReturnType<typeof setInterval> | null = null;

export function startPushRetryWorker(): void {
  if (_timer !== null) return; // already running

  logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, "push retry worker: starting");

  _timer = setInterval(async () => {
    const db = getServiceClient();
    if (!db) return; // service client not yet configured — skip tick

    try {
      const queue = new PushRetryQueue(db);
      await queue.processQueue();
    } catch (err) {
      logger.warn({ err }, "push retry worker: unhandled error during tick");
    }
  }, POLL_INTERVAL_MS);

  // Don't keep the Node.js event loop alive purely for this timer
  if (typeof _timer.unref === "function") _timer.unref();
}

export function stopPushRetryWorker(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
    logger.info("push retry worker: stopped");
  }
}

/**
 * Snapshot of push_retry_queue health used by the admin endpoint and the
 * startup stale-queue warning.
 */
export interface PushRetryHealth {
  queued_count:      number;
  failed_count:      number;
  oldest_queued_at:  string | null;
  last_succeeded_at: string | null;
}

/**
 * Query the push_retry_queue table for operator health metrics.
 * Returns null if the service client is unavailable.
 */
export async function queryPushRetryHealth(): Promise<PushRetryHealth | null> {
  const db = getServiceClient();
  if (!db) return null;

  const [
    { count: queuedCount, error: e1 },
    { count: failedCount, error: e2 },
    { data: oldestRows,   error: e3 },
    { data: lastSentRows, error: e4 },
  ] = await Promise.all([
    db.from("push_retry_queue").select("*", { count: "exact", head: true }).eq("status", "queued") as any,
    db.from("push_retry_queue").select("*", { count: "exact", head: true }).eq("status", "failed") as any,
    db.from("push_retry_queue").select("created_at").eq("status", "queued").order("created_at", { ascending: true }).limit(1) as any,
    db.from("push_retry_queue").select("updated_at").eq("status", "sent").order("updated_at", { ascending: false }).limit(1) as any,
  ]);

  if (e1 ?? e2 ?? e3 ?? e4) return null;

  return {
    queued_count:      queuedCount ?? 0,
    failed_count:      failedCount ?? 0,
    oldest_queued_at:  (oldestRows  as any[])?.[0]?.created_at  ?? null,
    last_succeeded_at: (lastSentRows as any[])?.[0]?.updated_at ?? null,
  };
}
