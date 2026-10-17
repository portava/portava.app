import type { SupabaseClient } from "@supabase/supabase-js";
import { liveEnvelope, readTripVersion, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";
import { PLAN_ITEM_PRIVACY_COLUMNS, withholdPrivatePlanItems } from "../policies/privateAnchorAccess.js";
import { planItemAccessFor } from "../../../server/trips/privateAnchorShares.js";

export const COMPASS_DISRUPTION_PLAN_READ_LIMIT = 5;

export interface TripCompassDisruptionPlanProjection extends TripProjectionEnvelope {
  tripId: string;
  viewerId: string;
  dayDate: string;
  items: Array<{ title: string; placeId: string }>;
  itemBasis: "visible_place_rows_in_capped_read";
  readLimit: typeof COMPASS_DISRUPTION_PLAN_READ_LIMIT;
}

export type TripCompassDisruptionPlanResult =
  | { ok: true; projection: TripCompassDisruptionPlanProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

export async function buildTripCompassDisruptionPlanProjection(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
  dayDate: string,
  opts: { now?: Date } = {},
): Promise<TripCompassDisruptionPlanResult> {
  const version = await readTripVersion(sc, tripId).catch(() => null);
  const { data, error } = await sc.from("trip_plan_items")
    .select("id, title, place_id, status, creator_id, location_is_private, privacy_scope" satisfies `${string}, ${typeof PLAN_ITEM_PRIVACY_COLUMNS}`)
    .eq("trip_id", tripId)
    .eq("day_date", dayDate)
    .neq("status", "cancelled")
    .is("removed_at", null)
    .limit(COMPASS_DISRUPTION_PLAN_READ_LIMIT);
  if (error) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" };
  const visibleRows = withholdPrivatePlanItems((data ?? []) as Record<string, unknown>[], await planItemAccessFor(sc, tripId, viewerId));
  const items: TripCompassDisruptionPlanProjection["items"] = [];
  for (const row of visibleRows) {
    if (typeof row.place_id !== "string" || !row.place_id) continue;
    items.push({ title: String(row.title ?? ""), placeId: row.place_id });
  }
  return { ok: true, projection: {
    ...liveEnvelope(version, opts.now), tripId, viewerId, dayDate, items,
    itemBasis: "visible_place_rows_in_capped_read", readLimit: COMPASS_DISRUPTION_PLAN_READ_LIMIT,
  } };
}
