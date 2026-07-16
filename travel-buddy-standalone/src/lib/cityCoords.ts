/**
 * cityCoords.ts — helpers for forwarding city coordinates to the API.
 *
 * The API expects lat/lng as a pair: both present or neither present.
 * Sending a half-pair (lat without lng, or vice versa) causes server-side
 * validation errors and silent geo-ranking failures.
 *
 * `buildCityCoords` extracts a both-or-null pair from a Place selection.
 * `cityCoordSpread` enforces the both-or-null contract at the call site:
 * spread its return value directly into a JSON payload object.
 */

import type { Place } from './location/placeTypes';

/**
 * Returns `{ lat, lng }` only when BOTH values on the Place are finite
 * numbers. Returns null when either value is missing, null, or NaN.
 *
 * Use this in onSelect handlers to set cityCoords state from a Place:
 *   setCityCoords(buildCityCoords(place));
 */
export function buildCityCoords(place: Place): { lat: number; lng: number } | null {
  if (
    typeof place.lat === 'number' &&
    isFinite(place.lat) &&
    typeof place.lng === 'number' &&
    isFinite(place.lng)
  ) {
    return { lat: place.lat, lng: place.lng };
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
