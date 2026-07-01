/**
 * usePulseFeed — primary data hook for the Pulse Wall.
 *
 * Calls /api/pulse (the real backend) and returns:
 *   - items: PulseFeedItem[] — the live posts, mapped to feed item shape
 *   - placeCards: PulseFeedItem[] — nearby place recommendations (type='place_card')
 *     returned by the backend when the live post count is below threshold
 *   - loading, error, reload — standard async hook helpers
 *
 * This replaces useGlobalFeed as the primary source for the For You tab.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { getPulseData, pulsePostToFeedItem, placeCardToFeedItem } from '../services/pulse';
import type { PulseFeedItem } from '../types/models';

export interface UsePulseFeedResult {
  items: PulseFeedItem[];
  placeCards: PulseFeedItem[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function usePulseFeed(opts: {
  city?: string;
  lat?: number | null;
  lng?: number | null;
}): UsePulseFeedResult {
  const [items, setItems] = useState<PulseFeedItem[]>([]);
  const [placeCards, setPlaceCards] = useState<PulseFeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    getPulseData({ city: opts.city, lat: opts.lat, lng: opts.lng, limit: 20 })
      .then((result) => {
        if (ac.signal.aborted) return;
        if (result.ok) {
          setItems(result.data.posts.map(pulsePostToFeedItem));
          setPlaceCards(result.data.placeCards.map(placeCardToFeedItem));
          setError(null);
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

  useEffect(() => {
    reload();
    return () => { abortRef.current?.abort(); };
  }, [reload]);

  return { items, placeCards, loading, error, reload };
}
