/**
 * Trips spec §24 — `server/trips/outboxWorker`: the loop that drains
 * public.trip_outbox. census-trips TR440.
 *
 * UNTIL §61 THE LOOP AND THE PASS WERE ONE FILE
 * =============================================
 * lib/mapTripProjectionWorker.ts (Map-owned) held both the timer that decides
 * WHEN the outbox is read and the pass that decides WHAT the map projection
 * makes of an event. §59 named that as the gap: an outbox worker distinct from
 * the projection workers. This file is the worker: it owns the timer and the
 * consumer registry; the Map file keeps its pass and re-exports the old
 * scheduler names so nothing that read them moved.
 *
 * THE CEILING, STATED
 * ===================
 * One consumer. Its cursor is trip_outbox.published_at, set inside the drain
 * RPC (2520) by the same plpgsql block that applies the projection — so a
 * second consumer cannot be added here without per-consumer offsets, which is
 * a migration this tree does not have. The registry is a function, not a
 * constant, because it reads the Map file's flag and that file imports this
 * one: a constant would be evaluated inside the import cycle.
 */
import { logger } from "../../lib/logger.js";
import {
  runTripMapProjectionPass, TRIP_MAP_PROJECTION_FLAG, type TripMapProjectionPassResult,
} from "../../lib/mapTripProjectionWorker.js";

export interface TripOutboxConsumer {
  id: string;
  /** The feature flag the consumer's pass checks before reading anything. */
  flag: string;
  pass: () => Promise<TripMapProjectionPassResult>;
}

/** The consumers this loop drives, in order. Exactly one today; see the header. */
export function tripOutboxConsumers(): readonly TripOutboxConsumer[] {
  return [{ id: "map-projection", flag: TRIP_MAP_PROJECTION_FLAG, pass: () => runTripMapProjectionPass() }];
}

export const TRIP_OUTBOX_STARTUP_DELAY_MS = 90 * 1000;   // after the server is up; the outbox is durable, nothing is lost by waiting
export const TRIP_OUTBOX_INTERVAL_MS = 60 * 1000;        // projection_lag_seconds (§21) is bounded by this when a consumer's flag is on

let _timer: ReturnType<typeof setTimeout> | null = null;

/** One pass over every consumer. A consumer that throws is recorded, never lets the next one be skipped. */
export async function runTripOutboxPass(): Promise<Record<string, TripMapProjectionPassResult>> {
  const out: Record<string, TripMapProjectionPassResult> = {};
  for (const c of tripOutboxConsumers()) {
    try {
      out[c.id] = await c.pass();
    } catch (err) {
      logger.warn({ err, consumer: c.id }, "trip outbox: consumer pass threw");
      out[c.id] = { skipped: true, reason: "error", scanned: 0, applied: 0, replayed: 0, deferredGap: 0, refused: 0, failed: 0, lastError: err instanceof Error ? err.message : String(err) };
    }
  }
  return out;
}

export function startTripOutboxWorker(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: TRIP_OUTBOX_STARTUP_DELAY_MS, intervalMs: TRIP_OUTBOX_INTERVAL_MS, consumers: tripOutboxConsumers().map((c) => ({ id: c.id, flag: c.flag })) },
    "TripOutboxWorker scheduled (each consumer is a no-op until its flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runTripOutboxPass()
      .catch((err) => logger.warn({ err }, "trip outbox pass failed"))
      .finally(() => { _timer = setTimeout(tick, TRIP_OUTBOX_INTERVAL_MS); });
  }, TRIP_OUTBOX_STARTUP_DELAY_MS);
}

export function stopTripOutboxWorker(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}

/** Test hook: is a timer currently scheduled? */
export function _tripOutboxWorkerArmed(): boolean {
  return _timer !== null;
}
