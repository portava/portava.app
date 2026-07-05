/**
 * InviteSlotSweeper
 *
 * Background job that periodically calls `reconcile_invite_link_slots` to age
 * out stranded `trip_invite_link_attempts` rows — rows written when a server
 * crashed after claiming a slot but before the `trip_members` INSERT committed.
 *
 * Why this exists
 * ───────────────
 * `claim_invite_link_slot_for_user` (migration 0110) atomically increments
 * `use_count` and inserts a `trip_invite_link_attempts` row in one transaction.
 * If the process is killed between that RPC and the subsequent `trip_members`
 * INSERT, the attempt row is left behind with no matching member row.  Without
 * periodic cleanup, old dangling attempt rows allow retries to skip the slot
 * guard even if the invite link has since been revoked.
 *
 * `reconcile_invite_link_slots(min_age_minutes)` (migration 0111) finds exactly
 * these orphaned rows and for each one: decrements `use_count` and deletes the
 * attempt row, restoring the slot so future users can claim it.  It uses
 * `FOR UPDATE SKIP LOCKED`, so concurrent sweeper runs never double-fix.
 *
 * Configuration (env vars)
 * ───────────────────────
 *   INVITE_SLOT_SWEEP_TTL_HOURS      — attempts older than this (no member row)
 *                                      are cleaned up.  Default: 24.
 *   INVITE_SLOT_SWEEP_INTERVAL_HOURS — how often the sweeper runs.  Default: 1.
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ service: "InviteSlotSweeper" });

// ── Configuration ──────────────────────────────────────────────────────────────

/** Requires a positive finite number; falls back to defaultVal otherwise. */
function parseEnvFloat(raw: string | undefined, defaultVal: number): number {
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal;
}

/**
 * Allows 0 (disable signal) as well as positive finite values.
 * Falls back to defaultVal only when the env var is absent or unparseable.
 */
function parseEnvNonNegativeFloat(raw: string | undefined, defaultVal: number): number {
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultVal;
}

const SWEEP_TTL_HOURS      = parseEnvFloat(process.env["INVITE_SLOT_SWEEP_TTL_HOURS"], 24);
const SWEEP_INTERVAL_HOURS = parseEnvNonNegativeFloat(process.env["INVITE_SLOT_SWEEP_INTERVAL_HOURS"], 1);

/** TTL in minutes forwarded to the Postgres function (default 1440 = 24 h). */
export const SWEEP_TTL_MINUTES = Math.round(SWEEP_TTL_HOURS * 60);

/** Exported so unit tests can advance fake timers by the right amount. */
export const SWEEP_INTERVAL_MS = SWEEP_INTERVAL_HOURS * 60 * 60 * 1_000;

/** Exported so unit tests can advance the startup delay. */
export const STARTUP_DELAY_MS = 60 * 1_000;

// ── Status tracking ────────────────────────────────────────────────────────────

interface SweeperStatus {
  lastRunAt: string | null;
  lastFixedCount: number | null;
  consecutiveFailures: number;
}

const _status: SweeperStatus = {
  lastRunAt: null,
  lastFixedCount: null,
  consecutiveFailures: 0,
};

export function getSweeperStatus(): Readonly<SweeperStatus> {
  return { ..._status };
}

// ── Sweep logic ────────────────────────────────────────────────────────────────

export interface SweepResult {
  fixed: number;
  slots: Array<{ linkId: string; userId: string; tripId: string; claimedAt: string }>;
  error: unknown;
}

/**
 * Call `reconcile_invite_link_slots` for all attempts older than
 * `ttlMinutes` that have no corresponding `trip_members` row.
 *
 * Accepts an optional `client` override so unit tests can inject a fake
 * Supabase client without a live connection.
 *
 * Never throws — errors are logged and returned.
 */
export async function sweepStrandedSlots(opts?: {
  client?: any | null;
  ttlMinutes?: number;
}): Promise<SweepResult> {
  const db =
    opts !== undefined && "client" in opts && opts.client !== undefined
      ? opts.client
      : isServiceClientReady
        ? getServiceClient()
        : null;

  if (!db) {
    logger.warn("InviteSlotSweeper: service client not ready — skipping sweep");
    return { fixed: 0, slots: [], error: null };
  }

  const ttlMinutes = opts?.ttlMinutes ?? SWEEP_TTL_MINUTES;

  try {
    const { data, error } = await db.rpc("reconcile_invite_link_slots", {
      min_age_minutes: ttlMinutes,
    });

    if (error) {
      _status.consecutiveFailures += 1;
      logger.error(
        { err: error, consecutiveFailures: _status.consecutiveFailures },
        "InviteSlotSweeper: reconcile_invite_link_slots RPC failed",
      );
      return { fixed: 0, slots: [], error };
    }

    const rows = (data ?? []) as Array<{
      link_id: string;
      user_id: string;
      trip_id: string;
      claimed_at: string;
    }>;

    const slots = rows.map((r) => ({
      linkId:    r.link_id,
      userId:    r.user_id,
      tripId:    r.trip_id,
      claimedAt: r.claimed_at,
    }));

    _status.lastRunAt       = new Date().toISOString();
    _status.lastFixedCount  = slots.length;
    _status.consecutiveFailures = 0;

    if (slots.length > 0) {
      logger.info(
        { fixed: slots.length, ttlMinutes },
        "InviteSlotSweeper: stranded slots recovered",
      );
    } else {
      logger.debug({ ttlMinutes }, "InviteSlotSweeper: no stranded slots found");
    }

    return { fixed: slots.length, slots, error: null };
  } catch (err) {
    _status.consecutiveFailures += 1;
    logger.error(
      { err, consecutiveFailures: _status.consecutiveFailures },
      "InviteSlotSweeper: unhandled error during sweep",
    );
    return { fixed: 0, slots: [], error: err };
  }
}

// ── Scheduler ──────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;

export function startInviteSlotSweeper(): void {
  if (_timer !== null) return;

  if (SWEEP_INTERVAL_HOURS === 0) {
    logger.info("InviteSlotSweeper: disabled (INVITE_SLOT_SWEEP_INTERVAL_HOURS=0)");
    return;
  }

  logger.info(
    { ttlHours: SWEEP_TTL_HOURS, intervalHours: SWEEP_INTERVAL_HOURS },
    "InviteSlotSweeper: starting",
  );

  const initialTimer = setTimeout(() => {
    sweepStrandedSlots().catch(() => {});
  }, STARTUP_DELAY_MS);

  if (typeof initialTimer.unref === "function") initialTimer.unref();

  _timer = setInterval(() => {
    sweepStrandedSlots().catch(() => {});
  }, SWEEP_INTERVAL_MS);

  if (typeof _timer.unref === "function") _timer.unref();
}

export function stopInviteSlotSweeper(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
    logger.info("InviteSlotSweeper: stopped");
  }
}
