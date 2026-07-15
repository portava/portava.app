/**
 * usePlaceSearch — debounced place search against /api/places/search.
 * Falls back to an empty list if the server is unavailable.
 */
import { useState, useEffect, useRef } from 'react';
import type { Place } from '../lib/location/placeTypes';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

const DEBOUNCE_MS = 350;

export interface UsePlaceSearchResult {
  results: Place[];
  loading: boolean;
  error: string | null;
}

export function usePlaceSearch(
  query: string,
  opts?: { countryCode?: string; type?: string; lat?: number; lng?: number },
): UsePlaceSearchResult {
  const [results, setResults] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    timerRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const params = new URLSearchParams({ q: query.trim() });
        if (opts?.countryCode) params.set('countryCode', opts.countryCode);
        if (opts?.type) params.set('type', opts.type);
        if (opts?.lat != null) params.set('lat', String(opts.lat));
        if (opts?.lng != null) params.set('lng', String(opts.lng));

        const res = await fetch(`${apiBase()}/api/places/search?${params}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        setResults(body.places ?? []);
        setError(null);
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        setError('Location search unavailable.');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query]);

  return { results, loading, error };
}
