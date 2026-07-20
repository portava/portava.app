import { useState, useCallback } from 'react';
import { fetchCompassWhy, type CompassWhyFactor } from '../../services/compass.ts';

interface UseCompassWhyExplanationResult {
  explanation:    string | null;
  factors:        CompassWhyFactor[];
  compassMatch:   number | null;
  communityScore: number | null;
  loading:        boolean;
  fetch:          (recommendationId: string) => Promise<string | null>;
  clear:          () => void;
}

export function useCompassWhyExplanation(): UseCompassWhyExplanationResult {
  const [explanation, setExplanation]       = useState<string | null>(null);
  const [factors, setFactors]               = useState<CompassWhyFactor[]>([]);
  const [compassMatch, setCompassMatch]     = useState<number | null>(null);
  const [communityScore, setCommunityScore] = useState<number | null>(null);
  const [loading, setLoading]               = useState(false);

  const fetch = useCallback(async (recommendationId: string): Promise<string | null> => {
    setLoading(true);
    const r = await fetchCompassWhy(recommendationId);
    setLoading(false);
    const text = r.ok ? (r.explanation ?? null) : null;
    setExplanation(text);
    setFactors(r.ok ? (r.factors ?? []) : []);
    setCompassMatch(r.ok ? (r.compassMatch ?? null) : null);
    setCommunityScore(r.ok ? (r.communityScore ?? null) : null);
    return text;
  }, []);

  const clear = useCallback(() => {
    setExplanation(null);
    setFactors([]);
    setCompassMatch(null);
    setCommunityScore(null);
  }, []);

  return { explanation, factors, compassMatch, communityScore, loading, fetch, clear };
}
