/**
 * LocationContext — app-wide GPS/location state.
 *
 * Wrap the root layout with <LocationProvider>. Any screen or component
 * can then call useLocationContext() to get the current city, request GPS,
 * or set a manual city.
 *
 * showPermissionPrompt is set to true when a location-required feature is
 * first loaded and no location has been captured yet.
 */
import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useActiveLocation } from '../hooks/useActiveLocation';
import type { ActiveLocationState, UseActiveLocationResult } from '../hooks/useActiveLocation';
import { useSession } from './SessionContext';

// ── Context shape ─────────────────────────────────────────────────────────────

interface LocationContextValue extends UseActiveLocationResult {
  showPermissionPrompt: boolean;
  showCityPicker: boolean;
  requireLocation: (feature?: string) => void;
  dismissPermissionPrompt: () => void;
  openCityPicker: () => void;
  closeCityPicker: () => void;
}

const LocationContext = createContext<LocationContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

const DISMISSED_KEY = 'location_prompt_dismissed';

export function LocationProvider({ children }: { children: React.ReactNode }) {
  const { isAuthed } = useSession();
  const locationHook = useActiveLocation();
  const { locationState, requestLocation, setManualCity } = locationHook;

  const [showPermissionPrompt, setShowPermissionPrompt] = useState(false);
  const [showCityPicker, setShowCityPicker] = useState(false);
  // Track whether the user has dismissed the prompt this session
  const [dismissed, setDismissed] = useState(false);

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
export type { ActiveLocationState, LocationContextValue };
