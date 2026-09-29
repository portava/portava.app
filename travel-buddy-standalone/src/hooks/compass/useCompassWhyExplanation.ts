import { useState, useCallback } from 'react';
import { fetchCompassWhy, type CompassWhyFactor } from '../../services/compass.ts';

interface UseCompassWhyExplanationResult {
  explanation:    string | null;
  factors:        CompassWhyFactor[];
  compassMatch:   number | null;
  communityScore: number | null;
  loading:        boolean;
  /** census-discovery §104 (DV-83, D-W11X2-58): the explanation could not be read — never shown as the generic one. */
  failed:         boolean;
  fetch:          (recommendationId: string) => Promise<string | null>;
  clear:          () => void;
}

export function useCompassWhyExplanation(): UseCompassWhyExplanationResult {
  const [explanation, setExplanation]       = useState<string | null>(null);
  const [factors, setFactors]               = useState<CompassWhyFactor[]>([]);
  const [compassMatch, setCompassMatch]     = useState<number | null>(null);
  const [communityScore, setCommunityScore] = useState<number | null>(null);
  const [loading, setLoading]               = useState(false);
  const [failed, setFailed]                 = useState(false);

  const fetch = useCallback(async (recommendationId: string): Promise<string | null> => {
    setLoading(true);
    const r = await fetchCompassWhy(recommendationId);
    setLoading(false);
    setFailed(!r.ok);
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
    setFailed(false);
  }, []);

  return { explanation, factors, compassMatch, communityScore, loading, failed, fetch, clear };
}
