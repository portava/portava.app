/**
 * useSearchSuggestions — live grouped typeahead for the global search bar.
 *
 * Responsiveness contract:
 *  - 250ms debounce; in-flight request aborted when a newer keystroke lands.
 *  - Previous groups stay rendered while the next request runs (progressive),
 *    so the panel never flashes empty mid-typing.
 *  - 60s in-memory LRU cache (60 entries) keyed by query + coarse coords, so
 *    backspacing over a word re-renders instantly with zero network.
 *  - Stale-response guard: only the latest request may commit state.
 */
import { useEffect, useRef, useState } from 'react';
import { getSearchSuggestions } from '../services/discovery';
import type { SuggestGroup } from '../services/discovery';

const DEBOUNCE_MS = 250;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 60;
const MIN_CHARS = 2;

interface CacheEntry { groups: SuggestGroup[]; ts: number }

export interface UseSearchSuggestionsOpts {
  lat?: number;
  lng?: number;
  city?: string;
  /** Master switch — false clears results and stops all fetching. */
  enabled?: boolean;
}

export function useSearchSuggestions(query: string, opts: UseSearchSuggestionsOpts = {}) {
  const { lat, lng, city, enabled = true } = opts;
  const [groups, setGroups] = useState<SuggestGroup[]>([]);
  const [loading, setLoading] = useState(false);

  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  const trimmed = query.trim().toLowerCase();
  // ~1km coord rounding: tiny GPS drift must not bust the cache key
  const latKey = lat != null ? Math.round(lat * 100) / 100 : null;
  const lngKey = lng != null ? Math.round(lng * 100) / 100 : null;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!enabled || trimmed.length < MIN_CHARS) {
      abortRef.current?.abort();
      abortRef.current = null;
      seqRef.current++;
      setGroups([]);
      setLoading(false);
      return;
    }

    const key = `${trimmed}|${latKey ?? ''}|${lngKey ?? ''}`;
    const cached = cacheRef.current.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      // Refresh LRU position
      cacheRef.current.delete(key);
      cacheRef.current.set(key, cached);
      seqRef.current++;
      setGroups(cached.groups);
      setLoading(false);
      return;
    }

    setLoading(true); // keep previous groups visible while fetching
    const mySeq = ++seqRef.current;

    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const res = await getSearchSuggestions(
        trimmed,
        { lat: lat ?? undefined, lng: lng ?? undefined, city },
        ctrl.signal,
      );

      if (mySeq !== seqRef.current) return; // superseded by a newer keystroke

      if (res.ok) {
        const cache = cacheRef.current;
        cache.set(key, { groups: res.groups, ts: Date.now() });
        while (cache.size > CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest == null) break;
          cache.delete(oldest);
        }
        setGroups(res.groups);
        setLoading(false);
      } else if (!res.aborted) {
        // Transient error: keep whatever was on screen (never flash empty)
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [trimmed, enabled, latKey, lngKey, city, lat, lng]);

  // Abort any in-flight request on unmount
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  return { groups, loading };
}
