/**
 * The orderings §27.1's monotonicity properties are measured against.
 *
 * A monotonicity property is meaningless without a stated order. "Permission
 * decreases → accessible set never increases" is only checkable once someone
 * says what it means for permission to decrease and for an accessible set to
 * increase. These are those definitions, written once so the property tests and
 * any future caller cannot disagree about them.
 *
 * THE RULE FOR EVERY LATTICE HERE: rank is derived from what the system
 * DISCLOSES, never from what it was configured to disclose. A card built from a
 * 'nearby' live share that emitted no area label discloses less than a card
 * built from a 'city_only' default that emitted a city name, and any ordering
 * that read the configuration instead of the output would score them the other
 * way round. That inversion is precisely the bug class §27.1 exists to catch,
 * so the ordering must not contain it.
 */

import type { CrewMemberCard } from "../../../lib/tripCrewLocation.js";
import type { MessageVerdict } from "../../../lib/messagingPermissions.js";

// ── Messaging permission lattice ──────────────────────────────────────────────

/**
 * denied (0) < requires_request (1) < allowed (2).
 *
 * `requires_request` sits in the middle because it is strictly more than a
 * denial (the sender may place one item in the recipient's request inbox) and
 * strictly less than an allow (no thread opens, no delivery happens).
 */
export function verdictRank(verdict: MessageVerdict): number {
  switch (verdict) {
    case "allowed":
      return 2;
    case "requires_request":
      return 1;
    case "denied":
      return 0;
    default:
      // An unrecognised verdict ranks ABOVE everything, so a new verdict added
      // without updating this ordering makes the monotonicity property fail
      // rather than silently pass by being scored as a denial.
      return Number.POSITIVE_INFINITY;
  }
}

// ── Location precision lattice ────────────────────────────────────────────────

/**
 * What a crew card actually discloses about where a person is.
 *
 *   0  nothing — no area label and no coordinates
 *   1  a city
 *   2  a district within a city (the label carries a comma-joined pair)
 *   3  exact coordinates
 *
 * Derived from the CARD, which is why `areaLabel` is inspected for its shape
 * rather than the input's visibility level being read back. resolveAreaLabel
 * emits "district, city" for the neighborhood and nearby levels and a bare city
 * for city_only, so the comma is the observable difference between them — and if
 * that function ever starts emitting a district for city_only, this ranking
 * reports the increase instead of hiding it behind the level that was requested.
 */
export function disclosedPrecision(card: CrewMemberCard): number {
  if (card.exactCoords && card.exactCoords.lat != null && card.exactCoords.lng != null) {
    return 3;
  }
  const label = card.areaLabel;
  if (!label) return 0;
  return label.includes(",") ? 2 : 1;
}

// ── Accessible-set ordering ───────────────────────────────────────────────────

/**
 * Is `after` a subset of `before`? The §27.1 form of "never increases" for a set
 * of readable message ids.
 *
 * Returns the offending ids rather than a boolean so a failure names what
 * appeared, which is the only thing a reader needs and the thing a boolean
 * throws away.
 */
export function newlyAccessible(before: readonly string[], after: readonly string[]): string[] {
  const seen = new Set(before);
  return after.filter((id) => !seen.has(id));
}
