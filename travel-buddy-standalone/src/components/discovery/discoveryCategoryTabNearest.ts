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

// ── Movement re-sort helpers ─────────────────────────────────────────────────

/** Approximate great-circle distance in km between two lat/lng pairs (Haversine). */
export function approxDistanceKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Minimum movement (km) needed to trigger a Nearest re-sort.
 * The comparison is strict (>) so movement at exactly the threshold is treated
 * as GPS jitter and does not trigger a re-fetch.
 */
export const NEAREST_REFRESH_THRESHOLD_KM = 0.1;

/**
 * Returns true when the user has moved far enough from the last-fetched position
 * to warrant a Nearest re-sort.
 *
 * The comparison is strictly greater-than: movement at or below
 * NEAREST_REFRESH_THRESHOLD_KM is treated as GPS jitter and returns false.
 *
 * Caller contract: `prev` must be non-null (i.e. a previous Nearest fetch has
 * already been recorded). When prev is null — the "first coords ever" case —
 * use `shouldBootstrapNearestLoad` instead; that function owns the cold-start
 * case and is already covered by its own tests.
 */
export function shouldRefreshNearestOnMovement(
  prev: { lat: number; lng: number },
  userLat: number,
  userLng: number,
): boolean {
  return approxDistanceKm(prev.lat, prev.lng, userLat, userLng) > NEAREST_REFRESH_THRESHOLD_KM;
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
