/**
 * useTravelIdentity — data hook for the Travel Identity Passport surface (§19).
 *
 * Reuses the existing §29 aggregate endpoint `GET /api/passport/:userId/projection`
 * (via `getTravelIdentity()`), reading only the `travelIdentity` slice: the
 * inferred, explainable Travel-DNA dimensions + traits (TABLE 20). The server
 * runs the inference and attaches the EVIDENCE for each reading, so this hook
 * never re-derives a "travel style" client-side (§30 — no client policy).
 *
 * Show / Hide / Not-Me (§19): the server projection carries each item's stored
 * `state`, but there is no write endpoint on the API server for these prefs yet,
 * so the SCREEN owns the toggles as optimistic local state seeded from `state`.
 * This hook is read-only; it just surfaces the projection + loading/error.
 *
 * Owner-facing (mirrors MyWorld / Journeys): the owner id comes from the session
 * so the projection returns the editable self-view with all items (including any
 * the owner previously hid — so they can toggle them back).
 */
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext.tsx';
import {
  getTravelIdentity,
  type TravelIdentityProjection,
} from '../../services/passportProjection.ts';

export interface UseTravelIdentityResult {
  identity: TravelIdentityProjection | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useTravelIdentity(): UseTravelIdentityResult {
  const { userId } = useSession();
  const [identity, setIdentity] = useState<TravelIdentityProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setIdentity(null);
      setError('Sign in to see your travel identity');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await getTravelIdentity(userId);
    if (res.ok) {
      setIdentity(res.data);
    } else {
      setError(res.message ?? 'Could not load your travel identity');
      setIdentity(null);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { identity, loading, error, reload: load };
}
