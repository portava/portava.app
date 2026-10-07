/**
 * planItemAccess — OD-TRIP-3 for the plan items Compass, the Map and the Wall
 * read: "Private anchors: owner-only by default. The owner can share an
 * individual anchor with selected trip members; trip membership or organizer
 * status alone does not grant access." (docs/ops/owner-decisions-20261004.md)
 *
 * ── A LOCAL SEAM, BOUND TO LANE C'S HELPER WHEN IT LANDS ─────────────────────
 * Lane C owns the rule and its loader for Trips (branch
 * claude/mission-c-discovery-telegraph-trips-20261005:
 * domain/trips/policies/privateAnchorAccess.ts and
 * server/trips/privateAnchorShares.ts). Neither is on `main`, and their files
 * are C's, so lane L's readers apply the SAME CONTRACT through this seam, with
 * the same names and the same pure rule, written out here verbatim:
 *   - the creator sees their own item;
 *   - anyone else sees nothing of a private item (no coordinates, address,
 *     place/source id, location name, title, notes) unless a grant exists while
 *     sharing is on;
 *   - a row that does not say it is public (`location_is_private` null, absent
 *     or unreadable) is PRIVATE, and one without `creator_id` is nobody's.
 * When C lands: replace this module's bodies with re-exports of C's
 * `planItemAccessFor` / `withholdPrivatePlanItems` / `canSeePlanItemLocation`
 * / `redactWithheldPlanItem` and delete the copy. The callers do not change.
 *
 * ONE DIFFERENCE, AND WHY IT IS SAFE: `planItemAccessFor` here grants nothing.
 * The grants table (`trip_private_anchor_shares`, C's migration 3970) does not
 * exist on this tree, so "no grant can exist" is exact — every other member's
 * private item is withheld, which is the owner-only default itself.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** The two columns every reader must select for the rule to decide. */
export const PLAN_ITEM_PRIVACY_COLUMNS = "creator_id, location_is_private";

/** What a withheld item is called. Neutral: it says a slot is taken, not where or what. */
export const WITHHELD_PLAN_TITLE = "Private plan";

/** The fields that locate or name a plan item. Each is nulled when withheld. */
export const WITHHELD_LOCATION_FIELDS = [
  "lat", "lng", "location_name", "address", "place_id", "google_place_id", "source_id",
  "route_stop_id", "notes", "description", "structured_location",
] as const;

export interface PlanItemAccess {
  viewerId: string;
  status: "ok" | "unread";
  reason?: string;
  /** Granted item id → the owner who granted it. Empty on this tree (see header). */
  grants: ReadonlyMap<string, string>;
}

export function ownerOnlyAccess(viewerId: string, status: "ok" | "unread" = "ok", reason?: string): PlanItemAccess {
  return { viewerId, status, ...(reason ? { reason } : {}), grants: new Map() };
}

/** What `viewerId` may see of other members' private plan items on this trip. */
export async function planItemAccessFor(_sc: SupabaseClient, _tripId: string, viewerId: string): Promise<PlanItemAccess> {
  return ownerOnlyAccess(viewerId);
}

type PlanRowLike = Record<string, unknown> & { id?: unknown; creator_id?: unknown; location_is_private?: unknown; removed_at?: unknown };

/** May this viewer see this plan item's location and name? */
export function canSeePlanItemLocation(access: PlanItemAccess, row: PlanRowLike): boolean {
  if (row.location_is_private === false) return true;
  const owner = typeof row.creator_id === "string" ? row.creator_id : null;
  if (owner !== null && owner === access.viewerId) return true;
  if (row.removed_at !== undefined && row.removed_at !== null) return false;
  const grantOwner = typeof row.id === "string" ? access.grants.get(row.id) : undefined;
  return owner !== null && grantOwner === owner;
}

/** The row as a viewer who may not see it receives it: the slot, not the place. */
export function redactWithheldPlanItem<T extends PlanRowLike>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const k of WITHHELD_LOCATION_FIELDS) if (k in out) out[k] = null;
  if ("title" in out) out.title = WITHHELD_PLAN_TITLE;
  out.location_withheld = true;
  return out as T;
}

/** Apply the rule to a list of plan rows read for this viewer. */
export function withholdPrivatePlanItems<T extends PlanRowLike>(rows: readonly T[], access: PlanItemAccess): T[] {
  return rows.map((r) => (canSeePlanItemLocation(access, r) ? r : redactWithheldPlanItem(r)));
}

/**
 * For a reader whose rows came from a shared projection that does not carry the
 * two privacy columns: read them by id. `null` = could not be read, and the
 * caller must then withhold every item it cannot prove public.
 */
export async function readPlanItemPrivacy(
  sc: SupabaseClient,
  tripId: string,
): Promise<Map<string, { creator_id: unknown; location_is_private: unknown }> | null> {
  try {
    const { data, error } = await sc.from("trip_plan_items").select(`id, ${PLAN_ITEM_PRIVACY_COLUMNS}`).eq("trip_id", tripId);
    if (error) return null;
    const out = new Map<string, { creator_id: unknown; location_is_private: unknown }>();
    for (const r of (data ?? []) as Array<{ id: unknown; creator_id: unknown; location_is_private: unknown }>) {
      out.set(String(r.id), { creator_id: r.creator_id, location_is_private: r.location_is_private });
    }
    return out;
  } catch {
    return null;
  }
}
