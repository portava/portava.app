/**
 * useLocationPreferences — loads the user's location-privacy preferences from
 * the API server and exposes the values consumed across location-aware screens.
 *
 * Returns:
 *   locationMode           — off | city_only | nearby | live_during_activity | trusted_circle_live
 *   sharingPaused          — true when sharing is temporarily paused
 *   effectivePulseVisibility — computed effective visibility (respects sharingPaused)
 *   discoveryVisibility    — discovery-specific visibility level
 *   hotelBlurEnabled       — whether exact hotel location is blurred
 *   isLoading              — true while the first fetch is in flight
 */
import { useState, useEffect, useCallback } from 'react';
import { useSession } from '../context/SessionContext';
import { freshToken } from '../services/apiToken';

export type LocationMode =
  | 'off'
  | 'city_only'
  | 'nearby'
  | 'live_during_activity'
  | 'trusted_circle_live';

export type PulseVisibility =
  | 'no_location'
  | 'city_only'
  | 'neighborhood'
  | 'venue_tagged'
  | 'exact_hidden';

export interface LocationPreferences {
  locationMode: LocationMode;
  sharingPaused: boolean;
  pulseVisibility: PulseVisibility | null;
  discoveryVisibility: PulseVisibility | null;
  effectivePulseVisibility: PulseVisibility;
  safeReturnEnabled: boolean;
  trustedCircleShare: boolean;
  hotelBlurEnabled: boolean;
}

const DEFAULT_PREFS: LocationPreferences = {
  locationMode: 'city_only',
  sharingPaused: false,
  pulseVisibility: null,
  discoveryVisibility: null,
  effectivePulseVisibility: 'city_only',
  safeReturnEnabled: true,
  trustedCircleShare: false,
  hotelBlurEnabled: true,
};

const MODE_DEFAULT_VISIBILITY: Record<LocationMode, PulseVisibility> = {
  off:                  'no_location',
  city_only:            'city_only',
  nearby:               'neighborhood',
  live_during_activity: 'neighborhood',
  trusted_circle_live:  'venue_tagged',
};

function computeEffectiveVisibility(prefs: Omit<LocationPreferences, 'effectivePulseVisibility'>): PulseVisibility {
  if (prefs.locationMode === 'off' || prefs.sharingPaused) return 'no_location';
  return prefs.pulseVisibility ?? MODE_DEFAULT_VISIBILITY[prefs.locationMode];
}

export interface UseLocationPreferencesResult {
  prefs: LocationPreferences;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useLocationPreferences(): UseLocationPreferencesResult {
  const { isAuthed } = useSession();
  const [prefs, setPrefs] = useState<LocationPreferences>(DEFAULT_PREFS);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!isAuthed) return;
    const token = await freshToken();
    if (!token) return;

    setIsLoading(true);
    try {
      const base = (process.env as any).EXPO_PUBLIC_API_BASE_URL ?? '';
      const res = await fetch(`${base}/api/me/location-preferences`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json() as {
        locationMode?: string;
        sharingPaused?: boolean;
        pulseVisibility?: string | null;
        discoveryVisibility?: string | null;
        safeReturnEnabled?: boolean;
        trustedCircleShare?: boolean;
        hotelBlurEnabled?: boolean;
      };

      const partial: Omit<LocationPreferences, 'effectivePulseVisibility'> = {
        locationMode:       (data.locationMode as LocationMode) ?? 'city_only',
        sharingPaused:      data.sharingPaused ?? false,
        pulseVisibility:    (data.pulseVisibility as PulseVisibility | null) ?? null,
        discoveryVisibility:(data.discoveryVisibility as PulseVisibility | null) ?? null,
        safeReturnEnabled:  data.safeReturnEnabled ?? true,
        trustedCircleShare: data.trustedCircleShare ?? false,
        hotelBlurEnabled:   data.hotelBlurEnabled !== false,
      };

      setPrefs({ ...partial, effectivePulseVisibility: computeEffectiveVisibility(partial) });
    } catch {
      // degrade gracefully — defaults remain
    } finally {
      setIsLoading(false);
    }
  }, [isAuthed]);

  useEffect(() => {
    load();
  }, [load]);

  return { prefs, isLoading, refresh: load };
}
