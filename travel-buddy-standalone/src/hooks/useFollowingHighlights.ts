/**
 * useFollowingHighlights — fetches the highlights feed for followed users.
 *
 * Returns a list of HighlightFeedUser entries (users with active highlights),
 * a session-local viewed set so rings mute after viewing without waiting for
 * the next server round-trip, and a markSessionViewed callback.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  fetchFollowingHighlightsFeed,
  type HighlightFeedUser,
  type HighlightErrorKind,
} from '../services/highlights.ts';
import { viewedHighlightIds, markViewed } from './useHighlightRingState.ts';

export interface FollowingHighlightsState {
  users: HighlightFeedUser[];
  loading: boolean;
  refresh: () => void;
  sessionViewedIds: Set<string>;
  markSessionViewed: (ids: string[]) => void;
  /**
   * §28.11. The server's own reason when the feed could NOT be read, or null
   * when the read succeeded — including when it succeeded and was empty.
   *
   * `GET /highlights/following-feed` refuses with `degraded_unavailable`
   * rather than serving `{ users: [] }` from a follow-graph lookup that
   * failed, because "nobody you follow has an active Highlight" is a claim
   * about other people. This hook used to collapse that refusal back into the
   * empty list, which made the server's care invisible one layer up.
   */
  unreadable: HighlightErrorKind | null;
}

export function useFollowingHighlights(): FollowingHighlightsState {
  const [users, setUsers] = useState<HighlightFeedUser[]>([]);
  const [unreadable, setUnreadable] = useState<HighlightErrorKind | null>(null);
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
        if (r.ok && r.data) {
          setUsers(r.data);
          setUnreadable(null);
          return;
        }
        // §28.11. The read did not happen. Keep the server's reason and do NOT
        // hand the UI an empty list it cannot tell apart from the truth.
        setUsers([]);
        setUnreadable(r.errorKind ?? 'db_error');
      })
      .catch(() => {
        if (cancelled) return;
        setUsers([]);
        setUnreadable('network_unreachable');
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

  return { users, loading, refresh, sessionViewedIds, markSessionViewed, unreadable };
}
