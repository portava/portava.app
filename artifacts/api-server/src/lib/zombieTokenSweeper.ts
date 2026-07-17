/**
 * ZombieTokenSweeper
 *
 * Belt-and-suspenders background job that periodically sweeps
 * `notification_devices` for tokens belonging to users who have accumulated
 * repeated DeviceNotRegistered push failures.
 *
 * Why this exists
 * ───────────────
 * `NotificationRouter.cleanupStaleTokens` removes invalid tokens inline after
 * every push delivery.  When that cleanup fails (DB error, RLS, transient
 * network) the bad tokens persist as "zombies" — they waste push API quota and
 * inflate delivery-failure noise with every subsequent send.
 *
 * This sweeper catches what inline cleanup misses by querying
 * `notification_delivery_attempts` for users whose push channel has repeatedly
 * logged a DeviceNotRegistered error, then deleting ALL their `notification_devices`
 * rows (Expo has told us at least once those devices are no longer registered).
 * The legacy `profiles.expo_push_token` is also cleared when it matches.
 *
 * Configuration (env vars)
 * ───────────────────────
 *   ZOMBIE_TOKEN_SWEEP_INTERVAL_HOURS  — interval between sweeps (default: 6)
 *   ZOMBIE_TOKEN_SWEEP_FAILURE_THRESHOLD — min DeviceNotRegistered failures to
 *                                          qualify a user for sweep (default: 3)
 *   ZOMBIE_TOKEN_SWEEP_LOOKBACK_DAYS   — how far back to look for failures (default: 7)
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ service: "ZombieTokenSweeper" });

// ── Configuration ─────────────────────────────────────────────────────────────

function parseEnvFloat(raw: string | undefined, defaultVal: number): number {
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal;
}

function parseEnvInt(raw: string | undefined, defaultVal: number): number {
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal;
}

const SWEEP_INTERVAL_HOURS  = parseEnvFloat(process.env["ZOMBIE_TOKEN_SWEEP_INTERVAL_HOURS"], 6);
const FAILURE_THRESHOLD     = parseEnvInt(process.env["ZOMBIE_TOKEN_SWEEP_FAILURE_THRESHOLD"], 3);
const LOOKBACK_DAYS         = parseEnvInt(process.env["ZOMBIE_TOKEN_SWEEP_LOOKBACK_DAYS"], 7);

export const SWEEP_INTERVAL_MS = SWEEP_INTERVAL_HOURS * 60 * 60 * 1_000;

/** Exported so unit tests can advance timers by the right amount. */
export const STARTUP_DELAY_MS = 60 * 1_000; // wait 60 s after server start

// ── Status tracking ───────────────────────────────────────────────────────────

interface SweepStatus {
  lastRunAt: string | null;
  lastSweptUserCount: number | null;
  consecutiveFailures: number;
}

const _status: SweepStatus = {
  lastRunAt: null,
  lastSweptUserCount: null,
  consecutiveFailures: 0,
};

export function getSweepStatus(): Readonly<SweepStatus> {
  return { ..._status };
}

// ── Sweep logic ───────────────────────────────────────────────────────────────

/**
 * Find users who have accumulated >= FAILURE_THRESHOLD DeviceNotRegistered
 * push failures in the past LOOKBACK_DAYS, then delete their stale device rows.
 *
 * Accepts an optional `client` override so unit tests can inject a fake
 * Supabase client without a live connection.
 *
 * Returns { swept, error } — never throws.
 */
export async function sweepZombieTokens(opts?: {
  client?: any | null;
  failureThreshold?: number;
  lookbackDays?: number;
}): Promise<{ swept: number; error: unknown }> {
  const db =
    opts !== undefined && "client" in opts && opts.client !== undefined
      ? opts.client
      : isServiceClientReady
        ? getServiceClient()
        : null;

  if (!db) {
    logger.warn("ZombieTokenSweeper: service client not ready — skipping sweep");
    return { swept: 0, error: null };
  }

  const threshold    = opts?.failureThreshold ?? FAILURE_THRESHOLD;
  const lookbackDays = opts?.lookbackDays     ?? LOOKBACK_DAYS;
  // Single clock read — all timestamps in this sweep derive from nowMs so the
  // lookback cutoff and lastRunAt can never disagree (split-clock risk).
  const nowMs        = Date.now();
  const since        = new Date(nowMs - lookbackDays * 24 * 60 * 60 * 1_000).toISOString();

  try {
    // ── Step 1: Find users with repeated DeviceNotRegistered failures ──────────
    // We query notification_delivery_attempts for push failures that mention
    // DeviceNotRegistered in the error_message, group by user_id, and keep only
    // users with >= threshold failures in the lookback window.
    const { data: failureRows, error: queryErr } = await db
      .from("notification_delivery_attempts")
      .select("user_id")
      .eq("channel", "push")
      .eq("status", "failed")
      .ilike("error_message", "%DeviceNotRegistered%")
      .gte("created_at", since);

    if (queryErr) {
      _status.consecutiveFailures += 1;
      logger.error(
        { err: queryErr, consecutiveFailures: _status.consecutiveFailures },
        "ZombieTokenSweeper: failed to query delivery attempts",
      );
      return { swept: 0, error: queryErr };
    }

    // Count failures per user client-side (Supabase JS doesn't expose GROUP BY HAVING)
    const failureCounts = new Map<string, number>();
    for (const row of (failureRows ?? []) as Array<{ user_id: string }>) {
      failureCounts.set(row.user_id, (failureCounts.get(row.user_id) ?? 0) + 1);
    }

    const eligibleUsers = [...failureCounts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([userId]) => userId);

    if (eligibleUsers.length === 0) {
      _status.lastRunAt = new Date(nowMs).toISOString();
      _status.lastSweptUserCount = 0;
      _status.consecutiveFailures = 0;
      logger.debug({ lookbackDays, threshold }, "ZombieTokenSweeper: no zombie tokens found");
      return { swept: 0, error: null };
    }

    // ── Step 2: Delete notification_devices rows for eligible users ───────────
    const { error: deleteDevErr } = await db
      .from("notification_devices")
      .delete()
      .in("user_id", eligibleUsers);

    if (deleteDevErr) {
      _status.consecutiveFailures += 1;
      logger.error(
        {
          err: deleteDevErr,
          eligibleUserCount: eligibleUsers.length,
          consecutiveFailures: _status.consecutiveFailures,
        },
        "ZombieTokenSweeper: failed to delete notification_devices rows",
      );
      return { swept: 0, error: deleteDevErr };
    }

    // ── Step 3: Clear legacy expo_push_token on matching profiles ─────────────
    // Best-effort — failure here is logged but does not block recording success.
    const { error: profileErr } = await db
      .from("profiles")
      .update({ expo_push_token: null })
      .in("id", eligibleUsers)
      .not("expo_push_token", "is", null);

    if (profileErr) {
      logger.warn(
        { err: profileErr, eligibleUserCount: eligibleUsers.length },
        "ZombieTokenSweeper: failed to clear legacy expo_push_token on some profiles",
      );
    }

    _status.lastRunAt = new Date(nowMs).toISOString();
    _status.lastSweptUserCount = eligibleUsers.length;
    _status.consecutiveFailures = 0;

    logger.info(
      {
        sweptUserCount: eligibleUsers.length,
        lookbackDays,
        threshold,
      },
      "ZombieTokenSweeper: swept zombie tokens",
    );

    return { swept: eligibleUsers.length, error: null };
  } catch (err) {
    _status.consecutiveFailures += 1;
    logger.error(
      { err, consecutiveFailures: _status.consecutiveFailures },
      "ZombieTokenSweeper: unhandled error during sweep",
    );
    return { swept: 0, error: err };
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;

export function startZombieTokenSweeper(): void {
  if (_timer !== null) return; // already running

  logger.info(
    { sweepIntervalHours: SWEEP_INTERVAL_HOURS, failureThreshold: FAILURE_THRESHOLD, lookbackDays: LOOKBACK_DAYS },
    "ZombieTokenSweeper: starting",
  );

  // Initial sweep after a short startup delay so the server is fully ready
  const initialTimer = setTimeout(() => {
    sweepZombieTokens().catch(() => {});
  }, STARTUP_DELAY_MS);

  if (typeof initialTimer.unref === "function") initialTimer.unref();

  _timer = setInterval(() => {
    sweepZombieTokens().catch(() => {});
  }, SWEEP_INTERVAL_MS);

  if (typeof _timer.unref === "function") _timer.unref();
}

export function stopZombieTokenSweeper(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
    logger.info("ZombieTokenSweeper: stopped");
  }
}
