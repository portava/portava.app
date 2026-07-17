import { useState, useCallback } from 'react';
import { fetchCompassWhy } from '../../services/compass.ts';

interface UseCompassWhyExplanationResult {
  explanation: string | null;
  loading:     boolean;
  fetch:       (recommendationId: string) => Promise<string | null>;
  clear:       () => void;
}

export function useCompassWhyExplanation(): UseCompassWhyExplanationResult {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);

  const fetch = useCallback(async (recommendationId: string): Promise<string | null> => {
    setLoading(true);
    const r = await fetchCompassWhy(recommendationId);
    setLoading(false);
    const text = r.ok ? (r.explanation ?? null) : null;
    setExplanation(text);
    return text;
  }, []);

  const clear = useCallback(() => setExplanation(null), []);

  return { explanation, loading, fetch, clear };
}
