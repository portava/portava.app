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
import type { ActiveLocationState, LocationSource, LocationFreshness, PermissionStatus } from './useActiveLocation.ts';
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
 * State transition applied when `requestLocation` is called but permission is
 * denied or unavailable — i.e. the user revoked GPS access after it was live.
 *
 * When the previous source was a GPS source ('gps_fresh', 'gps_cached', 'gps'),
 * the stale GPS coords and place are cleared so the UI never shows a location
 * the user has actively blocked.  Non-GPS sources (home, manual_city, etc.)
 * are left intact — only the permissionStatus is updated.
 */
export function buildGpsRevokedState(
  prev: ActiveLocationState,
  permStatus: PermissionStatus,
): ActiveLocationState {
  const isGpsSource =
    prev.source === 'gps_fresh' ||
    prev.source === 'gps_cached' ||
    prev.source === 'gps';

  if (!isGpsSource) {
    // Non-GPS location (home city, manual, etc.) is still valid — just update status.
    return {
      ...prev,
      permissionStatus: permStatus,
      userMessage:
        permStatus === 'denied'
          ? 'Location is off. You can still use Travel Buddy by choosing a city manually.'
          : 'GPS timed out. Try again or choose city manually.',
    };
  }

  // GPS was the active source — clear it to avoid showing a blocked location.
  return {
    ...prev,
    ok: false,
    permissionStatus: permStatus,
    source: 'none',
    freshness: 'unavailable',
    coords: null,
    userMessage:
      permStatus === 'denied'
        ? 'Location is off. You can still use Travel Buddy by choosing a city manually.'
        : 'GPS timed out. Try again or choose city manually.',
  };
}

/**
 * The exact derivation useUniversalLocation uses to expose `location`:
 * the active Place when the state is ok, otherwise null.
 */
export function deriveUniversalLocation(state: ActiveLocationState): Place | null {
  return state.ok ? state.place : null;
}

/**
 * Decides whether a server-persisted location state should be restored on
 * mount, given the *current* permission status.
 *
 * `loadLocationFromApi` maps GPS coords (no manualCity) to source:'last_known'.
 * When GPS permission is currently denied we must NOT restore that state —
 * the user revoked access after the coords were saved, and showing them again
 * would contradict the revocation.
 *
 * Manual-city and home-city states are unaffected because:
 *   - manual_city keeps source:'manual_city' regardless of permission
 *   - home is loaded from the profile endpoint, never from persisted GPS coords
 */
export function shouldRestorePersistedState(
  permStatus: PermissionStatus,
  savedState: ActiveLocationState,
): boolean {
  if (permStatus === 'denied' && savedState.source === 'last_known') {
    return false;
  }
  return true;
}
