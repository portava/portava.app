import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { fetchTripPlan, type TripPlanResult } from '../services/tripPlan.ts';

export interface UsePlanSyncOptions {
  /** When false, polling is disabled (e.g. access denied). Defaults to true. */
  enabled?: boolean;
  /** Poll interval in ms while the screen is focused and the app is active. */
  intervalMs?: number;
  /** Called with the latest plan on every successful poll. */
  onResult: (result: TripPlanResult) => void;
  /** Optional error handler; polling errors are otherwise swallowed. */
  onError?: (error: unknown) => void;
}

export interface UsePlanSyncApi {
  /** Force an immediate re-fetch outside the regular interval. */
  syncNow: () => Promise<void>;
}

/**
 * Lightweight background sync for a trip plan. While the host screen is focused
 * and the app is in the foreground, it polls `fetchTripPlan(tripId)` on a fixed
 * interval and hands the result to `onResult`. Polling stops when the screen
 * loses focus or the app is backgrounded, and resumes (with an immediate sync)
 * when it returns. Overlapping requests are suppressed.
 */
export function usePlanSync(
  tripId: string,
  { enabled = true, intervalMs = 10_000, onResult, onError }: UsePlanSyncOptions,
): UsePlanSyncApi {
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const inFlight = useRef(false);

  const syncNow = useCallback(async () => {
    if (!tripId || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await fetchTripPlan(tripId);
      onResultRef.current(result);
    } catch (error) {
      onErrorRef.current?.(error);
    } finally {
      inFlight.current = false;
    }
  }, [tripId]);

  useFocusEffect(
    useCallback(() => {
      if (!enabled || !tripId) return;

      let timer: ReturnType<typeof setInterval> | null = null;
      const start = () => {
        if (timer) return;
        timer = setInterval(() => {
          if (AppState.currentState === 'active') void syncNow();
        }, intervalMs);
      };
      const stop = () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      };

      start();
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          void syncNow();
          start();
        } else {
          stop();
        }
      });

      return () => {
        stop();
        sub.remove();
      };
    }, [enabled, tripId, intervalMs, syncNow]),
  );

  return { syncNow };
}
