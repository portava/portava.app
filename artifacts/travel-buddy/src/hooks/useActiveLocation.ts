/**
 * useActiveLocation — app-wide GPS/location state hook.
 *
 * Manages:
 *   - expo-location permission check + request
 *   - One-time GPS capture (getCurrentPositionAsync)
 *   - expo reverse geocode → place object
 *   - Sync to /api/me/location-state (persist across sessions)
 *   - Manual city override
 *   - Permission status tracking
 *   - Freshness tracking (live / recent / stale / unavailable)
 *
 * Does NOT run watchPosition (that belongs to Safe Return / active tracking).
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import * as Location from 'expo-location';
import { getCurrentGps, reverseGeocodeDetailed, checkLocationPermission } from '../services/location';
import { isSupabaseConfigured } from '../lib/supabase';

// ── Types ────────────────────────────────────────────────────────────────────

export type PermissionStatus = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unavailable';
export type LocationSource = 'gps' | 'last_known' | 'manual_city' | 'trip_context' | 'post_tag' | 'none';
export type LocationFreshness = 'live' | 'recent' | 'stale' | 'unavailable';

export interface LocationCoords {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
}

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
  place: LocationPlace;
  lastUpdatedAt: string | null;
  userMessage: string | null;
}

export interface UseActiveLocationResult {
  locationState: ActiveLocationState;
  isLoading: boolean;
  requestLocation: () => Promise<void>;
  refreshLocation: () => Promise<void>;
  setManualCity: (city: string, country?: string) => Promise<void>;
  clearManualCity: () => Promise<void>;
  getLocationForFeature: (feature: string) => ActiveLocationState;
}

// ── Constants ────────────────────────────────────────────────────────────────

const RECENT_THRESHOLD_MS = 15 * 60 * 1000;   // 15 min
const STALE_THRESHOLD_MS  = 60 * 60 * 1000;   // 60 min

const EMPTY_PLACE: LocationPlace = {
  city: null,
  district: null,
  country: null,
  countryCode: null,
  formatted: null,
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
  try {
    const { supabase } = await import('../lib/supabase');
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token ?? null;
  } catch {
    return null;
  }
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

    return {
      ok: !!(d.coords || d.manualCity),
      permissionStatus: (d.permissionStatus as PermissionStatus) ?? 'unknown',
      source,
      freshness: computeFreshness(d.updatedAt),
      coords: d.coords ?? null,
      place: d.manualCity
        ? { city: d.manualCity, district: null, country: d.manualCountry ?? null, countryCode: null, formatted: d.manualCity }
        : (d.place ?? EMPTY_PLACE),
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
        setLocationState((prev) => ({
          ...savedState,
          permissionStatus: permStatus,
          freshness: computeFreshness(savedState.lastUpdatedAt),
        }));
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

      const place = await reverseGeocodeDetailed(gps.lat!, gps.lng!);
      const now = new Date().toISOString();
      const next: ActiveLocationState = {
        ok: true,
        permissionStatus: 'granted',
        source: 'gps',
        freshness: 'live',
        coords: { lat: gps.lat!, lng: gps.lng!, accuracyMeters: gps.accuracyMeters },
        place,
        lastUpdatedAt: now,
        userMessage: place.city ? null : "We found your location, but couldn't name the city yet.",
      };

      if (!mountedRef.current) return;
      setLocationState(next);

      await saveLocationToApi({
        source: 'gps',
        permissionStatus: 'granted',
        coords: { lat: gps.lat, lng: gps.lng, accuracyMeters: gps.accuracyMeters },
        place,
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

  const setManualCity = useCallback(async (city: string, country?: string) => {
    const trimmedCity = city.trim();
    if (!trimmedCity) return;
    const now = new Date().toISOString();
    const next: ActiveLocationState = {
      ok: true,
      permissionStatus: locationState.permissionStatus,
      source: 'manual_city',
      freshness: 'live',
      coords: locationState.coords,
      place: { city: trimmedCity, district: null, country: country ?? null, countryCode: null, formatted: trimmedCity },
      lastUpdatedAt: now,
      userMessage: null,
    };
    setLocationState(next);
    await saveLocationToApi({ source: 'manual_city', manualCity: trimmedCity, manualCountry: country ?? null });
  }, [locationState]);

  const clearManualCity = useCallback(async () => {
    setLocationState((prev) => ({
      ...prev,
      source: prev.coords ? 'last_known' : 'none',
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
