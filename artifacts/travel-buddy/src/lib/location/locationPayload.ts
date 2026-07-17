/**
 * placeToLocationFields — the ONE mapping from a picker `Place` to the
 * normalized location fields the API accepts for content rows
 * (postcards → posts table, memories → memories table).
 *
 * Both composers use this so the two flows can never drift: same city
 * fallback (city ?? name), same provider placeId, same canonical registry id.
 * Coordinates are the picker's place-level coordinates (city/landmark
 * centroid), never a raw GPS fix, and the backend's existing privacy rules
 * govern when they become publicly visible.
 */
import type { Place } from './placeTypes.ts';

export interface ContentLocationFields {
  locationCity?: string;
  locationCountry?: string;
  locationLat?: number;
  locationLng?: number;
  placeId?: string;
  canonicalLocationId?: string;
}

export function placeToLocationFields(place: Place | null | undefined): ContentLocationFields {
  if (!place) return {};
  return {
    locationCity: place.city ?? place.name,
    locationCountry: place.country ?? undefined,
    locationLat: place.lat ?? undefined,
    locationLng: place.lng ?? undefined,
    placeId: place.id,
    canonicalLocationId: place.canonicalId ?? undefined,
  };
}
