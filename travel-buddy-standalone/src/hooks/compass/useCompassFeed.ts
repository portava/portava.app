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

  // Serve cached feed immediately on mount
  useEffect(() => {
    if (!userId) return;
    getCachedFeed(userId).then((cached) => {
      if (cached) setData(cached);
    }).catch(() => {});
  }, [userId]);

  const load = useCallback(async (isRefresh = false) => {
    if (!isAuthed || !enabled) return;
    const myId = ++loadIdRef.current;
    const stale = () => loadIdRef.current !== myId;

    if (isRefresh) setRefreshing(true);
    else if (!data) setLoading(true);

    const result = await fetchCompassSection(section, { city: city ?? undefined });

    if (stale()) return;
    setLoading(false);
    setRefreshing(false);

    if (result.ok && result.data) {
      setData(result.data);
      setError(null);
      if (userId) setCachedFeed(userId, result.data).catch(() => {});
    } else {
      setError(result.error ?? 'unknown');
    }
  }, [isAuthed, enabled, section, city, userId, data]);

  useEffect(() => {
    load(false);
  }, [isAuthed, enabled, section, city]);

  const refresh = useCallback(() => load(true), [load]);

  return {
    data,
    loading,
    refreshing,
    fallback:       data?.fallback ?? false,
    // Treat missing compassEnabled as disabled when the response is a fallback —
    // the section route omits the field on disabled/error paths, so this prevents
    // the client from treating a fallback response as "enabled" and waiting forever.
    compassEnabled: data?.fallback ? false : (data?.compassEnabled !== false),
    error,
    refresh,
  };
}
