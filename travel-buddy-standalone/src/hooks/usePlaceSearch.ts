/**
 * usePlaceSearch — debounced place search against /api/places/search.
 * Falls back to an empty list if the server is unavailable.
 *
 * Results are cached in-memory for 5 minutes (keyed on query + options) and
 * in-flight requests are deduplicated so two simultaneous identical queries
 * share one Promise.
 */
import { useState, useEffect } from 'react';
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

  useEffect(() => {
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

    let active = true;
    const controller = new AbortController();
    setResults([]);
    setError(null);
    setLoading(true);
    const timer = setTimeout(async () => {

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
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          if (!active) return;
          places = body.places ?? [];
          setCached(cacheKey, places);
        }
        if (!active) return;
        setResults(places);
        setError(null);
      } catch (error) {
        if (!active || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')) return;
        setError('Location search unavailable.');
        setResults([]);
      } finally {
        if (active) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, opts?.countryCode, opts?.type, opts?.lat, opts?.lng, opts?.refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { results, loading, error };
}
