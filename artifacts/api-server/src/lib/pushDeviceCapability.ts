/**
 * Per-device push capability — OD-1012-LAY-4a (owner, 2026-10-12).
 *
 * The owner approved `PUSH_IOS_TIME_SENSITIVE_ENTITLED` as a server setting,
 * "a rollout switch—not proof of an installed app's entitlement", and asked
 * that older or unknown app builds get ordinary notifications "when capability
 * is unavailable or uncertain". The server cannot see a device's build, so the
 * DEVICE says what it can do:
 *
 *   - the app reports `capabilities.iosTimeSensitive` with its push-token
 *     registration (POST /api/me/devices), computed from the build's own
 *     entitlement gate (travel-buddy-standalone safeNotifications.ts
 *     `iosTimeSensitiveAvailable()`);
 *   - this module stores it on that token's row
 *     (`notification_devices.ios_time_sensitive_capable`, migration 3771):
 *     true / false as reported, NULL when the registering build reported
 *     nothing (an older build) — so a downgrade to an older build clears it;
 *   - the router asks for iOS `time-sensitive` only for tokens whose row says
 *     true, and only while the rollout switch is on
 *     (LayoverReturnEscalation.ts `timeSensitivePushTokens`).
 *
 * Neither function ever fails the caller: a capability that cannot be written
 * or read is an UNKNOWN capability, and unknown means the ordinary level.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "./logger.js";
import { isMissingColumnError } from "./deviceRevocation.js";
import { timeSensitivePushTokens } from "../services/airport/LayoverReturnEscalation.js";

const logger = rootLogger.child({ service: "pushDeviceCapability" });

/** What a registration said about iOS time-sensitive delivery: true / false, or null when it said nothing. */
export function reportedIosTimeSensitive(capabilities: unknown): boolean | null {
  if (!capabilities || typeof capabilities !== "object") return null;
  const v = (capabilities as { iosTimeSensitive?: unknown }).iosTimeSensitive;
  return v === true ? true : v === false ? false : null;
}

/**
 * Record what the registering build reported on its token row. Always written
 * (NULL included), so the row reflects the LATEST registration of that token.
 */
export async function recordPushDeviceCapabilities(
  sc: SupabaseClient,
  userId: string,
  notificationDeviceRowId: string | null | undefined,
  capabilities: unknown,
): Promise<"recorded" | "no_row" | "column_absent" | "failed"> {
  if (!notificationDeviceRowId) return "no_row";
  try {
    const { error } = await sc
      .from("notification_devices")
      .update({ ios_time_sensitive_capable: reportedIosTimeSensitive(capabilities) })
      .eq("id", notificationDeviceRowId)
      .eq("user_id", userId);
    if (!error) return "recorded";
    if (isMissingColumnError(error)) {
      logger.debug({ userId }, "push: ios_time_sensitive_capable absent (3771 unapplied) — capability not recorded; the device stays ordinary");
      return "column_absent";
    }
    logger.warn({ err: error, userId }, "push: recording the device capability failed — the device stays ordinary until it registers again");
    return "failed";
  } catch (err) {
    logger.warn({ err, userId }, "push: recording the device capability threw — the device stays ordinary");
    return "failed";
  }
}

/**
 * The user's push tokens whose device REPORTED the iOS time-sensitive
 * capability. Called by the router only for an actionable return warning while
 * the rollout switch is on, so no other notification type reads it or depends
 * on it. Any failure — column absent (3771 unapplied), table unreadable, a
 * throw — answers "no device is known capable": the push still goes, ordinary.
 */
export async function timeSensitiveCapableTokens(sc: SupabaseClient, userId: string, notificationId: string): Promise<string[]> {
  try {
    const { data, error } = await sc
      .from("notification_devices")
      .select("push_token, ios_time_sensitive_capable")
      .eq("user_id", userId);
    if (error) {
      logger.warn({ err: error, notificationId, userId }, "push: device capabilities unreadable — return warning sent at the ordinary iOS level");
      return [];
    }
    return timeSensitivePushTokens(data as Array<{ push_token?: unknown; ios_time_sensitive_capable?: unknown }> | null);
  } catch (err) {
    logger.warn({ err, notificationId, userId }, "push: device capability read threw — return warning sent at the ordinary iOS level");
    return [];
  }
}
