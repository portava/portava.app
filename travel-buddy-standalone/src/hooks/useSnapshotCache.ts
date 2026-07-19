/**
 * useSnapshotCache — stale-while-revalidate snapshot cache.
 *
 * Reads an AsyncStorage snapshot for `key` on mount and returns it immediately
 * so screens can paint before the network fetch completes. Exposes a `save`
 * function screens call after a successful network fetch, and a `clear`
 * function for pull-to-refresh.
 *
 * Snapshot keys are automatically namespaced per-user:
 *   `snap:v1:<key>:<userId>`
 *
 * Constraints:
 *   - TTL:  1 hour (configurable via `ttlMs`)
 *   - Size: 128 KB JSON cap (writes silently dropped if exceeded)
 *   - Stale snapshots are returned but `isStale` is set to true
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSession } from '../context/SessionContext.tsx';
import {
  _buildKey,
  _loadSnapshot,
  _saveSnapshot,
  _clearSnapshot,
} from './snapshotCacheUtils.ts';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface SnapshotCacheResult<T> {
  /** Cached data from the previous session, or null if not yet loaded / expired (only if stale-past-TTL is null). */
  snapshot: T | null;
  /** True when the snapshot is older than `ttlMs`. The data is still returned — screens can show a subtle indicator if desired. */
  isStale: boolean;
  /** Fire-and-forget: serialise `data` to AsyncStorage. Silently skips if JSON exceeds 128 KB. */
  save: (data: T) => void;
  /** Remove the cached snapshot (e.g. on pull-to-refresh). */
  clear: () => void;
}

export function useSnapshotCache<T>(
  key: string,
  ttlMs: number = DEFAULT_TTL_MS,
): SnapshotCacheResult<T> {
  const { userId } = useSession();
  const [snapshot, setSnapshot] = useState<T | null>(null);
  const [isStale, setIsStale] = useState(false);

  // Keep userId in a ref so save/clear callbacks stay stable across uid changes
  const userIdRef = useRef(userId);
  useEffect(() => { userIdRef.current = userId; }, [userId]);

  // Derive the namespaced storage key (null when no userId yet)
  const storageKey = userId ? _buildKey(key, userId) : null;

  // Read snapshot from AsyncStorage on mount / when userId becomes available
  useEffect(() => {
    if (!storageKey) return;
    let cancelled = false;
    _loadSnapshot<T>(AsyncStorage, storageKey, ttlMs, Date.now())
      .then((result) => {
        if (cancelled || !result) return;
        setSnapshot(result.data);
        setIsStale(result.isStale);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [storageKey, ttlMs]);

  const save = useCallback((data: T) => {
    const uid = userIdRef.current;
    if (!uid) return;
    _saveSnapshot<T>(AsyncStorage, key, uid, data, Date.now());
    setSnapshot(data);
    setIsStale(false);
  }, [key]);

  const clear = useCallback(() => {
    const uid = userIdRef.current;
    if (!uid) return;
    _clearSnapshot(AsyncStorage, key, uid);
    setSnapshot(null);
    setIsStale(false);
  }, [key]);

  return { snapshot, isStale, save, clear };
}
