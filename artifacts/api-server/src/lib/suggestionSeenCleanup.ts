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
 * `startSuggestionSeenCleanup()` runs its own independent 24-hour scheduler so
 * expired rows are purged even when the daily-brief cleanup job is paused or
 * disabled. `purgeOldBriefs` also calls `purgeExpiredSuggestionSeen` as a
 * belt-and-suspenders measure, but the independent scheduler is the primary
 * guarantee.
 *
 * Accepts optional overrides so unit tests can inject a fake Supabase client
 * without touching env vars or module state.
 *
 * Never throws — errors are logged and returned so the caller can decide
 * whether to treat them as fatal.
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Status tracking
// ---------------------------------------------------------------------------

interface SuggestionSeenStatus {
  lastRunAt: string | null;
  lastDeletedCount: number | null;
  lastOutcome: "success" | "error" | "skipped" | null;
}

const _status: SuggestionSeenStatus = {
  lastRunAt: null,
  lastDeletedCount: null,
  lastOutcome: null,
};

/** Return a snapshot of the most recent suggestion-seen cleanup run. */
export function getSuggestionSeenStatus(): Readonly<SuggestionSeenStatus> {
  return { ..._status };
}

// ---------------------------------------------------------------------------
// Scheduler constants (mirrors dailyBriefCleanup cadence by default)
// ---------------------------------------------------------------------------

/** 24-hour interval between purge runs (not user-configurable — tied to expires_at TTL). */
export const SUGGESTION_SEEN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Short delay so the server finishes initialising before the first purge. */
export const SUGGESTION_SEEN_STARTUP_DELAY_MS = 45 * 1_000;

// ---------------------------------------------------------------------------
// Purge logic
// ---------------------------------------------------------------------------

export async function purgeExpiredSuggestionSeen(opts?: {
  client?: any;
}): Promise<{ deleted: number | null; error: unknown }> {
  const client = opts?.client ?? (isServiceClientReady ? getServiceClient() : null);

  if (!client) {
    logger.warn(
      "suggestionSeenCleanup: service client not ready — skipping purge",
    );
    _status.lastRunAt = new Date().toISOString();
    _status.lastOutcome = "skipped";
    _status.lastDeletedCount = null;
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
      _status.lastRunAt = new Date().toISOString();
      _status.lastOutcome = "error";
      _status.lastDeletedCount = null;
      return { deleted: null, error };
    }

    const deleted = count ?? 0;
    if (deleted > 0) {
      logger.info({ deleted }, "suggestionSeenCleanup: purged expired rows");
    }
    _status.lastRunAt = new Date().toISOString();
    _status.lastOutcome = "success";
    _status.lastDeletedCount = deleted;
    return { deleted, error: null };
  } catch (err) {
    logger.warn(
      { err },
      "suggestionSeenCleanup: unexpected error during purge",
    );
    _status.lastRunAt = new Date().toISOString();
    _status.lastOutcome = "error";
    _status.lastDeletedCount = null;
    return { deleted: null, error: err };
  }
}

// ---------------------------------------------------------------------------
// Independent scheduler
// ---------------------------------------------------------------------------

/**
 * Start the independent suggestion-seen cleanup scheduler.
 *
 * Runs once shortly after startup, then every 24 hours. This is independent
 * of the daily-brief cleanup scheduler so expired rows are purged even when
 * the brief job is paused or disabled.
 *
 * Returns the interval handle so callers can cancel it in tests if needed.
 */
export function startSuggestionSeenCleanup(): ReturnType<typeof setInterval> {
  const initialTimer = setTimeout(() => {
    purgeExpiredSuggestionSeen().catch(() => {});
  }, SUGGESTION_SEEN_STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    purgeExpiredSuggestionSeen().catch(() => {});
  }, SUGGESTION_SEEN_INTERVAL_MS);

  interval.unref();

  if (typeof initialTimer.unref === "function") {
    initialTimer.unref();
  }

  logger.info(
    { intervalHours: SUGGESTION_SEEN_INTERVAL_MS / 3_600_000 },
    "suggestionSeenCleanup: independent scheduler started",
  );

  return interval;
}
