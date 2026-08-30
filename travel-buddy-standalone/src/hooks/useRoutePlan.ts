/**
 * useRoutePlan — loads and periodically polls a route plan for checkpoint updates.
 * For trip-linked plans, also fetches group member progress.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchRoutePlan,
  fetchRoutePlanMembers,
  patchRoutePlanStop,
  type FullRoutePlan,
  type CheckpointStatus,
  type PatchStopPayload,
  type RoutePlanMembersResult,
} from '../services/routePlan.ts';
import { deriveRouteProgress } from './routeProgress.ts';

const POLL_INTERVAL_MS    = 10_000;
const MEMBERS_POLL_MS     = 30_000;

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
  memberProgress: RoutePlanMembersResult | null;
}

export function useRoutePlan({ planId, pollingEnabled = true }: UseRoutePlanOptions): UseRoutePlanResult {
  const [plan, setPlan]               = useState<FullRoutePlan | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [memberProgress, setMemberProgress] = useState<RoutePlanMembersResult | null>(null);

  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const membersRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const loadMembers = useCallback(async () => {
    if (!planId || !plan?.plan.tripId) return;
    try {
      const result = await fetchRoutePlanMembers(planId);
      setMemberProgress(result);
    } catch {
      // Non-fatal: member progress is supplementary
    }
  }, [planId, plan?.plan.tripId]);

  useEffect(() => {
    load();
  }, [load]);

  // Fetch member progress once the plan loads (only for trip-linked plans)
  useEffect(() => {
    if (plan?.plan.tripId) {
      loadMembers();
    }
  }, [plan?.plan.tripId, loadMembers]);

  useEffect(() => {
    if (!pollingEnabled || !planId) return;
    timerRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load, planId, pollingEnabled]);

  // Poll member progress less frequently
  useEffect(() => {
    if (!pollingEnabled || !planId || !plan?.plan.tripId) return;
    membersRef.current = setInterval(loadMembers, MEMBERS_POLL_MS);
    return () => {
      if (membersRef.current) clearInterval(membersRef.current);
    };
  }, [loadMembers, planId, pollingEnabled, plan?.plan.tripId]);

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

  const { completedCount, totalCount, progressFraction, nextStop } =
    deriveRouteProgress(plan?.stops ?? []);

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
    memberProgress,
  };
}
