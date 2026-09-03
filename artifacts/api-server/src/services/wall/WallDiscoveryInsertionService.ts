/**
 * WallDiscoveryInsertionService — social-explained discovery for For You (§13).
 *
 * For You may reach OUTSIDE the follow graph, but discovery must remain SOCIAL:
 * every inserted item explains WHY it is relevant, and an item that cannot be
 * explained socially is NOT inserted — "never naked directory listings" (spec
 * §13). This module owns exactly that decision, as a pure function.
 *
 * The explanation ladder is ordered relationship/relevance FIRST, popularity
 * LAST, which is the §13 guarantee that "creator popularity must not dominate
 * contributor reliability or real-world relevance":
 *
 *   1. followed_by   — someone the viewer follows follows this author (mutual /
 *                      second-degree social proof).
 *   2. trip_relevance— the place is in a city the viewer is travelling to.
 *   3. destination   — the place is the viewer's current / preferred city.
 *   4. interest      — the category / tags match the viewer's stated interests.
 *   5. hidden_gem    — the place is a disclosure-permitted Hidden Gem.
 *   6. missed        — a genuinely high-quality recent post the viewer likely
 *                      missed. This is the ONLY popularity-derived reason and it
 *                      is LAST, so a merely-popular post with no social or
 *                      real-world tie is dropped rather than inserted.
 *
 * A candidate that matches none of these returns null and the caller drops it —
 * the feed never shows an unexplained outside-graph object.
 *
 * Pure and DB-free: the caller gathers the signals from canonical systems and
 * hands them here. Never throws.
 */

export type DiscoveryExplanationKey =
  | "followed_by"
  | "trip_relevance"
  | "destination"
  | "interest"
  | "hidden_gem"
  | "missed";

export interface DiscoveryExplanation {
  key: DiscoveryExplanationKey;
  /** The visible "why you're seeing this" string (spec §7/§13). */
  reason: string;
}

/** The per-candidate signals the caller resolves from canonical rows. */
export interface DiscoveryCandidateSignals {
  authorId: string;
  placeCity?: string | null;
  placeCountry?: string | null;
  category?: string | null;
  tags?: string[];
  likeCount?: number;
  saveCount?: number;
  commentCount?: number;
  createdAt?: string | null;
  /** The place is a Hidden Gem the disclosure policy permits surfacing (§20). */
  isPermittedHiddenGem?: boolean;
}

/** The viewer-side signals, resolved once per request. */
export interface DiscoveryViewerSignals {
  /** Authors that people the viewer follows also follow (second-degree). */
  mutualFollowedAuthorIds?: Set<string>;
  /** Lowercased destination cities of the viewer's upcoming/active trips. */
  tripCities?: Set<string>;
  currentCity?: string | null;
  /** Lowercased preferred / home cities. */
  preferredCities?: Set<string>;
  /** Lowercased interest tokens (categories the viewer cares about). */
  interests?: Set<string>;
  now?: Date;
}

/** Quality thresholds for the popularity-of-last-resort "missed" reason. */
const MISSED_MIN_ENGAGEMENT = 8; // likes+saves+comments
const MISSED_MAX_AGE_DAYS = 21; // recent enough to be "missed", not stale

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Decide whether — and why — an outside-graph candidate should be inserted into
 * For You. Returns the social explanation, or null to DROP the candidate (no
 * naked directory listing, spec §13).
 */
export function explainDiscovery(
  cand: DiscoveryCandidateSignals,
  viewer: DiscoveryViewerSignals,
): DiscoveryExplanation | null {
  // 1 — followed_by / mutual (strongest social proof).
  if (cand.authorId && viewer.mutualFollowedAuthorIds?.has(cand.authorId)) {
    return { key: "followed_by", reason: "Followed by people you follow" };
  }

  const city = norm(cand.placeCity);

  // 2 — trip relevance (real-world, forward-looking).
  if (city && viewer.tripCities?.has(city)) {
    return {
      key: "trip_relevance",
      reason: `Because you're heading to ${cand.placeCity}`,
    };
  }

  // 3 — destination fit (current / preferred city).
  if (city && (norm(viewer.currentCity) === city || viewer.preferredCities?.has(city))) {
    return { key: "destination", reason: `Popular in ${cand.placeCity}` };
  }

  // 4 — interest fit (category / tags the viewer cares about).
  if (viewer.interests && viewer.interests.size > 0) {
    const cat = norm(cand.category);
    if (cat && viewer.interests.has(cat)) {
      return { key: "interest", reason: `Matches your interest in ${cand.category}` };
    }
    for (const tag of cand.tags ?? []) {
      const t = norm(tag);
      if (t && viewer.interests.has(t)) {
        return { key: "interest", reason: `Matches your interest in ${tag}` };
      }
    }
  }

  // 5 — a disclosure-permitted Hidden Gem.
  if (cand.isPermittedHiddenGem) {
    return { key: "hidden_gem", reason: "A Hidden Gem worth exploring" };
  }

  // 6 — high-quality recent post the viewer likely missed (popularity LAST, and
  //     only when also recent — popularity alone never earns insertion).
  const engagement =
    (cand.likeCount ?? 0) + (cand.saveCount ?? 0) + (cand.commentCount ?? 0);
  if (engagement >= MISSED_MIN_ENGAGEMENT && isRecent(cand.createdAt, viewer.now)) {
    return { key: "missed", reason: "High-quality post you might have missed" };
  }

  // No social explanation ⇒ drop (never a naked directory listing).
  return null;
}

function isRecent(createdAt: string | null | undefined, now?: Date): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  const nowMs = (now ?? new Date()).getTime();
  const ageDays = (nowMs - t) / (24 * 60 * 60 * 1000);
  return ageDays >= 0 && ageDays <= MISSED_MAX_AGE_DAYS;
}

export const _internal = { isRecent, norm, MISSED_MIN_ENGAGEMENT, MISSED_MAX_AGE_DAYS };
