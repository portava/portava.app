/**
 * useRentABuddyFlag — reads the `rent_buddy_enabled` feature flag.
 *
 * Integrates with the existing /api/feature-flags endpoint.
 * Returns true only when the flag is explicitly enabled server-side.
 */
import { useEffect, useState } from 'react';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

let _cachedEnabled: boolean | null = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resets the module-level cache. For use in tests only.
 */
export function _resetFlagCache(): void {
  _cachedEnabled = null;
  _cacheTs = 0;
}

/**
 * Returns the raw cache state. For use in tests only.
 */
export function _getRawCacheState(): { cachedEnabled: boolean | null; cacheTs: number; ttlMs: number } {
  return { cachedEnabled: _cachedEnabled, cacheTs: _cacheTs, ttlMs: CACHE_TTL_MS };
}

/**
 * Core logic: check cache, fetch if needed, update cache, return value.
 *
 * Extracted from useEffect so it can be tested in node:test without React.
 * `nowMs` defaults to Date.now() and can be overridden in tests to control
 * time deterministically. The same value is written to `_cacheTs` so the
 * function is fully deterministic under test control.
 *
 * Returns false on any fetch/parse error (fail-safe).
 */
export async function _resolveFlag(apiBase: string, nowMs = Date.now()): Promise<boolean> {
  if (_cachedEnabled !== null && nowMs - _cacheTs < CACHE_TTL_MS) {
    return _cachedEnabled;
  }

  try {
    const r = await fetch(`${apiBase}/api/feature-flags`);
    const body = await r.json() as { flags?: Record<string, boolean> };
    const val = body?.flags?.['rent_buddy_enabled'] ?? false;
    _cachedEnabled = val;
    _cacheTs = nowMs;
    return val;
  } catch {
    return false;
  }
}

export function useRentABuddyFlag(): { enabled: boolean; loading: boolean } {
  const [enabled, setEnabled] = useState<boolean>(_cachedEnabled ?? false);
  const [loading, setLoading] = useState<boolean>(_cachedEnabled === null);

  useEffect(() => {
    const now = Date.now();
    if (_cachedEnabled !== null && now - _cacheTs < CACHE_TTL_MS) {
      setEnabled(_cachedEnabled);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    _resolveFlag(API_BASE, now)
      .then((val) => {
        if (!cancelled) setEnabled(val);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  return { enabled, loading };
}
