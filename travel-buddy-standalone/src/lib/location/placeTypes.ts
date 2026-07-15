/**
 * Shared Place type definitions for GlobalPlacePicker, GPSPlaceLibrary,
 * and all location fields across the app.
 */

export type PlaceType =
  | 'country'
  | 'region'
  | 'city'
  | 'town'
  | 'district'
  | 'neighborhood'
  | 'place'
  | 'landmark'
  | 'airport';

export type LocationPrivacy = 'hidden' | 'city' | 'neighborhood' | 'exact';

export interface Place {
  id: string;
  type: PlaceType;
  name: string;
  displayName: string;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  district: string | null;
  lat: number | null;
  lng: number | null;
  timezone: string | null;
  source: 'nominatim' | 'foursquare' | 'gps' | 'manual' | 'legacy' | 'recent' | 'canonical';
  /**
   * Canonical location id from the universal location registry.
   * All provider variants of one real-world location ("Cebu", "Cebu City",
   * a Foursquare venue id) share the same canonicalId once resolved.
   * Null/undefined when the selection has not been resolved yet.
   */
  canonicalId?: string | null;
  confidence?: number;
  /** Street-level address line (may be null for city-level results) */
  address?: string | null;
  /** Postal / ZIP code (may be null for city-level results) */
  postalCode?: string | null;
  /** Full human-readable formatted address string */
  formattedAddress?: string | null;
}

export interface RecentPlace {
  id: string;
  place: Place;
  usedFor?: string;
  usedAt: string;
}

/** Convert a raw city/country string pair into a minimal Place snapshot (legacy compat). */
export function legacyToPlace(city: string, country?: string): Place {
  return {
    id: `legacy-${city.toLowerCase().replace(/\s+/g, '-')}`,
    type: 'city',
    name: city,
    displayName: country ? `${city}, ${country}` : city,
    country: country ?? null,
    countryCode: null,
    region: null,
    city,
    district: null,
    lat: null,
    lng: null,
    timezone: null,
    source: 'legacy',
    address: null,
    postalCode: null,
    formattedAddress: country ? `${city}, ${country}` : city,
  };
}
