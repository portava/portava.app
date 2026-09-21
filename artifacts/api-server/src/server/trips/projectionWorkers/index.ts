/**
 * Trips spec §24 — `server/trips/projectionWorkers`: the workers that keep
 * trip-derived state true over time, started and stopped as one set.
 * census-trips TR440.
 *
 *   reminders          §11.4's reminder pushes, claimed and de-duplicated
 *   live-share-expiry  §6.1's live-share grants swept past their expires_at
 *   retention-sweep    §5.3's activity-log prune and §5.3's raw_text forget
 *
 * The map projection is NOT here: it is a consumer of the outbox
 * (../outboxWorker.ts), driven by the outbox loop, not a worker over trip
 * state. Each worker keeps its own flag, cadence and tests; this module is
 * the one place src/index.ts starts them, so a worker cannot be added to
 * the tree and forgotten at startup.
 */
import { startTripReminderScheduler } from "./tripReminderScheduler.js";
import { startTripCrewLiveShareScheduler, stopTripCrewLiveShareScheduler } from "./tripCrewLiveShareScheduler.js";
import { startTripRetentionScheduler, stopTripRetentionScheduler, _tripRetentionSchedulerArmed } from "./tripRetentionScheduler.js";

export interface TripProjectionWorker {
  id: string;
  start: () => void;
  /** null: the worker has no stop (the reminder scheduler runs for the process's life). */
  stop: (() => void) | null;
  /** null: the worker does not expose an armed probe. */
  armed: (() => boolean) | null;
}

export const TRIP_PROJECTION_WORKERS: readonly TripProjectionWorker[] = [
  { id: "reminders", start: startTripReminderScheduler, stop: null, armed: null },
  { id: "live-share-expiry", start: startTripCrewLiveShareScheduler, stop: stopTripCrewLiveShareScheduler, armed: null },
  { id: "retention-sweep", start: startTripRetentionScheduler, stop: stopTripRetentionScheduler, armed: _tripRetentionSchedulerArmed },
];

export function startTripProjectionWorkers(): void {
  for (const w of TRIP_PROJECTION_WORKERS) w.start();
}

export function stopTripProjectionWorkers(): void {
  for (const w of TRIP_PROJECTION_WORKERS) w.stop?.();
}
