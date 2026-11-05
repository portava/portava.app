/**
 * Where a trip's destination is: its coordinates, canonical place id and time
 * zone, shaped as PATCH /trips/:id fields.
 *
 * POST /trips takes only the destination's city and country (CreateTripSchema,
 * and the Trip Kernel's CREATE_TRIP insert), and the edit screen never sent the
 * rest. So no trip made in the app had destination_lat/lng: it never showed on
 * the map (mapEntityFilters needs both), Trip Offline had no point to save, and
 * passport memory pins fell back to a city centroid. The PATCH route and
 * UPDATE_TRIP already accept these columns, so the create screen sends them in
 * a follow-up PATCH and the edit screen sends them with its save.
 *
 * Pure: the screens pass in what the picker gave them.
 */

export interface TripDestinationGeo {
  destinationLat: number | null;
  destinationLng: number | null;
  destinationPlaceId: string | null;
  /** Sent only when known; a missing zone never clears a stored one. */
  timezone?: string;
}

/** Anything a picker hands back: a canonical binding, a Place, a multi-city stop. */
export interface GeoSource {
  lat?: number | null;
  lng?: number | null;
  canonicalId?: string | null;
  timezone?: string | null;
}

function validPoint(s: GeoSource | null | undefined): s is GeoSource & { lat: number; lng: number } {
  return !!s
    && typeof s.lat === 'number' && Number.isFinite(s.lat) && Math.abs(s.lat) <= 90
    && typeof s.lng === 'number' && Number.isFinite(s.lng) && Math.abs(s.lng) <= 180
    // (0, 0) is open sea off Africa; every provider that has no point sends it.
    && !(s.lat === 0 && s.lng === 0);
}

function firstText(values: Array<string | null | undefined>): string | null {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

/**
 * The geo fields for a destination, from the first source that has a valid
 * point (and the first canonical id and zone among all of them), or null when
 * no source knows anything. Sources go best first: the canonical binding, then
 * the picked place.
 */
export function tripDestinationGeo(...sources: Array<GeoSource | null | undefined>): TripDestinationGeo | null {
  const point = sources.find(validPoint);
  const placeId = firstText(sources.map((s) => s?.canonicalId));
  const timezone = firstText(sources.map((s) => s?.timezone));
  if (!point && !placeId) return null;
  return {
    destinationLat: point ? point.lat : null,
    destinationLng: point ? point.lng : null,
    destinationPlaceId: placeId,
    ...(timezone ? { timezone } : {}),
  };
}

/**
 * What the edit screen sends with its save.
 *
 *  - The destination was picked again: its geo, or explicit nulls when the new
 *    pick has none, so the old city's point does not stay on the trip.
 *  - Not picked again, and the trip has no point yet (made before this was
 *    saved): the resolved destination's geo, to fill it in.
 *  - Otherwise nothing, so a stored point is never replaced by a coarser one.
 */
export function tripDestinationGeoForEdit(
  opts: { repicked: boolean; storedHasPoint: boolean },
  ...sources: Array<GeoSource | null | undefined>
): Partial<TripDestinationGeo> {
  const geo = tripDestinationGeo(...sources);
  if (opts.repicked) return geo ?? { destinationLat: null, destinationLng: null, destinationPlaceId: null };
  if (!opts.storedHasPoint && geo && geo.destinationLat !== null) {
    const { timezone: _zone, ...point } = geo; // filling in a point, not changing the trip's zone
    return point;
  }
  return {};
}
