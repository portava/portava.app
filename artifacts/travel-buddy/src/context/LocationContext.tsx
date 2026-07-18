/**
 * LocationContext — app-wide GPS/location state.
 *
 * Wrap the root layout with <LocationProvider>. Any screen or component
 * can then call useLocationContext() to get the current city, request GPS,
 * or set a location via a Place object.
 *
 * showPermissionPrompt is set to true when a location-required feature is
 * first loaded and no location has been captured yet.
 *
 * New in unified-location-source-of-truth:
 *   resolvedLocation  — single source of truth: session override → canonical cascade
 *   setSessionLocation — in-memory temporary override (never persisted)
 *   clearSessionLocation — revert to canonical resolved location
 */
import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import { useActiveLocation } from '../hooks/useActiveLocation.ts';
import type { ActiveLocationState, UseActiveLocationResult, LocationCoords, LocationFreshness, LocationSource } from '../hooks/useActiveLocation.ts';
import { useLocationPreferences } from '../hooks/useLocationPreferences.ts';
import type { LocationPreferences } from '../hooks/useLocationPreferences.ts';
import { useSession } from './SessionContext.tsx';
import type { Place } from '../lib/location/placeTypes.ts';

// ── Resolved location (single source of truth) ────────────────────────────────

/** The canonical location that all location-aware screens should read from. */
export interface ResolvedLocation {
  /** The active Place (city, name, coords). City is the most-used field. */
  place: Place;
  /** Lat/lng coordinates, or null when only a city name is available (e.g. home fallback). */
  coords: LocationCoords | null;
  /** How this location was resolved. Callers can show a freshness indicator for last_known/home. */
  source: LocationSource;
  /** How fresh the underlying data is. */
  freshness: LocationFreshness;
}

// ── Context shape ─────────────────────────────────────────────────────────────

interface LocationContextValue extends UseActiveLocationResult {
  showPermissionPrompt: boolean;
  showCityPicker: boolean;
  requireLocation: (feature?: string) => void;
  dismissPermissionPrompt: () => void;
  openCityPicker: () => void;
  closeCityPicker: () => void;
  /** User's location-privacy preferences, loaded from /api/me/location-preferences */
  locationPrefs: LocationPreferences;
  /** True while preferences are loading on first mount */
  locationPrefsLoading: boolean;
  /** Reload preferences (e.g. after the settings screen saves changes) */
  refreshLocationPrefs: () => Promise<void>;

  // ── Unified location source of truth ─────────────────────────────────────
  /**
   * Single resolved location: session override (if set) → canonical cascade
   * (GPS fresh → GPS cached → server last-known → profile home).
   * All location-aware screens should read from this instead of locationState directly.
   */
  resolvedLocation: ResolvedLocation;
  /**
   * Set a temporary in-memory session location (e.g. city search in Discovery).
   * Never written to the backend or AsyncStorage — cleared on tab focus or app resume.
   */
  setSessionLocation: (place: Place) => void;
  /** Clear the session override and revert to the canonical resolved location. */
  clearSessionLocation: () => void;
}

const LocationContext = createContext<LocationContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

const DISMISSED_KEY = 'location_prompt_dismissed';

export function LocationProvider({ children }: { children: React.ReactNode }) {
  const { isAuthed } = useSession();
  const locationHook = useActiveLocation();
  const { locationState, requestLocation, setManualCity } = locationHook;
  const { prefs: locationPrefs, isLoading: locationPrefsLoading, refresh: refreshLocationPrefs } = useLocationPreferences();

  const [showPermissionPrompt, setShowPermissionPrompt] = useState(false);
  const [showCityPicker, setShowCityPicker] = useState(false);
  // Track whether the user has dismissed the prompt this session
  const [dismissed, setDismissed] = useState(false);

  // ── Session location override (in-memory, never persisted) ────────────────
  const [sessionLocation, setSessionLocationState] = useState<Place | null>(null);

  const setSessionLocation = useCallback((place: Place) => {
    setSessionLocationState(place);
  }, []);

  const clearSessionLocation = useCallback(() => {
    setSessionLocationState(null);
  }, []);

  // ── Resolved location (single source of truth) ────────────────────────────
  const resolvedLocation = useMemo<ResolvedLocation>(() => {
    if (sessionLocation) {
      return {
        place: sessionLocation,
        coords:
          sessionLocation.lat != null && sessionLocation.lng != null
            ? { lat: sessionLocation.lat, lng: sessionLocation.lng, accuracyMeters: null }
            : locationState.coords,
        source: 'manual_city',
        freshness: 'live',
      };
    }
    return {
      place: locationState.place,
      coords: locationState.coords,
      source: locationState.source,
      freshness: locationState.freshness,
    };
  }, [sessionLocation, locationState]);

  // Auto-show prompt once the user is authed, location is unknown, and they
  // haven't dismissed before. Only prompt once per session.
  useEffect(() => {
    if (!isAuthed) return;
    if (dismissed) return;
    if (locationState.permissionStatus === 'unknown') return; // still loading
    if (locationState.ok) return; // already have a location
    if (locationState.permissionStatus === 'denied') return; // can't prompt again
    if (locationState.permissionStatus === 'granted') return; // has permission, just no fix yet

    // Show after a short delay so the main screen settles first
    const timer = setTimeout(() => setShowPermissionPrompt(true), 2000);
    return () => clearTimeout(timer);
  }, [isAuthed, locationState.permissionStatus, locationState.ok, dismissed]);

  const requireLocation = useCallback((_feature?: string) => {
    if (locationState.ok || dismissed) return;
    if (locationState.permissionStatus !== 'denied') {
      setShowPermissionPrompt(true);
    }
  }, [locationState.ok, locationState.permissionStatus, dismissed]);

  const dismissPermissionPrompt = useCallback(() => {
    setShowPermissionPrompt(false);
    setDismissed(true);
  }, []);

  const openCityPicker = useCallback(() => {
    setShowPermissionPrompt(false);
    setShowCityPicker(true);
  }, []);

  const closeCityPicker = useCallback(() => setShowCityPicker(false), []);

  return (
    <LocationContext.Provider
      value={{
        ...locationHook,
        showPermissionPrompt,
        showCityPicker,
        requireLocation,
        dismissPermissionPrompt,
        openCityPicker,
        closeCityPicker,
        locationPrefs,
        locationPrefsLoading,
        refreshLocationPrefs,
        resolvedLocation,
        setSessionLocation,
        clearSessionLocation,
      }}
    >
      {children}
    </LocationContext.Provider>
  );
}

// ── Consumer hook ─────────────────────────────────────────────────────────────

export function useLocationContext(): LocationContextValue {
  const ctx = useContext(LocationContext);
  if (!ctx) throw new Error('useLocationContext must be used inside <LocationProvider>');
  return ctx;
}

// Re-export types so consumers don't need to import from the hook directly
// Note: ResolvedLocation is already exported as `export interface` above — do not re-export here.
export type { ActiveLocationState, LocationContextValue, LocationPreferences, Place };
