/**
 * usePopularCities — "Popular on Portava" cities ranked by real traveler
 * activity, from /api/locations/popular. Optionally proximity-biased when
 * coordinates are provided.
 *
 * Results are cached module-wide for 15 minutes per coordinate bucket, so
 * reopening pickers is instant. Server failure -> empty list (callers fall
 * back to their local seed list).
 */
import { useState, useEffect } from 'react';
import type { Place } from '../lib/location/placeTypes.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { places: Place[]; ts: number }>();
const inFlight = new Map<string, Promise<Place[]>>();

function keyFor(lat?: number | null, lng?: number | null, limit?: number): string {
  const l = lat != null && lng != null ? `${lat.toFixed(1)},${lng.toFixed(1)}` : 'global';
  return `${l}:${limit ?? 12}`;
}

async function fetchPopular(lat?: number | null, lng?: number | null, limit = 12): Promise<Place[]> {
  const key = keyFor(lat, lng, limit);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.places;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const params = new URLSearchParams({ limit: String(limit) });
  if (lat != null && lng != null) {
    params.set('lat', String(lat));
    params.set('lng', String(lng));
  }

  const promise = fetch(`${apiBase()}/api/locations/popular?${params}`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const places: Place[] = Array.isArray(body?.places) ? body.places : [];
      cache.set(key, { places, ts: Date.now() });
      return places;
    })
    .catch(() => [] as Place[])
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

export function usePopularCities(opts: {
  lat?: number | null;
  lng?: number | null;
  limit?: number;
  enabled?: boolean;
} = {}) {
  const { lat = null, lng = null, limit = 12, enabled = true } = opts;
  const key = keyFor(lat, lng, limit);
  const warm = cache.get(key);
  const [places, setPlaces] = useState<Place[]>(
    warm && Date.now() - warm.ts < CACHE_TTL_MS ? warm.places : [],
  );
  const [loading, setLoading] = useState(places.length === 0 && enabled);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetchPopular(lat, lng, limit).then((p) => {
      if (!alive) return;
      if (p.length > 0) setPlaces(p);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return { places, loading };
}
