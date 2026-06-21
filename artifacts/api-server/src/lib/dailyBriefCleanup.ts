/**
 * Daily Brief Cleanup
 *
 * Purges daily_briefs rows older than DAILY_BRIEF_RETENTION_DAYS (default 60) days so the table does not grow
 * unbounded. Runs once immediately on startup (after a short delay to let
 * the server fully initialise) and then every 24 hours.
 *
 * The delete uses the brief_date index added in migration 0013 so the scan
 * is cheap regardless of table size.
 *
 * Failures are logged and swallowed — the cleanup is best-effort and must
 * never crash the server. Failed purges increment a consecutive-failure
 * counter so monitoring can key on the ERROR log event or the
 * GET /healthz/cleanup endpoint.
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger } from "./logger.js";

// ─── Exported for unit testing ───────────────────────────────────────────────

/**
 * Parse DAILY_BRIEF_RETENTION_DAYS. Returns 60 (default) when the value is
 * missing, non-numeric, zero, or negative.
 */
export function parseRetentionDays(raw: string | undefined): number {
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

/**
 * Parse DAILY_BRIEF_CLEANUP_INTERVAL_HOURS. Returns 24 (default) when the
 * value is missing, non-numeric, zero, or negative. Accepts fractional values
 * (e.g. 0.5 → every 30 minutes).
 */
export function parseIntervalHours(raw: string | undefined): number {
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

// ─── Module-level constants (resolved once at startup) ───────────────────────

const RETENTION_DAYS = parseRetentionDays(process.env.DAILY_BRIEF_RETENTION_DAYS);
const CLEANUP_INTERVAL_HOURS = parseIntervalHours(process.env.DAILY_BRIEF_CLEANUP_INTERVAL_HOURS);

/** Exported for unit tests so they can advance fake timers by the right amount. */
export const INTERVAL_MS = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1_000;

/** Exported for unit tests so they can advance fake timers by the right amount. */
export const STARTUP_DELAY_MS = 30 * 1_000;

// ─── Status tracking ──────────────────────────────────────────────────────────

export type CleanupOutcome = "success" | "error" | "skipped";

interface CleanupStatus {
  lastRunAt: string | null;
  lastOutcome: CleanupOutcome | null;
  lastDeletedCount: number | null;
  consecutiveFailures: number;
}

const _status: CleanupStatus = {
  lastRunAt: null,
  lastOutcome: null,
  lastDeletedCount: null,
  consecutiveFailures: 0,
};

/** Return a snapshot of the most recent cleanup run status. */
export function getCleanupStatus(): Readonly<CleanupStatus> {
  return { ..._status };
}

/**
 * True when the cleanup job last ran within the expected window.
 * Window = INTERVAL_MS + 1 hour grace (default: 25 h for a daily job).
 * Returns false when lastRunAt is null (never ran) or the timestamp is stale.
 */
export function computeCleanupHealthy(lastRunAt: string | null): boolean {
  if (!lastRunAt) return false;
  const windowMs = INTERVAL_MS + 3_600_000; // interval + 1 h grace
  return Date.now() - new Date(lastRunAt).getTime() < windowMs;
}

/**
 * Query the persistent `job_health` table for the cleanup job's last run time.
 * Falls back to { cleanupHealthy: false, lastRunAt: null } when the service
 * client is unavailable or the table does not yet exist.
 */
export async function queryCleanupHealth(): Promise<{
  cleanupHealthy: boolean;
  lastRunAt: string | null;
}> {
  const client = isServiceClientReady ? getServiceClient() : null;
  if (!client) return { cleanupHealthy: false, lastRunAt: null };

  const { data, error } = await client
    .from("job_health")
    .select("last_run_at")
    .eq("job", "cleanup")
    .maybeSingle();

  if (error || !data) return { cleanupHealthy: false, lastRunAt: null };

  const lastRunAt = (data as any).last_run_at as string;
  return { cleanupHealthy: computeCleanupHealthy(lastRunAt), lastRunAt };
}

function recordSuccess(deleted: number): void {
  _status.lastRunAt = new Date().toISOString();
  _status.lastOutcome = "success";
  _status.lastDeletedCount = deleted;
  _status.consecutiveFailures = 0;
}

function recordError(err: unknown): void {
  _status.lastRunAt = new Date().toISOString();
  _status.lastOutcome = "error";
  _status.lastDeletedCount = null;
  _status.consecutiveFailures += 1;

  logger.error(
    { err, consecutiveFailures: _status.consecutiveFailures },
    "dailyBriefCleanup: purge failed — consecutive failure alert",
  );
}

function recordSkipped(): void {
  _status.lastRunAt = new Date().toISOString();
  _status.lastOutcome = "skipped";
  _status.lastDeletedCount = null;
}

// ─── Test instrumentation ────────────────────────────────────────────────────

/**
 * Incremented every time purgeOldBriefs is invoked. Exported so scheduler
 * unit tests can assert how many purge calls fired without relying on timing.
 * Not meaningful in production — reads are always zero-cost.
 */
export let _purgeCallCount = 0;

// ─── Purge logic ─────────────────────────────────────────────────────────────

/**
 * Delete daily_briefs rows whose brief_date is older than `retentionDays`.
 *
 * Accepts optional overrides so unit tests can inject a fake Supabase client
 * and a custom retention window without touching env vars or module state.
 *
 * Returns { deleted, error } so callers (and tests) can inspect the outcome.
 * Never throws — errors are logged and returned.
 */
export async function purgeOldBriefs(opts?: {
  client?: any;
  retentionDays?: number;
}): Promise<{ deleted: number | null; error: unknown }> {
  _purgeCallCount++;
  const client = opts?.client ?? (isServiceClientReady ? getServiceClient() : null);
  const retentionDays = opts?.retentionDays ?? RETENTION_DAYS;

  if (!client) {
    logger.warn("dailyBriefCleanup: service client not ready — skipping purge");
    recordSkipped();
    return { deleted: null, error: null };
  }

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  // ── Step 1: run the purge — this is the authoritative result ────────────────
  let purgeResult: { deleted: number | null; error: unknown };
  try {
    const { error, count } = await client
      .from("daily_briefs")
      .delete({ count: "exact" })
      .lt("brief_date", cutoffDate);

    if (error) {
      recordError(error);
      purgeResult = { deleted: null, error };
    } else {
      const deleted = count ?? 0;
      recordSuccess(deleted);
      logger.info({ deleted, cutoffDate }, "dailyBriefCleanup: purged old briefs");
      purgeResult = { deleted, error: null };
    }
  } catch (err) {
    recordError(err);
    purgeResult = { deleted: null, error: err };
  }

  // ── Step 2: persist last-run timestamp (non-fatal, isolated from purge) ─────
  // Runs only after a successful purge. Failures here NEVER change purgeResult.
  if (purgeResult.error === null && _status.lastOutcome === "success") {
    const sc = opts?.client ?? (isServiceClientReady ? getServiceClient() : null);
    if (sc) {
      try {
        const { error: upsertErr } = await sc
          .from("job_health")
          .upsert(
            { job: "cleanup", last_run_at: _status.lastRunAt, updated_at: _status.lastRunAt },
            { onConflict: "job" },
          );
        if (upsertErr) {
          logger.warn({ err: upsertErr }, "dailyBriefCleanup: could not persist job health — table may not exist yet");
        }
      } catch (persistErr) {
        logger.warn({ err: persistErr }, "dailyBriefCleanup: could not persist job health");
      }
    }
  }

  return purgeResult;
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Start the background cleanup scheduler.
 * Returns the interval handle so callers can cancel it in tests if needed.
 */
export function startDailyBriefCleanup(): ReturnType<typeof setInterval> {
  const initialTimer = setTimeout(() => {
    purgeOldBriefs().catch(() => {});
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    purgeOldBriefs().catch(() => {});
  }, INTERVAL_MS);

  interval.unref();

  if (typeof initialTimer.unref === "function") {
    initialTimer.unref();
  }

  logger.info(
    { retentionDays: RETENTION_DAYS, intervalHours: INTERVAL_MS / 3_600_000 },
    "dailyBriefCleanup: scheduler started",
  );

  return interval;
}
