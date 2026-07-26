/**
 * useGridFeed — fetches paginated Grid-mode feed items.
 *
 * Manages filter state, cursor pagination, and session IDs for the grid feed.
 * Switching the filter resets the cursor and fetches a fresh first page.
 *
 * Uses the mediaFeed service (authenticated, base-URL-aware) rather than
 * calling fetch() directly, so requests carry the correct bearer token and
 * base URL on all platforms.
 */

import { useState, useCallback, useRef } from 'react';
import { fetchGridFeed } from '../services/mediaFeed.ts';
import type { MediaGridItem, GridFilter } from '../types/media.ts';

// ── State shape ───────────────────────────────────────────────────────────────

interface GridSlot {
  items: MediaGridItem[];
  nextCursor: string | null;
  sessionId: string;
  loading: boolean;
  error: string | null;
}

function newSlot(sessionId: string): GridSlot {
  return {
    items: [],
    nextCursor: null,
    sessionId,
    loading: false,
    error: null,
  };
}

function genSessionId(): string {
  return `gsess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface GridFeedState {
  filter: GridFilter;
  setFilter: (f: GridFilter) => void;

  items: MediaGridItem[];
  loading: boolean;
  error: string | null;

  /** Load the first page (or refresh the current filter). */
  loadFeed: () => Promise<void>;
  /** Append the next page. No-op when there is no next cursor or already loading. */
  loadMore: () => Promise<void>;
}

export function useGridFeed(): GridFeedState {
  const [filter, setFilterState] = useState<GridFilter>('all');

  // Single slot — filter switches reset state entirely.
  const slotRef = useRef<GridSlot>(newSlot(genSessionId()));

  // Trigger re-render by bumping a version counter.
  const [, bumpVersion] = useState(0);
  const rerender = useCallback(() => bumpVersion((v) => v + 1), []);

  // ── Fetch helper ────────────────────────────────────────────────────────────

  const fetchPage = useCallback(
    async (f: GridFilter, cursor: string | null): Promise<void> => {
      const s = slotRef.current;
      if (s.loading) return;

      slotRef.current = { ...s, loading: true, error: null };
      rerender();

      const result = await fetchGridFeed({
        filter: f,
        cursor: cursor ?? undefined,
        sessionId: slotRef.current.sessionId,
      });

      if (result.ok && result.data) {
        const data = result.data;
        slotRef.current = {
          ...slotRef.current,
          items: cursor
            ? [...slotRef.current.items, ...data.items]
            : data.items,
          nextCursor: data.nextCursor,
          sessionId: data.sessionId || slotRef.current.sessionId,
          loading: false,
          error: null,
        };
      } else {
        slotRef.current = {
          ...slotRef.current,
          loading: false,
          error: result.message ?? 'Failed to load grid feed',
        };
      }

      rerender();
    },
    [rerender],
  );

  // ── Public API ──────────────────────────────────────────────────────────────

  const setFilter = useCallback(
    (f: GridFilter) => {
      setFilterState(f);
      // Reset state and immediately fetch the first page for the new filter.
      slotRef.current = newSlot(genSessionId());
      rerender();
      fetchPage(f, null);
    },
    [fetchPage, rerender],
  );

  const loadFeed = useCallback(async () => {
    const currentFilter = filter;
    slotRef.current = newSlot(genSessionId());
    rerender();
    await fetchPage(currentFilter, null);
  }, [filter, fetchPage, rerender]);

  const loadMore = useCallback(async () => {
    const s = slotRef.current;
    if (!s.nextCursor || s.loading) return;
    await fetchPage(filter, s.nextCursor);
  }, [filter, fetchPage]);

  const slot = slotRef.current;

  return {
    filter,
    setFilter,
    items: slot.items,
    loading: slot.loading,
    error: slot.error,
    loadFeed,
    loadMore,
  };
}
