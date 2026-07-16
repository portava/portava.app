/**
 * sendPushWithRetry — shared wrapper around sendPushNotification that
 * enqueues on the PushRetryQueue when Expo returns a transient
 * (retryable) failure, instead of silently dropping the alert.
 *
 * Callers pass one or more recipients ({ userId, tokens }) so retry-queue
 * rows can be attributed to the right user. Invalid/missing tokens are
 * filtered the same way sendPushNotification does.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger.js";
import { sendPushNotification, type PushPayload, type PushResult } from "./push.js";
import { PushRetryQueue } from "./pushRetryQueue.js";
import { clearDeadTokens } from "./pushTokenCleanup.js";

// ── Test seam ──────────────────────────────────────────────────────────────────
// Allows unit tests to replace clearDeadTokens with a mock (e.g. one that
// throws) without having to mock the entire module.  Production code always
// sees null here, so the real clearDeadTokens is used.
let _testClearDeadTokensFn: ((db: SupabaseClient, tokens: string[]) => Promise<void>) | null = null;

/** @internal Only call from tests. Pass null to restore the real implementation. */
export function _setTestClearDeadTokens(
  fn: ((db: SupabaseClient, tokens: string[]) => Promise<void>) | null,
): void {
  _testClearDeadTokensFn = fn;
}

export interface PushRecipient {
  userId: string;
  tokens: (string | null | undefined)[];
}

function validTokens(tokens: (string | null | undefined)[]): string[] {
  return tokens.filter(
    (t): t is string => typeof t === "string" && t.startsWith("ExponentPushToken["),
  );
}

/**
 * Send a push to one or more recipients; on a transient (retryable) failure,
 * enqueue one PushRetryQueue row per recipient so the alert is retried with
 * backoff instead of dropped.
 *
 * Never throws — retry-queue enqueue failures are logged by the queue itself.
 */
export async function sendPushWithRetry(
  db: SupabaseClient | null,
  recipients: PushRecipient | PushRecipient[],
  payload: PushPayload,
): Promise<PushResult> {
  const list = (Array.isArray(recipients) ? recipients : [recipients])
    .map((r) => ({ userId: r.userId, tokens: validTokens(r.tokens) }))
    .filter((r) => r.tokens.length > 0);

  if (list.length === 0) return { sent: 0, errors: [] };

  const allTokens = [...new Set(list.flatMap((r) => r.tokens))];
  const result = await sendPushNotification(allTokens, payload);

  if (result.retryable) {
    if (!db) {
      logger.warn(
        { users: list.length },
        "push retry: transient failure but no db client — alert dropped",
      );
      return result;
    }
    const queue = new PushRetryQueue(db);
    for (const r of list) {
      await queue.enqueue({
        notificationId: null,
        userId: r.userId,
        tokens: r.tokens,
        payload,
        deliveryAttemptId: null,
        lastError: "transient failure on initial attempt",
      });
    }
    logger.info(
      { users: list.length },
      "push retry: queued for retry after transient failure",
    );
    return result;
  }

  // Clear tokens Expo reports as permanently dead so we stop pushing to them.
  // DeviceNotRegistered  — device is permanently gone.
  // InvalidCredentials   — push credentials are wrong for this token (always
  //                        undeliverable); treat the same as DeviceNotRegistered
  //                        so the token doesn't accumulate as a zombie.
  const staleTokens = result.errors
    .filter((e) => e.error === "DeviceNotRegistered" || e.error === "InvalidCredentials")
    .map((e) => e.token);
  if (staleTokens.length > 0) {
    if (db) {
      try {
        const clearFn = _testClearDeadTokensFn ?? clearDeadTokens;
        await clearFn(db, staleTokens);
        logger.info(
          { staleCleared: staleTokens.length },
          "push: cleared dead tokens after DeviceNotRegistered/InvalidCredentials",
        );
      } catch (err) {
        logger.warn(
          { err, staleCount: staleTokens.length },
          "push: clearDeadTokens threw on initial send path — delivery result preserved",
        );
      }
    } else {
      logger.warn(
        { staleCount: staleTokens.length },
        "push: DeviceNotRegistered/InvalidCredentials but no db client — dead tokens not cleared",
      );
    }
  }

  return result;
}
