import { useCallback, useEffect, useState } from 'react';
import { fetchInteractionContext, type InteractionContext } from '../services/interactionContext.ts';

interface UseUserInteractionContextResult {
  context: InteractionContext | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useUserInteractionContext(userId: string | null): UseUserInteractionContextResult {
  const [context, setContext] = useState<InteractionContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true); setError(null);
    const res = await fetchInteractionContext(userId);
    setLoading(false);
    if (res.ok && res.data) { setContext(res.data); }
    else { setError(res.error ?? 'Unknown error'); }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  return { context, loading, error, refresh: load };
}
