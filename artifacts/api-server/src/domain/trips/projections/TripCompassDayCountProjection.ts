import type { SupabaseClient } from "@supabase/supabase-js";
import { liveEnvelope, readTripVersion, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";
import { PLAN_ITEM_PRIVACY_COLUMNS, withholdPrivatePlanItems } from "../policies/privateAnchorAccess.js";
import { isTripPlanPrivacyScope, type TripPlanPrivacyScope } from "../policies/tripPlanPrivacy.js";
import { planItemAccessFor } from "../../../server/trips/privateAnchorShares.js";

export const COMPASS_DAY_COUNT_SCAN_LIMIT = 50;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAN_STATUSES = ["draft", "proposed", "tentative", "confirmed", "in_progress", "done", "moved", "cancelled", "skipped"] as const;

export interface TripCompassDayCountProjection extends TripProjectionEnvelope {
  tripId: string;
  viewerId: string;
  dayDate: string;
  visibleCount: number;
  countBasis: "visible_rows_in_capped_read";
  readLimit: typeof COMPASS_DAY_COUNT_SCAN_LIMIT;
}

export type TripCompassDayCountResult =
  | { ok: true; projection: TripCompassDayCountProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

interface CountRow extends Record<string, unknown> {
  id: string;
  trip_id: string;
  day_date: string;
  status: (typeof PLAN_STATUSES)[number];
  removed_at: null;
  creator_id: string | null;
  location_is_private: boolean | null;
  privacy_scope: TripPlanPrivacyScope | null;
}

function isCountRow(value: unknown, tripId: string, dayDate: string): value is CountRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && CANONICAL_UUID.test(row.id)
    && row.trip_id === tripId && row.day_date === dayDate && row.removed_at === null
    && typeof row.status === "string" && (PLAN_STATUSES as readonly string[]).includes(row.status) && row.status !== "cancelled"
    && (row.creator_id === null || (typeof row.creator_id === "string" && CANONICAL_UUID.test(row.creator_id)))
    && (row.location_is_private === null || typeof row.location_is_private === "boolean")
    && (row.privacy_scope === null || isTripPlanPrivacyScope(row.privacy_scope));
}

export async function buildTripCompassDayCountProjection(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
  dayDate: string,
  opts: { now?: Date } = {},
): Promise<TripCompassDayCountResult> {
  const unavailable = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" } as const;
  if (!CANONICAL_UUID.test(tripId) || !CANONICAL_UUID.test(viewerId)
    || !/^\d{4}-\d{2}-\d{2}$/.test(dayDate) || !Number.isFinite(Date.parse(dayDate))
    || new Date(dayDate).toISOString().slice(0, 10) !== dayDate) return unavailable;
  try {
    const version = await readTripVersion(sc, tripId).catch(() => null);
    const { data, error } = await sc.from("trip_plan_items")
      .select("id, trip_id, day_date, status, removed_at, creator_id, location_is_private, privacy_scope" satisfies `${string}, ${typeof PLAN_ITEM_PRIVACY_COLUMNS}`)
      .eq("trip_id", tripId)
      .eq("day_date", dayDate)
      .neq("status", "cancelled")
      .is("removed_at", null)
      .limit(COMPASS_DAY_COUNT_SCAN_LIMIT);
    if (error || !Array.isArray(data)
      || !data.every((row: unknown): row is CountRow => isCountRow(row, tripId, dayDate))
      || data.length > COMPASS_DAY_COUNT_SCAN_LIMIT || new Set(data.map((row) => row.id)).size !== data.length) return unavailable;
    const access = await planItemAccessFor(sc, tripId, viewerId);
    if (access.status !== "ok" || access.selectionUnread !== undefined) return unavailable;
    return { ok: true, projection: {
      ...liveEnvelope(version, opts.now), tripId, viewerId, dayDate,
      visibleCount: withholdPrivatePlanItems(data, access).length,
      countBasis: "visible_rows_in_capped_read", readLimit: COMPASS_DAY_COUNT_SCAN_LIMIT,
    } };
  } catch {
    return unavailable;
  }
}
