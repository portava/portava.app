/**
 * useWallFeed — paginates GET /wall for one feed session (Wall spec §28).
 *
 * CURSOR-STABLE. Page 2 must never reshuffle page 1: this hook only ever
 * APPENDS newly-arrived items and de-duplicates by `canonicalObjectId`, so a
 * projection that already appeared in the session is dropped rather than moved.
 * The server's For You cursor carries the rank session snapshot, so the pages
 * of one session stay internally ordered; Following is strict reverse chronology
 * and likewise only grows downward.
 *
 * A change of `mode` or `sessionIntent` starts a NEW session (fresh cursor,
 * cleared dedup set, items reset). `refresh()` also starts a new session.
 *
 * FAIL-SOFT (spec §40): a failed page keeps whatever items are already on
 * screen — a safe social feed always remains. "Not configured / disabled"
 * resolves to an empty, non-error feed (`degraded: true`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWall } from '../services/wallApi.ts';
import type { WallMode, WallProjection } from '../types/wallProjection.ts';

const PAGE_LIMIT = 12;

type FetchReason = 'initial' | 'refresh' | 'more';

export interface UseWallFeedResult {
  items: WallProjection[];
  /** First-page load in flight (no items yet). */
  loading: boolean;
  /** Pull-to-refresh in flight. */
  refreshing: boolean;
  /** Next-page load in flight. */
  loadingMore: boolean;
  /** Last transport error (kept items remain visible). null when healthy. */
  error: string | null;
  /** True when the Wall is disabled / unconfigured → safe empty feed. */
  degraded: boolean;
  /** Following only: viewer reached the end of eligible content (spec §27). */
  caughtUp: boolean;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
  /** Drop an object the viewer marked "not interested" and keep it hidden (§7/§32). */
  hide: (projectionId: string) => void;
  mode: WallMode;
}

/**
 * Keep only items whose canonicalObjectId has not already been seen (spec §28)
 * and that the viewer has not hidden (§7 not-interested control).
 */
function dedupe(
  incoming: WallProjection[],
  seen: Set<string>,
  hidden: Set<string>,
): WallProjection[] {
  const out: WallProjection[] = [];
  for (const item of incoming) {
    if (hidden.has(item.projectionId)) continue;
    const key = item.canonicalObjectId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function useWallFeed(
  mode: WallMode,
  sessionIntent?: string | null,
): UseWallFeedResult {
  const [items, setItems] = useState<WallProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [caughtUp, setCaughtUp] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // Non-reactive session state.
  const cursorRef = useRef<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const hiddenRef = useRef<Set<string>>(new Set());
  const genRef = useRef(0);
  const inFlightRef = useRef(false);

  const normalizedIntent = sessionIntent ?? null;

  const doFetch = useCallback(
    async (reason: FetchReason) => {
      const reset = reason !== 'more';
      if (inFlightRef.current) return;
      if (reason === 'more' && !cursorRef.current) return;

      if (reset) {
        genRef.current += 1;
        cursorRef.current = null;
      }
      const gen = genRef.current;
      const cursor = reset ? null : cursorRef.current;

      inFlightRef.current = true;
      if (reason === 'initial') setLoading(true);
      else if (reason === 'refresh') setRefreshing(true);
      else setLoadingMore(true);

      try {
        const res = await fetchWall({
          mode,
          cursor,
          sessionIntent: normalizedIntent,
          limit: PAGE_LIMIT,
        });
        // A newer session started while this was in flight — drop the result.
        if (gen !== genRef.current) return;

        if (res.ok) {
          setError(null);
          setDegraded(res.degraded);
          cursorRef.current = res.data.nextCursor ?? null;
          setHasMore(!!res.data.nextCursor);
          setCaughtUp(!!res.data.caughtUp);
          if (reset) {
            seenRef.current = new Set();
            setItems(dedupe(res.data.items, seenRef.current, hiddenRef.current));
          } else {
            const fresh = dedupe(res.data.items, seenRef.current, hiddenRef.current);
            if (fresh.length > 0) setItems((prev) => [...prev, ...fresh]);
          }
        } else if (res.error !== 'aborted') {
          // Keep existing items — a safe social feed remains (spec §40).
          setError(res.error);
        }
      } finally {
        // Guard BOTH the loading resets AND the in-flight release by generation:
        // a superseded (stale-gen) request that resolves must not clear
        // inFlightRef while a NEWER request is still running — doing so would let
        // a refresh in that window supersede the newer request and strand
        // `loading` true (a permanent spinner instead of the empty state). Only
        // the latest request (gen === genRef.current) releases the guard; the
        // effect-cleanup path resets inFlightRef for a genuinely new session.
        if (gen === genRef.current) {
          if (reason === 'initial') setLoading(false);
          else if (reason === 'refresh') setRefreshing(false);
          else setLoadingMore(false);
          inFlightRef.current = false;
        }
      }
    },
    [mode, normalizedIntent],
  );

  // Start a fresh session whenever mode / sessionIntent changes.
  useEffect(() => {
    void doFetch('initial');
    return () => {
      // Invalidate any in-flight request from the previous session.
      genRef.current += 1;
      inFlightRef.current = false;
    };
  }, [doFetch]);

  const loadMore = useCallback(() => {
    void doFetch('more');
  }, [doFetch]);

  const refresh = useCallback(() => {
    void doFetch('refresh');
  }, [doFetch]);

  const hide = useCallback((projectionId: string) => {
    hiddenRef.current.add(projectionId);
    setItems((prev) => prev.filter((i) => i.projectionId !== projectionId));
  }, []);

  return {
    items,
    loading,
    refreshing,
    loadingMore,
    error,
    degraded,
    caughtUp,
    hasMore,
    loadMore,
    refresh,
    hide,
    mode,
  };
}
