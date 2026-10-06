/**
 * Trips spec §14.1 / §14.4 — who may see a private anchor (census-trips TR256).
 *
 * THE OWNER'S DECISION (2026-10-04, Trips, verbatim):
 *   "Private anchors: Owner-only by default. The owner can share an individual
 *    anchor with selected trip members; trip membership or organizer status
 *    alone does not grant access."
 *
 * An anchor is a trip plan item whose `location_is_private` is TRUE; its owner
 * is the item's `creator_id`. Until this module, `GET
 * /trips/:tripId/map-projection` put such items into a layer of their own —
 * and then served that layer, exact coordinates included, to EVERY accepted
 * member of the trip. A client that never draws the layer is not an access
 * rule; the wire was the leak.
 *
 * THE RULE, AS A PURE FUNCTION, SO IT CAN BE TESTED IN EVERY DIRECTION
 *   - the owner sees their own anchor;
 *   - anyone else sees it ONLY when the owner granted it to them
 *     (`trip_private_anchor_shares`, migration 3970) AND sharing is switched on;
 *   - an anchor whose owner is unknown is visible to NOBODY;
 *   - a viewer's role on the trip is not an input at all. That is the
 *     "organizer status alone does not grant access" clause, and it is held by
 *     the function's signature: there is no parameter a role could arrive in
 *     (asserted by arity in the test, like `buildDisplayFields`).
 *
 * WHEN THE GRANTS COULD NOT BE READ. The answer is `unread`, never "only your
 * own": a layer that silently dropped the anchors shared WITH the viewer would
 * look complete and be wrong. When sharing is off, grants are not consulted, so
 * there is nothing that could have failed and the own-only answer is exact.
 *
 * PURE. No client, no flag read, no I/O.
 */

export const PRIVATE_ANCHOR_SHARE_MAX = 50;

export interface AnchorCandidate {
  id: string;
  /** `trip_plan_items.creator_id`; null when it was not read. */
  ownerId: string | null;
}

/** What the viewer was granted, as read. `tableAbsent`: 3970 not applied — no grant can exist. */
export type AnchorGrantRead =
  | { status: "ok"; grantedToViewer: ReadonlySet<string>; tableAbsent?: boolean }
  | { status: "unread"; reason: string };

export type AnchorRelation = "own" | "shared_with_me";

export type AnchorVisibility<T extends AnchorCandidate> =
  | { status: "ok"; items: Array<{ anchor: T; relation: AnchorRelation }> }
  | { status: "unread"; reason: string };

export function anchorsVisibleTo<T extends AnchorCandidate>(
  viewerId: string,
  anchors: readonly T[],
  sharingOn: boolean,
  grants: AnchorGrantRead,
): AnchorVisibility<T> {
  const items: Array<{ anchor: T; relation: AnchorRelation }> = [];
  if (sharingOn && grants.status === "unread") {
    return { status: "unread", reason: grants.reason };
  }
  const granted = sharingOn && grants.status === "ok" ? grants.grantedToViewer : new Set<string>();
  for (const a of anchors) {
    if (!a.ownerId) continue;
    if (a.ownerId === viewerId) {
      items.push({ anchor: a, relation: "own" });
      continue;
    }
    if (granted.has(a.id)) items.push({ anchor: a, relation: "shared_with_me" });
  }
  return { status: "ok", items };
}

/**
 * May `callerId` grant or list grants on this anchor? Only its owner, and only
 * while it IS a private anchor of this trip that has not been removed. A plan
 * item that is not private has nothing to share: its location is already the
 * crew's.
 */
export type AnchorOwnership =
  | { ok: true }
  | { ok: false; code: "not_found" | "forbidden" | "invalid_payload"; message: string };

export function ownsShareableAnchor(
  callerId: string,
  tripId: string,
  item: { trip_id: string; creator_id: string | null; location_is_private: boolean | null; removed_at: string | null } | null,
): AnchorOwnership {
  if (!item || item.trip_id !== tripId || item.removed_at !== null) {
    return { ok: false, code: "not_found", message: "That place is not on this trip" };
  }
  if (item.creator_id !== callerId) {
    return { ok: false, code: "forbidden", message: "Only the person who added a private place can share it" };
  }
  if (item.location_is_private !== true) {
    return { ok: false, code: "invalid_payload", message: "This place is not private; the whole trip can already see it" };
  }
  return { ok: true };
}

// ── Every reader of a plan item's location, not only the map ─────────────────
//
// Wave 1 enforced the owner-only rule on `GET /trips/:id/map-projection` alone;
// an independent verifier found the same private places leaving the server on
// the route chain, Pulse, the route-plan accommodation, the plan list, Today,
// the offline bundle and more. This is the ONE rule every such reader applies
// (census-trips §81). An anchor is a plan item whose `location_is_private` is
// not FALSE; its owner is `creator_id`.
//
// WHAT A VIEWER WHO MAY NOT SEE IT RECEIVES — the lead's reading of
// "owner-only", chosen as the safe direction and recorded for the owner to
// confirm: the slot, not the place. No coordinates, no address, no place or
// source id, no location name, and no title, notes or description (a hotel's
// name is its location). The time window, status, category and the item's id
// stay, so the shared plan still shows that the time is taken. Derived values
// must not carry it either: a withheld row has no coordinates, so no distance,
// travel time, centre of gravity or route hop can be computed to or from it.
//
// FAIL CLOSED. A row that does not carry `location_is_private` is treated as
// private, and one without `creator_id` as nobody's — so a reader that forgot
// to select the two columns over-withholds in its tests instead of leaking.

/** The two columns every reader must select for the rule to decide. */
export const PLAN_ITEM_PRIVACY_COLUMNS = "creator_id, location_is_private";

/** What a withheld item is called. Neutral: it says a slot is taken, not where or what. */
export const WITHHELD_PLAN_TITLE = "Private plan";

/** The fields that locate or name a plan item. Each is nulled when withheld. */
export const WITHHELD_LOCATION_FIELDS = [
  "lat", "lng", "location_name", "address", "place_id", "google_place_id", "source_id",
  "route_stop_id", "notes", "description", "structured_location",
  // lead ruling D-65 (2026-10-06): owner-only covers the place's location, its
  // name and any text derived from them — the town and venue name too.
  "city", "country", "neighborhood", "venue_name",
] as const;

/**
 * What one viewer may see on one trip, as read. `grants` maps a granted item id
 * to the owner the grant was made by; it holds only grants that are VALID now
 * (sharing on, the owner and the viewer both accepted members). `unread`: some
 * input could not be read, so `grants` is empty and every private item of
 * another member is withheld — the safe answer, and named.
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

export type PlanRowLike = Record<string, unknown> & { id?: unknown; creator_id?: unknown; location_is_private?: unknown; removed_at?: unknown };

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
