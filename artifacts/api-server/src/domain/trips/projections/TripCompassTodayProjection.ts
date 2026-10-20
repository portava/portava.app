import type { SupabaseClient } from "@supabase/supabase-js";
import { liveEnvelope, readTripVersion, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";
import { PLAN_ITEM_PRIVACY_COLUMNS, withholdPrivatePlanItems } from "../policies/privateAnchorAccess.js";
import { isTripPlanPrivacyScope, type TripPlanPrivacyScope } from "../policies/tripPlanPrivacy.js";
import { planItemAccessFor } from "../../../server/trips/privateAnchorShares.js";

export const COMPASS_TODAY_READ_LIMIT = 5;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAN_STATUSES = ["draft", "proposed", "tentative", "confirmed", "in_progress", "done", "moved", "skipped"] as const;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/;

export interface CompassTodayPlanItem {
  id: string;
  title: string;
  startsAt: string | null;
  sortOrder: number;
}

export interface TripCompassTodayProjection extends TripProjectionEnvelope {
  tripId: string;
  viewerId: string;
  dayDate: string;
  items: CompassTodayPlanItem[];
  itemBasis: "visible_rows_in_capped_read";
  readLimit: typeof COMPASS_TODAY_READ_LIMIT;
}

export type TripCompassTodayResult =
  | { ok: true; projection: TripCompassTodayProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

interface TodayRow extends Record<string, unknown> {
  id: string;
  trip_id: string;
  day_date: string;
  title: string;
  starts_at: string | null;
  sort_order: number;
  status: (typeof PLAN_STATUSES)[number];
  removed_at: null;
  creator_id: string | null;
  location_is_private: boolean | null;
  privacy_scope: TripPlanPrivacyScope | null;
}

function isDayDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function isTodayRow(value: unknown, tripId: string, dayDate: string): value is TodayRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && CANONICAL_UUID.test(row.id)
    && row.trip_id === tripId && row.day_date === dayDate && row.removed_at === null
    && typeof row.title === "string"
    && (row.starts_at === null || (typeof row.starts_at === "string" && TIMESTAMP.test(row.starts_at)
      && isDayDate(row.starts_at.slice(0, 10)) && Number.isFinite(Date.parse(row.starts_at))))
    && typeof row.sort_order === "number" && Number.isInteger(row.sort_order)
    && row.sort_order >= -2147483648 && row.sort_order <= 2147483647
    && typeof row.status === "string" && (PLAN_STATUSES as readonly string[]).includes(row.status)
    && (row.creator_id === null || (typeof row.creator_id === "string" && CANONICAL_UUID.test(row.creator_id)))
    && (row.location_is_private === null || typeof row.location_is_private === "boolean")
    && (row.privacy_scope === null || isTripPlanPrivacyScope(row.privacy_scope));
}

export async function buildTripCompassTodayProjection(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
  dayDate: string,
  opts: { now?: Date } = {},
): Promise<TripCompassTodayResult> {
  const unavailable = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" } as const;
  if (!CANONICAL_UUID.test(tripId) || !CANONICAL_UUID.test(viewerId) || !isDayDate(dayDate)) return unavailable;
  try {
    const version = await readTripVersion(sc, tripId).catch(() => null);
    const { data, error } = await sc.from("trip_plan_items")
      .select("id, trip_id, day_date, title, starts_at, sort_order, status, removed_at, creator_id, location_is_private, privacy_scope" satisfies `${string}, ${typeof PLAN_ITEM_PRIVACY_COLUMNS}`)
      .eq("trip_id", tripId)
      .eq("day_date", dayDate)
      .neq("status", "cancelled")
      .is("removed_at", null)
      .order("starts_at", { ascending: true })
      .order("sort_order", { ascending: true })
      .limit(COMPASS_TODAY_READ_LIMIT);
    if (error || !Array.isArray(data)
      || !data.every((row: unknown): row is TodayRow => isTodayRow(row, tripId, dayDate))
      || data.length > COMPASS_TODAY_READ_LIMIT || new Set(data.map((row) => row.id)).size !== data.length) return unavailable;
    const access = await planItemAccessFor(sc, tripId, viewerId);
    if (access.status !== "ok" || access.selectionUnread !== undefined) return unavailable;
    return { ok: true, projection: {
      ...liveEnvelope(version, opts.now), tripId, viewerId, dayDate,
      items: withholdPrivatePlanItems(data, access).map((row) => ({
        id: row.id, title: row.title, startsAt: row.starts_at, sortOrder: row.sort_order,
      })),
      itemBasis: "visible_rows_in_capped_read", readLimit: COMPASS_TODAY_READ_LIMIT,
    } };
  } catch {
    return unavailable;
  }
}
