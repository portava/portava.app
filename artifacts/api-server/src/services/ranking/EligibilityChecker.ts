/**
 * EligibilityChecker — centralized eligibility gate for DiscoveryRankingService.
 *
 * Runs before any score is computed. Any item failing any check is excluded
 * from ranking entirely — no score can rescue an ineligible item.
 *
 * Centralizes checks scattered across pulse.ts, discovery.ts, and
 * CompassEligibilityEngine so all feed surfaces apply identical rules.
 *
 * Exception policy: FAIL-OPEN — if a check throws unexpectedly, the item is
 * allowed through rather than silently hidden from every user.
 */

import type { RankingInput, RankingViewerContext } from "./DiscoveryRankingService.js";

export interface EligibilityResult {
  eligible: boolean;
  reason: string | null;
}

const ELIGIBLE: EligibilityResult = { eligible: true, reason: null };
const ineligible = (reason: string): EligibilityResult => ({ eligible: false, reason });

/**
 * Run all eligibility checks against one item.
 * Returns immediately on the first failing check (short-circuit).
 */
export function checkItemEligibility(
  item: RankingInput,
  viewer: RankingViewerContext,
): EligibilityResult {
  try {
    // ── Hard safety checks ────────────────────────────────────────────────

    // Author blocked by viewer or blocks viewer (bidirectional)
    if (item.authorIsBlockedByViewer) return ineligible("author_blocked_by_viewer");
    if (item.authorBlocksViewer)      return ineligible("viewer_blocked_by_author");

    // Viewer has muted this author (content still counts for muted-creator signal)
    if (item.authorIsMutedByViewer)   return ineligible("author_muted_by_viewer");

    // Item was reported by this viewer
    if (item.viewerHasReportedItem)   return ineligible("viewer_reported_item");

    // Item was explicitly hidden by viewer
    if (item.viewerHasHiddenItem)     return ineligible("viewer_hidden_item");

    // Viewer has hidden all content from this creator
    if (item.viewerHasHiddenCreator)  return ineligible("creator_hidden_by_viewer");

    // ── Content state ──────────────────────────────────────────────────────

    if (item.isDeleted)    return ineligible("item_deleted");
    if (item.isExpired)    return ineligible("item_expired");
    if (item.isSuspended)  return ineligible("author_or_item_suspended");
    if (item.isModerated)  return ineligible("item_moderated");

    // ── Privacy / visibility ───────────────────────────────────────────────

    if (item.isPrivate) return ineligible("item_private");

    // ── Age restriction ────────────────────────────────────────────────────

    if (item.isAgeRestricted && item.minAgeRequired != null && item.minAgeRequired > 0) {
      if (viewer.viewerAge != null && viewer.viewerAge < item.minAgeRequired) {
        return ineligible("viewer_age_below_minimum");
      }
    }

    // ── Geographic restriction ─────────────────────────────────────────────

    if (
      item.isGeoRestricted &&
      item.geoRestrictionCountries != null &&
      item.geoRestrictionCountries.length > 0 &&
      viewer.currentCountry != null
    ) {
      const restricted = item.geoRestrictionCountries.map((c) => c.toLowerCase());
      if (!restricted.includes(viewer.currentCountry.toLowerCase())) {
        return ineligible("geo_restricted");
      }
    }

    return ELIGIBLE;
  } catch {
    // Fail-open: unexpected exceptions do not remove items from the feed
    return ELIGIBLE;
  }
}
