/**
 * useUniversalLocation — single public API for all location needs.
 *
 * This is the only import screens need for location. They no longer import
 * from useActiveLocation, useLocationContext, usePlaceSearch, or
 * src/services/location directly.
 *
 * Exposes:
 *   location          — current active Place | null
 *   isLoading         — GPS / context loading state
 *   permissionStatus  — current permission status
 *   setLocation(place) — set manual location (replaces setManualCity)
 *   requestGPS()      — request GPS fix + reverse geocode
 *   searchPlaces()    — imperative place search with 5-min cache
 *   reverseGeocode()  — reverse geocode lat/lng → Place
 *   recentPlaces      — recently used places
 *   openPicker()      — open the GlobalPlacePicker sheet
 */
import { useCallback } from 'react';
import { useLocationContext } from '../context/LocationContext.tsx';
import { useRecentPlaces } from './useRecentPlaces.ts';
import { reverseGeocodeToPlace } from '../services/location.ts';
import { fetchPlacesFromApi } from './usePlaceSearch.ts';
import { deriveUniversalLocation } from './activeLocation.state.ts';
import type { Place } from '../lib/location/placeTypes.ts';

export interface UseUniversalLocationResult {
  /** Currently active location (null if not yet set / permission denied) */
  location: Place | null;
  /** True while GPS is being acquired or location context is loading */
  isLoading: boolean;
  /** Current location permission status */
  permissionStatus: 'unknown' | 'prompt' | 'granted' | 'denied' | 'unavailable';
  /** Set a place as the active location (e.g. from picker or manual entry) */
  setLocation: (place: Place) => Promise<void>;
  /** Request a GPS fix and resolve to a Place */
  requestGPS: () => Promise<void>;
  /** Imperative place search with 5-min cache */
  searchPlaces: (
    query: string,
    opts?: { countryCode?: string; lat?: number; lng?: number },
  ) => Promise<Place[]>;
  /** Reverse geocode coordinates to a full Place */
  reverseGeocode: (lat: number, lng: number) => Promise<Place>;
  /** Recently used places (from /api/me/recent-places) */
  recentPlaces: Place[];
  /** Open the GlobalPlacePicker modal */
  openPicker: () => void;
}

export function useUniversalLocation(): UseUniversalLocationResult {
  const ctx = useLocationContext();
  const { recents } = useRecentPlaces();

  const { locationState, isLoading, setManualCity, requestLocation, openCityPicker } = ctx;

  // Derive a Place | null from the context state.
  // locationState.place is already a Place (after useActiveLocation migration).
  // We return null when the location is not yet set / ok.
  const location: Place | null = deriveUniversalLocation(locationState);

  const setLocation = useCallback(
    async (place: Place) => {
      await setManualCity(place);
    },
    [setManualCity],
  );

  const requestGPS = useCallback(async () => {
    await requestLocation();
  }, [requestLocation]);

  const searchPlaces = useCallback(
    (
      query: string,
      opts?: { countryCode?: string; lat?: number; lng?: number },
    ): Promise<Place[]> => {
      if (!query.trim()) return Promise.resolve([]);
      return fetchPlacesFromApi(query, opts);
    },
    [],
  );

  const reverseGeocode = useCallback(
    (lat: number, lng: number): Promise<Place> => reverseGeocodeToPlace(lat, lng),
    [],
  );

  const openPicker = useCallback(() => {
    openCityPicker();
  }, [openCityPicker]);

  return {
    location,
    isLoading,
    permissionStatus: locationState.permissionStatus,
    setLocation,
    requestGPS,
    searchPlaces,
    reverseGeocode,
    recentPlaces: recents,
    openPicker,
  };
}
