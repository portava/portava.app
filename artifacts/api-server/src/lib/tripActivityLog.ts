/**
 * trip_activity_log — the audit row a flag-off (legacy) trip write leaves, and
 * the keyed replay it allows. census-trips TR47: "state transitions must be
 * commands with authorization, validation, audit and idempotency". The kernel
 * path has receipts (trip_command_receipts) and events for the last two; the
 * legacy twin has this file. Metadata carries ids, keys and status names only:
 * 2789's CHECK refuses coordinate keys, and nothing here writes any.
 */
import { logger } from "./logger.js";

export interface TripActivityRow {
  id: string;
  event_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
}

/** Writes one audit row; a failed insert is logged and reported false, never thrown — the write it records has already happened. */
export async function logTripActivity(
  client: any,
  tripId: string,
  actorId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const { error } = await client
    .from("trip_activity_log")
    .insert({ trip_id: tripId, actor_id: actorId, event_type: eventType, metadata })
    .then((r: any) => r, (err: any) => ({ error: err }));
  if (error) {
    logger.warn({ err: error, tripId, actorId, eventType }, "trip_activity_log insert failed — audit row lost");
    return false;
  }
  return true;
}

/**
 * The most recent audit row of this type for the trip whose metadata carries
 * the idempotency key; null when none, or when the log could not be read — a
 * replay is never guessed, the write simply happens again.
 */
export async function findTripActivityByKey(
  client: any,
  tripId: string,
  eventType: string,
  idempotencyKey: string,
): Promise<TripActivityRow | null> {
  const { data, error } = await client
    .from("trip_activity_log")
    .select("id, event_type, metadata, created_at")
    .eq("trip_id", tripId)
    .eq("event_type", eventType)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    logger.warn({ err: error, tripId, eventType }, "trip_activity_log read failed — no replay");
    return null;
  }
  for (const row of (data ?? []) as TripActivityRow[]) {
    const key = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>)["idempotency_key"] : null;
    if (key === idempotencyKey) return row;
  }
  return null;
}
