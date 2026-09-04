/**
 * useContributions — data hook for the §20 Contribution reputation card.
 *
 * Fetches the reputation read route (`GET /api/passport/:userId/contributions`)
 * for `userId`, defaulting to the signed-in user. The hook never derives
 * reputation on the client — it only unwraps the already-privacy-filtered
 * server payload (see passportContributions.normalizeContributions). When the
 * route is absent or fails, `contributions` is null and the caller falls back to
 * the projection credentials.
 *
 * `enabled` is a test/perf seam: when false the hook does no I/O and stays inert
 * (used by surfaces driven entirely by an injected override so no network or
 * post-unmount setState leaks into the test).
 */
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/SessionContext.tsx';
import {
  getPassportContributions,
  type ContributionProjection,
} from '../../services/passportContributions.ts';

export interface UseContributionsResult {
  contributions: ContributionProjection | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useContributions(
  userId?: string,
  opts: { enabled?: boolean } = {},
): UseContributionsResult {
  const enabled = opts.enabled !== false;
  const session = useSession();
  const targetId = userId ?? session.userId ?? null;

  const [contributions, setContributions] = useState<ContributionProjection | null>(null);
  const [loading, setLoading] = useState(enabled && !!targetId);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled || !targetId) {
      setContributions(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await getPassportContributions(targetId);
    if (res.ok) {
      setContributions(res.data);
    } else {
      setContributions(null);
      setError(res.message);
    }
    setLoading(false);
  }, [enabled, targetId]);

  useEffect(() => {
    load();
  }, [load]);

  return { contributions, loading, error, reload: load };
}
