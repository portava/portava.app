import type { SupabaseClient } from "@supabase/supabase-js";
import { liveEnvelope, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";
import { PLAN_ITEM_PRIVACY_COLUMNS, withholdPrivatePlanItems, type PlanItemAccess } from "../policies/privateAnchorAccess.js";
import { isTripPlanPrivacyScope, type TripPlanPrivacyScope } from "../policies/tripPlanPrivacy.js";
import { planItemAccessFor } from "../../../server/trips/privateAnchorShares.js";

export const COMPASS_RANGE_PLAN_ITEM_CAP = 20;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TripCompassRangeItem {
  tripId: string;
  title: string;
  dayDate: string;
}

export interface TripCompassRangeProjection {
  viewerId: string;
  startDate: string;
  endDate: string;
  rowLimit: typeof COMPASS_RANGE_PLAN_ITEM_CAP;
  sources: Array<TripProjectionEnvelope & { tripId: string }>;
  items: TripCompassRangeItem[];
  accessStatus: "ok" | "unread";
}

export type TripCompassRangeResult =
  | { ok: true; projection: TripCompassRangeProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

interface RangeRow extends Record<string, unknown> {
  id: string;
  trip_id: string;
  title: string | null;
  day_date: string;
  creator_id: string | null;
  location_is_private: boolean | null;
  privacy_scope: TripPlanPrivacyScope | null;
  removed_at: null;
}

function isRangeRow(value: unknown, tripIds: ReadonlySet<string>, startDate: string, endDate: string): value is RangeRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && CANONICAL_UUID.test(row.id)
    && typeof row.trip_id === "string" && tripIds.has(row.trip_id)
    && (row.title === null || typeof row.title === "string")
    && typeof row.day_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.day_date)
    && Number.isFinite(Date.parse(row.day_date)) && new Date(row.day_date).toISOString().slice(0, 10) === row.day_date
    && row.day_date >= startDate && row.day_date <= endDate
    && (row.creator_id === null || (typeof row.creator_id === "string" && CANONICAL_UUID.test(row.creator_id)))
    && (row.location_is_private === null || typeof row.location_is_private === "boolean")
    && (row.privacy_scope === null || isTripPlanPrivacyScope(row.privacy_scope))
    && row.removed_at === null;
}

async function readVersions(sc: SupabaseClient, tripIds: readonly string[]): Promise<Map<string, number | null>> {
  const versions = new Map<string, number | null>();
  try {
    const { data, error } = await sc.from("trips").select("id, version").in("id", [...tripIds]);
    if (error || !Array.isArray(data)) return versions;
    for (const value of data as unknown[]) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return new Map();
      const row = value as Record<string, unknown>;
      if (typeof row.id !== "string" || !tripIds.includes(row.id) || versions.has(row.id)) return new Map();
      versions.set(row.id, typeof row.version === "number" && Number.isSafeInteger(row.version) && row.version >= 0 ? row.version : null);
    }
    return versions;
  } catch {
    return new Map();
  }
}

export async function buildTripCompassRangeProjection(
  sc: SupabaseClient,
  tripIds: readonly string[],
  viewerId: string,
  range: { startDate: string; endDate: string },
  opts: { now?: Date } = {},
): Promise<TripCompassRangeResult> {
  const unavailable = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" } as const;
  const selectedIds = new Set(tripIds);
  if (!CANONICAL_UUID.test(viewerId) || tripIds.length === 0 || selectedIds.size !== tripIds.length
    || !tripIds.every((tripId) => CANONICAL_UUID.test(tripId))) return unavailable;
  try {
    const versions = await readVersions(sc, tripIds);
    const { data, error } = await sc.from("trip_plan_items")
      .select("id, trip_id, title, day_date, removed_at, creator_id, location_is_private, privacy_scope" satisfies `${string}, ${typeof PLAN_ITEM_PRIVACY_COLUMNS}`)
      .in("trip_id", [...tripIds])
      .gte("day_date", range.startDate)
      .lte("day_date", range.endDate)
      .is("removed_at", null)
      .limit(COMPASS_RANGE_PLAN_ITEM_CAP);
    if (error || !Array.isArray(data)
      || !data.every((row: unknown): row is RangeRow => isRangeRow(row, selectedIds, range.startDate, range.endDate))
      || data.length > COMPASS_RANGE_PLAN_ITEM_CAP || new Set(data.map((row) => row.id)).size !== data.length) return unavailable;
    const accessByTrip = new Map<string, PlanItemAccess>();
    for (const tripId of tripIds) accessByTrip.set(tripId, await planItemAccessFor(sc, tripId, viewerId));
    const items: TripCompassRangeItem[] = [];
    for (const row of data) {
      const access = accessByTrip.get(row.trip_id);
      if (!access) return unavailable;
      const visible = withholdPrivatePlanItems([row], access)[0];
      if (visible) items.push({ tripId: visible.trip_id, title: visible.title ?? "", dayDate: visible.day_date });
    }
    const now = opts.now ?? new Date();
    return { ok: true, projection: {
      viewerId, ...range, rowLimit: COMPASS_RANGE_PLAN_ITEM_CAP,
      sources: tripIds.map((tripId) => ({ tripId, ...liveEnvelope(versions.get(tripId) ?? null, now) })),
      items,
      accessStatus: [...accessByTrip.values()].some((access) => access.status === "unread" || access.selectionUnread !== undefined) ? "unread" : "ok",
    } };
  } catch {
    return unavailable;
  }
}
