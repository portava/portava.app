/**
 * useNextBestAction — fetches the trip's next best action (Trip Brain wave).
 *
 * Fail-soft by design: resolves to null when the API base is unconfigured,
 * the server flag (trip_readiness_enabled) is off, the caller lacks access,
 * or the request fails — so the Today/Next Up section renders its existing
 * empty state unchanged in every degraded case.
 */
import { useEffect, useState } from 'react';
import { fetchNextBestAction, type NextBestAction } from '../services/tripIntel.ts';

export function useNextBestAction(tripId: string | null | undefined): {
  action: NextBestAction['primary'];
  loading: boolean;
} {
  const [action, setAction] = useState<NextBestAction['primary']>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(tripId));

  useEffect(() => {
    let cancelled = false;
    if (!tripId) { setAction(null); setLoading(false); return; }
    setLoading(true);
    (async () => {
      const nba = await fetchNextBestAction(tripId);
      if (cancelled) return;
      setAction(nba?.primary ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tripId]);

  return { action, loading };
}
