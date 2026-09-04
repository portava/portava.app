/**
 * usePassportProjection — fetch the §29 Passport aggregate for a given traveler
 * as the current viewer, for the §3 Passport Home previews (recent stamps,
 * Featured Journey, next Trip, memories) and the §17 "YOU TWO" summary.
 *
 * All privacy filtering happens server-side (§4/§21/§30); this hook is a thin
 * fetch wrapper with a §31 client cache in front of it. It FAILS SOFT: any
 * auth/network error sets `error` and leaves `data` at whatever the cache could
 * still serve (or null) so callers can render nothing (owner Home) or a quiet
 * empty state (viewer). A null/empty `userId` is a no-op — no fetch is issued —
 * which keeps the owner Passport tab and public-passport component tests
 * hermetic when they inject data via a hookOverride instead.
 *
 * §31 CACHE (passportProjectionCache):
 *   • In-memory first (instant on remount), then AsyncStorage (instant across
 *     app launches), then always a revalidation fetch.
 *   • Tiered TTLs: the static identity half is served for a long time; the
 *     volatile half (traveler state, availability, trust, shared context,
 *     capabilities) is BLANKED once past the short TTL so stale availability is
 *     never shown as current and capabilities fail closed until the fetch lands.
 *   • Expiry-on-read: the tier check runs at read time, never on a timer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getPassportProjection,
  type PassportProjectionView,
} from '../services/passportProjection.ts';
import {
  projectionStorageKey,
  readMemoryCache,
  resolveCached,
  writeMemoryCache,
  type CachedProjection,
} from './passportProjectionCache.ts';

export interface UsePassportProjectionResult {
  data: PassportProjectionView | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

async function readStorage(userId: string): Promise<CachedProjection | null> {
  try {
    const raw = await AsyncStorage.getItem(projectionStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedProjection;
    if (!parsed || typeof parsed.fetchedAt !== 'number' || !parsed.data) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeStorage(userId: string, entry: CachedProjection): Promise<void> {
  try {
    await AsyncStorage.setItem(projectionStorageKey(userId), JSON.stringify(entry));
  } catch {
    // Cache persistence is best-effort; a failure never surfaces to the user.
  }
}

export function usePassportProjection(
  userId: string | null | undefined,
): UsePassportProjectionResult {
  const [data, setData] = useState<PassportProjectionView | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // Bumping this forces a refetch without changing userId.
  const [nonce, setNonce] = useState(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const id = (userId ?? '').trim();
    if (!id) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const alive = () => !cancelled && aliveRef.current;

    // 1. In-memory cache — synchronous, so a remount shows instantly.
    const mem = resolveCached(readMemoryCache(id), Date.now());
    if (mem) {
      setData(mem.data);
      // A fully-fresh in-memory hit still revalidates in the background, but
      // does not need the spinner; a stale/absent one shows loading.
      setLoading(!mem.fresh);
    } else {
      setData(null);
      setLoading(true);
    }
    setError(null);

    // 2. AsyncStorage cache — only when memory missed (memory is newer).
    if (!mem) {
      void readStorage(id).then((stored) => {
        if (!alive()) return;
        const resolved = resolveCached(stored, Date.now());
        // Only fill from storage if the fetch has not already produced data.
        if (resolved && !cancelled) {
          setData((cur) => cur ?? resolved.data);
        }
      });
    }

    // 3. Always revalidate against the server.
    getPassportProjection(id)
      .then((res) => {
        if (!alive()) return;
        if (res.ok) {
          const fetchedAt = Date.now();
          writeMemoryCache(id, res.data, fetchedAt);
          void writeStorage(id, { data: res.data, fetchedAt });
          setData(res.data);
          setError(null);
        } else {
          // Keep whatever the cache served; only report the error.
          setError(res.message);
        }
      })
      .catch((e) => {
        if (!alive()) return;
        setError(e instanceof Error ? e.message : 'Network error');
      })
      .finally(() => {
        if (!alive()) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
