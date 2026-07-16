import type { Place } from './location/placeTypes';

/**
 * Extracts city coordinates from a Place selection, guaranteeing both-or-null.
 * Returns `{ lat, lng }` only when the Place carries both values; null otherwise.
 * Use this as the single source-of-truth setter so lat/lng can never drift apart.
 */
export function buildCityCoords(
  place: Place,
): { lat: number; lng: number } | null {
  if (place.lat != null && place.lng != null) {
    return { lat: place.lat, lng: place.lng };
  }
  return null;
}

/**
 * Spreads city coords into a search-param object.
 * Produces `{ lat, lng }` when coords are present, or `{}` when null,
 * so callers can safely spread the result into any query object.
 */
export function cityCoordSpread(
  coords: { lat: number; lng: number } | null,
): { lat: number; lng: number } | Record<string, never> {
  return coords ?? {};
}
