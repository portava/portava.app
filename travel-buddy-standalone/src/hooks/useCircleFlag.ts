/**
 * useCircleFlag — reads the `find_your_circle_enabled` feature flag.
 *
 * Follows the same caching + fail-safe pattern as useRentABuddyFlag.
 * Returns { enabled: false } when the flag is missing, the API is unreachable,
 * or the Supabase client is not configured.
 */
import { useEffect, useState } from 'react';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

let _cachedEnabled: boolean | null = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function _resetCircleFlagCache(): void {
  _cachedEnabled = null;
  _cacheTs = 0;
}

export async function _resolveCircleFlag(apiBase: string, nowMs = Date.now()): Promise<boolean> {
  if (_cachedEnabled !== null && nowMs - _cacheTs < CACHE_TTL_MS) {
    return _cachedEnabled;
  }

  try {
    const r = await fetch(`${apiBase}/api/feature-flags`);
    const body = await r.json() as { flags?: Record<string, boolean> };
    const val = body?.flags?.['find_your_circle_enabled'] ?? false;
    _cachedEnabled = val;
    _cacheTs = nowMs;
    return val;
  } catch {
    return false;
  }
}

export function useCircleFlag(): { enabled: boolean; loading: boolean } {
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

    _resolveCircleFlag(API_BASE, now)
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
