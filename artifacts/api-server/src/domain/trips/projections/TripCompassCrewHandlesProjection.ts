import type { SupabaseClient } from "@supabase/supabase-js";
import { liveEnvelope, readTripVersion, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";

export const COMPASS_CREW_HANDLES_READ_LIMIT = 8;

export interface TripCompassCrewHandlesProjection extends TripProjectionEnvelope {
  tripId: string;
  viewerId: string;
  handles: string[];
  handleBasis: "nonempty_profile_handles_in_capped_accepted_rows";
  readLimit: typeof COMPASS_CREW_HANDLES_READ_LIMIT;
}

export type TripCompassCrewHandlesResult =
  | { ok: true; projection: TripCompassCrewHandlesProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

export async function buildTripCompassCrewHandlesProjection(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
  opts: { now?: Date } = {},
): Promise<TripCompassCrewHandlesResult> {
  const version = await readTripVersion(sc, tripId).catch(() => null);
  const { data, error } = await sc.from("trip_members")
    .select("profiles(handle), role, status")
    .eq("trip_id", tripId)
    .eq("status", "accepted")
    .limit(COMPASS_CREW_HANDLES_READ_LIMIT);
  if (error) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" };
  const handles = ((data ?? []) as Array<{ profiles?: { handle?: unknown } | null }>)
    .map((row) => row.profiles?.handle)
    .filter((handle): handle is string => typeof handle === "string" && handle.length > 0);
  return { ok: true, projection: {
    ...liveEnvelope(version, opts.now), tripId, viewerId, handles,
    handleBasis: "nonempty_profile_handles_in_capped_accepted_rows", readLimit: COMPASS_CREW_HANDLES_READ_LIMIT,
  } };
}
