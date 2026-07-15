/**
 * Location service — GPS capture + reverse geocode using expo-location.
 *
 * The composer, Pulse, Discovery, and Postcards use this for one-time
 * location reads. Active/persistent tracking lives in useActiveLocation.
 *
 * If permission is denied or GPS fails we return graceful nulls — posting
 * is never blocked and we never fabricate coordinates.
 *
 * The backend decides verification; this only supplies the user's real GPS.
 */
import * as Location from 'expo-location';
import type { Place } from '../lib/location/placeTypes';
import { reverseGeocodeToPlaceCore } from './reverseGeocodePlace.core';

export interface GpsResult {
  granted: boolean;
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
  /** true when the fix came from getLastKnownPositionAsync (cached), false for a fresh fix */
  cached?: boolean;
  error?: string;
}

/** Hard timeout for a live GPS fix before falling back to last-known position. */
const GPS_TIMEOUT_MS = 8_000;

export interface PlaceResult {
  city: string | null;
  district: string | null;
  country: string | null;
  countryCode: string | null;
  formatted: string | null;
}

/** Legacy slim result — kept for backward compat with the composer. */
export interface ReverseGeocodeResult {
  city: string | null;
  country: string | null;
  name: string | null;
}

export async function getCurrentGps(): Promise<GpsResult> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      return { granted: false, lat: null, lng: null, accuracyMeters: null, error: 'permission_denied' };
    }

    // Race a live fix against a hard timeout so GPS never stalls the UI indefinitely.
    const liveFixPromise = Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    const timeoutPromise = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error('gps_timeout')), GPS_TIMEOUT_MS),
    );

    try {
      const pos = await Promise.race([liveFixPromise, timeoutPromise]) as Location.LocationObject;
      return {
        granted: true,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyMeters: pos.coords.accuracy ?? null,
        cached: false,
      };
    } catch {
      // Live fix timed out or failed — fall back to the last known position.
    }

    // Last-known fallback: accept a cached fix up to 5 min old with ≤500 m accuracy.
    try {
      const last = await Location.getLastKnownPositionAsync({
        maxAge: 5 * 60 * 1000,
        requiredAccuracy: 500,
      });
      if (last) {
        return {
          granted: true,
          lat: last.coords.latitude,
          lng: last.coords.longitude,
          accuracyMeters: last.coords.accuracy ?? null,
          cached: true,
        };
      }
    } catch {
      // No cached position available.
    }

    return { granted: false, lat: null, lng: null, accuracyMeters: null, error: 'gps_failed' };
  } catch (e) {
    return {
      granted: false,
      lat: null,
      lng: null,
      accuracyMeters: null,
      error: e instanceof Error ? e.message : 'gps_failed',
    };
  }
}

/** Check permission without prompting. */
export async function checkLocationPermission(): Promise<'granted' | 'denied' | 'prompt' | 'unavailable'> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return 'unavailable';
  }
}

/**
 * Canonical reverse geocode — returns a full Place object.
 *
 * Tries the backend /api/places/reverse endpoint first (supports Nominatim
 * with Mapbox fallback). Falls back to expo's built-in geocoder if the API
 * is unreachable or returns no result.
 */
export async function reverseGeocodeToPlace(lat: number, lng: number): Promise<Place> {
  const apiBase = (process.env as any).EXPO_PUBLIC_API_BASE_URL ?? '';
  // Delegate to the pure core (unit-tested in reverseGeocodePlace.test.ts),
  // wiring in the real fetch + expo geocoder.
  return reverseGeocodeToPlaceCore(
    {
      apiBase,
      fetchFn: (url) => fetch(url),
      expoReverseGeocode: (coords) => Location.reverseGeocodeAsync(coords),
    },
    lat,
    lng,
  );
}

/**
 * Full reverse geocode with district + countryCode.
 * @deprecated Use reverseGeocodeToPlace() instead — it returns a canonical Place.
 */
export async function reverseGeocodeDetailed(lat: number, lng: number): Promise<PlaceResult> {
  const place = await reverseGeocodeToPlace(lat, lng);
  return {
    city: place.city ?? null,
    district: place.district ?? null,
    country: place.country ?? null,
    countryCode: place.countryCode ?? null,
    formatted: place.formattedAddress ?? place.displayName ?? null,
  };
}

/**
 * Slim reverse geocode — kept for backward compat with the composer.
 * @deprecated Use reverseGeocodeToPlace() instead.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
  const place = await reverseGeocodeToPlace(lat, lng);
  return {
    city: place.city ?? null,
    country: place.country ?? null,
    name: place.displayName ?? null,
  };
}
