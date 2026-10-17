/**
 * Trips spec §19.1 — the trip's hard commitments (`trip_commitments`, 2761) as a
 * typed projection, for Compass's §12.1 `getCommitments(tripId)` tool
 * (census-compass CT-02, Trips `:25`).
 *
 * The tool used to read the table itself, with its own column list, its own
 * ordering rule and its own column-to-field mapping. That is Trips' contract to
 * state: a commitment's fields are §5.1's, and the order a traveller reads them in
 * is "when must I be there", falling back to when it starts. The tool keeps what
 * is the tool's — the operational-projections gate it consults BEFORE this read,
 * and its wire wording.
 *
 * Envelope: `trips.version` read before the rows; unattributable when unreadable.
 * A failed or malformed read is `TRIP_PROJECTION_UNAVAILABLE`; a readable empty
 * set is "no hard commitments".
 *
 * NOT PURE — it reads `trips.version` and `trip_commitments`. It writes nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { liveEnvelope, readTripVersion, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";

export interface TripCompassCommitment {
  id: string;
  stageId: string | null;
  type: string | null;
  startsAt: string | null;
  requiredArrivalAt: string | null;
  placeId: string | null;
  /** Postgres `interval`s arrive as text. */
  latenessTolerance: string | null;
  prepDuration: string | null;
  flexibility: string | null;
  confidence: number | string | null;
}

export interface TripCompassCommitmentsProjection extends TripProjectionEnvelope {
  tripId: string;
  viewerId: string;
  /** Ordered by required arrival, else start — earliest first. */
  commitments: TripCompassCommitment[];
}

export type TripCompassCommitmentsResult =
  | { ok: true; projection: TripCompassCommitmentsProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

const UNAVAILABLE = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" } as const;
const TEXT = ["stage_id", "type", "starts_at", "required_arrival_at", "place_id", "lateness_tolerance", "prep_duration", "flexibility"] as const;

function toCommitment(value: unknown): TripCompassCommitment | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  if (!TEXT.every((c) => row[c] === null || row[c] === undefined || typeof row[c] === "string")) return null;
  const confidence = row.confidence;
  if (!(confidence === null || confidence === undefined || typeof confidence === "string"
    || (typeof confidence === "number" && Number.isFinite(confidence)))) return null;
  const s = (c: (typeof TEXT)[number]) => (row[c] as string | null | undefined) ?? null;
  return {
    id: row.id, stageId: s("stage_id"), type: s("type"), startsAt: s("starts_at"),
    requiredArrivalAt: s("required_arrival_at"), placeId: s("place_id"), latenessTolerance: s("lateness_tolerance"),
    prepDuration: s("prep_duration"), flexibility: s("flexibility"), confidence: (confidence as number | string | null | undefined) ?? null,
  };
}

export async function buildTripCompassCommitmentsProjection(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
  opts: { now?: Date } = {},
): Promise<TripCompassCommitmentsResult> {
  try {
    const version = await readTripVersion(sc, tripId).catch(() => null);
    const { data, error } = await sc.from("trip_commitments")
      .select("id, stage_id, type, starts_at, required_arrival_at, place_id, lateness_tolerance, prep_duration, flexibility, confidence")
      .eq("trip_id", tripId);
    if (error || !Array.isArray(data)) return UNAVAILABLE;
    const commitments: TripCompassCommitment[] = [];
    for (const value of data as unknown[]) {
      const commitment = toCommitment(value);
      if (!commitment) return UNAVAILABLE;
      commitments.push(commitment);
    }
    commitments.sort((a, b) => String(a.requiredArrivalAt ?? a.startsAt ?? "").localeCompare(String(b.requiredArrivalAt ?? b.startsAt ?? "")));
    return { ok: true, projection: { ...liveEnvelope(version, opts.now), tripId, viewerId, commitments } };
  } catch {
    return UNAVAILABLE;
  }
}
