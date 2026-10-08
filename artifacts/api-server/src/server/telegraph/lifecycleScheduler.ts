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
 * ── THE WATERMARK, AND WHY IT IS NOT IN PROCESS MEMORY ──────────────────────
 * The location half needs to know what the previous tick already covered. That
 * watermark used to live in a module-level `let`, and that was the defect this
 * file now fixes: `.replit` sets `deploymentTarget = "autoscale"`, which
 * suspends the container after fifteen idle minutes, and a suspended event loop
 * does not tick. On a restart the in-memory watermark re-seeded to
 * `now - SWEEP_INTERVAL_MS`, so every `location.expired` for a share that
 * expired during the gap was not late — it was never emitted at all, and
 * nothing recorded that it had been skipped. `lib/schedulerCoverage.ts` names
 * the incident: all 58 schedulers stopped together on 2026-09-30 and stayed
 * stopped for fifty-four hours.
 *
 * So the watermark is now a ROW (`lib/schedulerWatermark.ts`, job key
 * `telegraph_location_expiry`), and process memory is kept only as a
 * same-process fast path: it saves a read on each of the ~288 ticks a day that
 * are not the first one after a boot, and it is always at least as advanced as
 * the row, because memory only moves on a tick that also tried to commit.
 *
 * Three properties of that arrangement are load-bearing:
 *
 *   1. A WATERMARK READ THAT FAILED IS NOT A WATERMARK THAT IS ABSENT.
 *      `readWatermark` distinguishes `{at: null, ok: true}` ("no row yet") from
 *      `{ok: false}` ("could not tell"). On `ok: false` this tick falls back to
 *      the one-interval lookback AND REFUSES TO COMMIT. Committing on a read it
 *      could not perform would move the row forward over a window chosen from a
 *      guess, permanently losing everything between the stored instant and that
 *      guess. CONTRIBUTING.md:33-66 — a check that cannot establish its result
 *      must fail rather than assume.
 *   2. THE COMMIT HAPPENS AFTER THE WORK, NEVER BEFORE. Same reason the old
 *      in-memory assignment was guarded by `failures.length === 0`.
 *   3. A FAILED COMMIT IS REPORTED, NOT FOLDED INTO `failures`. The emits did
 *      happen, so the window's work succeeded; the cost of a lost commit is one
 *      re-emitted window after the next restart, which `eventKey` makes
 *      idempotent (§13.3). Calling the tick failed would instead hold the
 *      watermark back and re-emit that window every five minutes for as long as
 *      the write stayed broken. It surfaces as `watermark.committed: false` and
 *      an error log so it cannot be invisible.
 *
 * The availability half needs no watermark at all: it DELETEs what it ends, so
 * the row itself is the watermark. See the sweep's header.
 */
import { getServiceClient } from "../../lib/supabase.js";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  commitWatermark,
  readWatermark,
  scanWindow,
} from "../../lib/schedulerWatermark.js";
import {
  LOCATION_SWEEP_HORIZON_HOURS,
  sweepExpiredAvailability,
  sweepExpiredLocationShares,
} from "../../services/telegraph/lifecycleSweep.js";
import { MAX_LOCATION_SHARE_HOURS } from "../../services/telegraph/messageKinds.js";

const logger = rootLogger.child({ job: "telegraphLifecycleScheduler" });

export const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes
export const STARTUP_DELAY_MS = 45_000;      // after the crew sweep, on purpose: both read location rows

/** The durable watermark's job key. One key, one lane: the location half. */
export const LOCATION_WATERMARK_JOB = "telegraph_location_expiry";

/**
 * How far back the first tick after a restart will reach — and the number is
 * DERIVED, because the only honest value is the one the candidate read can
 * actually serve.
 *
 * `sweepExpiredLocationShares` bounds its scan with
 * `.gte("created_at", now - LOCATION_SWEEP_HORIZON_HOURS)` (8h), and a share's
 * row is dated when the share STARTED, not when it ends. A share expiring at
 * `T` was created somewhere in `[T - MAX_LOCATION_SHARE_HOURS, T)` (4h), so it
 * is inside that scan only while `T - 4h >= now - 8h`, i.e. while
 * `T >= now - 4h`. A catch-up window deeper than `8h - 4h` therefore widens the
 * WINDOW without widening what the READ returns: it would emit for the
 * short-lived shares that happen to still be in the horizon and silently drop
 * the long-lived ones, which is a worse failure than a stated bound because it
 * looks like coverage.
 *
 * The alternative was to widen the horizon to match a bigger catch-up. Rejected,
 * twice over: the horizon is what keeps this query a bitmap index scan over the
 * hottest table in the product every five minutes (see the sweep's header), and
 * `LOCATION_SWEEP_SCAN_LIMIT` takes 500 rows ordered `created_at DESC` — so a
 * wider horizon drops the OLDEST rows first, which are exactly the catch-up
 * rows. A wider horizon would thus buy coverage that the limit then takes away,
 * again silently.
 *
 * So: cap the catch-up at what the read can see, and keep the two consistent by
 * construction rather than by comment. A gap longer than this (the fifty-four
 * hour one, for instance) is recovered for its last four hours and reported as
 * capped for the rest; `window.capped` and `lastWindowCapped` exist so that
 * "we did not cover it" is a fact an operator can read rather than a silence.
 */
export const MAX_LOCATION_CATCHUP_MS =
  (LOCATION_SWEEP_HORIZON_HOURS - MAX_LOCATION_SHARE_HOURS) * 3600_000;

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
  /**
   * The last tick's location window hit `MAX_LOCATION_CATCHUP_MS`, so shares
   * that expired before it were NOT emitted and will not be. True is the
   * expected shape of the first tick after a long suspend; true on a steady
   * five-minute cadence means ticks are not happening.
   */
  lastWindowCapped: boolean;
  /**
   * The last clean tick's watermark reached the database. False means the next
   * restart will re-cover a window this process already emitted — tolerable
   * (§13.3, `eventKey`), but not something to discover from a graph.
   */
  lastWatermarkDurable: boolean;
}

const _status: LifecycleSweepStatus = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastAvailabilityExpired: 0,
  lastLocationExpired: 0,
  lastFailures: [],
  consecutiveFailures: 0,
  lastWindowCapped: false,
  lastWatermarkDurable: false,
};

/**
 * The instant the previous tick's location window ended, for THIS process only.
 * A cache of the durable row, never the source of truth: it is populated from
 * the row on the first tick after a boot and thereafter only by a tick that
 * committed-or-tried-to-commit, which is what keeps it >= the row. See the
 * header.
 */
let _locationWatermark: Date | null = null;

/**
 * The watermark's two operations, behind a seam — for the same reason
 * `tickOnce` takes a `client`.
 *
 * The two behaviours that matter here are a READ THAT REFUSES and a COMMIT THAT
 * REFUSES, and neither can be provoked through a Supabase double without this
 * file's tests reaching into another module's table and column names. A test
 * that cannot provoke the failure proves only that the guard is written, not
 * that it works, and CONTRIBUTING.md:33-66 is explicit that a guard needs a
 * negative case that goes red when the defect is reintroduced. The default is
 * the real durable pair, so production has no seam in it.
 */
export interface WatermarkStore {
  read(sc: any, job: string): Promise<{ at: Date | null; ok: boolean }>;
  commit(sc: any, job: string, through: Date): Promise<boolean>;
}
const DURABLE_STORE: WatermarkStore = { read: readWatermark, commit: commitWatermark };
let _store: WatermarkStore = DURABLE_STORE;

/** Swap the watermark store in tests. `null` restores the durable one. */
export function _setWatermarkStoreForTests(store: WatermarkStore | null): void {
  _store = store ?? DURABLE_STORE;
}

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
  _status.lastWindowCapped = false;
  _status.lastWatermarkDurable = false;
  _locationWatermark = null;
}

/** Where a tick's `since` came from, and whether its `through` was stored. */
export interface WatermarkOutcome {
  /**
   * `memory`     — this process's own previous tick (the fast path).
   * `stored`     — the durable row, read on the first tick after a boot.
   * `none`       — no row yet; first run ever, one-interval lookback.
   * `unreadable` — the READ FAILED. One-interval lookback, and NO commit.
   */
  source: "memory" | "stored" | "none" | "unreadable";
  committed: boolean;
}

export interface LifecycleTickResult {
  ok: boolean;
  skipped: boolean;
  availabilityExpired: number;
  locationExpired: number;
  failures: string[];
  /**
   * The half-open window this tick covered for location shares. `capped` means
   * it was trimmed to `MAX_LOCATION_CATCHUP_MS` and the earlier part of the gap
   * is not covered by this tick or any later one.
   */
  window: { since: string; now: string; capped: boolean } | null;
  watermark: WatermarkOutcome;
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
    return {
      ok: false, skipped: true, availabilityExpired: 0, locationExpired: 0,
      failures: ["no_service_client"], window: null,
      watermark: { source: "none", committed: false },
    };
  }

  // THE DURABLE ROW IS THE SOURCE; MEMORY IS A CACHE OF IT.
  //
  // `ok: false` from the read is handled as a REFUSAL, not an absence: it takes
  // the same one-interval lookback a true first run takes, and it sets
  // `readRefused`, which is the only thing that stops the commit below. The
  // alternative — treating an unreadable row as "no watermark" — is how a single
  // transient PostgREST error permanently erases every expiry between the stored
  // instant and `now - 5min`, and it would do it while reporting a clean tick.
  //
  // Memory is deliberately NOT refreshed on a refused read. Adopting the
  // guessed window as this process's watermark would make the loss permanent on
  // the next tick too, and would never read the row again; leaving it null costs
  // one re-overlapped window and lets the next tick recover the real value.
  let source: WatermarkOutcome["source"] = "memory";
  let watermarkAt = _locationWatermark;
  let readRefused = false;
  if (watermarkAt === null) {
    const stored = await _store.read(db, LOCATION_WATERMARK_JOB);
    if (!stored.ok) {
      readRefused = true;
      source = "unreadable";
      logger.error(
        { job: LOCATION_WATERMARK_JOB },
        "telegraphLifecycleScheduler: could NOT read the location watermark — using the one-interval lookback and refusing to commit, so the stored position is not reset by a transient read error",
      );
    } else {
      watermarkAt = stored.at;
      source = stored.at === null ? "none" : "stored";
    }
  }

  const win = scanWindow({
    watermark: readRefused ? null : watermarkAt,
    now,
    // Unchanged first-run behaviour: with nothing stored, one interval back.
    defaultLookbackMs: SWEEP_INTERVAL_MS,
    maxCatchupMs: MAX_LOCATION_CATCHUP_MS,
  });
  const since = win.since;
  if (win.capped) {
    logger.warn(
      { since: since.toISOString(), maxCatchupMs: MAX_LOCATION_CATCHUP_MS, source },
      "telegraphLifecycleScheduler: location catch-up window CAPPED — shares that expired before it are not emitted by this tick or any later one",
    );
  }
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
  //
  // A tick whose watermark READ was refused does not commit either, for the
  // reason above: it would store a position derived from a guess.
  const ok = failures.length === 0;
  let committed = false;
  if (ok && !readRefused) {
    _locationWatermark = win.through;
    try {
      committed = await _store.commit(db, LOCATION_WATERMARK_JOB, win.through);
    } catch (err) {
      committed = false;
      logger.error(
        { err: (err as Error)?.message ?? "threw", job: LOCATION_WATERMARK_JOB },
        "telegraphLifecycleScheduler: location watermark commit THREW",
      );
    }
    if (!committed) {
      // Not a `failures` entry — see the header, property 3. The window's work
      // is done; what is at risk is only the next restart re-covering it.
      logger.error(
        { job: LOCATION_WATERMARK_JOB, through: win.through.toISOString() },
        "telegraphLifecycleScheduler: location watermark did NOT persist — a restart will re-emit this window, and a longer outage will not be recovered past the catch-up cap",
      );
    }
  }

  _status.lastWindowCapped = win.capped;
  _status.lastWatermarkDurable = committed;
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
    window: { since: since.toISOString(), now: ranAt, capped: win.capped },
    watermark: { source, committed },
  };
}

let _timer: ReturnType<typeof setTimeout> | null = null; let _generation = 0; // which loop is current: a pass re-arms only if no stop() came after its own start(), so a stop()/start() mid-pass cannot leave two loops (schedulerRestartDuringPass.test.ts)

/** Start the background lifecycle sweep. Called once at startup. Idempotent. */
export function startTelegraphLifecycleScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: SWEEP_INTERVAL_MS },
    "telegraphLifecycleScheduler: started",
  );
  const generation = ++_generation; _timer = setTimeout(function tick() {
    void tickOnce().finally(() => {
      if (generation === _generation) _timer = setTimeout(tick, SWEEP_INTERVAL_MS);
    });
  }, STARTUP_DELAY_MS);
}

export function stopTelegraphLifecycleScheduler(): void {
  _generation += 1; if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}
