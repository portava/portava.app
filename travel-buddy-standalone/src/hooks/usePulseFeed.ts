/**
 * usePulseFeed — primary data hook for the Pulse Wall.
 *
 * Calls /api/pulse (the real backend) and returns:
 *   - items: PulseFeedItem[] — the live posts, mapped to feed item shape
 *   - placeCards: PulseFeedItem[] — nearby place recommendations (type='place_card')
 *     returned by the backend when the live post count is below threshold
 *   - loading, error, reload — standard async hook helpers
 *   - loadMore — load the next page (cursor-based, de-duped by id)
 *   - hasMore — true when the last page returned a full limit
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { getPulseData, pulsePostToFeedItem, placeCardToFeedItem } from '../services/pulse.ts';
import type { PulseFeedItem } from '../types/models.ts';
import { useBlockedIds } from '../context/BlockedIdsContext.tsx';

const PAGE_SIZE = 20;

export interface UsePulseFeedResult {
  items: PulseFeedItem[];
  placeCards: PulseFeedItem[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  /**
   * Why the last load failed, when it did. 'unauthenticated' is the one the UI
   * must not conflate with a network problem: /api/pulse is auth-only, so a
   * signed-out user fails here every time, and telling them to check their
   * connection sends them to debug the wrong thing.
   */
  errorKind: string | null;
  reload: () => void;
  loadMore: () => void;
  /** Mark a post as deleted so it is filtered out on every subsequent reload. */
  markDeleted: (id: string) => void;
  /** Session UUID returned by the most recent successful feed response. Forward to outcome calls. */
  sessionId: string | null;
}

export function usePulseFeed(opts: {
  city?: string;
  lat?: number | null;
  lng?: number | null;
}): UsePulseFeedResult {
  const [items, setItems] = useState<PulseFeedItem[]>([]);
  const [placeCards, setPlaceCards] = useState<PulseFeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Carried alongside `error` so the UI can tell a signed-out user to sign in
  // rather than to check their connection.
  const [errorKind, setErrorKind] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Cursor = createdAt of the oldest item on the current page
  const cursorRef = useRef<string | null>(null);
  // IDs deleted this session — excluded from every reload so they never reappear
  const deletedIds = useRef(new Set<string>());
  // Fetch generation — bumped by every reload so an in-flight loadMore started
  // against the previous list can't append stale rows (or write a stale cursor)
  // into the fresh one.
  const fetchGenRef = useRef(0);

  // Client-side block filter — defense-in-depth on top of server-side block enforcement.
  // When the block list is still loading (empty Set), no items are incorrectly excluded.
  const { blockedIds } = useBlockedIds();
  const isNotBlocked = useCallback(
    (item: PulseFeedItem) => !item.author?.id || !blockedIds.has(item.author.id),
    [blockedIds],
  );

  const markDeleted = useCallback((id: string) => {
    deletedIds.current.add(id);
    setItems((prev) => prev.filter((p) => !deletedIds.current.has(p.id)));
  }, []);

  const reload = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    cursorRef.current = null;
    fetchGenRef.current += 1; // invalidate any in-flight loadMore

    setLoading(true);
    setHasMore(false);
    getPulseData({ city: opts.city, lat: opts.lat, lng: opts.lng, limit: PAGE_SIZE })
      .then((result) => {
        if (ac.signal.aborted) return;
        if (result.ok) {
          const raw = result.data.posts;
          // Pagination is based on raw backend count so deleting a post from the
          // local set does not prematurely prevent loading further pages.
          const hasNextPage = raw.length === PAGE_SIZE;
          if (hasNextPage) {
            cursorRef.current = raw[raw.length - 1]?.createdAt ?? null;
            setHasMore(true);
          }
          setItems(raw.map(pulsePostToFeedItem).filter((p) => !deletedIds.current.has(p.id) && isNotBlocked(p)));
          setPlaceCards(result.data.placeCards.map(placeCardToFeedItem));
          setSessionId(result.data.sessionId ?? null);
          setError(null);
          setErrorKind(null);
        } else {
          setError(result.error);
          setErrorKind(result.errorKind ?? null);
        }
      })
      .catch(() => {
        if (!ac.signal.aborted) { setError('Network error'); setErrorKind('network'); }
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
  }, [opts.city, opts.lat, opts.lng, isNotBlocked]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || !cursorRef.current) return;
    setLoadingMore(true);
    const before = cursorRef.current;
    const gen = fetchGenRef.current;
    getPulseData({ city: opts.city, lat: opts.lat, lng: opts.lng, limit: PAGE_SIZE, before })
      .then((result) => {
        // A reload started while this page was in flight — its rows belong to
        // the old list, so discard them (no append, no cursor write).
        if (gen !== fetchGenRef.current) return;
        if (result.ok) {
          const mapped = result.data.posts.map(pulsePostToFeedItem);
          // De-dupe by id and exclude locally-deleted posts and blocked authors
          setItems((prev) => {
            const seen = new Set(prev.map((p) => p.id));
            const fresh = mapped.filter((p) => !seen.has(p.id) && !deletedIds.current.has(p.id) && isNotBlocked(p));
            return [...prev, ...fresh];
          });
          if (mapped.length === PAGE_SIZE) {
            const oldest = result.data.posts[result.data.posts.length - 1]?.createdAt ?? null;
            cursorRef.current = oldest;
            setHasMore(true);
          } else {
            cursorRef.current = null;
            setHasMore(false);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore, opts.city, opts.lat, opts.lng, isNotBlocked]);

  useEffect(() => {
    reload();
    return () => { abortRef.current?.abort(); };
  }, [reload]);

  return { items, placeCards, loading, loadingMore, hasMore, error, errorKind, reload, loadMore, markDeleted, sessionId };
}
