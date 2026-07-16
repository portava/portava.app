/**
 * useMapTravelers — polls the map-travelers endpoint while the Discovery map
 * is visible, showing travelers who share their location in discovery.
 *
 * Battery/network guarantees:
 *   - Polls every POLL_MS (45s) — no websockets, no high-frequency timers.
 *   - Pauses entirely when the app is backgrounded (AppState) or when
 *     `enabled` is false (travelers layer toggled off / map unmounted).
 *   - Re-fetches early only when the map centre moves significantly
 *     (> ~1/3 of the query radius), so panning within a city reuses data.
 *   - Keeps the last good result on transient errors — markers never flash
 *     out of existence because one poll failed.
 *
 * Privacy note: coordinates in MapTraveler are ALREADY coarsened by the
 * server (city centroid or ~2km grid). The client never sees precise
 * positions, so nothing here needs to blur further.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getMapTravelers, type MapTraveler } from '../services/mapTravelers';

const POLL_MS = 45_000;

/** Rough distance in km between two coords (equirectangular — fine at city scale). */
function roughKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const x = (bLng - aLng) * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  const y = bLat - aLat;
  return Math.sqrt(x * x + y * y) * 111.32;
}

export interface UseMapTravelersResult {
  travelers: MapTraveler[];
  /** True only before the FIRST successful load — later polls are silent. */
  loading: boolean;
  /** Set when the latest poll failed AND we have no data to show. */
  error: string | null;
  refresh: () => void;
}

export function useMapTravelers(opts: {
  lat: number | null;
  lng: number | null;
  radiusKm?: number;
  enabled: boolean;
}): UseMapTravelersResult {
  const { lat, lng, enabled } = opts;
  const radiusKm = opts.radiusKm ?? 50;

  const [travelers, setTravelers] = useState<MapTraveler[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlight = useRef(false);
  const hasLoaded = useRef(false);
  const lastFetchAt = useRef(0);
  const lastCenter = useRef<{ lat: number; lng: number } | null>(null);
  const appActive = useRef(AppState.currentState === 'active' || AppState.currentState === 'unknown');

  const doFetch = useCallback(async (fLat: number, fLng: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!hasLoaded.current) setLoading(true);
    const res = await getMapTravelers(fLat, fLng, radiusKm);
    inFlight.current = false;
    lastFetchAt.current = Date.now();
    lastCenter.current = { lat: fLat, lng: fLng };
    if (res.ok) {
      hasLoaded.current = true;
      setError(null);
      // Dedup by id defensively — one marker per user, always.
      const seen = new Set<string>();
      setTravelers(res.data.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true))));
    } else if (!hasLoaded.current) {
      setError(res.error);
    } // else: keep last good data silently
    setLoading(false);
  }, [radiusKm]);

  const refresh = useCallback(() => {
    if (lat != null && lng != null && enabled) void doFetch(lat, lng);
  }, [lat, lng, enabled, doFetch]);

  // Track app foreground/background so we never poll in the background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      const wasActive = appActive.current;
      appActive.current = s === 'active';
      // Coming back to foreground with stale data → refresh immediately.
      if (!wasActive && appActive.current && enabled && lat != null && lng != null) {
        if (Date.now() - lastFetchAt.current > POLL_MS) void doFetch(lat, lng);
      }
    });
    return () => sub.remove();
  }, [enabled, lat, lng, doFetch]);

  // Main poll loop + significant-move refetch.
  useEffect(() => {
    if (!enabled || lat == null || lng == null) return;

    // Immediate fetch if we've never loaded, moved far, or data is stale.
    const movedFar = lastCenter.current
      ? roughKm(lastCenter.current.lat, lastCenter.current.lng, lat, lng) > radiusKm / 3
      : true;
    if (movedFar || Date.now() - lastFetchAt.current > POLL_MS) {
      void doFetch(lat, lng);
    }

    const timer = setInterval(() => {
      if (appActive.current) void doFetch(lat, lng);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, lat, lng, radiusKm, doFetch]);

  return { travelers, loading: loading && !hasLoaded.current, error, refresh };
}
