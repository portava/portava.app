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

// ── BOUND (census-trips §90, 2026-10-11) ─────────────────────────────────────
// The binding this header asked for: lane C's modules are on main, so the
// rule, the loader and the redaction are RE-EXPORTS of the one implementation.
// What changes for the Input Intelligence readers: the rule now also enforces §6.3's
// `privacy_scope` (a `private` / `selected_participants` plan, or one whose
// scope was not read, is its creator's alone — TR116), `planItemAccessFor`
// honours a still-true sharing grant and answers `unread` when one cannot be
// read, and the withheld field set includes lead ruling D-65's town and venue
// names. The seam's own hardening — an `unread` access admits no grant,
// whatever its map holds — is now in the shared rule. Callers do not change.
export {
  PLAN_ITEM_PRIVACY_COLUMNS,
  WITHHELD_PLAN_TITLE,
  WITHHELD_LOCATION_FIELDS,
  ownerOnlyAccess,
  canSeePlanItemLocation,
  redactWithheldPlanItem,
  withholdPrivatePlanItems,
  type PlanItemAccess,
} from "../../domain/trips/policies/privateAnchorAccess.js";
export { planItemAccessFor } from "../../server/trips/privateAnchorShares.js";
