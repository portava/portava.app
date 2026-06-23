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
import AsyncStorage from '@react-native-async-storage/async-storage';
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

const STORAGE_KEY = '@highlight_viewed_ids_v1';

/**
 * In-memory set of viewed highlight IDs.
 * Populated on first import by `initViewedIds()` (which loads & prunes AsyncStorage).
 * Updated on every `markViewed()` call.
 */
export const viewedHighlightIds = new Set<string>();

/** Map persisted to AsyncStorage: id → ISO expiresAt string. */
let _persistedMap: Record<string, string> = {};

/** Promise that resolves once the persisted IDs have been loaded. */
let _initPromise: Promise<void> | null = null;

/** Initialise from AsyncStorage — called once at module load. */
function initViewedIds(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
      const now = Date.now();
      const pruned: Record<string, string> = {};
      for (const [id, expiresAt] of Object.entries(stored)) {
        if (new Date(expiresAt).getTime() > now) {
          pruned[id] = expiresAt;
          viewedHighlightIds.add(id);
        }
      }
      _persistedMap = pruned;
      // Write back the pruned map only if we actually removed stale entries
      if (Object.keys(pruned).length !== Object.keys(stored).length) {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
      }
    } catch {
      // Storage unavailable — fall back to module-memory only
    }
  })();
  return _initPromise;
}

// Kick off immediately so storage is ready before the first render.
initViewedIds();

/**
 * Mark a highlight as viewed.
 * Updates the in-memory set and persists id→expiresAt to AsyncStorage so
 * the ring stays muted across app restarts.
 *
 * @param id        Highlight ID.
 * @param expiresAt ISO-8601 expiry string from the Highlight object (optional;
 *                  if omitted the entry is still added in-memory but not persisted).
 */
export function markViewed(id: string, expiresAt?: string): void {
  viewedHighlightIds.add(id);
  if (!expiresAt) return;
  // Skip persistence if this id is already stored with the same expiry
  if (_persistedMap[id] === expiresAt) return;
  _persistedMap[id] = expiresAt;
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(_persistedMap)).catch(() => {});
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

    // Wait for the persisted IDs to finish loading before the first fetch so
    // computeState uses the full set and avoids a spurious "unviewed" flash.
    const run = async () => {
      await initViewedIds();
      if (inFlight.has(userId)) return;
      inFlight.add(userId);
      try {
        const r = await fetchUserHighlights(userId);
        const highlights = r.ok && r.data ? r.data : [];
        const computed = computeState(highlights);
        cache.set(userId, { state: computed, fetchedAt: Date.now() });
        if (userIdRef.current === userId) setState(computed);
      } finally {
        inFlight.delete(userId);
      }
    };

    run();
  }, [userId, refreshKey]);

  return state;
}
