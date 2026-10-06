/**
 * OD-TRIP-3 for Input Intelligence's plan-item suggestions — a THIN SEAM over
 * the Trips rule, under the same names, until the Trips lane's helpers reach
 * main.
 *
 * THE OWNER'S DECISION (OD-TRIP-3, 2026-10-04): "Private anchors: Owner-only by
 * default. The owner can share an individual anchor with selected trip members;
 * trip membership or organizer status alone does not grant access."
 *
 * WHY HERE. `searchPlans` (lib/inputAssistance/searchCandidates.ts) matched
 * `trip_plan_items.title` across every admitted trip and returned the row to
 * whoever typed — another member's PRIVATE place included. A plan item's
 * `location_is_private` defaults to TRUE in the schema, so that was most of them.
 *
 * THE CONTRACT — copied from lane C's branch
 * (`origin/claude/mission-c-discovery-telegraph-trips-20261005` @ 87df318f4:
 * `domain/trips/policies/privateAnchorAccess.ts` and
 * `server/trips/privateAnchorShares.ts`), byte for byte where it is pure:
 *   - the creator sees their own item;
 *   - anyone else sees a private item ONLY when the creator granted it to them
 *     while sharing is on;
 *   - a row that does not carry `location_is_private` is treated as private,
 *     and one without `creator_id` as nobody's (fail closed);
 *   - when access could not be read, nothing private of anyone else is shown.
 *
 * WHAT THIS TREE DOES NOT HAVE. The grant table (`trip_private_anchor_shares`)
 * and the sharing flag exist only on lane C's branch, so here no grant can
 * exist and `planItemAccessFor` is owner-only — the decision's default — with
 * no read. It must not invent the schema it would read.
 *
 * BINDING. When lane C lands, this file's body becomes re-exports of
 * `withholdPrivatePlanItems` / `canSeePlanItemLocation` / `ownerOnlyAccess`
 * from `domain/trips/policies/privateAnchorAccess.ts` and `planItemAccessFor`
 * from `server/trips/privateAnchorShares.ts`; the caller does not change.
 */

/** The two columns every reader must select for the rule to decide. */
export const PLAN_ITEM_PRIVACY_COLUMNS = "creator_id, location_is_private";

/** What a withheld item is called. Neutral: it says a slot is taken, not where or what. */
export const WITHHELD_PLAN_TITLE = "Private plan";

/** The fields that locate or name a plan item. Each is nulled when withheld. */
export const WITHHELD_LOCATION_FIELDS = [
  "lat", "lng", "location_name", "address", "place_id", "google_place_id", "source_id",
  "route_stop_id", "notes", "description", "structured_location",
] as const;

/**
 * What one viewer may see on one trip, as read. `grants` maps a granted item id
 * to the owner the grant was made by. `unread`: some input could not be read,
 * so `grants` is empty and every private item of another member is withheld.
 */
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
 * What `viewerId` may see on `tripId`. On this tree: owner-only, because no
 * grant can exist (see the header). Async and client-taking so the binding to
 * lane C's reader changes no caller.
 */
export async function planItemAccessFor(_sc: unknown, _tripId: string, viewerId: string): Promise<PlanItemAccess> {
  return ownerOnlyAccess(viewerId);
}
