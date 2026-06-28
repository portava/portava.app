/**
 * PushRetryQueue
 *
 * Persists failed push notification deliveries to the `push_retry_queue` table
 * and retries them with exponential backoff.
 *
 * Retry schedule (3 total attempts = 1 initial + 2 retries):
 *   Retry 1: +5 s after initial failure
 *   Retry 2: +15 s after retry 1 failure
 *   → total window ≈ 20–35 s
 *
 * A matching `notification_delivery_attempts` row is set to 'pending' on
 * enqueue and updated to 'sent' or 'failed' after final resolution.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "./logger.js";
import { sendPushNotification, type PushPayload } from "./push.js";

const logger = rootLogger.child({ service: "PushRetryQueue" });

/** Delay in seconds before each retry (index 0 = retry 1, index 1 = retry 2). */
const RETRY_DELAYS_SECONDS = [5, 15] as const;

/** Total number of attempts including the initial one (not a retry). */
const MAX_ATTEMPTS = 3;

/**
 * If a row has been in 'processing' status for longer than this threshold it
 * is assumed the server crashed mid-flight.  The worker resets it to 'queued'
 * so it will be picked up again on the next tick.
 */
const STALE_PROCESSING_THRESHOLD_MS = 2 * 60 * 1_000; // 2 minutes

export interface EnqueueOpts {
  notificationId: string | null;
  userId: string;
  tokens: string[];
  payload: PushPayload;
  /**
   * UUID of the notification_delivery_attempts row to update on final
   * resolution. Pass null when the attempt row could not be created — the
   * retry still happens but the delivery-attempt status will not be updated.
   */
  deliveryAttemptId: string | null;
  lastError?: string;
}

export class PushRetryQueue {
  constructor(private readonly db: SupabaseClient) {}

  /**
   * Persist a failed push attempt for later retry.
   * The initial attempt_count is 1 (the initial failure counts as attempt 1).
   * next_retry_at is set to now() + RETRY_DELAYS_SECONDS[0].
   */
  async enqueue(opts: EnqueueOpts): Promise<void> {
    const nextRetryAt = new Date(
      Date.now() + RETRY_DELAYS_SECONDS[0] * 1_000,
    ).toISOString();

    const { error } = await this.db.from("push_retry_queue").insert({
      notification_id:     opts.notificationId,
      user_id:             opts.userId,
      tokens:              opts.tokens,
      payload:             opts.payload,
      attempt_count:       1,
      max_attempts:        MAX_ATTEMPTS,
      next_retry_at:       nextRetryAt,
      last_error:          opts.lastError ?? null,
      status:              "queued",
      delivery_attempt_id: opts.deliveryAttemptId,
    });

    if (error) {
      logger.warn({ err: error, userId: opts.userId }, "push retry: failed to enqueue");
    } else {
      logger.info(
        { userId: opts.userId, notificationId: opts.notificationId, nextRetryAt },
        "push retry: enqueued for retry",
      );
    }
  }

  /**
   * Reset any rows that have been stuck in 'processing' for longer than
   * STALE_PROCESSING_THRESHOLD_MS back to 'queued' with next_retry_at = now.
   *
   * This handles the case where the server crashed/restarted after claiming a
   * row but before finalise() ran, which would otherwise leave the row in
   * 'processing' forever (the worker only selects 'queued' rows).
   */
  async recoverStaleProcessing(): Promise<void> {
    const staleThreshold = new Date(
      Date.now() - STALE_PROCESSING_THRESHOLD_MS,
    ).toISOString();
    const now = new Date().toISOString();

    const { data: recovered, error } = await this.db
      .from("push_retry_queue")
      .update({ status: "queued", next_retry_at: now, updated_at: now })
      .eq("status", "processing")
      .lt("updated_at", staleThreshold)
      .select("id");

    if (error) {
      logger.warn({ err: error }, "push retry: stale recovery query failed");
      return;
    }

    if (recovered && recovered.length > 0) {
      logger.warn(
        { count: recovered.length },
        "push retry: reset stale processing rows to queued (likely crash recovery)",
      );
    }
  }

  /**
   * Process all queued items whose next_retry_at is in the past.
   * First recovers any rows stranded in 'processing' from a prior crash, then
   * claims each due 'queued' row atomically by flipping status → 'processing'.
   */
  async processQueue(): Promise<void> {
    // Recover rows stranded by a previous crash/restart before claiming new ones
    await this.recoverStaleProcessing();

    const now = new Date().toISOString();

    // Claim all due items atomically
    const { data: items, error: fetchErr } = await this.db
      .from("push_retry_queue")
      .update({ status: "processing", updated_at: now })
      .eq("status", "queued")
      .lte("next_retry_at", now)
      .select();

    if (fetchErr) {
      logger.warn({ err: fetchErr }, "push retry: failed to claim queue items");
      return;
    }

    if (!items || items.length === 0) return;

    logger.info({ count: items.length }, "push retry: processing items");

    await Promise.allSettled(items.map((item: any) => this.processItem(item)));
  }

  private async processItem(item: any): Promise<void> {
    const {
      id,
      user_id:             userId,
      notification_id:     notificationId,
      tokens,
      payload,
      attempt_count:       prevAttemptCount,
      max_attempts:        maxAttempts,
      delivery_attempt_id: deliveryAttemptId,
    } = item;

    const newAttemptCount: number = prevAttemptCount + 1;

    try {
      const result = await sendPushNotification(tokens as string[], payload as PushPayload);

      if (result.sent > 0 || (!result.retryable && result.errors.length === 0)) {
        // Success (or all tokens had per-device errors — nothing to retry)
        await this.finalise(id, "sent", deliveryAttemptId, newAttemptCount);
        logger.info({ id, userId, attempt: newAttemptCount }, "push retry: succeeded");
        return;
      }

      if (result.retryable && newAttemptCount < maxAttempts) {
        // Still retryable and haven't exhausted attempts — re-queue
        const delayIdx = newAttemptCount - 1; // 0-based index into RETRY_DELAYS_SECONDS
        const delaySec = RETRY_DELAYS_SECONDS[delayIdx] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1];
        const nextRetryAt = new Date(Date.now() + delaySec * 1_000).toISOString();

        await this.db
          .from("push_retry_queue")
          .update({
            status:        "queued",
            attempt_count: newAttemptCount,
            next_retry_at: nextRetryAt,
            last_error:    "retryable failure",
            updated_at:    new Date().toISOString(),
          })
          .eq("id", id);

        logger.info(
          { id, userId, attempt: newAttemptCount, nextRetryAt },
          "push retry: re-queued for next retry",
        );
        return;
      }

      // Exhausted all attempts
      const lastErr = result.retryable
        ? `failed after ${newAttemptCount} attempts`
        : "non-retryable error";

      await this.finalise(id, "failed", deliveryAttemptId, newAttemptCount, lastErr);
      logger.warn(
        { id, userId, notificationId, attempt: newAttemptCount },
        "push retry: exhausted all attempts — delivery failed",
      );
    } catch (err) {
      logger.warn({ err, id, userId }, "push retry: unexpected error processing item");

      if (newAttemptCount < maxAttempts) {
        const delayIdx = newAttemptCount - 1;
        const delaySec = RETRY_DELAYS_SECONDS[delayIdx] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1];
        const nextRetryAt = new Date(Date.now() + delaySec * 1_000).toISOString();

        await this.db
          .from("push_retry_queue")
          .update({
            status:        "queued",
            attempt_count: newAttemptCount,
            next_retry_at: nextRetryAt,
            last_error:    String(err),
            updated_at:    new Date().toISOString(),
          })
          .eq("id", id);
      } else {
        await this.finalise(id, "failed", deliveryAttemptId, newAttemptCount, String(err));
      }
    }
  }

  /**
   * Mark the retry queue row as terminal (sent/failed) and update the
   * corresponding notification_delivery_attempts row.
   */
  private async finalise(
    queueId: string,
    outcome: "sent" | "failed",
    deliveryAttemptId: string | null,
    attemptCount: number,
    errorMessage?: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    await this.db
      .from("push_retry_queue")
      .update({
        status:        outcome,
        attempt_count: attemptCount,
        last_error:    errorMessage ?? null,
        updated_at:    now,
      })
      .eq("id", queueId);

    if (deliveryAttemptId) {
      const { error } = await this.db
        .from("notification_delivery_attempts")
        .update({
          status:        outcome,
          error_message: errorMessage ?? null,
          metadata:      { retryAttempts: attemptCount },
        })
        .eq("id", deliveryAttemptId);

      if (error) {
        logger.warn(
          { err: error, deliveryAttemptId },
          "push retry: failed to update delivery attempt status",
        );
      }
    }
  }
}
