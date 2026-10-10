/**
 * planItemAccess — OD-TRIP-3 for the plan items Compass, the Map and the Wall
 * read: "Private anchors: owner-only by default. The owner can share an
 * individual anchor with selected trip members; trip membership or organizer
 * status alone does not grant access." (docs/ops/owner-decisions-20261004.md)
 *
 * ── BOUND TO LANE C'S HELPER (#650 merged) ───────────────────────────────────
 * This was a local seam carrying lane C's contract verbatim while C's modules
 * were not on main. They are now, so the rule, the access loader and the
 * redaction are RE-EXPORTS of C's (domain/trips/policies/privateAnchorAccess.ts,
 * server/trips/privateAnchorShares.ts) and there is one implementation. The
 * callers do not change. What this changes in behaviour: `planItemAccessFor`
 * now honours a sharing grant (trip_private_anchor_shares, while
 * trip_private_anchor_sharing_enabled is on) instead of granting nothing, and
 * answers `unread` when the sharing setting or the grants cannot be read — in
 * which case every other member's private item is withheld, as before.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export {
  PLAN_ITEM_PRIVACY_COLUMNS,
  WITHHELD_PLAN_TITLE,
  WITHHELD_LOCATION_FIELDS,
  ownerOnlyAccess,
  canSeePlanItemLocation,
  redactWithheldPlanItem,
  withholdPrivatePlanItems,
  type PlanItemAccess,
  type PlanRowLike,
} from "../domain/trips/policies/privateAnchorAccess.js";
export { planItemAccessFor } from "../server/trips/privateAnchorShares.js";

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
    const { data, error } = await sc.from("trip_plan_items").select("id, creator_id, location_is_private").eq("trip_id", tripId);
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
