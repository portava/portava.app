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
import { getPulseData, pulsePostToFeedItem, placeCardToFeedItem } from '../services/pulse';
import type { PulseFeedItem } from '../types/models';

const PAGE_SIZE = 20;

export interface UsePulseFeedResult {
  items: PulseFeedItem[];
  placeCards: PulseFeedItem[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  reload: () => void;
  loadMore: () => void;
  /** Mark a post as deleted so it is filtered out on every subsequent reload. */
  markDeleted: (id: string) => void;
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
  const abortRef = useRef<AbortController | null>(null);
  // Cursor = createdAt of the oldest item on the current page
  const cursorRef = useRef<string | null>(null);
  // IDs deleted this session — excluded from every reload so they never reappear
  const deletedIds = useRef(new Set<string>());

  const markDeleted = useCallback((id: string) => {
    deletedIds.current.add(id);
    setItems((prev) => prev.filter((p) => !deletedIds.current.has(p.id)));
  }, []);

  const reload = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    cursorRef.current = null;

    setLoading(true);
    setHasMore(false);
    getPulseData({ city: opts.city, lat: opts.lat, lng: opts.lng, limit: PAGE_SIZE })
      .then((result) => {
        if (ac.signal.aborted) return;
        if (result.ok) {
          const mapped = result.data.posts
            .map(pulsePostToFeedItem)
            .filter((p) => !deletedIds.current.has(p.id));
          setItems(mapped);
          setPlaceCards(result.data.placeCards.map(placeCardToFeedItem));
          setError(null);
          if (mapped.length === PAGE_SIZE) {
            const oldest = result.data.posts[result.data.posts.length - 1]?.createdAt ?? null;
            cursorRef.current = oldest;
            setHasMore(true);
          }
        } else {
          setError(result.error);
        }
      })
      .catch(() => {
        if (!ac.signal.aborted) setError('Network error');
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
  }, [opts.city, opts.lat, opts.lng]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || !cursorRef.current) return;
    setLoadingMore(true);
    const before = cursorRef.current;
    getPulseData({ city: opts.city, lat: opts.lat, lng: opts.lng, limit: PAGE_SIZE, before })
      .then((result) => {
        if (result.ok) {
          const mapped = result.data.posts.map(pulsePostToFeedItem);
          // De-dupe by id and exclude locally-deleted posts
          setItems((prev) => {
            const seen = new Set(prev.map((p) => p.id));
            const fresh = mapped.filter((p) => !seen.has(p.id) && !deletedIds.current.has(p.id));
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
  }, [loadingMore, hasMore, opts.city, opts.lat, opts.lng]);

  useEffect(() => {
    reload();
    return () => { abortRef.current?.abort(); };
  }, [reload]);

  return { items, placeCards, loading, loadingMore, hasMore, error, reload, loadMore, markDeleted };
}
