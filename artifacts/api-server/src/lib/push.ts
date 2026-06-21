/**
 * Minimal Expo Push Notification helper.
 *
 * Uses the Expo Push API directly (no SDK dependency).
 * Silently no-ops if no tokens are provided or the request fails.
 */

import { logger } from "./logger.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Send a push notification to one or more Expo push tokens.
 * Tokens that are empty or non-Expo-format are silently dropped.
 */
export async function sendPushNotification(
  tokens: (string | null | undefined)[],
  payload: PushPayload,
): Promise<void> {
  const valid = tokens.filter(
    (t): t is string =>
      typeof t === "string" && t.startsWith("ExponentPushToken["),
  );
  if (valid.length === 0) return;

  const messages = valid.map((to) => ({
    to,
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
    sound: "default",
  }));

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "expo push: non-2xx response");
    }
  } catch (err) {
    logger.warn({ err }, "expo push: network error");
  }
}
