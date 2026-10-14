/**
 * locationContextValue — the READ-ONLY half of the app-wide location context.
 *
 * WHY THIS IS A SEPARATE MODULE (census-layover L164, §70)
 * =======================================================
 * L164: location is requested "when enabling live return assistance / map
 * context, not solely because Layover exists". The layover map card mounts
 * `PlaceDetailSheet`, which only READS where the viewer is (to show a distance).
 * It used to read that through `LocationContext.tsx`, which imports the
 * app-root location hook, which reaches the OS prompt in `services/location.ts`
 * — so the layover surface's import graph contained the app's location prompt
 * even though nothing on it asked for one, and the L164 guard could only except
 * those files by name.
 *
 * This module is everything a reader needs and nothing a requester needs:
 *
 *   - `ResolvedLocation`, the one location shape screens read;
 *   - `ResolvedLocationContext`, provided by `LocationProvider` (mounted once at
 *     the app root) with the SAME value `useLocationContext().resolvedLocation`
 *     returns — so every screen reads one source of truth;
 *   - `useResolvedLocation()`, which returns that DATA and nothing else.
 *
 * The context value carries no function: a module that reads location through
 * here cannot request, refresh or require it, because nothing it can reach does.
 * The requesting half (the request / refresh / require functions and the
 * permission sheet) stays on `useLocationContext()` in `LocationContext.tsx`.
 * (Those function names are not written here on purpose: the guard scans this
 * file's raw text, and a reader module that names a request function fails it.)
 *
 * WHAT THIS MODULE MAY IMPORT: `react` and types with no location API behind
 * them. The L164 guard (`src/lib/__tests__/layoverSensingCadence.test.ts`)
 * pins that the layover surface reaches this module and not the provider.
 */
import { createContext, useContext } from 'react';
import type { LocationCoords, LocationFreshness, LocationSource } from '../hooks/activeLocation.types.ts';
import type { Place } from '../lib/location/placeTypes.ts';

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

/**
 * Provided by `LocationProvider` alongside the full context. Its value is the
 * resolved location itself — data only, never a function.
 */
export const ResolvedLocationContext = createContext<ResolvedLocation | null>(null);

/**
 * The resolved location (session override → canonical cascade), read-only.
 *
 * Throws outside `<LocationProvider>`, exactly as `useLocationContext()` does:
 * a reader mounted without the root provider is a wiring defect, not a viewer
 * with no location.
 */
export function useResolvedLocation(): ResolvedLocation {
  const value = useContext(ResolvedLocationContext);
  if (!value) throw new Error('useResolvedLocation must be used inside <LocationProvider>');
  return value;
}
