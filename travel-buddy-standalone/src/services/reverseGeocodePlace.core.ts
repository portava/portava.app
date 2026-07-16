/**
 * reverseGeocodePlace.core — pure, dependency-injected reverse-geocode logic.
 *
 * Extracted from src/services/location.ts so the three-stage fallback chain
 * (backend API → expo geocoder → coordinate-only stub) can be unit-tested with
 * node:test without importing expo-location (which cannot load under node).
 *
 * `location.ts` wires in the real `fetch` and `Location.reverseGeocodeAsync`;
 * tests inject fakes.
 *
 * Contract (tested in src/services/__tests__/reverseGeocodePlace.test.ts):
 *   Stage 1 — backend /api/places/reverse responds with a place that has an id
 *             → returned as-is, with lat/lng/source:'gps' overlaid.
 *   Stage 2 — backend unreachable / non-ok / empty → expo geocoder result is
 *             mapped to a full Place (city/country/countryCode/etc. populated).
 *   Stage 3 — both fail → coordinate-only stub Place. Never throws, never
 *             returns null — callers always receive a complete Place object.
 */
import type { Place } from '../lib/location/placeTypes.ts';

/** Minimal shape of one expo-location reverse-geocode address result. */
export interface ExpoGeocodeAddress {
  city?: string | null;
  district?: string | null;
  subregion?: string | null;
  region?: string | null;
  country?: string | null;
  isoCountryCode?: string | null;
  name?: string | null;
  street?: string | null;
  postalCode?: string | null;
}

export interface ReverseGeocodeDeps {
  /** Base URL for the backend API ('' for relative). */
  apiBase: string;
  /** fetch-like function used for the backend reverse endpoint. */
  fetchFn: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  /** expo Location.reverseGeocodeAsync-like function. */
  expoReverseGeocode: (coords: { latitude: number; longitude: number }) => Promise<ExpoGeocodeAddress[]>;
}

/** Stage 3: coordinate-only stub — used when every geocode source fails. */
export function coordinateStubPlace(lat: number, lng: number): Place {
  return {
    id: `gps-${lat.toFixed(4)}-${lng.toFixed(4)}`,
    type: 'place' as const,
    name: 'Current Location',
    displayName: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
    country: null,
    countryCode: null,
    region: null,
    city: null,
    district: null,
    lat,
    lng,
    timezone: null,
    source: 'gps' as const,
    address: null,
    postalCode: null,
    formattedAddress: null,
  };
}

/** Stage 2: map one expo geocoder address to a full Place. */
export function expoAddressToPlace(r: ExpoGeocodeAddress, lat: number, lng: number): Place {
  const city = r.city ?? r.subregion ?? r.region ?? null;
  const district = r.district ?? (r.subregion !== city ? r.subregion ?? null : null);
  const country = r.country ?? null;
  const countryCode = r.isoCountryCode ?? null;
  const addressLine = [r.name, r.street].filter(Boolean).join(' ') || null;
  const displayName = [city, country].filter(Boolean).join(', ') || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const formattedAddress = [addressLine, city, country].filter(Boolean).join(', ') || displayName;
  return {
    id: `gps-${lat.toFixed(4)}-${lng.toFixed(4)}`,
    type: 'city' as const,
    name: city ?? displayName,
    displayName,
    country,
    countryCode,
    region: r.region ?? null,
    city,
    district: district ?? null,
    lat,
    lng,
    timezone: null,
    source: 'gps' as const,
    address: addressLine,
    postalCode: r.postalCode ?? null,
    formattedAddress,
  };
}

/**
 * Canonical reverse geocode with injectable deps — returns a full Place.
 * Never throws; falls through the three-stage chain instead.
 */
export async function reverseGeocodeToPlaceCore(
  deps: ReverseGeocodeDeps,
  lat: number,
  lng: number,
): Promise<Place> {
  // Stage 1: backend API
  try {
    const res = await deps.fetchFn(`${deps.apiBase}/api/places/reverse?lat=${lat}&lng=${lng}`);
    if (res.ok) {
      const body = await res.json() as any;
      const p = body?.place;
      if (p && p.id) {
        return {
          ...p,
          lat,
          lng,
          source: 'gps' as const,
        } as Place;
      }
    }
  } catch {
    // Fall through to expo geocoder.
  }

  // Stage 2: expo's built-in geocoder
  try {
    const results = await deps.expoReverseGeocode({ latitude: lat, longitude: lng });
    const r = results?.[0];
    if (r) return expoAddressToPlace(r, lat, lng);
  } catch {
    // Fall through to static fallback.
  }

  // Stage 3: coordinate-only fallback
  return coordinateStubPlace(lat, lng);
}
