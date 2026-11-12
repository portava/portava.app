import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchCompassSection,
  getCachedFeed,
  setCachedFeed,
  type CompassFeedResponse,
} from '../../services/compass.ts';
import { useSession } from '../../context/SessionContext.tsx';

interface UseCompassFeedOptions {
  section?: string;
  city?: string | null;
  enabled?: boolean;
}

interface UseCompassFeedResult {
  data:         CompassFeedResponse | null;
  loading:      boolean;
  refreshing:   boolean;
  fallback:     boolean;
  compassEnabled: boolean;
  error:        string | null;
  refresh:      () => void;
  refreshIfStale: () => void;
}

/**
 * Fetches a Compass feed section with AsyncStorage caching.
 *
 * - On mount: serves cached feed immediately (no loading flash), then
 *   silently refreshes in the background.
 * - On manual refresh: shows refreshing indicator.
 * - Falls back gracefully when `compassEnabled` is false in the response.
 */
export function useCompassFeed({
  section = 'for_you',
  city,
  enabled = true,
}: UseCompassFeedOptions = {}): UseCompassFeedResult {
  const { userId, isAuthed } = useSession();
  const [data, setData]           = useState<CompassFeedResponse | null>(null);
  const [loading, setLoading]     = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const loadIdRef = useRef(0);
  const dataOwner = useRef(userId);
  const visibleData = dataOwner.current === userId ? data : null;
  const dataRef = useRef(data);
  dataRef.current = visibleData;
  const lastRequestedAt = useRef(0);
  const pending = useRef(false);
  const networkAnswered = useRef(false);

  // Serve cached feed immediately on mount
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    networkAnswered.current = false;
    getCachedFeed(userId).then((cached) => {
      if (!cancelled && !networkAnswered.current && cached) { dataOwner.current = userId; setData(cached); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);

  const load = useCallback(async (isRefresh = false) => {
    if (!isAuthed || !enabled || pending.current) return;
    const myId = ++loadIdRef.current;
    const stale = () => loadIdRef.current !== myId;
    pending.current = true;
    lastRequestedAt.current = Date.now();
    setError(null);

    if (isRefresh) setRefreshing(true);
    else if (!dataRef.current) setLoading(true);

    const result = await fetchCompassSection(section, { city: city ?? undefined })
      .catch(() => ({ ok: false, data: undefined, error: 'network_error' }));

    if (stale()) return;
    pending.current = false;
    networkAnswered.current = true;
    setLoading(false);
    setRefreshing(false);

    if (result.ok && result.data) {
      dataOwner.current = userId;
      setData(result.data);
      setError(null);
      if (userId) setCachedFeed(userId, result.data).catch(() => {});
    } else {
      lastRequestedAt.current = 0;
      setError(result.error ?? 'unknown');
    }
  }, [isAuthed, enabled, section, city, userId]);

  useEffect(() => {
    pending.current = false;
    lastRequestedAt.current = 0;
    if (!isAuthed || !enabled) {
      setLoading(false);
      setRefreshing(false);
    }
    void load(false);
    return () => { loadIdRef.current += 1; pending.current = false; };
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);
  // The mount request already counts. Re-entering a fresh tab must not start
  // another request, and receiving data must not change this callback's identity.
  const refreshIfStale = useCallback(() => {
    if (Date.now() - lastRequestedAt.current >= 60_000) void load(true);
  }, [load]);

  return {
    data: visibleData,
    loading,
    refreshing,
    fallback:       visibleData?.fallback ?? false,
    // Treat missing compassEnabled as disabled when the response is a fallback —
    // the section route omits the field on disabled/error paths, so this prevents
    // the client from treating a fallback response as "enabled" and waiting forever.
    compassEnabled: visibleData?.fallback ? false : (visibleData?.compassEnabled !== false),
    error,
    refresh,
    refreshIfStale,
  };
}
