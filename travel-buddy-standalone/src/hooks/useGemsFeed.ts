/**
 * useGemsFeed — data hook for the Gems (hidden gems) full-screen feed.
 *
 * Fetches from GET /api/media/gems-feed with the current areaMode, category,
 * and cursor from mediaStore. Manages loading, pagination, and error state.
 *
 * Location headers (X-User-Lat / X-User-Lng) are injected automatically when
 * areaMode = 'near_me' and the caller provides coords.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { freshToken } from '../services/apiToken.ts';
import { useMediaStore, type GeoAreaMode, type GemCategory } from '../stores/mediaStore.ts';
import type { GemState, GemConfidence } from '../lib/gems/gemStateDisplay.ts';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

export interface GemsFeedItem {
  id: string;
  sourceType: 'gem';
  gemId: string | null;
  caption: string | null;
  tags: string[];
  createdAt: string;
  creator: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    isPrivate: boolean;
    isVerified: boolean;
    followersCount: number | null;
    followingCount: number | null;
    bio: string | null;
  };
  media: Array<{
    id: string;
    type: 'image' | 'video';
    url: string;
    thumbnailUrl: string | null;
    provenanceLabel: 'illustrative' | null;
  }>;
  stats: {
    viewCount: number;
    likeCount: number;
    saveCount: number;
    commentCount: number;
  };
  location: {
    name: string | null;
    city: string | null;
    country: string | null;
    canonicalPlaceId: string | null;
    placeType: string | null;
    isVerified: boolean;
    lat: number | null;
    lng: number | null;
  } | null;
  viewerState: {
    hasLiked: boolean;
    hasSaved: boolean;
    isFollowingCreator: boolean;
    hasFollowRequestPending: boolean;
  };
  /**
   * §16 Hidden Gem Intelligence projections. Optional: the media gems-feed only
   * carries these once the backend enriches the item; when absent the overlay
   * renders exactly as before (degrade, never throws).
   */
  gemState?: GemState | null;
  gemConfidence?: GemConfidence | null;
}

export interface UseGemsFeedOptions {
  areaMode: GeoAreaMode;
  category: GemCategory | null;
  tripId?: string | null;
  city?: string | null;
  /** GPS coords for near_me mode — only passed after permission granted. */
  userLat?: number | null;
  userLng?: number | null;
}

interface UseGemsFeedResult {
  items: GemsFeedItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /**
   * Why the last load failed. 'unauthenticated' matters because the gems feed
   * is auth-only, so a signed-out user fails here every time and needs to be
   * told to sign in — not shown a transport error.
   */
  errorKind: 'unauthenticated' | 'other' | null;
  hasMore: boolean;
  refresh: () => void;
  loadMore: () => void;
}

export function useGemsFeed(opts: UseGemsFeedOptions): UseGemsFeedResult {
  const { setGemsModeState } = useMediaStore();

  const [items, setItems] = useState<GemsFeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'unauthenticated' | 'other' | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const abortRef = useRef<AbortController | null>(null);

  const fetchPage = useCallback(async (cursor: string | null, reset: boolean) => {
    // Near me requires coordinates
    if (opts.areaMode === 'near_me' && (opts.userLat == null || opts.userLng == null)) {
      if (reset) {
        setItems([]);
        setLoading(false);
      }
      return;
    }

    // Cancel any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    reset ? setLoading(true) : setLoadingMore(true);
    setError(null);
    setErrorKind(null);

    try {
      const params = new URLSearchParams({ areaMode: opts.areaMode });
      if (opts.category) params.set('category', opts.category);
      if (opts.tripId) params.set('tripId', opts.tripId);
      if (opts.city) params.set('city', opts.city);
      if (cursor) params.set('cursor', cursor);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      const token = await freshToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;

      if (opts.areaMode === 'near_me' && opts.userLat != null && opts.userLng != null) {
        headers['X-User-Lat'] = String(opts.userLat);
        headers['X-User-Lng'] = String(opts.userLng);
      }

      const resp = await fetch(`${API_BASE}/api/media/gems-feed?${params.toString()}`, {
        headers,
        signal: controller.signal,
      });

      if (!resp.ok) {
        // The server's `message` is diagnostic text for developers — it used to
        // be thrown straight through and rendered to the user, which is how
        // "Missing or malformed Authorization header" ended up on screen as the
        // explanation for an empty Gems tab. Classify it instead; the raw text
        // stays available to the caller but the UI no longer has to print it.
        const body = await resp.json().catch(() => ({}));
        const err = new Error((body as any)?.message ?? `HTTP ${resp.status}`);
        (err as any).status = resp.status;
        throw err;
      }

      const data = await resp.json() as { items: GemsFeedItem[]; nextCursor: string | null; sessionId: string };
      const newItems = data.items ?? [];

      setItems((prev) => reset ? newItems : [...prev, ...newItems]);
      setNextCursor(data.nextCursor ?? null);
      setHasMore(!!data.nextCursor);

      // Persist session id and cursor to store
      setGemsModeState({ sessionId: data.sessionId, cursor: data.nextCursor });
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // expected cancellation
      const status = (e as any)?.status as number | undefined;
      setErrorKind(status === 401 || status === 403 ? 'unauthenticated' : 'other');
      setError(e.message ?? 'Failed to load gems');
    } finally {
      // Only a SUPERSEDED request declines to clear the flag — a newer request
      // is in flight and owns the state. An aborted request that is still the
      // current one must clear it.
      //
      // The old guard was `!controller.signal.aborted`, which skipped the reset
      // for ANY aborted request. Switching Roam's Watch/Grid/Gems segments
      // quickly aborts the in-flight fetch, and if no replacement took
      // ownership the spinner ran forever — observed stuck for over a minute on
      // an endpoint that answers 401 immediately.
      if (abortRef.current === controller) {
        reset ? setLoading(false) : setLoadingMore(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.areaMode, opts.category, opts.tripId, opts.city, opts.userLat, opts.userLng]);

  // Reset and reload when filters change
  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    setHasMore(true);
    fetchPage(null, true);
    return () => { abortRef.current?.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage]);

  const refresh = useCallback(() => {
    setItems([]);
    setNextCursor(null);
    setHasMore(true);
    fetchPage(null, true);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || loading) return;
    fetchPage(nextCursor, false);
  }, [hasMore, loadingMore, loading, nextCursor, fetchPage]);

  return { items, loading, loadingMore, error, errorKind, hasMore, refresh, loadMore };
}
