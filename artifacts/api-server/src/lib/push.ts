/**
 * Minimal Expo Push Notification helper.
 *
 * Uses the Expo Push API directly (no SDK dependency).
 * Silently no-ops if no tokens are provided or the request fails.
 *
 * Response body is parsed so per-token errors (e.g. DeviceNotRegistered) are
 * surfaced in logs rather than silently swallowed.
 *
 * Test slot: _setTestFetch(fn) injects a mock fetch implementation.
 * This is the same pattern as _setTestTokenProvider in pushTokenService.ts.
 * Has zero effect in production because tests never run in the Expo runtime.
 */

import { logger } from "./logger.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /**
   * Delivery priority forwarded verbatim to the Expo Push API.
   * - "high"    → FCM high priority (wakes a backgrounded Android device) /
   *               APNs priority 10 (immediate delivery on iOS).
   * - "normal"  → FCM normal priority (device decides when to deliver) /
   *               APNs priority 5.
   * - "default" → Expo chooses; effectively "high" for iOS, "normal" for
   *               Android when no explicit value is set.
   * Use "high" for time-sensitive alerts such as incoming calls.
   */
  priority?: "default" | "normal" | "high";
}

export interface PushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface PushResult {
  sent: number;
  errors: Array<{ token: string; error: string; message?: string }>;
  /**
   * True when the failure was caused by a transient condition (network error
   * or a 5xx response from Expo) and the caller should retry.
   * False (or absent) for per-token errors such as DeviceNotRegistered.
   */
  retryable?: boolean;
}

// ── Test slot ─────────────────────────────────────────────────────────────────

let _testFetch: typeof fetch | null = null;

/**
 * Override the fetch implementation used by sendPushNotification in tests.
 * Pass null to restore the default global fetch.
 */
export function _setTestFetch(fn: typeof fetch | null): void {
  _testFetch = fn;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a push notification to one or more Expo push tokens.
 * Tokens that are empty or non-Expo-format are silently dropped.
 *
 * Returns a PushResult summarising how many messages were accepted by Expo and
 * any per-token errors returned in the response body (e.g. DeviceNotRegistered).
 * The caller may use this to clean up stale tokens from the DB.
 */
export async function sendPushNotification(
  tokens: (string | null | undefined)[],
  payload: PushPayload,
  opts?: {
    /** Override the fetch implementation (for tests — prefer _setTestFetch). */
    fetchImpl?: typeof fetch;
  },
): Promise<PushResult> {
  const valid = tokens.filter(
    (t): t is string =>
      typeof t === "string" && t.startsWith("ExponentPushToken["),
  );

  if (valid.length === 0) return { sent: 0, errors: [] };

  const messages = valid.map((to) => ({
    to,
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
    sound: "default",
    // Forward the caller's priority so time-sensitive pushes (e.g. incoming
    // calls) use FCM high-priority delivery and APNs priority 10, which wakes
    // a backgrounded device. Omitting the field lets Expo choose its default.
    ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
  }));

  const doFetch = opts?.fetchImpl ?? _testFetch ?? fetch;

  try {
    const res = await doFetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "expo push: non-2xx response");
      return { sent: 0, errors: [], retryable: res.status >= 500 };
    }

    let tickets: PushTicket[] = [];
    try {
      const json = await res.json() as { data?: PushTicket[] };
      tickets = json.data ?? [];
    } catch {
      logger.warn("expo push: failed to parse response body");
      return { sent: valid.length, errors: [] };
    }

    let sent = 0;
    const errors: PushResult["errors"] = [];

    tickets.forEach((ticket, i) => {
      if (ticket.status === "ok") {
        sent++;
      } else {
        const token  = valid[i] ?? "unknown";
        const errCode = ticket.details?.error ?? "unknown";
        const errMsg  = ticket.message;
        logger.warn({ token, errCode, errMsg }, "expo push: per-token error");
        errors.push({ token, error: errCode, message: errMsg });
      }
    });

    if (errors.length > 0) {
      logger.warn(
        { errorCount: errors.length, totalSent: sent },
        "expo push: some tokens had errors",
      );
    }

    return { sent, errors };
  } catch (err) {
    logger.warn({ err }, "expo push: network error");
    return { sent: 0, errors: [], retryable: true };
  }
}
