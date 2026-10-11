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

// ── BOUND (census-trips §90, 2026-10-11) ─────────────────────────────────────
// The binding this header asked for: lane C's modules are on main, so the
// rule, the loader and the redaction are RE-EXPORTS of the one implementation.
// What changes for the Safe Return readers: the rule now also enforces §6.3's
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
