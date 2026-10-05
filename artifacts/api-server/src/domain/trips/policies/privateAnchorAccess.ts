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
