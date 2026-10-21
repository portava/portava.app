/**
 * Trips spec §19.1 — the uncapped plan projections Compass consumes instead of
 * reading `trip_plan_items` itself (census-compass CT-02, Trips `:25`).
 *
 * WHY NOT THE TODAY PROJECTION
 * ============================
 * Census-compass §55 recorded why the three remaining Compass plan readers could
 * not simply be swapped onto `TripCompassTodayProjection`: it is capped at five
 * rows and refuses outright when plan access is unread, so the Autopilot's
 * detectors, Live's rolling context and Sense's free-gap nudge would each have
 * been answering a narrower question than the one they ask. These two builders
 * answer THEIR questions, uncapped, in Trips:
 *
 *   buildTripCompassPlanProjection     the whole live plan (not removed, not
 *                                      cancelled) — the Autopilot's universe
 *   buildTripCompassDayPlanProjection  one day's live plan — Live's and Sense's
 *
 * Both apply OD-TRIP-3 / §96 (domain/trips/policies/privateAnchorAccess.ts)
 * through the ONE grant-aware loader (`planItemAccessFor`), so no Compass caller
 * holds a plan row its viewer may not see: another member's private item keeps
 * its slot (id, time, lock type) and loses its name and place; a plan its scope
 * hides from the viewer is not returned at all. When the access read is
 * `unread` every other member's private item is withheld, as before, and the
 * projection SAYS so (`accessStatus`) rather than refusing — the consumers'
 * existing behaviour.
 *
 * The cancelled/removed rule is the one both consumers already applied: the
 * whole-plan read filters it in the query; the day read keeps Live's and Sense's
 * client-side filter (`status !== "cancelled" && removed_at == null`) so the same
 * rows reach them.
 *
 * Envelope: `trips.version` read BEFORE the rows (routes/tripMapProjection.ts's
 * order and reason), unattributable when unreadable. A failed or malformed read
 * is `TRIP_PROJECTION_UNAVAILABLE`; a readable empty day is an empty day.
 *
 * NOT PURE — it reads `trips.version`, `trip_plan_items`, and the access
 * loader's tables. It writes nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { liveEnvelope, readTripVersion, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";
import { PLAN_ITEM_PRIVACY_COLUMNS, withholdPrivatePlanItems } from "../policies/privateAnchorAccess.js";
import { planItemAccessFor } from "../../../server/trips/privateAnchorShares.js";

/** A plan row as the Autopilot reads it. Snake-case column names: these are the table's own. */
export interface TripCompassPlanRow extends Record<string, unknown> {
  id: string;
  title: string | null;
  category: string | null;
  status: string | null;
  lock_type: string | null;
  day_date: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location_name: string | null;
  lat: number | null;
  lng: number | null;
  source_type: string | null;
  source_id: string | null;
  sort_order: number | null;
  creator_id: string | null;
  location_is_private: boolean | null;
  privacy_scope: string | null;
}

/** One day's live plan item, as Live and Sense read it. */
export interface TripCompassDayPlanItem {
  id: string;
  /** null = untitled; a withheld item carries Trips' withheld title. */
  title: string | null;
  startsAt: string | null;
  status: string | null;
}

export interface TripCompassPlanProjection extends TripProjectionEnvelope {
  tripId: string;
  viewerId: string;
  /** The live plan the viewer may see, private items redacted to their slot. */
  rows: TripCompassPlanRow[];
  accessStatus: "ok" | "unread";
}

export interface TripCompassDayPlanProjection extends TripProjectionEnvelope {
  tripId: string;
  viewerId: string;
  dayDate: string;
  items: TripCompassDayPlanItem[];
  accessStatus: "ok" | "unread";
}

export type TripCompassPlanResult =
  | { ok: true; projection: TripCompassPlanProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

export type TripCompassDayPlanResult =
  | { ok: true; projection: TripCompassDayPlanProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

const UNAVAILABLE = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" } as const;

const TEXT_COLUMNS = ["title", "category", "status", "lock_type", "day_date", "starts_at", "ends_at", "location_name", "source_type", "source_id", "creator_id", "privacy_scope", "removed_at"] as const;
const NUMBER_COLUMNS = ["lat", "lng", "sort_order"] as const;

/** A plan row: an object with a non-empty string id, every other read column absent/null or its schema type. */
function isPlanRow(value: unknown): value is Record<string, unknown> & { id: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && row.id.length > 0
    && TEXT_COLUMNS.every((c) => row[c] === null || row[c] === undefined || typeof row[c] === "string")
    && NUMBER_COLUMNS.every((c) => row[c] === null || row[c] === undefined || (typeof row[c] === "number" && Number.isFinite(row[c])))
    && (row.location_is_private === null || row.location_is_private === undefined || typeof row.location_is_private === "boolean");
}

function text(row: Record<string, unknown>, column: string): string | null {
  return typeof row[column] === "string" ? (row[column] as string) : null;
}
function num(row: Record<string, unknown>, column: string): number | null {
  return typeof row[column] === "number" ? (row[column] as number) : null;
}

function toPlanRow(row: Record<string, unknown> & { id: string }): TripCompassPlanRow {
  return {
    id: row.id,
    title: text(row, "title"),
    category: text(row, "category"),
    status: text(row, "status"),
    lock_type: text(row, "lock_type"),
    day_date: text(row, "day_date"),
    starts_at: text(row, "starts_at"),
    ends_at: text(row, "ends_at"),
    location_name: text(row, "location_name"),
    lat: num(row, "lat"),
    lng: num(row, "lng"),
    source_type: text(row, "source_type"),
    source_id: text(row, "source_id"),
    sort_order: num(row, "sort_order"),
    creator_id: text(row, "creator_id"),
    location_is_private: typeof row.location_is_private === "boolean" ? row.location_is_private : null,
    privacy_scope: text(row, "privacy_scope"),
  };
}

/** Withheld per OD-TRIP-3 / §96. The access read is skipped for an empty plan: withholding nothing is nothing. */
async function visibleTo<T extends Record<string, unknown> & { id: string }>(
  sc: SupabaseClient, tripId: string, viewerId: string, rows: T[],
): Promise<{ rows: T[]; accessStatus: "ok" | "unread" }> {
  if (rows.length === 0) return { rows, accessStatus: "ok" };
  const access = await planItemAccessFor(sc, tripId, viewerId);
  return {
    rows: withholdPrivatePlanItems(rows, access),
    accessStatus: access.status === "unread" || access.selectionUnread !== undefined ? "unread" : "ok",
  };
}

/** The trip's whole live plan, as `viewerId` may see it. */
export async function buildTripCompassPlanProjection(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
  opts: { now?: Date } = {},
): Promise<TripCompassPlanResult> {
  try {
    const version = await readTripVersion(sc, tripId).catch(() => null);
    const { data, error } = await sc.from("trip_plan_items")
      .select("id, title, category, status, lock_type, day_date, starts_at, ends_at, location_name, lat, lng, source_type, source_id, sort_order, creator_id, location_is_private, privacy_scope" satisfies `${string}, ${typeof PLAN_ITEM_PRIVACY_COLUMNS}`)
      .eq("trip_id", tripId)
      .is("removed_at", null)
      .neq("status", "cancelled");
    if (error || !Array.isArray(data) || !data.every(isPlanRow)) return UNAVAILABLE;
    const visible = await visibleTo(sc, tripId, viewerId, data.map(toPlanRow));
    return { ok: true, projection: {
      ...liveEnvelope(version, opts.now), tripId, viewerId, rows: visible.rows, accessStatus: visible.accessStatus,
    } };
  } catch {
    return UNAVAILABLE;
  }
}

/** One day's live plan (`day_date = dayDate`, not cancelled, not removed), as `viewerId` may see it. */
export async function buildTripCompassDayPlanProjection(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
  dayDate: string,
  opts: { now?: Date } = {},
): Promise<TripCompassDayPlanResult> {
  try {
    const version = await readTripVersion(sc, tripId).catch(() => null);
    const { data, error } = await sc.from("trip_plan_items")
      .select("id, title, starts_at, status, day_date, removed_at, creator_id, location_is_private, privacy_scope" satisfies `${string}, ${typeof PLAN_ITEM_PRIVACY_COLUMNS}`)
      .eq("trip_id", tripId)
      .eq("day_date", dayDate);
    if (error || !Array.isArray(data) || !data.every(isPlanRow)) return UNAVAILABLE;
    const visible = await visibleTo(sc, tripId, viewerId, data);
    return { ok: true, projection: {
      ...liveEnvelope(version, opts.now), tripId, viewerId, dayDate,
      items: visible.rows
        .filter((row) => row.status !== "cancelled" && row.removed_at == null)
        .map((row) => ({ id: row.id, title: text(row, "title"), startsAt: text(row, "starts_at"), status: text(row, "status") })),
      accessStatus: visible.accessStatus,
    } };
  } catch {
    return UNAVAILABLE;
  }
}
