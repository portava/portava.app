/**
 * Telegraph §13.2 — the background job that ENDS availability signals and
 * scoped location shares, and emits `availability.expired` / `location.expired`.
 *
 * `services/telegraph/lifecycleSweep.ts` holds the rules; this holds the clock.
 * They are separate files so the rules are testable without a timer, which is
 * the only way the half-open window in `sharesExpiringIn` can be pinned.
 *
 * ── THE SHAPE IS THE CREW LIVE-SHARE SCHEDULER'S, DELIBERATELY ──────────────
 * `server/trips/projectionWorkers/tripCrewLiveShareScheduler.ts` records three
 * defects it was rewritten to fix, and all three are available here:
 *
 *   1. A FAILED SWEEP THAT LOOKS IDLE. The sweep functions return `failures`
 *      rather than throwing, so a tick that could not read the table would
 *      otherwise record `expired: 0` and a fresh `lastRunAt` — an operator sees
 *      a job running on time while a privacy control has stopped. `lastRunAt`
 *      and `lastSuccessAt` are therefore two different fields, and only a tick
 *      with no failures moves the second.
 *   2. `setInterval` WITH NO OVERLAP GUARD. Self-rescheduling `setTimeout`: the
 *      next tick is armed from `.finally`, so a slow pass is never joined by
 *      the next one over the same rows.
 *   3. NO IDEMPOTENT START AND NO STOP. `_timer` guards the start and `stop`
 *      exists, which is also what makes this testable at all.
 *
 * ── THE WATERMARK, AND WHY A COLD START DOES NOT REPLAY A DAY ───────────────
 * The location half needs to know what the previous tick already covered. That
 * watermark is in process memory, so a restart loses it — and the recovery
 * rule is the interesting decision. Resuming from the epoch would replay every
 * share in the horizon on every deploy. Resuming from `now` would drop every
 * share that expired while the process was down. It resumes from
 * `now - SWEEP_INTERVAL_MS`: at most one interval is re-emitted, never more,
 * and the events carry a stable `eventKey` so a consumer can tell.
 *
 * The availability half needs no watermark at all: it DELETEs what it ends, so
 * the row itself is the watermark. See the sweep's header.
 */
import { getServiceClient } from "../../lib/supabase.js";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  sweepExpiredAvailability,
  sweepExpiredLocationShares,
} from "../../services/telegraph/lifecycleSweep.js";

const logger = rootLogger.child({ job: "telegraphLifecycleScheduler" });

export const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes
export const STARTUP_DELAY_MS = 45_000;      // after the crew sweep, on purpose: both read location rows

export interface LifecycleSweepStatus {
  /** When a sweep was last ATTEMPTED. */
  lastRunAt: string | null;
  /** When a sweep last genuinely SUCCEEDED. Diverges from lastRunAt when broken. */
  lastSuccessAt: string | null;
  lastAvailabilityExpired: number;
  lastLocationExpired: number;
  /** Why the last tick was not a success; empty on a clean tick. */
  lastFailures: string[];
  consecutiveFailures: number;
}

const _status: LifecycleSweepStatus = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastAvailabilityExpired: 0,
  lastLocationExpired: 0,
  lastFailures: [],
  consecutiveFailures: 0,
};

/** The instant the previous tick's location window ended. See the header. */
let _locationWatermark: Date | null = null;

export function getLifecycleSweepStatus(): Readonly<LifecycleSweepStatus> {
  return { ..._status, lastFailures: [..._status.lastFailures] };
}

/** Reset between test runs — not for production use. */
export function _resetLifecycleSweepStatus(): void {
  _status.lastRunAt = null;
  _status.lastSuccessAt = null;
  _status.lastAvailabilityExpired = 0;
  _status.lastLocationExpired = 0;
  _status.lastFailures = [];
  _status.consecutiveFailures = 0;
  _locationWatermark = null;
}

export interface LifecycleTickResult {
  ok: boolean;
  skipped: boolean;
  availabilityExpired: number;
  locationExpired: number;
  failures: string[];
  /** The half-open window this tick covered for location shares. */
  window: { since: string; now: string } | null;
}

export async function tickOnce(
  opts: { client?: any; now?: Date } = {},
): Promise<LifecycleTickResult> {
  // Explicit null means "no client"; undefined means "use the service client".
  // NOT `opts.client ?? getServiceClient()` — `??` does not short-circuit on an
  // explicit null, so a test passing `client: null` would get a REAL client.
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  const now = opts.now ?? new Date();
  const ranAt = now.toISOString();

  if (!db) {
    _status.lastRunAt = ranAt;
    _status.lastFailures = ["no_service_client"];
    _status.consecutiveFailures += 1;
    logger.warn("telegraphLifecycleScheduler: service client not ready — skipping sweep");
    return { ok: false, skipped: true, availabilityExpired: 0, locationExpired: 0, failures: ["no_service_client"], window: null };
  }

  const since = _locationWatermark ?? new Date(now.getTime() - SWEEP_INTERVAL_MS);
  const failures: string[] = [];
  let availabilityExpired = 0;
  let locationExpired = 0;

  try {
    const a = await sweepExpiredAvailability(db, now);
    availabilityExpired = a.expired;
    failures.push(...a.failures);
  } catch (err) {
    failures.push(`availability: ${(err as Error)?.message ?? "threw"}`);
  }

  try {
    const l = await sweepExpiredLocationShares(db, { now, since });
    locationExpired = l.expired;
    failures.push(...l.failures);
  } catch (err) {
    failures.push(`location: ${(err as Error)?.message ?? "threw"}`);
  }

  // The watermark advances ONLY on a tick that read cleanly. Advancing it after
  // a failed read would silently skip every share that expired inside the
  // window the broken tick was supposed to cover — the loss would be permanent
  // and invisible, which is worse than emitting one window twice.
  const ok = failures.length === 0;
  if (ok) _locationWatermark = now;

  _status.lastRunAt = ranAt;
  _status.lastAvailabilityExpired = availabilityExpired;
  _status.lastLocationExpired = locationExpired;
  _status.lastFailures = [...failures];
  if (ok) {
    _status.consecutiveFailures = 0;
    _status.lastSuccessAt = ranAt;
  } else {
    _status.consecutiveFailures += 1;
    logger.error(
      { failures, consecutiveFailures: _status.consecutiveFailures },
      "telegraphLifecycleScheduler: sweep did NOT fully succeed — availability or location expiry is NOT being emitted",
    );
  }

  return {
    ok,
    skipped: false,
    availabilityExpired,
    locationExpired,
    failures,
    window: { since: since.toISOString(), now: ranAt },
  };
}

let _timer: ReturnType<typeof setTimeout> | null = null;

/** Start the background lifecycle sweep. Called once at startup. Idempotent. */
export function startTelegraphLifecycleScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: SWEEP_INTERVAL_MS },
    "telegraphLifecycleScheduler: started",
  );
  _timer = setTimeout(function tick() {
    void tickOnce().finally(() => {
      _timer = setTimeout(tick, SWEEP_INTERVAL_MS);
    });
  }, STARTUP_DELAY_MS);
}

export function stopTelegraphLifecycleScheduler(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}
