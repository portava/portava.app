/**
 * Suggestion-seen cleanup
 *
 * Deletes rows from `user_suggestion_seen` whose `expires_at` timestamp has
 * passed. These rows are written by the hybrid seen-ID cache so that
 * suggestion strips stay fresh across server restarts; once they expire they
 * are no longer read and can be safely removed.
 *
 * The `user_suggestion_seen_expires_idx` index on `expires_at` (created in
 * migration 0050) makes the DELETE a fast index scan regardless of table size.
 *
 * This function is called from `purgeOldBriefs` so it runs on the same daily
 * cadence and its deleted count is included in the cleanup health report
 * visible at GET /api/healthz/cleanup.
 *
 * Accepts optional overrides so unit tests can inject a fake Supabase client
 * without touching env vars or module state.
 *
 * Never throws — errors are logged and returned so the caller can decide
 * whether to treat them as fatal.
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger } from "./logger.js";

export async function purgeExpiredSuggestionSeen(opts?: {
  client?: any;
}): Promise<{ deleted: number | null; error: unknown }> {
  const client = opts?.client ?? (isServiceClientReady ? getServiceClient() : null);

  if (!client) {
    logger.warn(
      "suggestionSeenCleanup: service client not ready — skipping purge",
    );
    return { deleted: null, error: null };
  }

  const now = new Date().toISOString();

  try {
    const { error, count } = await client
      .from("user_suggestion_seen")
      .delete({ count: "exact" })
      .lt("expires_at", now);

    if (error) {
      logger.warn(
        { err: error },
        "suggestionSeenCleanup: purge failed — expired rows not removed",
      );
      return { deleted: null, error };
    }

    const deleted = count ?? 0;
    if (deleted > 0) {
      logger.info({ deleted }, "suggestionSeenCleanup: purged expired rows");
    }
    return { deleted, error: null };
  } catch (err) {
    logger.warn(
      { err },
      "suggestionSeenCleanup: unexpected error during purge",
    );
    return { deleted: null, error: err };
  }
}
