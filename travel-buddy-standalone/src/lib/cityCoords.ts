/**
 * cityCoords.ts — helpers for forwarding city coordinates to the API.
 *
 * The API expects lat/lng as a pair: both present or neither present.
 * Sending a half-pair (lat without lng, or vice versa) causes server-side
 * validation errors and silent geo-ranking failures.
 *
 * `cityCoordSpread` enforces the both-or-null contract at the call site:
 * spread its return value directly into a JSON payload object.
 */

/**
 * Returns `{ lat, lng }` when BOTH values are finite numbers, otherwise null.
 *
 * This is the single source of truth for the both-or-null guard.
 */
export function buildCityCoords(
  coords?: { lat?: number | null; lng?: number | null } | null,
): { lat: number; lng: number } | null {
  if (
    coords != null &&
    typeof coords.lat === 'number' &&
    isFinite(coords.lat) &&
    typeof coords.lng === 'number' &&
    isFinite(coords.lng)
  ) {
    return { lat: coords.lat, lng: coords.lng };
  }
  return null;
}

/**
 * Returns `{ lat, lng }` only when BOTH values are finite numbers.
 * Returns an empty object when either value is missing, null, or NaN.
 *
 * Usage:
 *   body: JSON.stringify({ city, ...cityCoordSpread(coords) })
 */
export function cityCoordSpread(
  coords?: { lat?: number | null; lng?: number | null } | null,
): { lat: number; lng: number } | Record<never, never> {
  const result = buildCityCoords(coords);
  return result !== null ? result : {};
}
