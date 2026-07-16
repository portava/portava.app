/**
 * pushTokenCleanup — shared helper for clearing dead Expo push tokens.
 *
 * Used by both pushWithRetry (initial send path) and pushRetryQueue (retry
 * path) so the same three-table cleanup runs regardless of which code path
 * detected the dead token.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger.js";

/**
 * Clear tokens Expo reported as DeviceNotRegistered or InvalidCredentials from
 * every place they are stored:
 *   - profiles.expo_push_token
 *   - notification_devices.push_token (row deleted)
 *   - rent_buddy_profiles.expo_push_token
 *
 * Never throws — each step is wrapped so a failure in one table doesn't block
 * the others.
 */
export async function clearDeadTokens(
  db: SupabaseClient,
  staleTokens: string[],
): Promise<void> {
  // Guard: an empty .in() filter can match all rows on some Supabase driver
  // versions — a catastrophic silent wipe.  Skip all DB work when the list is
  // empty so callers don't have to remember to check before calling.
  if (staleTokens.length === 0) return;

  try {
    const { error } = await db
      .from("profiles")
      .update({ expo_push_token: null })
      .in("expo_push_token", staleTokens);
    if (error) throw error;
  } catch (err) {
    logger.warn(
      { err, staleCount: staleTokens.length },
      "push: failed to clear dead tokens from profiles",
    );
  }

  try {
    const { error } = await db
      .from("notification_devices")
      .delete()
      .in("push_token", staleTokens);
    if (error) throw error;
  } catch (err) {
    logger.warn(
      { err, staleCount: staleTokens.length },
      "push: failed to delete dead tokens from notification_devices",
    );
  }

  try {
    const { error } = await db
      .from("rent_buddy_profiles")
      .update({ expo_push_token: null })
      .in("expo_push_token", staleTokens);
    if (error) throw error;
  } catch (err) {
    logger.warn(
      { err, staleCount: staleTokens.length },
      "push: failed to clear dead tokens from rent_buddy_profiles",
    );
  }
}
