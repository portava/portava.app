/**
 * activeLocation.state — pure state transitions for useActiveLocation.
 *
 * Extracted so the setManualCity / setLocation path (the one
 * useUniversalLocation().setLocation delegates to) can be unit-tested with
 * node:test without React or expo-location.
 *
 * Contract (tested in src/hooks/__tests__/universalLocation.setLocation.test.ts):
 *   - buildManualCityState(prev, place, nowIso) returns an ok:true state whose
 *     `place` is the exact Place passed in — no fields dropped.
 *   - buildGpsState(lat, lng, accuracyMeters, isCached, place, nowIso) returns
 *     an ok:true state with source:'gps_fresh'|'gps_cached', completely
 *     replacing any prior place (including source:'home').
 *   - deriveUniversalLocation(state) is the same derivation
 *     useUniversalLocation uses to expose `location`; after a set it returns
 *     the same Place.
 *   - buildManualCityPayload(place) is what gets persisted to
 *     /api/me/location-state; it always carries the full place plus the
 *     legacy manualCity/manualCountry columns.
 */
import type { ActiveLocationState, LocationSource, LocationFreshness } from './useActiveLocation.ts';
import type { Place } from '../lib/location/placeTypes.ts';

/**
 * State transition applied when `requestLocation` succeeds.
 *
 * Completely replaces whatever was in `prev` (including source:'home') with the
 * live or cached GPS fix + reverse-geocoded place.  The previous place is not
 * merged — it is discarded so a home-city fallback cannot linger after GPS
 * becomes available.
 */
export function buildGpsState(
  lat: number,
  lng: number,
  accuracyMeters: number | null,
  isCached: boolean,
  place: Place,
  nowIso: string,
): ActiveLocationState {
  const source: LocationSource = isCached ? 'gps_cached' : 'gps_fresh';
  const freshness: LocationFreshness = isCached ? 'recent' : 'live';
  return {
    ok: true,
    permissionStatus: 'granted',
    source,
    freshness,
    coords: { lat, lng, accuracyMeters },
    place: { ...place, lat, lng },
    lastUpdatedAt: nowIso,
    userMessage: isCached
      ? (place.city ? `Showing recent location near ${place.city}.` : 'Showing a recent location. Live GPS unavailable.')
      : (place.city ? null : "We found your location, but couldn't name the city yet."),
  };
}

/** State transition applied when the user sets a manual location (picker, map, etc.). */
export function buildManualCityState(
  prev: ActiveLocationState,
  place: Place,
  nowIso: string,
): ActiveLocationState {
  return {
    ok: true,
    permissionStatus: prev.permissionStatus,
    source: 'manual_city',
    freshness: 'live',
    coords: place.lat != null && place.lng != null
      ? { lat: place.lat, lng: place.lng, accuracyMeters: null }
      : prev.coords,
    place,
    lastUpdatedAt: nowIso,
    userMessage: null,
  };
}

/** Persistence payload for /api/me/location-state on a manual set. */
export function buildManualCityPayload(place: Place): {
  source: 'manual_city';
  manualCity: string | null;
  manualCountry: string | null;
  place: Place;
} {
  return {
    source: 'manual_city',
    manualCity: place.city ?? place.name,
    manualCountry: place.country ?? null,
    place,
  };
}

/**
 * The exact derivation useUniversalLocation uses to expose `location`:
 * the active Place when the state is ok, otherwise null.
 */
export function deriveUniversalLocation(state: ActiveLocationState): Place | null {
  return state.ok ? state.place : null;
}
