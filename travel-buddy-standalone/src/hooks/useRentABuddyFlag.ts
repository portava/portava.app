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

// ── Tri-state read (testing mode, lane tm-rab) ────────────────────────────────
//
// `_resolveFlag` answers `false` both when the flag is OFF and when the flags
// could not be READ, so the layout showed the same "coming soon" screen for a
// switched-off feature and for a network failure. The layout needs the three
// apart: OFF is a gate refusal (name the gate, say what unblocks it), UNKNOWN is
// a failed read (error with retry). An UNKNOWN is never cached, so a retry
// really fetches again; ON/OFF share the existing cache and TTL.

export type RentABuddyFlagState = 'on' | 'off' | 'unknown';

export async function _resolveFlagState(apiBase: string, nowMs = Date.now()): Promise<RentABuddyFlagState> {
  if (_cachedEnabled !== null && nowMs - _cacheTs < CACHE_TTL_MS) {
    return _cachedEnabled ? 'on' : 'off';
  }
  try {
    const r = await fetch(`${apiBase}/api/feature-flags`);
    if (!r.ok) return 'unknown';
    const body = await r.json() as { flags?: Record<string, boolean> };
    if (!body || typeof body.flags !== 'object' || body.flags === null) return 'unknown';
    const val = body.flags['rent_buddy_enabled'] === true;
    _cachedEnabled = val;
    _cacheTs = nowMs;
    return val ? 'on' : 'off';
  } catch {
    return 'unknown';
  }
}

/** The layout's gate read: loading, on, off (a gate refusal) or unknown (a failed read), with a retry. */
export function useRentABuddyGate(): { state: RentABuddyFlagState | 'loading'; retry: () => void } {
  const [state, setState] = useState<RentABuddyFlagState | 'loading'>(
    _cachedEnabled === null ? 'loading' : (_cachedEnabled ? 'on' : 'off'),
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    if (_cachedEnabled !== null && now - _cacheTs < CACHE_TTL_MS) {
      setState(_cachedEnabled ? 'on' : 'off');
      return;
    }
    setState('loading');
    _resolveFlagState(API_BASE, now)
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => { if (!cancelled) setState('unknown'); });
    return () => { cancelled = true; };
  }, [attempt]);

  // A retry re-reads the flag: it drops the cached ON/OFF, so "Check again" on
  // the OFF state sees an admin's flip without waiting out the TTL.
  return { state, retry: () => { _resetFlagCache(); setAttempt((a) => a + 1); } };
}
