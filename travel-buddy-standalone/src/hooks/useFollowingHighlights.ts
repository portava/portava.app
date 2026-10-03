/**
 * useFollowingHighlights — fetches the highlights feed for followed users.
 *
 * Returns a list of HighlightFeedUser entries (users with active highlights),
 * a session-local viewed set so rings mute after viewing without waiting for
 * the next server round-trip, and a markSessionViewed callback.
 *
 * THE WHOLE FEED, ONE BOUNDED PAGE AT A TIME. With `highlights_feed_bounded_enabled`
 * on, the server answers a finite page (spec §12) and a `nextCursor`. This hook
 * used to read the first page only and drop the cursor: every followed user
 * whose highlights fell after it was missing from the tray, and a user split
 * across pages showed part of their highlights — a partial read presented as
 * the complete tray. It now follows the cursor until the server has nothing
 * further, merging pages as they arrive. Every request stays bounded; the tray
 * holds what it always held with the cap off. A walk that cannot finish (a
 * later page refused, or a cursor that does not advance) keeps what it read and
 * reports `unreadable`, so the strip can say the tray is incomplete.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  fetchFollowingHighlightsFeed,
  type HighlightFeedUser,
  type HighlightErrorKind,
} from '../services/highlights.ts';
import { viewedHighlightIds, markViewed } from './useHighlightRingState.ts';

/**
 * Merge one page of the following feed into what earlier pages returned. The
 * server orders highlights by time and groups them per user, so one user can
 * span a page boundary: their later highlights are appended to the entry they
 * already have, in arrival order, each highlight once. New users keep page order.
 * Pure: neither input is mutated.
 */
export function mergeFollowingFeedPages(
  have: readonly HighlightFeedUser[],
  page: readonly HighlightFeedUser[],
): HighlightFeedUser[] {
  const out = have.map((u) => ({ ...u, highlights: [...u.highlights] }));
  const index = new Map(out.map((u, i) => [u.userId, i] as const));
  for (const incoming of page) {
    const at = index.get(incoming.userId);
    if (at === undefined) {
      index.set(incoming.userId, out.length);
      out.push({ ...incoming, highlights: [...incoming.highlights] });
      continue;
    }
    const target = out[at];
    const seen = new Set(target.highlights.map((h) => h.id));
    for (const h of incoming.highlights) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      target.highlights.push(h);
    }
  }
  return out;
}

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
   *
   * Also set when the cursor walk stopped part-way: `users` then holds the
   * pages that WERE read, and this says the tray is not complete (`db_error`
   * for a cursor that did not advance).
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
    // One walk per refresh. `cancelled` is this walk's own: a page that lands
    // after a refresh (or unmount) started another walk is dropped, never merged.
    let cancelled = false;
    setLoading(true);
    (async () => {
      let merged: HighlightFeedUser[] = [];
      let cursor: string | null = null;
      const visited = new Set<string>();
      for (;;) {
        let r: Awaited<ReturnType<typeof fetchFollowingHighlightsFeed>>;
        try {
          r = await fetchFollowingHighlightsFeed(cursor);
        } catch {
          if (cancelled) return;
          setUsers(merged);
          setUnreadable('network_unreachable');
          return;
        }
        if (cancelled) return;
        if (!(r.ok && r.data)) {
          // §28.11. The read did not happen. Keep the server's reason and do NOT
          // hand the UI a list it cannot tell apart from the truth: on the first
          // page that is the empty list, on a later page it is the pages read.
          setUsers(merged);
          setUnreadable(r.errorKind ?? 'db_error');
          return;
        }
        merged = mergeFollowingFeedPages(merged, r.data);
        setUsers(merged);
        const next = r.nextCursor ?? null;
        if (next === null) {
          setUnreadable(null);
          return;
        }
        if (next === cursor || visited.has(next)) {
          // A cursor that does not move would walk forever and never finish.
          setUnreadable('db_error');
          return;
        }
        visited.add(next);
        cursor = next;
      }
    })().finally(() => {
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
