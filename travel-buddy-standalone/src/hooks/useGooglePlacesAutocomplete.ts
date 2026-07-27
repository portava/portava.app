/**
 * useGooglePlacesAutocomplete — debounced Google Places Autocomplete via the
 * backend proxy at /api/places/google-autocomplete.
 *
 * The backend proxy keeps the API key server-side (no CORS issues) and returns
 * normalized Place objects. Falls back silently to an empty list when the key
 * is not configured or the request fails.
 *
 * fetchGooglePlaceDetails() can be called on selection to enrich a Google Place
 * with its lat/lng (autocomplete results omit coordinates).
 */
import { useState, useEffect, useRef } from 'react';
import type { Place } from '../lib/location/placeTypes.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

const DEBOUNCE_MS = 300;

export interface UseGooglePlacesResult {
  places: Place[];
  loading: boolean;
}

/**
 * Fetch geometry + formatted_address for a Google place_id. Used to enrich a
 * selected autocomplete result before canonical resolution. Returns null when
 * the backend key is unconfigured or the call fails — the caller should fall
 * through to resolve with whatever data it already has.
 */
export async function fetchGooglePlaceDetails(
  placeId: string,
): Promise<{ lat: number; lng: number; formattedAddress: string } | null> {
  try {
    const params = new URLSearchParams({ place_id: placeId });
    const res = await fetch(`${apiBase()}/api/places/google-details?${params}`);
    if (!res.ok) return null;
    const body = await res.json();
    return (body.details as { lat: number; lng: number; formattedAddress: string } | null) ?? null;
  } catch {
    return null;
  }
}

export function useGooglePlacesAutocomplete(
  query: string,
  opts?: { countryCode?: string; type?: 'city' | 'all' },
): UseGooglePlacesResult {
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim() || query.trim().length < 2) {
      setPlaces([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    timerRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const params = new URLSearchParams({ input: query.trim() });
        if (opts?.type === 'city') params.set('type', 'city');
        if (opts?.countryCode) params.set('countryCode', opts.countryCode);

        const res = await fetch(`${apiBase()}/api/places/google-autocomplete?${params}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        setPlaces((body.places as Place[]) ?? []);
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        setPlaces([]);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query, opts?.type, opts?.countryCode]); // eslint-disable-line react-hooks/exhaustive-deps

  return { places, loading };
}
