/**
 * Trips spec §22.2 / §21.1 — deterministic replay, verified, and the metric
 * that counts a mismatch: `trip_event_replay_mismatch_total` ("Determinism
 * regression", census-trips TR400).
 *
 * The verification itself is SQL: public.trip_snapshot_verify_replay
 * (2773) replays the trip's events from the seed and from a stored snapshot,
 * and returns whether the two folds agree, with the differing keys. This
 * file is the one TypeScript caller, so that
 *
 *   1. a mismatch is COUNTED — the metric is recorded here, per trip, and
 *      readable with readTripMetric (§21.1); the SQL cannot do that;
 *   2. the result is typed and the reasons are the kernel's own
 *      (TRIP_SNAPSHOT_NO_EVENTS / TRIP_SNAPSHOT_NOT_FOUND), not re-invented.
 *
 * Reached from POST /trips/:tripId/replay/verify (routes/tripProjections.ts),
 * crew-gated, under trip_operational_projections_enabled (the snapshot
 * tables are part of the batch that flag requires).
 */
import { incrementTripMetric } from "./tripMetrics.js";

export interface ReplayVerification {
  ok: boolean;
  tripId: string;
  headVersion: number | null;
  snapshotVersion: number | null;
  /** True when the full replay and the snapshot-plus-tail replay agree. */
  equal: boolean | null;
  differingKeys: string[];
  /** Why it could not be verified, when it could not. */
  reason: "TRIP_SNAPSHOT_NO_EVENTS" | "TRIP_SNAPSHOT_NOT_FOUND" | "TRIP_REPLAY_UNAVAILABLE" | null;
  detail: string | null;
}

export async function verifyTripReplay(sc: any, tripId: string, atVersion: number): Promise<ReplayVerification> {
  const { data, error } = await sc.rpc("trip_snapshot_verify_replay", { p_trip_id: tripId, p_at_version: atVersion });
  if (error) {
    return { ok: false, tripId, headVersion: null, snapshotVersion: atVersion, equal: null, differingKeys: [], reason: "TRIP_REPLAY_UNAVAILABLE", detail: String(error.message ?? error) };
  }
  const r = (data ?? {}) as Record<string, unknown>;
  if (r.ok !== true && typeof r.reason === "string") {
    const reason = r.reason === "TRIP_SNAPSHOT_NO_EVENTS" || r.reason === "TRIP_SNAPSHOT_NOT_FOUND" ? r.reason : "TRIP_REPLAY_UNAVAILABLE";
    return { ok: false, tripId, headVersion: null, snapshotVersion: atVersion, equal: null, differingKeys: [], reason, detail: String(r.reason) };
  }
  const equal = r.equal === true;
  const differingKeys = Array.isArray(r.differing_keys) ? r.differing_keys.map(String) : [];
  if (!equal) incrementTripMetric("trip_event_replay_mismatch_total", { trip: tripId });
  return {
    ok: equal, tripId,
    headVersion: typeof r.head_version === "number" ? r.head_version : null,
    snapshotVersion: typeof r.snapshot_version === "number" ? r.snapshot_version : atVersion,
    equal, differingKeys, reason: null,
    detail: equal ? null : `replay from the seed and replay from snapshot ${atVersion} disagree on ${differingKeys.join(", ") || "unlisted keys"}`,
  };
}
