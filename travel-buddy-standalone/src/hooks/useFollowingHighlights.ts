/**
 * useFollowingHighlights — fetches the highlights feed for followed users.
 *
 * Returns a list of HighlightFeedUser entries (users with active highlights),
 * a session-local viewed set so rings mute after viewing without waiting for
 * the next server round-trip, and a markSessionViewed callback.
 */
import { useState, useEffect, useCallback } from 'react';
import { fetchFollowingHighlightsFeed, type HighlightFeedUser } from '../services/highlights.ts';
import { viewedHighlightIds, markViewed } from './useHighlightRingState.ts';

export interface FollowingHighlightsState {
  users: HighlightFeedUser[];
  loading: boolean;
  refresh: () => void;
  sessionViewedIds: Set<string>;
  markSessionViewed: (ids: string[]) => void;
}

export function useFollowingHighlights(): FollowingHighlightsState {
  const [users, setUsers] = useState<HighlightFeedUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionViewedIds, setSessionViewedIds] = useState<Set<string>>(
    () => new Set(viewedHighlightIds),
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchFollowingHighlightsFeed()
      .then((r) => {
        if (cancelled) return;
        setUsers(r.ok && r.data ? r.data : []);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const markSessionViewed = useCallback((ids: string[]) => {
    for (const id of ids) markViewed(id);
    setSessionViewedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  return { users, loading, refresh, sessionViewedIds, markSessionViewed };
}
