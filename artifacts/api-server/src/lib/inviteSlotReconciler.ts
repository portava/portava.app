/**
 * InviteSlotReconciler
 *
 * Background job that periodically calls the `reconcile_invite_link_slots`
 * PostgreSQL function to fix stranded invite-link slots.
 *
 * Why this exists
 * ───────────────
 * The invite-link accept flow calls `claim_invite_link_slot_for_user`, which
 * atomically increments `use_count` in `trip_invite_links` and writes a row to
 * `trip_invite_link_attempts`.  A subsequent `trip_members` INSERT is then
 * issued.  If the process is killed between the claim and the INSERT — or if
 * the INSERT fails for any reason — the slot stays stranded:
 *   • use_count is higher than the real member count
 *   • a trip_invite_link_attempts row exists for (link_id, user_id)
 *   • no trip_members row exists for (trip_id, user_id)
 *
 * The DB function `reconcile_invite_link_slots` finds and repairs such rows.
 * This scheduler calls it on a configurable interval so stranded slots are
 * resolved automatically without operator intervention.
 *
 * Configuration (env vars)
 * ────────────────────────
 *   INVITE_SLOT_RECONCILE_INTERVAL_HOURS  — hours between reconciliation runs
 *                                           (default: 1; set to 0 to disable)
 *   INVITE_SLOT_RECONCILE_MIN_AGE_MINUTES — minimum slot age before a stranded
 *                                           slot is fixed (default: 5); must be
 *                                           > 0 to avoid touching in-flight requests
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ service: "InviteSlotReconciler" });

// ── Configuration ─────────────────────────────────────────────────────────────

function parseEnvNonNegativeFloat(raw: string | undefined, defaultVal: number): number {
  if (raw === undefined) return defaultVal;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultVal;
}

function parseEnvPositiveInt(raw: string | undefined, defaultVal: number): number {
  if (raw === undefined) return defaultVal;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal;
}

export const RECONCILE_INTERVAL_HOURS = parseEnvNonNegativeFloat(
  process.env["INVITE_SLOT_RECONCILE_INTERVAL_HOURS"],
  1,
);

const MIN_AGE_MINUTES = parseEnvPositiveInt(
  process.env["INVITE_SLOT_RECONCILE_MIN_AGE_MINUTES"],
  5,
);

export const RECONCILE_INTERVAL_MS = RECONCILE_INTERVAL_HOURS * 60 * 60 * 1_000;

export const STARTUP_DELAY_MS = 60 * 1_000;

// ── Status tracking ───────────────────────────────────────────────────────────

interface ReconcileStatus {
  lastRunAt: string | null;
  lastFixedCount: number | null;
  consecutiveFailures: number;
}

const _status: ReconcileStatus = {
  lastRunAt: null,
  lastFixedCount: null,
  consecutiveFailures: 0,
};

export function getReconcileStatus(): Readonly<ReconcileStatus> {
  return { ..._status };
}

// ── Reconciliation logic ──────────────────────────────────────────────────────

/**
 * Call `reconcile_invite_link_slots` via the Supabase service client and log
 * the results.  Accepts an optional `client` override so unit tests can inject
 * a fake client.
 *
 * Returns `{ fixed, error }` — never throws.
 */
export async function reconcileInviteSlots(opts?: {
  client?: any | null;
  minAgeMinutes?: number;
}): Promise<{ fixed: number; error: unknown }> {
  const db =
    opts !== undefined && "client" in opts && opts.client !== undefined
      ? opts.client
      : isServiceClientReady
        ? getServiceClient()
        : null;

  if (!db) {
    logger.warn("InviteSlotReconciler: service client not ready — skipping reconciliation");
    return { fixed: 0, error: null };
  }

  const minAge = opts?.minAgeMinutes ?? MIN_AGE_MINUTES;

  try {
    const { data, error } = await db.rpc("reconcile_invite_link_slots", {
      min_age_minutes: minAge,
    });

    if (error) {
      _status.consecutiveFailures += 1;
      logger.error(
        { err: error, consecutiveFailures: _status.consecutiveFailures },
        "InviteSlotReconciler: RPC call failed",
      );
      return { fixed: 0, error };
    }

    const rows = (data ?? []) as Array<{
      link_id: string;
      user_id: string;
      claimed_at: string;
      trip_id: string;
    }>;

    _status.lastRunAt = new Date().toISOString();
    _status.lastFixedCount = rows.length;
    _status.consecutiveFailures = 0;

    if (rows.length > 0) {
      logger.info(
        { fixedCount: rows.length, minAgeMinutes: minAge },
        "InviteSlotReconciler: fixed stranded invite-link slots",
      );
      for (const row of rows) {
        logger.debug(
          { link_id: row.link_id, user_id: row.user_id, trip_id: row.trip_id, claimed_at: row.claimed_at },
          "InviteSlotReconciler: fixed slot",
        );
      }
    } else {
      logger.debug(
        { minAgeMinutes: minAge },
        "InviteSlotReconciler: no stranded slots found",
      );
    }

    return { fixed: rows.length, error: null };
  } catch (err) {
    _status.consecutiveFailures += 1;
    logger.error(
      { err, consecutiveFailures: _status.consecutiveFailures },
      "InviteSlotReconciler: unhandled error during reconciliation",
    );
    return { fixed: 0, error: err };
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;

export function startInviteSlotReconciler(): void {
  if (RECONCILE_INTERVAL_HOURS === 0) {
    logger.info(
      "InviteSlotReconciler: disabled (INVITE_SLOT_RECONCILE_INTERVAL_HOURS=0)",
    );
    return;
  }

  if (_timer !== null) return; // already running

  logger.info(
    { reconcileIntervalHours: RECONCILE_INTERVAL_HOURS, minAgeMinutes: MIN_AGE_MINUTES },
    "InviteSlotReconciler: starting",
  );

  const initialTimer = setTimeout(() => {
    reconcileInviteSlots().catch(() => {});
  }, STARTUP_DELAY_MS);

  if (typeof initialTimer.unref === "function") initialTimer.unref();

  _timer = setInterval(() => {
    reconcileInviteSlots().catch(() => {});
  }, RECONCILE_INTERVAL_MS);

  if (typeof _timer.unref === "function") _timer.unref();
}

export function stopInviteSlotReconciler(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
    logger.info("InviteSlotReconciler: stopped");
  }
}
