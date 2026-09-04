/**
 * usePassportProjection — fetch the §29 Passport aggregate for a given traveler
 * as the current viewer, for the §3 Passport Home previews (recent stamps,
 * Featured Journey, next Trip, memories) and the §17 "YOU TWO" summary.
 *
 * All privacy filtering happens server-side (§4/§21/§30); this hook is a thin
 * fetch-and-cache-in-state wrapper. It FAILS SOFT: any auth/network error sets
 * `error` and leaves `data` null so callers can render nothing (owner Home) or a
 * quiet empty state (viewer). A null/empty `userId` is a no-op — no fetch is
 * issued — which keeps the owner Passport tab and public-passport component
 * tests hermetic when they inject data via a hookOverride instead.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPassportProjection,
  type PassportProjectionView,
} from '../services/passportProjection.ts';

export interface UsePassportProjectionResult {
  data: PassportProjectionView | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
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
    setLoading(true);
    setError(null);
    getPassportProjection(id)
      .then((res) => {
        if (cancelled || !aliveRef.current) return;
        if (res.ok) {
          setData(res.data);
          setError(null);
        } else {
          setData(null);
          setError(res.message);
        }
      })
      .catch((e) => {
        if (cancelled || !aliveRef.current) return;
        setData(null);
        setError(e instanceof Error ? e.message : 'Network error');
      })
      .finally(() => {
        if (cancelled || !aliveRef.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
