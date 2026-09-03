/**
 * useJourneys — data hook for the standalone Journeys Passport surface (§14).
 *
 * Reuses the existing privacy-safe endpoint `GET /api/passport/:userId/journeys`
 * (via `getPassportJourneys()`), which the server already groups into the
 * WORLD → year → country → city → Trip hierarchy (TABLE 26) and coarsens per
 * viewer permission. This hook invents no endpoint and holds no Trip storage of
 * its own (§34): it only fetches the owner's own journeys projection and exposes
 * loading / error / restricted state to the screen.
 *
 * The owner id comes from the session; this surface is owner-facing (mirrors
 * MyWorld). When there is no session the hook fails soft with a sign-in message.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext.tsx';
import {
  getPassportJourneys,
  type JourneysProjection,
} from '../../services/passportProjection.ts';

export interface UseJourneysResult {
  journeys: JourneysProjection | null;
  /** True when the server withheld data (blocked/unavailable viewer). */
  restricted: boolean;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useJourneys(): UseJourneysResult {
  const { userId } = useSession();
  const [journeys, setJourneys] = useState<JourneysProjection | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setJourneys(null);
      setRestricted(false);
      setError('Sign in to see your journeys');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await getPassportJourneys(userId);
    if (res.ok) {
      setJourneys(res.data.journeys);
      setRestricted(res.data.restricted);
    } else {
      setError(res.message ?? 'Could not load your journeys');
      setJourneys(null);
      setRestricted(false);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { journeys, restricted, loading, error, reload: load };
}
