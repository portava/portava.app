/**
 * Pure logic helpers for DiscoveryCategoryTab's Nearest sort behaviour.
 *
 * Zero React Native imports — safe to test with:
 *   node --import tsx/esm --test \
 *     src/components/discovery/__tests__/DiscoveryCategoryTab.nearest.test.ts
 */

// ── Bootstrap guard ───────────────────────────────────────────────────────────

/**
 * Returns true when the location-change effect should trigger a fresh fetch
 * immediately (the "bootstrap" case).
 *
 * The bootstrap case occurs when all three conditions hold:
 *  1. sortBy is 'nearest' — the user has activated the Nearest sort chip.
 *  2. Real user coordinates are now available (userLat / userLng non-null).
 *  3. The last fetch ran without valid user coords (lastFetchedCoords is null),
 *     so the current results are ordered by destination-centre rather than the
 *     user's actual position.
 *
 * When this returns true the caller should discard the current result set and
 * call load(1, filters, true) with the real user coordinates so the list
 * immediately reflects the correct distance ordering.
 */
export function shouldBootstrapNearestLoad(opts: {
  sortBy: string | null | undefined;
  userLat: number | null | undefined;
  userLng: number | null | undefined;
  lastFetchedCoords: { lat: number; lng: number } | null;
}): boolean {
  const { sortBy, userLat, userLng, lastFetchedCoords } = opts;
  if (sortBy !== 'nearest') return false;
  if (userLat == null || userLng == null) return false;
  return lastFetchedCoords === null;
}

// ── Coord resolver ────────────────────────────────────────────────────────────

/**
 * Resolves the user coordinates to pass to getDiscoveryPlaces as the
 * nearestUserLat / nearestUserLng parameters.
 *
 * Returns the user's real coordinates when sortBy is 'nearest' so the API can
 * recompute distances from the user's position.  Returns null for both fields
 * in all other sort modes — the destination-centre lat/lng is used instead,
 * and the cache key must never include user coordinates.
 */
export function resolveNearestFetchCoords(
  sortBy: string | null | undefined,
  userLat: number | null | undefined,
  userLng: number | null | undefined,
): { nearestUserLat: number | null; nearestUserLng: number | null } {
  if (sortBy !== 'nearest' || userLat == null || userLng == null) {
    return { nearestUserLat: null, nearestUserLng: null };
  }
  return { nearestUserLat: userLat, nearestUserLng: userLng };
}
