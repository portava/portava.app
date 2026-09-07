/**
 * Trip Map projection worker — the Map-owned consumer of public.trip_outbox
 * (Trips spec §19.4).
 *
 * WHAT THIS IS
 * ============
 * The TypeScript half of the §19.4 projection worker. The database half is
 * public.trip_map_projection_drain (migration 2520), which in ONE call reads
 * unpublished trip_outbox rows in aggregate_version order per trip, projects
 * each trip's coordinate-free TripMapProjection (§14.1/§14.4) into
 * trip_map_projections, records the event in trip_map_projection_applied, and
 * sets trip_outbox.published_at — those three writes in one plpgsql sub-block
 * so a crash between them can neither lose nor duplicate an event. This module
 * only decides WHEN to call it and reports what it did.
 *
 * INPUT CONTRACT (consumed, not authored)
 * =======================================
 * Everything read is a 2420 column: trip_outbox(id, event_id, trip_id,
 * published_at, attempts) and trip_events(event_id, trip_id,
 * aggregate_version, sequence, type). 2450 (contract v2) adds actor_role and a
 * `family` payload key; neither is read. The event vocabulary is
 * TRIP_EVENT_TYPES from lib/tripKernel.ts, imported here as published —
 * the drain accepts any 'trip.%' label and records it; the test pins the SQL
 * literals in 2420/2450 against that list so vocabulary drift is loud.
 *
 * GATING
 * ======
 * `trip_map_projection_worker_enabled`, seeded FALSE by 2520. Read here through
 * isFlagEnabled (fail-closed: absent row, unreadable table, thrown client all
 * read as false) BEFORE the RPC is issued, and re-checked inside the function
 * (p_enforce_flag). Gated off, a tick is exactly one feature_flags read.
 *
 * SCHEDULER
 * =========
 * Nothing Map-owned was registered in index.ts before this, and the two Trip
 * workers (reminder, crew live-share) are Trips-lane pollers over their own
 * tables, not outbox consumers. So this follows the house scheduler shape
 * (memoryProjectionScheduler / intelProjectionScheduler): startup delay, a
 * self-rescheduling timer, every error logged and swallowed. One line in
 * index.ts starts it.
 *
 * IN PRODUCTION THIS HAS NO INPUT. Production has no trips.version, no
 * trip_events, no trip_outbox (2334/2337/2420/2450 are unapplied), and 2520's
 * precondition block refuses to apply there until they are. Until the owner
 * applies that chain the flag stays FALSE and this is one flag read a minute.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { TRIP_EVENT_TYPES } from "./tripKernel.js";

export const TRIP_MAP_PROJECTION_FLAG = "trip_map_projection_worker_enabled";
export const TRIP_MAP_PROJECTION_DRAIN_RPC = "trip_map_projection_drain";
/** Matches trip_map_projections.projection_schema_version written by 2520. */
export const TRIP_MAP_PROJECTION_SCHEMA_VERSION = 1;
/** The vocabulary this worker consumes: exactly what Trips publishes. */
export const CONSUMED_TRIP_EVENT_TYPES: readonly string[] = TRIP_EVENT_TYPES;

export const TRIP_MAP_PROJECTION_BATCH_LIMIT = 200;
const STARTUP_DELAY_MS = 90 * 1000;   // after the server is up; the outbox is durable, nothing is lost by waiting
const INTERVAL_MS = 60 * 1000;        // projection_lag_seconds (§21) is bounded by this when the flag is on

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface TripMapProjectionPassResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  scanned: number;
  applied: number;
  replayed: number;
  deferredGap: number;
  refused: number;
  failed: number;
  lastError: string | null;
}

const EMPTY: TripMapProjectionPassResult = {
  skipped: true, reason: null,
  scanned: 0, applied: 0, replayed: 0, deferredGap: 0, refused: 0, failed: 0, lastError: null,
};

function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function runTripMapProjectionPass(
  opts: { client?: any; limit?: number } = {},
): Promise<TripMapProjectionPassResult> {
  // Explicit null means "no client"; undefined means "use the service client"
  // (the house pattern — see memoryProjectionScheduler).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { ...EMPTY, reason: "no_client" };
  if (!(await isFlagEnabled(db, TRIP_MAP_PROJECTION_FLAG))) return { ...EMPTY, reason: "disabled" };

  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? TRIP_MAP_PROJECTION_BATCH_LIMIT), 1), 1000);
  try {
    const { data, error } = await db.rpc(TRIP_MAP_PROJECTION_DRAIN_RPC, { p_limit: limit, p_enforce_flag: true });
    if (error) {
      logger.warn({ err: error }, "trip map projection: drain failed");
      return { ...EMPTY, reason: "error" };
    }
    const r = (data ?? {}) as Record<string, unknown>;
    // The function re-checks the flag; a flip between our read and its read
    // comes back as skipped and is reported as such, not as work done.
    if (r.skipped === true) return { ...EMPTY, reason: "disabled" };
    const out: TripMapProjectionPassResult = {
      skipped: false, reason: null,
      scanned: int(r.scanned), applied: int(r.applied), replayed: int(r.replayed),
      deferredGap: int(r.deferred_gap), refused: int(r.refused), failed: int(r.failed),
      lastError: typeof r.last_error === "string" ? r.last_error : null,
    };
    if (out.refused > 0 || out.failed > 0) {
      logger.warn({ ...out }, "trip map projection: pass had refused or failed events");
    } else if (out.applied > 0 || out.replayed > 0 || out.deferredGap > 0) {
      logger.info({ ...out }, "trip map projection pass complete");
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "trip map projection pass threw");
    return { ...EMPTY, reason: "error" };
  }
}

export function startTripMapProjectionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: TRIP_MAP_PROJECTION_FLAG },
    "TripMapProjectionScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runTripMapProjectionPass()
      .catch((err) => logger.warn({ err }, "trip map projection pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopTripMapProjectionScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}

/** Test hook: is a timer currently scheduled? */
export function _tripMapProjectionSchedulerArmed(): boolean {
  return _timer !== null;
}
