/**
 * useTripCrewMap
 *
 * Polls GET /api/trips/:tripId/crew/map every 30 seconds.
 * Same pattern as useThreadMessages — interval ref prevents drift on re-renders.
 * Polling is paused when the app is backgrounded or inactive and resumes
 * (with an immediate refresh) when it returns to the foreground.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { AppState } from 'react-native';
import { getCrewMap, type CrewMemberCard } from '../services/tripCrewLocation.ts';

export interface UseTripCrewMapResult {
  members: CrewMemberCard[];
  totalCount: number;
  featureEnabled: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 30_000;

export function useTripCrewMap(tripId: string | null, refreshKey = 0): UseTripCrewMapResult {
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

  // Immediate re-fetch whenever the caller increments refreshKey
  // (e.g. after sending an invite from TripInviteSheet).
  useEffect(() => {
    if (!tripId || refreshKey === 0) return;
    void fetchMap();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    if (!tripId) return;

    // Initial fetch — only when app is already in the foreground
    if (AppState.currentState === 'active') void fetchMap();

    const startPoll = () => {
      if (intervalRef.current) return;
      intervalRef.current = setInterval(() => {
        if (AppState.currentState === 'active') void fetchMap();
      }, POLL_INTERVAL_MS);
    };

    const stopPoll = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    startPoll();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void fetchMap(); // immediate refresh on foregrounding
        startPoll();
      } else {
        stopPoll();
      }
    });

    return () => {
      stopPoll();
      sub.remove();
    };
  }, [tripId, fetchMap]);

  return { members, totalCount, featureEnabled, loading, error, refresh: fetchMap };
}
