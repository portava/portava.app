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
