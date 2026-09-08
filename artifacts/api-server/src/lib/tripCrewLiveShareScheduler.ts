/**
 * Trip Crew Live-Share Expiry Scheduler
 *
 * Sweeps `trip_crew_location_sessions` rows where status='active' and
 * expires_at < now(), marks them 'expired', and writes audit events to
 * trip_crew_location_events.
 *
 * ── WHY THIS WAS REWRITTEN ───────────────────────────────────────────────────
 * Three defects, all of the same family: the job could not tell a healthy idle
 * tick from a broken one, and said "I ran" either way.
 *
 * 1. A FAILED SWEEP LOOKED EXACTLY LIKE AN IDLE ONE, AND STILL WROTE HEALTH.
 *    `sweepExpiredLiveShares` checks its `.error` and returns 0 — it does NOT
 *    throw. So the catch block below never fired for the most likely failure
 *    (a renamed column, an RLS or grant change, an unreachable database); the
 *    try path ran, `expired === 0` so nothing was logged, and the `job_health`
 *    upsert recorded `last_run_at = now`. An operator watching job_health saw a
 *    job running on time while live location shares stayed ACTIVE past their
 *    expiry indefinitely — a privacy control that had silently stopped.
 *
 *    The sweep is not this lane's file to change, so the outcome is made
 *    measurable from outside it: one bounded PROBE for a single already-expired
 *    active row, with its `.error` checked, before the sweep runs.
 *
 *      probe errors              → the table is unreadable. The sweep is NOT
 *                                  attempted and the tick is a FAILURE.
 *      probe finds no such row   → there was genuinely nothing to expire;
 *                                  `expired: 0` is a real answer.
 *      probe sees a row, sweep
 *        returns 0               → the update did not do what the backlog says
 *                                  it should have; a FAILURE, not an idle tick.
 *
 * 2. `setInterval` WITH NO OVERLAP GUARD. Every other scheduler in this tree
 *    reschedules itself from `.finally` precisely so a slow pass cannot be
 *    overlapped by the next one. This one fired every 5 minutes regardless, so
 *    a sweep that outlived its interval was joined by a second concurrent pass
 *    over the same rows. Now a self-rescheduling `setTimeout`, like its
 *    siblings: the next tick is scheduled only once the current one has ended.
 *
 * 3. NO IDEMPOTENT START AND NO STOP. `startTripCrewLiveShareScheduler()` had
 *    no `_timer` guard, so calling it twice installed two independent timers,
 *    and there was no way to stop it — which is also why it had no test.
 *
 * ── DOUBLE-RUN SAFETY ACROSS INSTANCES ───────────────────────────────────────
 * Safe, and by an actual mechanism rather than by luck: the sweep is a
 * CONDITIONAL WRITE — `UPDATE … SET status='expired' WHERE status='active' AND
 * expires_at < now()` — so of two instances sweeping the same row exactly one
 * update matches it, and `.select()` returns the row only to the winner. The
 * audit event is written per returned row, so it is written once. No claim
 * table and no lock is needed here.
 *
 * Failures are logged and swallowed — a best-effort background job must never
 * crash the server — but they are now COUNTED, and `getLiveShareSweepStatus()`
 * carries the count out.
 */
import { getServiceClient } from "./supabase.js";
import { sweepExpiredLiveShares } from "../services/tripCrew/TripCrewLiveShareService.js";
import { logger as rootLogger } from "./logger.js";

const JOB_KEY = "crew_live_share_cleanup";

const logger = rootLogger.child({ job: "tripCrewLiveShareScheduler" });

export const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes
export const STARTUP_DELAY_MS = 30_000;      // let the server warm up first

// ── Status ────────────────────────────────────────────────────────────────────

export interface LiveShareSweepStatus {
  /** When a sweep was last ATTEMPTED. */
  lastRunAt: string | null;
  /** When a sweep last genuinely SUCCEEDED. Diverges from lastRunAt when broken. */
  lastSuccessAt: string | null;
  lastExpired: number;
  /** Why the last tick was not a success; empty on a clean tick. */
  lastFailures: string[];
  consecutiveFailures: number;
}

const _status: LiveShareSweepStatus = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastExpired: 0,
  lastFailures: [],
  consecutiveFailures: 0,
};

export function getLiveShareSweepStatus(): Readonly<LiveShareSweepStatus> {
  return { ..._status, lastFailures: [..._status.lastFailures] };
}

/** Reset status between test runs — not for production use. */
export function _resetLiveShareStatus(): void {
  _status.lastRunAt = null;
  _status.lastSuccessAt = null;
  _status.lastExpired = 0;
  _status.lastFailures = [];
  _status.consecutiveFailures = 0;
}

// ── Probe ─────────────────────────────────────────────────────────────────────

/**
 * Is there at least one active session already past its expiry, and can we even
 * see the table?
 *
 * `.error` is checked because supabase-js RESOLVES on a database error with
 * `data: null` — an unchecked read here would answer "no backlog" for an
 * unreadable table, which is the precise mistake this whole file is correcting.
 */
async function probeExpiredBacklog(
  db: any,
  nowIso: string,
): Promise<{ readable: boolean; backlog: boolean }> {
  try {
    const { data, error } = await db
      .from("trip_crew_location_sessions")
      .select("id")
      .eq("status", "active")
      .lt("expires_at", nowIso)
      .limit(1);
    if (error) {
      logger.error(
        { err: error },
        "tripCrewLiveShareScheduler: expiry probe FAILED — the sessions table could not be read; NOT reporting 'nothing to expire'",
      );
      return { readable: false, backlog: false };
    }
    return { readable: true, backlog: Array.isArray(data) && data.length > 0 };
  } catch (err) {
    logger.error({ err }, "tripCrewLiveShareScheduler: expiry probe threw — could not look");
    return { readable: false, backlog: false };
  }
}

// ── One sweep ─────────────────────────────────────────────────────────────────

export interface LiveShareSweepResult {
  ok: boolean;
  skipped: boolean;
  skipReason: "no_service_client" | null;
  expired: number;
  probeReadable: boolean;
  backlogSeen: boolean;
  failures: string[];
}

export async function runLiveShareSweep(
  opts: { client?: any; now?: Date } = {},
): Promise<LiveShareSweepResult> {
  // Explicit null means "no client"; undefined means "use the service client".
  // NOT `opts.client ?? getServiceClient()` — `??` does not short-circuit on an
  // explicit null, so a test passing `client: null` would get a REAL client and
  // open a socket.
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) {
    logger.warn("tripCrewLiveShareScheduler: service client not ready — skipping sweep");
    return {
      ok: false, skipped: true, skipReason: "no_service_client",
      expired: 0, probeReadable: false, backlogSeen: false,
      failures: ["no_service_client"],
    };
  }

  const now = opts.now ?? new Date();
  const ranAt = now.toISOString();
  const failures: string[] = [];

  const probe = await probeExpiredBacklog(db, ranAt);
  let expired = 0;

  if (!probe.readable) {
    failures.push("sessions_unreadable");
  } else {
    try {
      expired = await sweepExpiredLiveShares(db);
      if (expired > 0) {
        logger.info({ expired }, "tripCrewLiveShareScheduler: swept expired live shares");
      }
      if (probe.backlog && expired === 0) {
        // sweepExpiredLiveShares returns 0 for a failed update as well as for an
        // empty one. The probe is the only thing that can tell those apart.
        failures.push("sweep_zero_despite_backlog");
        logger.error(
          {},
          "tripCrewLiveShareScheduler: probe saw an expired active session but the sweep expired 0 — treating as a FAILED sweep, not an idle one",
        );
      }
    } catch (err) {
      failures.push("sweep_threw");
      logger.error({ err }, "tripCrewLiveShareScheduler: sweep failed");
    }
  }

  // Record the ATTEMPT either way so a stalled job is still detectable, exactly
  // as before. What is new is that the tick's own outcome is no longer thrown
  // away when it fails without throwing.
  const { error: healthError } = await db.from("job_health").upsert(
    { job: JOB_KEY, last_run_at: ranAt },
    { onConflict: "job" },
  );
  if (healthError) {
    logger.warn({ err: healthError }, "tripCrewLiveShareScheduler: could not persist job health");
  }

  return {
    ok: failures.length === 0,
    skipped: false,
    skipReason: null,
    expired,
    probeReadable: probe.readable,
    backlogSeen: probe.backlog,
    failures,
  };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setTimeout> | null = null;

export async function tickOnce(opts: { client?: any; now?: Date } = {}): Promise<LiveShareSweepResult> {
  let r: LiveShareSweepResult;
  try {
    r = await runLiveShareSweep(opts);
  } catch (err) {
    _status.lastRunAt = new Date().toISOString();
    _status.consecutiveFailures += 1;
    _status.lastFailures = ["threw"];
    logger.error(
      { err, consecutiveFailures: _status.consecutiveFailures },
      "tripCrewLiveShareScheduler: tick threw",
    );
    return {
      ok: false, skipped: false, skipReason: null, expired: 0,
      probeReadable: false, backlogSeen: false, failures: ["threw"],
    };
  }

  _status.lastRunAt = new Date().toISOString();
  _status.lastFailures = [...r.failures];
  _status.lastExpired = r.expired;

  // Resets ONLY on a tick that genuinely succeeded — not on one that merely
  // did not throw. A sweep that could not read the table is not an idle sweep.
  if (r.ok) {
    _status.consecutiveFailures = 0;
    _status.lastSuccessAt = _status.lastRunAt;
  } else {
    _status.consecutiveFailures += 1;
    logger.error(
      { failures: r.failures, consecutiveFailures: _status.consecutiveFailures },
      "tripCrewLiveShareScheduler: sweep did NOT fully succeed",
    );
  }
  return r;
}

/**
 * Start the background live-share expiry sweep.
 * Called once at server startup (after `app.listen`). Idempotent.
 */
export function startTripCrewLiveShareScheduler(): void {
  if (_timer !== null) return; // already started

  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: SWEEP_INTERVAL_MS },
    "tripCrewLiveShareScheduler: started",
  );

  // Self-rescheduling: the next tick is armed only once this one has ended, so
  // a slow sweep is never overlapped by the next.
  _timer = setTimeout(function tick() {
    void tickOnce().finally(() => {
      _timer = setTimeout(tick, SWEEP_INTERVAL_MS);
    });
  }, STARTUP_DELAY_MS);
}

export function stopTripCrewLiveShareScheduler(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}
