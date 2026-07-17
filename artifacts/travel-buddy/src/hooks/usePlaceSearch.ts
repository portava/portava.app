/**
 * usePlaceSearch — debounced place search against /api/places/search.
 * Falls back to an empty list if the server is unavailable.
 *
 * Results are cached in-memory for 5 minutes (keyed on query + options) and
 * in-flight requests are deduplicated so two simultaneous identical queries
 * share one Promise.
 */
import { useState, useEffect, useRef } from 'react';
import type { Place } from '../lib/location/placeTypes.ts';
import {
  getCached,
  setCached,
  getInFlight,
  setInFlight,
  deleteInFlight,
  makeCacheKey,
} from '../lib/location/placeSearchCache.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

const DEBOUNCE_MS = 350;

export interface UsePlaceSearchResult {
  results: Place[];
  loading: boolean;
  error: string | null;
}

export async function fetchPlacesFromApi(
  query: string,
  opts?: { countryCode?: string; type?: string; lat?: number; lng?: number },
): Promise<Place[]> {
  const cacheKey = makeCacheKey(query, opts);

  // Return warm cache entry synchronously
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Deduplicate in-flight requests
  const existing = getInFlight(cacheKey);
  if (existing) return existing;

  const params = new URLSearchParams({ q: query.trim() });
  if (opts?.countryCode) params.set('countryCode', opts.countryCode);
  if (opts?.type) params.set('type', opts.type);
  if (opts?.lat != null) params.set('lat', String(opts.lat));
  if (opts?.lng != null) params.set('lng', String(opts.lng));

  const promise = fetch(`${apiBase()}/api/places/search?${params}`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const results: Place[] = body.places ?? [];
      setCached(cacheKey, results);
      return results;
    })
    .finally(() => {
      deleteInFlight(cacheKey);
    });

  setInFlight(cacheKey, promise);
  return promise;
}

export function usePlaceSearch(
  query: string,
  opts?: {
    countryCode?: string; type?: string; lat?: number; lng?: number;
    /**
     * Bump to force a re-fetch of the current query (retry after an error).
     * Failed requests are never cached, so re-running the effect refetches.
     */
    refreshKey?: number;
  },
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

    // Check cache immediately (synchronous warm hit)
    const cacheKey = makeCacheKey(query, opts);
    const cached = getCached(cacheKey);
    if (cached) {
      setResults(cached);
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

        // Check in-flight dedup before issuing a new request
        const existing = getInFlight(cacheKey);
        let places: Place[];
        if (existing) {
          places = await existing;
        } else {
          const res = await fetch(`${apiBase()}/api/places/search?${params}`, {
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          places = body.places ?? [];
          setCached(cacheKey, places);
        }
        setResults(places);
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
  }, [query, opts?.refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { results, loading, error };
}
