/**
 * useTripCrewMap
 *
 * Polls GET /api/trips/:tripId/crew/map every 30 seconds.
 * Same pattern as useThreadMessages — interval ref prevents drift on re-renders.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { getCrewMap, type CrewMapResponse, type CrewMemberCard } from '../services/tripCrewLocation';

export interface UseTripCrewMapResult {
  members: CrewMemberCard[];
  totalCount: number;
  featureEnabled: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 30_000;

export function useTripCrewMap(tripId: string | null): UseTripCrewMapResult {
  const [members, setMembers] = useState<CrewMemberCard[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [featureEnabled, setFeatureEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMap = useCallback(async () => {
    if (!tripId) return;
    setLoading((prev) => prev ? prev : true);
    const result = await getCrewMap(tripId);
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMembers(result.data.members);
    setTotalCount(result.data.totalCount);
    setFeatureEnabled(result.data.featureEnabled);
    setError(null);
  }, [tripId]);

  useEffect(() => {
    if (!tripId) return;
    fetchMap();
    intervalRef.current = setInterval(fetchMap, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [tripId, fetchMap]);

  return { members, totalCount, featureEnabled, loading, error, refresh: fetchMap };
}
