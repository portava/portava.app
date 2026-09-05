/**
 * useYearbook — data hook for the Yearbook Passport surface (§9 Phase 9).
 *
 * Reuses the existing owner-private endpoint
 * `GET /api/passport/me/yearbook` (via `getPassportYearbook()`), which already
 * aggregates the owner's journeys, stamps, memories and Travel DNA into
 * explainable per-year lines and applies the passport privacy boundary
 * server-side. This hook invents no endpoint, stores nothing and re-derives
 * nothing — it only exposes loading / error / restricted state to the screen.
 *
 * The yearbook is the OWNER's own; there is no viewer variant, so this hook
 * takes no target id. Without a session it fails soft with a sign-in message.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext.tsx';
import {
  getPassportYearbook,
  type YearbookProjection,
} from '../../services/passportProjection.ts';

export interface UseYearbookResult {
  yearbook: YearbookProjection | null;
  /** True when the server withheld the yearbook (it is owner-private). */
  restricted: boolean;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * @param year  optional single calendar year to load. Omitted → every year with
 *   content. A requested year with nothing in it still comes back as an explicit
 *   empty entry rather than an error, so the screen shows an honest empty state.
 */
export function useYearbook(year?: number | null): UseYearbookResult {
  const { userId } = useSession();
  const [yearbook, setYearbook] = useState<YearbookProjection | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setYearbook(null);
      setRestricted(false);
      setError('Sign in to see your yearbook');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await getPassportYearbook(year ?? null);
    if (res.ok) {
      setYearbook(res.data.yearbook);
      setRestricted(res.data.restricted);
    } else {
      setError(res.message ?? 'Could not load your yearbook');
      setYearbook(null);
      setRestricted(false);
    }
    setLoading(false);
  }, [userId, year]);

  useEffect(() => {
    load();
  }, [load]);

  return { yearbook, restricted, loading, error, reload: load };
}
