/**
 * Pure map-entity privacy / visibility filters.
 *
 * Extracted from useMapEntities so they can be unit-tested directly: the hook
 * itself imports React and the service layer (Supabase / expo), which cannot be
 * loaded in the node:test runner, so the privacy tests used to hand-copy this
 * logic (and a mutation to the real hook left them green). useMapEntities now
 * imports these helpers, so a change here changes real product behaviour and the
 * privacy unit tests bind to this exact source.
 */

/** Fields the event visibility guard reads (subset of EventListItem). */
export interface MapEventVisibilityFields {
  visibility: string;
  locationLat: number | null;
  locationLng: number | null;
}

/** Fields the trip visibility guard reads (subset of TripRow). */
export interface MapTripVisibilityFields {
  visibility: string;
  destinationLat: number | null;
  destinationLng: number | null;
}

/**
 * Deterministic ±0.01° jitter (~1 km) based on a string seed so a friend marker
 * position is stable between renders but never reveals an exact coordinate.
 */
export function deterministicJitter(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  }
  // Map unsigned 16-bit hash to [-0.01, +0.01]
  return ((h & 0xffff) / 0x10000 - 0.5) * 0.02;
}

/** Coarsen a friend's exact coordinate to area level via deterministic jitter. */
export function coarsenForFriend(
  userId: string,
  lat: number,
  lng: number,
): { lat: number; lng: number } {
  return {
    lat: lat + deterministicJitter(userId + ':lat'),
    lng: lng + deterministicJitter(userId + ':lng'),
  };
}

/**
 * Only located public / friends_only events may appear as public map pins.
 * invite_only / circle / trip events are never meant for general discovery and
 * must never surface as public pins.
 */
export function isMapVisibleEvent(ev: MapEventVisibilityFields): boolean {
  if (ev.locationLat == null || ev.locationLng == null) return false;
  if (
    ev.visibility === 'invite_only' ||
    ev.visibility === 'circle' ||
    ev.visibility === 'trip'
  ) return false;
  return true;
}

/** Private trips, and trips without a destination coordinate, never appear on the map. */
export function isMapVisibleTrip(trip: MapTripVisibilityFields): boolean {
  return (
    trip.visibility !== 'private' &&
    trip.destinationLat != null &&
    trip.destinationLng != null
  );
}
