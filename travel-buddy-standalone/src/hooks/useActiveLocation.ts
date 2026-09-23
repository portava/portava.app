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
import { getCurrentGps, reverseGeocodeToPlace, checkLocationPermission } from '../services/location.ts';
import type { Place } from '../lib/location/placeTypes.ts';
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { onAuthChange } from '../services/auth.ts';
import { buildManualCityState, buildManualCityPayload, buildGpsState, buildGpsRevokedState, shouldRestorePersistedState } from './activeLocation.state';
import {
  DEVICE_ID_HEADER,
  EMPTY_PLACE,
  accountChanged,
  buildAccountChangeState,
  clampFreshnessForPrecision,
  coordsPrecisionOf,
  type CoordsPrecision,
} from './activeLocation.state';
import { _loadHomeFromProfile } from './activeLocation.homeProfile.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type PermissionStatus = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unavailable';
export type LocationSource =
  | 'gps'          // legacy — kept for backward-compat with persisted API payloads
  | 'gps_fresh'    // live fix from getCurrentPositionAsync
  | 'gps_cached'   // fallback from getLastKnownPositionAsync
  | 'last_known'   // server-persisted location from a previous session
  | 'home'         // profile home city — lowest-priority fallback
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
  /**
   * What the SERVER said about a restored coordinate: `precise` only when this
   * device is the one that published it, `approximate` for a grid-snapped point
   * (§17.8 / §30A.7 — a precise share does not follow the account onto a new
   * device). Absent for a coordinate this device measured itself.
   */
  coordsPrecision?: CoordsPrecision;
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


/**
 * This device's registered id, or null.
 *
 * §17.8 / §30A.7: the server binds an ACTIVE PRECISE location to the device
 * that published it, and serves a precise coordinate back only to that device.
 * Presenting the id is therefore how this phone keeps its own fix precise; a
 * phone that has not registered (or a build that cannot reach SecureStore)
 * simply reads a coarse point, which is the safe direction to fail in.
 */
async function deviceIdHeaders(): Promise<Record<string, string>> {
  try {
    const { getRegisteredDeviceId } = await import('../lib/cryptoIdentity.ts');
    const deviceId = await getRegisteredDeviceId();
    return deviceId ? { [DEVICE_ID_HEADER]: deviceId } : {};
  } catch {
    return {};
  }
}

async function saveLocationToApi(patch: object): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const [base, token, deviceHeaders] = await Promise.all([apiBase(), fetchToken(), deviceIdHeaders()]);
    if (!token) return;
    await fetch(`${base}/api/me/location-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...deviceHeaders },
      body: JSON.stringify(patch),
    });
  } catch {
    // non-fatal: local state is still updated
  }
}

async function loadLocationFromApi(): Promise<ActiveLocationState | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const [base, token, deviceHeaders] = await Promise.all([apiBase(), fetchToken(), deviceIdHeaders()]);
    if (!token) return null;
    const res = await fetch(`${base}/api/me/location-state`, {
      headers: { Authorization: `Bearer ${token}`, ...deviceHeaders },
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

    const coordsPrecision = coordsPrecisionOf(d.coordsPrecision);

    return {
      ok: !!(d.coords || d.manualCity),
      permissionStatus: (d.permissionStatus as PermissionStatus) ?? 'unknown',
      coordsPrecision,
      source,
      // A coarse point is never 'live' — see clampFreshnessForPrecision.
      freshness: clampFreshnessForPrecision(computeFreshness(d.updatedAt), coordsPrecision),
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

  const accountRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // §17.8 / §30A.7 — ACCOUNT ISOLATION.
  //
  // A precise position belongs to a device AND to the account that published
  // it. The server refuses to serve a precise fix to a device that did not
  // publish it; this is the client half, and it is the same shape the Input
  // Intelligence lane used for its policy snapshot
  // (`platform/input-assistance/services/policyStore.ts#setActiveAccount` drops
  // the snapshot, `installInputPolicySync.ts#applyAccountChange` erases the
  // caches with it): on an account CHANGE, drop what is held rather than let
  // the next account read the previous one's location.
  //
  // The first notification only records who is signed in — the mount cascade is
  // already loading for them, and clearing here would race it. Every subsequent
  // CHANGE clears.
  useEffect(() => {
    let alive = true;
    const unsubscribe = onAuthChange((userId) => {
      if (!alive) return;
      const held = accountRef.current;
      accountRef.current = userId;
      if (held === undefined) return; // first observation, not a change
      if (!accountChanged(held, userId)) return;
      setLocationState((prev) => buildAccountChangeState(prev));
    });
    return () => { alive = false; unsubscribe(); };
  }, []);

  // On mount: 3-tier cascade:
  //   tier 1 — GPS live/cached (requestLocation, called by the user or auto)
  //   tier 2 — server-persisted last-active (loadLocationFromApi)
  //   tier 3 — profile home city (loadHomeFromProfile)
  useEffect(() => {
    let alive = true;
    (async () => {
      const [permStatus, savedState] = await Promise.all([
        checkLocationPermission(),
        loadLocationFromApi(),
      ]);
      if (!alive) return;

      if (savedState?.ok && shouldRestorePersistedState(permStatus, savedState)) {
        // Tier 2: server-persisted last-active or manual city.
        // shouldRestorePersistedState guards against re-applying stale GPS
        // coords when permission is currently denied (the user revoked GPS
        // after the state was last saved to the server).
        setLocationState({
          ...savedState,
          permissionStatus: permStatus,
          freshness: clampFreshnessForPrecision(
            computeFreshness(savedState.lastUpdatedAt),
            savedState.coordsPrecision ?? null,
          ),
        });
      } else {
        // Tier 3: try profile home city as last resort
        const homeState = await _loadHomeFromProfile(permStatus, {
          isConfigured: isSupabaseConfigured,
          getToken: fetchToken,
          getBase: apiBase,
        });
        if (!alive) return;
        if (homeState) {
          setLocationState(homeState);
        } else {
          // No location at all — just update permission status
          setLocationState((prev) => ({ ...prev, permissionStatus: permStatus }));
        }
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
        setLocationState((prev) => buildGpsRevokedState(prev, permStatus));
        // Persist the cleared state so that on the next app launch the
        // server-persisted coords are gone and the mount cascade cannot
        // restore a location the user has actively blocked.
        await saveLocationToApi({ permissionStatus: permStatus, source: 'none', coords: null });
        return;
      }

      const place = await reverseGeocodeToPlace(gps.lat!, gps.lng!);
      const now = new Date().toISOString();
      const isCached = gps.cached === true;
      const next: ActiveLocationState = buildGpsState(
        gps.lat!, gps.lng!, gps.accuracyMeters, isCached, place, now,
      );

      if (!mountedRef.current) return;
      setLocationState(next);

      await saveLocationToApi({
        source: next.source,
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
