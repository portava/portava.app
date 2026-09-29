import { useState, useCallback, useRef } from 'react';
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
  const [failed, setFailed]                 = useState(false); const reqRef = useRef(0);  // census-discovery §105 (DV-83, D-W11X2-63): only the LATEST request writes the sheet (as DiscoveryCategoryTab, D-W11X2-38)

  const fetch = useCallback(async (recommendationId: string): Promise<string | null> => {
    const myId = ++reqRef.current; setLoading(true); setExplanation(null); setFactors([]); setCompassMatch(null); setCommunityScore(null); setFailed(false);  // §105: a new card never shows the last card's reason
    const r = await fetchCompassWhy(recommendationId); if (reqRef.current !== myId) return null;  // §105: another card's (or a closed sheet's) late answer is dropped
    setLoading(false);
    setFailed(!r.ok);
    const text = r.ok ? (r.explanation ?? null) : null;
    setExplanation(text);
    setFactors(r.ok ? (r.factors ?? []) : []);
    setCompassMatch(r.ok ? (r.compassMatch ?? null) : null);
    setCommunityScore(r.ok ? (r.communityScore ?? null) : null);
    return text;
  }, []);

  const clear = useCallback(() => { reqRef.current += 1; setLoading(false);  // §105: a sheet closed mid-read is written by nothing
    setExplanation(null);
    setFactors([]);
    setCompassMatch(null);
    setCommunityScore(null);
    setFailed(false);
  }, []);

  return { explanation, factors, compassMatch, communityScore, loading, failed, fetch, clear };
}
