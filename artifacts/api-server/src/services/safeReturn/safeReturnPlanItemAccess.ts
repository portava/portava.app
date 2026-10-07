/**
 * OD-TRIP-3 for the Safe Return readers — "a private trip place is owner-only
 * unless the owner shared it" — behind a THIN SEAM with lane C's names.
 *
 * WHY A SEAM AND NOT AN IMPORT. The rule's home is lane C's branch
 * (`domain/trips/policies/privateAnchorAccess.ts` for the pure rule,
 * `server/trips/privateAnchorShares.ts` for `planItemAccessFor`, at
 * `origin/claude/mission-c-discovery-telegraph-trips-20261005` 87df318f4). It
 * is not on main. The two Safe Return readers below leak today, so they apply
 * the SAME contract now, through functions with the SAME names and shapes.
 *
 * BIND WHEN C LANDS: delete this file and import `withholdPrivatePlanItems`,
 * `PLAN_ITEM_PRIVACY_COLUMNS` from `domain/trips/policies/privateAnchorAccess.js`
 * and `planItemAccessFor` from `server/trips/privateAnchorShares.js`. The two
 * call sites do not change.
 *
 * THE CONTRACT (C's, unchanged)
 *   - the creator sees their own private place;
 *   - anyone else sees NOTHING of it (no name, no coordinates) unless the
 *     creator granted it to them while sharing is on;
 *   - a row that does not say it is not private is private, and one with no
 *     creator is nobody's — so a reader that forgot the two columns
 *     over-withholds instead of leaking;
 *   - a role on the trip is not an input.
 *
 * WHAT THIS TREE CAN AND CANNOT DO. Grants live in lane C's
 * `trip_private_anchor_shares` (its migration 3970) behind its
 * `trip_private_anchor_sharing_enabled` flag. Neither exists on this tree, so
 * NO grant can exist here: `planItemAccessFor` answers owner-only, exactly —
 * there is nothing it reads, so nothing it could fail to read. C's version
 * adds the grant read, and answers `unread` (still withholding) when it fails.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** The two columns every reader must select for the rule to decide. */
export const PLAN_ITEM_PRIVACY_COLUMNS = "creator_id, location_is_private";

/** What a withheld item is called: a slot is taken, not where or what. */
export const WITHHELD_PLAN_TITLE = "Private plan";

/** The fields that locate or name a plan item. Each is nulled when withheld. */
export const WITHHELD_LOCATION_FIELDS = [
  "lat", "lng", "location_name", "address", "place_id", "google_place_id", "source_id",
  "route_stop_id", "notes", "description", "structured_location",
] as const;

/** What one viewer may see on one trip. `grants`: granted item id → the owner who granted it. */
export interface PlanItemAccess {
  viewerId: string;
  status: "ok" | "unread";
  reason?: string;
  grants: ReadonlyMap<string, string>;
}

export function ownerOnlyAccess(viewerId: string, status: "ok" | "unread" = "ok", reason?: string): PlanItemAccess {
  return { viewerId, status, ...(reason ? { reason } : {}), grants: new Map() };
}

type PlanRowLike = Record<string, unknown> & { id?: unknown; creator_id?: unknown; location_is_private?: unknown; removed_at?: unknown };

/** May this viewer see this plan item's location and name? */
export function canSeePlanItemLocation(access: PlanItemAccess, row: PlanRowLike): boolean {
  if (row.location_is_private === false) return true;
  const owner = typeof row.creator_id === "string" ? row.creator_id : null;
  if (owner !== null && owner === access.viewerId) return true;
  if (row.removed_at !== undefined && row.removed_at !== null) return false;
  // A grant read that FAILED is owner-only, whatever the grants map holds
  // (census-layover §52.2, verifier probe P8b): `{ status: "unread" }` with a
  // non-empty map used to admit the grantee. Nothing on this tree builds that
  // state, and lane C's `planItemAccessFor` must not be able to either once it
  // is bound here.
  if (access.status !== "ok") return false;
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

/** Apply the rule to plan rows read for this viewer. */
export function withholdPrivatePlanItems<T extends PlanRowLike>(rows: readonly T[], access: PlanItemAccess): T[] {
  return rows.map((r) => (canSeePlanItemLocation(access, r) ? r : redactWithheldPlanItem(r)));
}

/**
 * What `viewerId` may see on `tripId`. On this tree: owner-only (see the
 * header — no grant source exists). Same signature as lane C's, so binding is
 * an import change.
 */
export async function planItemAccessFor(_sc: SupabaseClient, _tripId: string, viewerId: string): Promise<PlanItemAccess> {
  return ownerOnlyAccess(viewerId);
}
