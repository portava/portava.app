/**
 * Trips spec §5.3 / §21.3 — the retention sweep that makes two documented
 * policies TRUE rather than declared (census-trips TR100, TR387, TR403).
 *
 *   trip_activity_log_prune()               2789: evidence past retain_until
 *   trip_reservations_forget_raw_text()     2791: pasted booking text past
 *                                           raw_text_retain_until
 *
 * Both are SQL functions service_role alone may call, and nothing in the
 * database schedules them; this file does. The same fail-closed contract as
 * intelRetentionScheduler: a DELETE / a forget is irreversible, so the sweep
 * runs only while `trip_retention_sweep_enabled` (2792) reads TRUE — no row,
 * an unreadable row, or FALSE all mean nothing happens — and DISABLED,
 * NO_CLIENT and ERROR are reported apart, because a sweep that is failing and
 * a sweep nobody switched on look identical from the tables and must not
 * look identical from the logs.
 *
 * Each function is called on its own; a failure of one does not stop the
 * other, and the result names which failed. The counts are what the
 * functions report (`pruned`, `forgotten`), coerced from whatever PostgREST
 * returns — a bigint can arrive as a string.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";

export const TRIP_RETENTION_FLAG = "trip_retention_sweep_enabled";
export const TRIP_ACTIVITY_LOG_PRUNE_RPC = "trip_activity_log_prune";
export const TRIP_RESERVATION_FORGET_RPC = "trip_reservations_forget_raw_text";

const STARTUP_DELAY_MS = 9 * 60 * 1000;
/** Retention is measured in days; six hours is more than enough and keeps
 *  the flag read, the only cost while off, to four a day. */
export const INTERVAL_MS = 6 * 60 * 60 * 1000;

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface TripRetentionSweepResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  /** Rows trip_activity_log_prune() deleted; null when that call failed. */
  activityLogPruned: number | null;
  /** Reservations whose raw_text trip_reservations_forget_raw_text() nulled; null when that call failed. */
  reservationsForgotten: number | null;
  /** The rpc names that failed, so an operator knows which policy is unenforced. */
  failed: string[];
}

function count(data: unknown, key: string): number {
  const r = (data ?? {}) as Record<string, unknown>;
  const n = Number(r[key]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function runTripRetentionSweep(opts: { client?: any } = {}): Promise<TripRetentionSweepResult> {
  // Explicit null means "no client"; undefined means "use the service client"
  // (the house pattern — see intelRetentionScheduler for why `??` is wrong here).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  const empty = { activityLogPruned: null, reservationsForgotten: null, failed: [] as string[] };
  if (!db) return { ...empty, skipped: true, reason: "no_client" };
  if (!(await isFlagEnabled(db, TRIP_RETENTION_FLAG))) return { ...empty, skipped: true, reason: "disabled" };

  const failed: string[] = [];
  let activityLogPruned: number | null = null;
  let reservationsForgotten: number | null = null;
  try {
    const { data, error } = await db.rpc(TRIP_ACTIVITY_LOG_PRUNE_RPC);
    if (error) { failed.push(TRIP_ACTIVITY_LOG_PRUNE_RPC); logger.warn({ err: error }, "trip retention: activity log prune failed"); }
    else activityLogPruned = count(data, "pruned");
  } catch (err) { failed.push(TRIP_ACTIVITY_LOG_PRUNE_RPC); logger.warn({ err }, "trip retention: activity log prune threw"); }
  try {
    const { data, error } = await db.rpc(TRIP_RESERVATION_FORGET_RPC);
    if (error) { failed.push(TRIP_RESERVATION_FORGET_RPC); logger.warn({ err: error }, "trip retention: reservation raw_text forget failed"); }
    else reservationsForgotten = count(data, "forgotten");
  } catch (err) { failed.push(TRIP_RESERVATION_FORGET_RPC); logger.warn({ err }, "trip retention: reservation raw_text forget threw"); }

  if ((activityLogPruned ?? 0) > 0 || (reservationsForgotten ?? 0) > 0) {
    logger.info({ activityLogPruned, reservationsForgotten }, "trip retention sweep enforced a policy");
  }
  return { skipped: false, reason: failed.length > 0 ? "error" : null, activityLogPruned, reservationsForgotten, failed };
}

export function startTripRetentionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: TRIP_RETENTION_FLAG },
    "TripRetentionScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runTripRetentionSweep()
      .catch((err) => logger.warn({ err }, "trip retention sweep failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopTripRetentionScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}

/** Test hook: is a timer currently scheduled? */
export function _tripRetentionSchedulerArmed(): boolean {
  return _timer !== null;
}
