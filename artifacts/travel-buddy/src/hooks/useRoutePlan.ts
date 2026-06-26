/**
 * useRoutePlan — loads and periodically polls a route plan for checkpoint updates.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchRoutePlan,
  patchRoutePlanStop,
  type FullRoutePlan,
  type CheckpointStatus,
  type PatchStopPayload,
} from '../services/routePlan';

const POLL_INTERVAL_MS = 10_000;

export interface UseRoutePlanOptions {
  planId: string | null;
  pollingEnabled?: boolean;
}

export interface UseRoutePlanResult {
  plan: FullRoutePlan | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  markArrived: (stopId: string) => Promise<void>;
  skipStop: (stopId: string) => Promise<void>;
  patchStop: (stopId: string, payload: PatchStopPayload) => Promise<void>;
  completedCount: number;
  totalCount: number;
  progressFraction: number;
  nextStop: FullRoutePlan['stops'][number] | null;
}

export function useRoutePlan({ planId, pollingEnabled = true }: UseRoutePlanOptions): UseRoutePlanResult {
  const [plan, setPlan] = useState<FullRoutePlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!planId) return;
    if (!quiet) setLoading(true);
    try {
      const data = await fetchRoutePlan(planId);
      setPlan(data);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load route plan');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [planId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!pollingEnabled || !planId) return;
    timerRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load, planId, pollingEnabled]);

  const patchStop = useCallback(async (stopId: string, payload: PatchStopPayload) => {
    if (!planId) return;
    const updated = await patchRoutePlanStop(planId, stopId, payload);
    setPlan((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        stops: prev.stops.map((s) => (s.id === updated.id ? updated : s)),
      };
    });
  }, [planId]);

  const markArrived = useCallback(async (stopId: string) => {
    await patchStop(stopId, { checkpointStatus: 'arrived' });
  }, [patchStop]);

  const skipStop = useCallback(async (stopId: string) => {
    await patchStop(stopId, { checkpointStatus: 'skipped' });
  }, [patchStop]);

  const completedCount = plan?.stops.filter((s) => s.checkpointStatus === 'arrived').length ?? 0;
  const totalCount = plan?.stops.length ?? 0;
  const progressFraction = totalCount > 0 ? completedCount / totalCount : 0;

  const nextStop = plan?.stops.find((s) => s.checkpointStatus === 'pending') ?? null;

  return {
    plan,
    loading,
    error,
    refresh: load,
    markArrived,
    skipStop,
    patchStop,
    completedCount,
    totalCount,
    progressFraction,
    nextStop,
  };
}
