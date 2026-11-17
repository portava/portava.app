/**
 * useWatchFeed — fetches paginated Watch-mode feed items.
 *
 * Maintains independent cursors, active-item indices, and session IDs for the
 * For You and Following feeds.  Switching feedType immediately returns the
 * previously-loaded items for that feed (they are cached in refs) while a
 * background refresh may run if the cache is stale.
 *
 * Uses the mediaFeed service (authenticated, base-URL-aware) rather than
 * calling fetch() directly, so requests carry the correct bearer token and
 * base URL on all platforms.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { newClientEventId } from '../services/clientEventId.ts';
import { captureMessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { fetchWatchFeed } from '../services/mediaFeed.ts';
import { fetchOwnedApi } from '../services/ownedApiRequest.ts';
import type { MediaFeedItem, WatchFeedType } from '../types/media.ts';

// ── Per-feed state ────────────────────────────────────────────────────────────

interface FeedSlot {
  items: MediaFeedItem[];
  nextCursor: string | null;
  sessionId: string;
  loading: boolean;
  error: string | null;
  /** Index of the visible (active) item. */
  activeIndex: number;
}

const newSlot = (sessionId: string): FeedSlot => ({
  items: [],
  nextCursor: null,
  sessionId,
  loading: false,
  error: null,
  activeIndex: 0,
});

function genSessionId(): string {
  return newClientEventId();
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface WatchFeedState {
  feedType: WatchFeedType;
  setFeedType: (t: WatchFeedType) => void;

  items: MediaFeedItem[];
  sessionId: string;
  loading: boolean;
  error: string | null;
  activeIndex: number;
  setActiveIndex: (idx: number) => void;

  /** Load the first page (or refresh). */
  loadFeed: () => Promise<void>;
  /** Append the next page. */
  loadMore: () => Promise<void>;

  /** Patch a single item's commentCount in place (e.g. after posting a comment). */
  setItemCommentCount: (id: string, count: number) => void;
}

export function useWatchFeed(): WatchFeedState {
  const [feedType, setFeedTypeState] = useState<WatchFeedType>('for_you');
  const mounted = useRef(true);
  const requests = useRef(new Map<WatchFeedType, AbortController>());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const controller of requests.current.values()) controller.abort(); requests.current.clear(); };
  }, []);

  // Per-feed slots — keep state for both feeds simultaneously.
  const slotsRef = useRef<Record<WatchFeedType, FeedSlot>>({
    'for_you': newSlot(genSessionId()),
    'following': newSlot(genSessionId()),
  });

  // Trigger re-render by bumping a version counter.
  const [, bumpVersion] = useState(0);
  const rerender = useCallback(() => bumpVersion((v) => v + 1), []);

  const slot = slotsRef.current[feedType];

  // ── Fetch helper ────────────────────────────────────────────────────────────

  const fetchPage = useCallback(
    async (type: WatchFeedType, cursor: string | null): Promise<void> => {
      const s = slotsRef.current[type];
      if (s.loading) return;
      const owner = captureMessagingOwnerRequest();
      if (!owner?.isCurrent() || !mounted.current) return;
      const controller = new AbortController();
      requests.current.get(type)?.abort();
      requests.current.set(type, controller);
      const isCurrent = () => mounted.current && owner.isCurrent() && slotsRef.current[type].sessionId === s.sessionId;

      slotsRef.current[type] = { ...s, loading: true, error: null };
      rerender();

      const result = await fetchWatchFeed({
        feedType: type,           // 'for_you' | 'following' — matches API contract
        cursor: cursor ?? undefined,
        sessionId: s.sessionId,
        owner, signal: controller.signal, isCurrent,
      }, fetchOwnedApi);
      if (requests.current.get(type) === controller) requests.current.delete(type);
      if (!isCurrent()) return;

      if (result.ok && result.data) {
        const data = result.data;
        slotsRef.current[type] = {
          ...slotsRef.current[type],
          items: cursor
            ? [...slotsRef.current[type].items, ...data.items]
            : data.items,
          nextCursor: data.nextCursor,
          // Adopt server-assigned sessionId on first load.
          sessionId: data.sessionId || slotsRef.current[type].sessionId,
          loading: false,
          error: null,
        };
      } else {
        slotsRef.current[type] = {
          ...slotsRef.current[type],
          loading: false,
          error: result.message ?? 'Failed to load feed',
        };
      }

      rerender();
    },
    [rerender],
  );

  // ── Public API ──────────────────────────────────────────────────────────────

  const setFeedType = useCallback(
    (t: WatchFeedType) => {
      setFeedTypeState(t);
      // Load immediately on first visit to a feed type.
      if (slotsRef.current[t].items.length === 0 && !slotsRef.current[t].loading) {
        slotsRef.current[t] = newSlot(genSessionId());
        rerender();
        fetchPage(t, null);
      }
    },
    [fetchPage, rerender],
  );

  const loadFeed = useCallback(async () => {
    // Reset cursor + session when explicitly refreshing.
    slotsRef.current[feedType] = newSlot(genSessionId());
    rerender();
    await fetchPage(feedType, null);
  }, [feedType, fetchPage, rerender]);

  const loadMore = useCallback(async () => {
    const s = slotsRef.current[feedType];
    if (!s.nextCursor || s.loading) return;
    await fetchPage(feedType, s.nextCursor);
  }, [feedType, fetchPage]);

  const setActiveIndex = useCallback(
    (idx: number) => {
      slotsRef.current[feedType] = { ...slotsRef.current[feedType], activeIndex: idx };
      rerender();
    },
    [feedType, rerender],
  );

  // Patches commentCount for a single item across BOTH feed slots (an item can
  // be present in both for_you and following simultaneously), so the bubble
  // updates immediately after a comment is posted regardless of which tab is
  // active.
  const setItemCommentCount = useCallback(
    (id: string, count: number) => {
      let changed = false;
      (Object.keys(slotsRef.current) as WatchFeedType[]).forEach((type) => {
        const s = slotsRef.current[type];
        const idx = s.items.findIndex((it) => it.id === id);
        if (idx === -1) return;
        const nextItems = [...s.items];
        nextItems[idx] = { ...nextItems[idx], commentCount: count };
        slotsRef.current[type] = { ...s, items: nextItems };
        changed = true;
      });
      if (changed) rerender();
    },
    [rerender],
  );

  return {
    feedType,
    setFeedType,
    items: slot.items,
    sessionId: slot.sessionId,
    loading: slot.loading,
    error: slot.error,
    activeIndex: slot.activeIndex,
    setActiveIndex,
    loadFeed,
    loadMore,
    setItemCommentCount,
  };
}
