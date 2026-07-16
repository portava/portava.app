/**
 * useActiveLocation — app-wide GPS/location state hook.
 *
 * Manages:
 *   - expo-location permission check + request
 *   - One-time GPS capture (getCurrentPositionAsync)
 *   - Reverse geocode → canonical Place object
 *   - Sync to /api/me/location-state (persist across sessions)
 *   - Manual location override (accepts full Place)
 *   - Permission status tracking
 *   - Freshness tracking (live / recent / stale / unavailable)
 *
 * Does NOT run watchPosition (that belongs to Safe Return / active tracking).
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { getCurrentGps, reverseGeocodeToPlace, checkLocationPermission } from '../services/location';
import type { Place } from '../lib/location/placeTypes';
import { isSupabaseConfigured } from '../lib/supabase';
import { buildManualCityState, buildManualCityPayload } from './activeLocation.state';

// ── Types ────────────────────────────────────────────────────────────────────

export type PermissionStatus = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unavailable';
export type LocationSource =
  | 'gps'          // legacy — kept for backward-compat with persisted API payloads
  | 'gps_fresh'    // live fix from getCurrentPositionAsync
  | 'gps_cached'   // fallback from getLastKnownPositionAsync
  | 'last_known'   // legacy alias for gps_cached
  | 'manual_city'
  | 'trip_context'
  | 'post_tag'
  | 'none';
export type LocationFreshness = 'live' | 'recent' | 'stale' | 'unavailable';

export interface LocationCoords {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
}

/**
 * @deprecated Use Place from placeTypes instead.
 * Kept for backward compat with any persisted API shapes that still use this format.
 */
export interface LocationPlace {
  city: string | null;
  district: string | null;
  country: string | null;
  countryCode: string | null;
  formatted: string | null;
}

export interface ActiveLocationState {
  ok: boolean;
  permissionStatus: PermissionStatus;
  source: LocationSource;
  freshness: LocationFreshness;
  coords: LocationCoords | null;
  /** Current active place — always a full canonical Place object. */
  place: Place;
  lastUpdatedAt: string | null;
  userMessage: string | null;
}

export interface UseActiveLocationResult {
  locationState: ActiveLocationState;
  isLoading: boolean;
  requestLocation: () => Promise<void>;
  refreshLocation: () => Promise<void>;
  /** Set the active location from a full Place object. */
  setManualCity: (place: Place) => Promise<void>;
  clearManualCity: () => Promise<void>;
  getLocationForFeature: (feature: string) => ActiveLocationState;
}

// ── Constants ────────────────────────────────────────────────────────────────

const RECENT_THRESHOLD_MS = 15 * 60 * 1000;   // 15 min
const STALE_THRESHOLD_MS  = 60 * 60 * 1000;   // 60 min

const EMPTY_PLACE: Place = {
  id: '',
  type: 'city',
  name: '',
  displayName: '',
  country: null,
  countryCode: null,
  region: null,
  city: null,
  district: null,
  lat: null,
  lng: null,
  timezone: null,
  source: 'manual',
};

const INITIAL_STATE: ActiveLocationState = {
  ok: false,
  permissionStatus: 'unknown',
  source: 'none',
  freshness: 'unavailable',
  coords: null,
  place: EMPTY_PLACE,
  lastUpdatedAt: null,
  userMessage: null,
};

// ── Freshness helper ─────────────────────────────────────────────────────────

function computeFreshness(lastUpdatedAt: string | null): LocationFreshness {
  if (!lastUpdatedAt) return 'unavailable';
  const age = Date.now() - new Date(lastUpdatedAt).getTime();
  if (age < RECENT_THRESHOLD_MS) return 'live';
  if (age < STALE_THRESHOLD_MS)  return 'recent';
  return 'stale';
}

// ── API helpers (no import cycle — fetch directly) ───────────────────────────

async function apiBase(): Promise<string> {
  return (process.env as any).EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function fetchToken(): Promise<string | null> {
  const { freshToken } = await import('../services/apiToken');
  return freshToken();
}

async function saveLocationToApi(patch: object): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const [base, token] = await Promise.all([apiBase(), fetchToken()]);
    if (!token) return;
    await fetch(`${base}/api/me/location-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(patch),
    });
  } catch {
    // non-fatal: local state is still updated
  }
}

async function loadLocationFromApi(): Promise<ActiveLocationState | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const [base, token] = await Promise.all([apiBase(), fetchToken()]);
    if (!token) return null;
    const res = await fetch(`${base}/api/me/location-state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const d = json.locationState;
    if (!d) return null;

    const source: LocationSource = d.manualCity
      ? 'manual_city'
      : d.coords
      ? 'last_known'
      : 'none';

    // Build a Place from the persisted state
    let place: Place;
    if (d.manualCity) {
      const city = d.manualCity as string;
      const country = d.manualCountry as string | null ?? null;
      place = {
        id: `manual-${city.toLowerCase().replace(/\s+/g, '-')}`,
        type: 'city',
        name: city,
        displayName: country ? `${city}, ${country}` : city,
        country,
        countryCode: null,
        region: null,
        city,
        district: null,
        lat: d.coords?.lat ?? null,
        lng: d.coords?.lng ?? null,
        timezone: null,
        source: 'manual',
      };
    } else if (d.place && d.place.id) {
      // Persisted place snapshot — may be a full Place or a legacy LocationPlace
      place = {
        ...EMPTY_PLACE,
        ...(d.place as Partial<Place>),
        source: 'recent',
      };
    } else {
      place = EMPTY_PLACE;
    }

    return {
      ok: !!(d.coords || d.manualCity),
      permissionStatus: (d.permissionStatus as PermissionStatus) ?? 'unknown',
      source,
      freshness: computeFreshness(d.updatedAt),
      coords: d.coords ?? null,
      place,
      lastUpdatedAt: d.updatedAt ?? null,
      userMessage: null,
    };
  } catch {
    return null;
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useActiveLocation(): UseActiveLocationResult {
  const [locationState, setLocationState] = useState<ActiveLocationState>(INITIAL_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // On mount: check permission + load saved state from API
  useEffect(() => {
    let alive = true;
    (async () => {
      const [permStatus, savedState] = await Promise.all([
        checkLocationPermission(),
        loadLocationFromApi(),
      ]);
      if (!alive) return;

      if (savedState) {
        setLocationState({
          ...savedState,
          permissionStatus: permStatus,
          freshness: computeFreshness(savedState.lastUpdatedAt),
        });
      } else {
        setLocationState((prev) => ({ ...prev, permissionStatus: permStatus }));
      }
    })();
    return () => { alive = false; };
  }, []);

  const requestLocation = useCallback(async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      const gps = await getCurrentGps();

      if (!gps.granted) {
        const permStatus: PermissionStatus = gps.error === 'permission_denied' ? 'denied' : 'unavailable';
        if (!mountedRef.current) return;
        setLocationState((prev) => ({
          ...prev,
          permissionStatus: permStatus,
          userMessage: permStatus === 'denied'
            ? 'Location is off. You can still use Travel Buddy by choosing a city manually.'
            : 'GPS timed out. Try again or choose city manually.',
        }));
        await saveLocationToApi({ permissionStatus: permStatus });
        return;
      }

      const place = await reverseGeocodeToPlace(gps.lat!, gps.lng!);
      const now = new Date().toISOString();
      const isCached = gps.cached === true;
      const source: LocationSource = isCached ? 'gps_cached' : 'gps_fresh';
      const next: ActiveLocationState = {
        ok: true,
        permissionStatus: 'granted',
        source,
        freshness: isCached ? 'recent' : 'live',
        coords: { lat: gps.lat!, lng: gps.lng!, accuracyMeters: gps.accuracyMeters },
        place: { ...place, lat: gps.lat!, lng: gps.lng! },
        lastUpdatedAt: now,
        userMessage: isCached
          ? (place.city ? `Showing recent location near ${place.city}.` : 'Showing a recent location. Live GPS unavailable.')
          : (place.city ? null : "We found your location, but couldn't name the city yet."),
      };

      if (!mountedRef.current) return;
      setLocationState(next);

      await saveLocationToApi({
        source,
        permissionStatus: 'granted',
        coords: { lat: gps.lat, lng: gps.lng, accuracyMeters: gps.accuracyMeters },
        place: next.place,
      });
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [isLoading]);

  const refreshLocation = useCallback(async () => {
    const perm = await checkLocationPermission();
    if (perm !== 'granted') {
      setLocationState((prev) => ({ ...prev, permissionStatus: perm }));
      return;
    }
    await requestLocation();
  }, [requestLocation]);

  const setManualCity = useCallback(async (place: Place) => {
    // Pure transition + payload builders are unit-tested in
    // src/hooks/__tests__/universalLocation.setLocation.test.ts.
    const next = buildManualCityState(locationState, place, new Date().toISOString());
    setLocationState(next);
    await saveLocationToApi(buildManualCityPayload(place));
  }, [locationState]);

  const clearManualCity = useCallback(async () => {
    setLocationState((prev) => ({
      ...prev,
      source: prev.coords ? 'gps_cached' : 'none',
      place: prev.coords ? prev.place : EMPTY_PLACE,
    }));
    await saveLocationToApi({ manualCity: null, manualCountry: null });
  }, []);

  const getLocationForFeature = useCallback(
    (_feature: string): ActiveLocationState => locationState,
    [locationState],
  );

  return {
    locationState,
    isLoading,
    requestLocation,
    refreshLocation,
    setManualCity,
    clearManualCity,
    getLocationForFeature,
  };
}
