/**
 * Global Input Intelligence — suggestion cache (spec §33 stale-while-revalidate,
 * §49 "stale cache refresh").
 *
 * A small TTL + LRU cache of suggestion lists keyed by (fieldId, normalized
 * query, coarse coords). Generalizes the 60s/60-entry LRU baked into
 * `useSearchSuggestions` so every field shares one cache implementation with
 * the same hard-won properties:
 *   - backspacing over a word re-renders instantly with zero network,
 *   - a tiny GPS drift never busts the key (coords rounded to ~1km),
 *   - the cache never returns entries past their TTL (no stale-as-fresh).
 *
 * Pure module (no React, no network, no RN) — unit-tested under node:test.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';

export interface SuggestionCacheOptions {
  /** Entry lifetime in ms. Default 60_000 (matches legacy search cache). */
  ttlMs?: number;
  /** Max entries before LRU eviction. Default 60. */
  max?: number;
}

interface CacheEntry {
  suggestions: InputSuggestion[];
  ts: number;
}

export class SuggestionCache {
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly map = new Map<string, CacheEntry>();
  /** Injectable clock for deterministic tests. */
  private readonly now: () => number;

  constructor(opts: SuggestionCacheOptions = {}, now: () => number = Date.now) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.max = opts.max ?? 60;
    this.now = now;
  }

  /**
   * Build a stable cache key. Query is trimmed + lowercased; coords are rounded
   * to 2 decimal places (~1km) so GPS jitter doesn't fragment the cache.
   */
  static key(fieldId: string, query: string, lat?: number | null, lng?: number | null): string {
    const q = query.trim().toLowerCase();
    const latKey = lat != null ? Math.round(lat * 100) / 100 : '';
    const lngKey = lng != null ? Math.round(lng * 100) / 100 : '';
    return `${fieldId}|${q}|${latKey}|${lngKey}`;
  }

  /**
   * Read a fresh entry, or `null` when missing/expired. A hit refreshes the
   * LRU recency of the entry (Map preserves insertion order → delete+set moves
   * it to the most-recent position).
   */
  get(key: string): InputSuggestion[] | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (this.now() - entry.ts >= this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // Refresh LRU position.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.suggestions;
  }

  /** Store a suggestion list, evicting the oldest entries past `max`. */
  set(key: string, suggestions: InputSuggestion[]): void {
    this.map.set(key, { suggestions, ts: this.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest == null) break;
      this.map.delete(oldest);
    }
  }

  /** True when a fresh (unexpired) entry exists for the key. */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  clear(): void {
    this.map.clear();
  }

  /** Current live entry count (excludes nothing — call after gets to prune). */
  get size(): number {
    return this.map.size;
  }
}

/**
 * Process-wide shared cache instance. Fields share it so returning to a
 * previously-typed query is instant across screens. Tests construct their own
 * `new SuggestionCache(...)` with an injected clock instead of touching this.
 */
export const sharedSuggestionCache = new SuggestionCache();
