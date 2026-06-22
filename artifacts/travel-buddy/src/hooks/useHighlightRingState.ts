/**
 * useHighlightRingState — fetches and caches active-highlight ring state for a user.
 *
 * Uses a module-level LRU-style cache (60 s TTL) so multiple cards showing the
 * same user don't hammer the API.
 *
 * Pass an incrementing `refreshKey` to force a cache-bust and immediate re-fetch
 * (e.g. after the owner creates a new highlight so the ring activates instantly).
 */
import { useState, useEffect, useRef } from 'react';
import { fetchUserHighlights, type Highlight } from '../services/highlights';

export interface HighlightRingState {
  hasActive: boolean;
  allViewed: boolean;
  highlights: Highlight[];
}

interface CacheEntry {
  state: HighlightRingState;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();
const inFlight = new Set<string>();

/** Load a set of viewed highlight IDs from module state (updated by HighlightViewer). */
export const viewedHighlightIds = new Set<string>();

export function markViewed(id: string): void {
  viewedHighlightIds.add(id);
}

function getCached(userId: string): HighlightRingState | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(userId);
    return null;
  }
  return entry.state;
}

function computeState(highlights: Highlight[]): HighlightRingState {
  const hasActive = highlights.length > 0;
  const allViewed = hasActive && highlights.every((h) => viewedHighlightIds.has(h.id));
  return { hasActive, allViewed, highlights };
}

/** Invalidate the cache for a user (e.g. after creating a new highlight). */
export function invalidateHighlightCache(userId: string): void {
  cache.delete(userId);
}

/**
 * Hook: returns { hasActive, allViewed, highlights } for the given userId.
 * Returns null while loading. Safe to call with null userId (returns null immediately).
 *
 * Pass an incrementing `refreshKey` to force a cache-bust and immediate re-fetch.
 * Increment it (e.g. via setState(k => k + 1)) after a successful highlight creation
 * so the ring activates without waiting for the 60-second TTL to expire.
 */
export function useHighlightRingState(userId: string | null, refreshKey = 0): HighlightRingState | null {
  const [state, setState] = useState<HighlightRingState | null>(() =>
    userId ? getCached(userId) : null,
  );
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  useEffect(() => {
    if (!userId) {
      setState(null);
      return;
    }

    // A non-zero refreshKey means the caller explicitly requested a fresh fetch.
    // Bust the cache entry so the fetch below runs unconditionally.
    if (refreshKey > 0) {
      cache.delete(userId);
    }

    const cached = getCached(userId);
    if (cached) {
      // Re-compute allViewed with latest viewedIds
      setState(computeState(cached.highlights));
      return;
    }

    if (inFlight.has(userId)) return;

    inFlight.add(userId);
    fetchUserHighlights(userId)
      .then((r) => {
        const highlights = r.ok && r.data ? r.data : [];
        const computed = computeState(highlights);
        cache.set(userId, { state: computed, fetchedAt: Date.now() });
        inFlight.delete(userId);
        if (userIdRef.current === userId) setState(computed);
      })
      .catch(() => {
        inFlight.delete(userId);
      });
  }, [userId, refreshKey]);

  return state;
}
