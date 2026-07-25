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
  /**
   * Set to true when the main fetch already started with real user coords on
   * this mount cycle (before its async `await`).  When true, the bootstrap
   * branch must be suppressed — the in-flight fetch will set lastFetchedCoords
   * once it completes, so firing a second fetch would duplicate the request.
   *
   * This prevents a spurious re-fetch when the user switches category tabs:
   * the component re-mounts (resetting lastFetchedCoords to null), the main
   * fetch effect fires with real coords (sets this flag), and the location-
   * change effect fires in the same React batch and must not bootstrap again.
   */
  fetchPendingWithCoords?: boolean;
}): boolean {
  const { sortBy, userLat, userLng, lastFetchedCoords, fetchPendingWithCoords } = opts;
  if (sortBy !== 'nearest') return false;
  if (userLat == null || userLng == null) return false;
  if (fetchPendingWithCoords) return false;
  return lastFetchedCoords === null;
}

// ── Movement re-sort helpers ─────────────────────────────────────────────────

import { haversineKm } from '../../utils/geoDistance.ts';

/** Approximate great-circle distance in km between two lat/lng pairs (Haversine). */
export function approxDistanceKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  return haversineKm(lat1, lng1, lat2, lng2);
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
