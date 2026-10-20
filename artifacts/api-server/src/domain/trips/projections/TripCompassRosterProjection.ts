import type { SupabaseClient } from "@supabase/supabase-js";
import { liveEnvelope, readTripVersion, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";

const ROSTER_ROLES = ["owner", "co_host", "member", "viewer"] as const;
const ROSTER_STATUSES = ["invited", "accepted", "declined", "removed", "left"] as const;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TripCompassRosterProjection extends TripProjectionEnvelope {
  tripId: string;
  viewerId: string;
  memberIds: string[];
}

export type TripCompassRosterResult =
  | { ok: true; projection: TripCompassRosterProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

function isRosterRow(value: unknown): value is { user_id: string; role: string; status: string | null } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.user_id === "string" && CANONICAL_UUID.test(row.user_id)
    && typeof row.role === "string" && (ROSTER_ROLES as readonly string[]).includes(row.role)
    && (row.status === null || (typeof row.status === "string" && (ROSTER_STATUSES as readonly string[]).includes(row.status)));
}

export async function buildTripCompassRosterProjection(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
  opts: { now?: Date } = {},
): Promise<TripCompassRosterResult> {
  const unavailable = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" } as const;
  if (!CANONICAL_UUID.test(tripId) || !CANONICAL_UUID.test(viewerId)) return unavailable;
  try {
    const version = await readTripVersion(sc, tripId).catch(() => null);
    const { data, error } = await sc.from("trip_members")
      .select("user_id, role, status")
      .eq("trip_id", tripId)
      .in("role", [...ROSTER_ROLES]);
    if (error || !Array.isArray(data) || !data.every(isRosterRow)) return unavailable;
    const memberIds = new Set([viewerId]);
    for (const row of data) {
      if (row.status === null || row.status === "accepted") memberIds.add(row.user_id);
    }
    return { ok: true, projection: {
      ...liveEnvelope(version, opts.now), tripId, viewerId, memberIds: [...memberIds],
    } };
  } catch {
    return unavailable;
  }
}
