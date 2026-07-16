/**
 * cityCoords.ts — helpers for forwarding city coordinates to the API.
 *
 * The API expects lat/lng as a pair: both present or neither present.
 * Sending a half-pair (lat without lng, or vice versa) causes server-side
 * validation errors and silent geo-ranking failures.
 *
 * `cityCoordSpread` enforces the both-or-null contract at the call site:
 * spread its return value directly into a JSON payload object.
 *
 * `applyCoords` merges a coord pair into a base params object only when BOTH
 * values are valid finite numbers, making it impossible to pass a half-pair.
 */

/** Both lat and lng as finite numbers. */
export type CoordPair = { lat: number; lng: number };

type MaybeCoords = { lat?: number | null; lng?: number | null } | null | undefined;

/**
 * Merges `{ lat, lng }` into `base` only when BOTH values are finite numbers.
 * Returns `base` unchanged when either coordinate is missing, null, or NaN.
 *
 * Usage:
 *   const params = applyCoords({ city, ...rest }, { lat: cityLat, lng: cityLng });
 *   const params = applyCoords({ city, ...rest }, cityCoords); // cityCoords: { lat, lng } | null
 */
export function applyCoords<T extends object>(base: T, coords: MaybeCoords): T | (T & CoordPair) {
  if (
    coords != null &&
    typeof coords.lat === 'number' &&
    isFinite(coords.lat) &&
    typeof coords.lng === 'number' &&
    isFinite(coords.lng)
  ) {
    return { ...base, lat: coords.lat, lng: coords.lng };
  }
  return base;
}

/**
 * Returns `{ lat, lng }` only when BOTH values are finite numbers.
 * Returns an empty object when either value is missing, null, or NaN.
 */
export function buildCityCoords(
  coords?: { lat?: number | null; lng?: number | null } | null,
): { lat: number; lng: number } | Record<never, never> {
  if (
    coords != null &&
    typeof coords.lat === 'number' &&
    isFinite(coords.lat) &&
    typeof coords.lng === 'number' &&
    isFinite(coords.lng)
  ) {
    return { lat: coords.lat, lng: coords.lng };
  }
  return {};
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
  return buildCityCoords(coords);
}
