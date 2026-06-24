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

    fetch(`${API_BASE}/api/feature-flags`)
      .then((r) => r.json())
      .then((body: { flags?: Record<string, boolean> }) => {
        if (cancelled) return;
        const val = body?.flags?.['rent_buddy_enabled'] ?? false;
        _cachedEnabled = val;
        _cacheTs = Date.now();
        setEnabled(val);
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
