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

/**
 * The columns every reader must select for the rule to decide: the anchor pair,
 * and §6.3's `privacy_scope` (2770, census-trips TR116 / §90). A reader that
 * leaves the scope out over-withholds — every other member's item becomes a
 * slot — instead of serving a plan its creator marked private.
 */
export const PLAN_ITEM_PRIVACY_COLUMNS = "creator_id, location_is_private, privacy_scope";

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
  grants: ReadonlyMap<string, string>; /** OD-1012-PRIV-5 (census-trips §95): the selected_participants plans whose AUTHOR selected this viewer, valid now (3727; absent = none). */ selected?: ReadonlySet<string>; /** Set when the selection could not be read: no selection admits. */ selectionUnread?: string;
}

export function ownerOnlyAccess(viewerId: string, status: "ok" | "unread" = "ok", reason?: string): PlanItemAccess {
  return { viewerId, status, ...(reason ? { reason } : {}), grants: new Map() };
}

export type PlanRowLike = Record<string, unknown> & { id?: unknown; creator_id?: unknown; location_is_private?: unknown; privacy_scope?: unknown; removed_at?: unknown };

// ── §6.3's privacy scope (census-trips TR116, §90) ──────────────────────────
//
// `routes/trips.ts` accepts and stores a plan's `privacy_scope`; until §90 no
// reader read it, so a plan its creator marked `private` was served to the
// whole crew. The scope is decided HERE, before the anchor rule, so every
// reader that already applies `canSeePlanItemLocation` enforces it.
//
//   - `crew`, `trip`, `friends_nearby`, `public` admit the crew (each is the
//     crew or wider; every reader of this rule serves accepted members only),
//     and the anchor rule below then decides the item's location;
//   - `private` admits its creator ONLY. Not the organizer (§6.1: roles are not
//     permissions; OD-TRIP-3's "organizer status alone does not grant access"
//     applied to the same question), and not a private-place grant: a grant
//     shares an anchor's LOCATION, it does not widen a plan's audience.
//     OD-1012-PRIV-5 (2026-10-12) answered §90.5's open question: "Private
//     access is limited to its author and explicitly selected people" (§95);
//   - `selected_participants` admits its creator AND the people the creator
//     selected (trip_plan_item_audience, 3727 — never `trip_plan_participants`,
//     which is self-service attendance), read by planItemAccessFor, valid only
//     while they are accepted crew. The write doors store the selection with
//     the scope; without 3727 they still refuse it (422);
//   - a scope that is absent (not selected, or a database without 2770), null
//     or unknown is UNREAD, and unread fails closed: creator only.
//
// What a viewer the scope excludes receives: NOTHING (§95; "Time slots inherit
// plan privacy") — withholdPrivatePlanItems drops the row, see planItemVisibility.

/** The scopes whose audience includes the trip's accepted crew. */
export const CREW_VISIBLE_PRIVACY_SCOPES: ReadonlySet<string> = new Set(["crew", "trip", "friends_nearby", "public"]);

/** Does this row's §6.3 scope admit the crew? Unread (absent, null, unknown) is no. */
export function planScopeAdmitsCrew(row: { privacy_scope?: unknown }): boolean {
  return typeof row.privacy_scope === "string" && CREW_VISIBLE_PRIVACY_SCOPES.has(row.privacy_scope);
}

/**
 * The scope half alone, for a reader that routes private ANCHORS through its
 * own grant-aware layer (the map projection) and must still drop a plan whose
 * scope excludes the viewer before anything is drawn.
 */
export function planScopeAdmitsViewer(viewer: string | PlanItemAccess, row: PlanRowLike): boolean {
  if (planScopeAdmitsCrew(row)) return true;
  const viewerId = typeof viewer === "string" ? viewer : viewer.viewerId;
  if (typeof row.creator_id === "string" && row.creator_id === viewerId) return true;
  // OD-1012-PRIV-5 (census-trips §95): "Private access is limited to its author and explicitly selected people."
  // Only a `selected_participants` plan, only a person its AUTHOR selected (trip_plan_item_audience, read by
  // planItemAccessFor and still valid), only while live. `private` and unknown scopes stay the author's alone,
  // and organizer status is not an input here at all.
  if (typeof viewer === "string" || row.privacy_scope !== "selected_participants") return false;
  if (row.removed_at !== undefined && row.removed_at !== null) return false;
  return typeof row.id === "string" && viewer.selected?.has(row.id) === true;
}

/** May this viewer see this plan item's location and name? */
export function canSeePlanItemLocation(access: PlanItemAccess, row: PlanRowLike): boolean {
  if (!planScopeAdmitsViewer(access, row)) return false;
  if (row.location_is_private === false) return true;
  const owner = typeof row.creator_id === "string" ? row.creator_id : null;
  if (owner !== null && owner === access.viewerId) return true;
  // A grant read that FAILED admits nobody, whatever the map holds (the
  // inputAssistance and Safe Return seams carried this; they now bind here).
  if (access.status !== "ok") return false;
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

/**
 * What one viewer receives of one plan row (census-trips §95):
 *   - `full`   — the row as stored;
 *   - `slot`   — the plan is the viewer's to see but its PLACE is another member's private anchor (OD-TRIP-3):
 *                the §81.2 slot (time window, status, category, id; "Private plan");
 *   - `hidden` — the plan's §6.3 scope excludes the viewer. OD-1012-PRIV-5: "Time slots inherit plan privacy" —
 *                the slot is the plan's too, so NOTHING of it is served: no row, no time window, no id.
 */
export type PlanItemVisibility = "full" | "slot" | "hidden";

export function planItemVisibility(access: PlanItemAccess, row: PlanRowLike): PlanItemVisibility {
  if (!planScopeAdmitsViewer(access, row)) return "hidden";
  return canSeePlanItemLocation(access, row) ? "full" : "slot";
}

/**
 * Apply the rule to a list of plan rows read for this viewer: a plan whose scope excludes the viewer is DROPPED
 * (its time slot inherits its privacy, OD-1012-PRIV-5), another member's private place becomes the slot. The
 * result can be SHORTER than the input — a caller that indexes `[0]` must handle `undefined`.
 */
export function withholdPrivatePlanItems<T extends PlanRowLike>(rows: readonly T[], access: PlanItemAccess): T[] {
  const out: T[] = [];
  for (const r of rows) {
    const v = planItemVisibility(access, r);
    if (v === "full") out.push(r);
    else if (v === "slot") out.push(redactWithheldPlanItem(r));
  }
  return out;
}
