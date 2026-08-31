/**
 * useMediaWorld — loads the NOW/World projection (spec §4.1/§39).
 *
 * Wraps the pure worldReducer with the projection service. Handles request
 * cancellation on unmount / reload, and stale-while-revalidate: a reload keeps
 * showing the previous dashboard until the new one arrives. Never throws — a
 * failed/absent endpoint resolves to an empty or error VIEW state that the
 * screen renders cleanly.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  INITIAL_WORLD_STATE,
  worldReducer,
  type WorldViewState,
} from '../state/worldState.ts';
import { fetchWorld, type WorldParams } from '../services/mediaProjection.ts';

export interface UseMediaWorldResult {
  state: WorldViewState;
  reload: () => void;
}

export function useMediaWorld(params: WorldParams = {}): UseMediaWorldResult {
  const [state, dispatch] = useReducer(worldReducer, INITIAL_WORLD_STATE);
  const abortRef = useRef<AbortController | null>(null);
  // Keep the latest params in a ref so reload() has a stable identity.
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: 'load_start' });
    void fetchWorld({ ...paramsRef.current, signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      dispatch({ type: 'load_result', result, at: Date.now() });
    });
  }, []);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
    // Reload when the coarse location/city inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, params.cityId, params.lat, params.lng]);

  return { state, reload: load };
}
