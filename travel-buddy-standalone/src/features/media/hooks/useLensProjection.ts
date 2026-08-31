/**
 * useLensProjection — generic loader for a lens projection (spec §42/§43).
 *
 * A small stale-while-revalidate loader used by the scaffolded lens screens
 * (Experiences / People / My World). Given a fetcher that returns a
 * ProjectionResult and an emptiness predicate, it exposes a LensLoadState the
 * screen renders through LensStateView. Cancels in flight on unmount/reload and
 * never throws.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  lensStateFromResult,
  type LensLoadState,
} from '../state/worldState.ts';
import type { ProjectionResult } from '../types/media.ts';

type Action<T> =
  | { type: 'start' }
  | { type: 'result'; state: LensLoadState<T> };

export interface UseLensProjectionResult<T> {
  state: LensLoadState<T>;
  reload: () => void;
}

export function useLensProjection<T>(
  fetcher: (opts: { signal: AbortSignal }) => Promise<ProjectionResult<T>>,
  isEmpty: (data: T) => boolean,
  deps: readonly unknown[] = [],
): UseLensProjectionResult<T> {
  const initial: LensLoadState<T> = { status: 'idle', data: null, loadedAt: null, errorKind: null };

  const [state, dispatch] = useReducer((s: LensLoadState<T>, action: Action<T>): LensLoadState<T> => {
    switch (action.type) {
      case 'start':
        return { ...s, status: s.data ? 'revalidating' : 'loading', errorKind: null };
      case 'result':
        return action.state;
      default:
        return s;
    }
  }, initial);

  const abortRef = useRef<AbortController | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: 'start' });
    void fetcherRef.current({ signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      dispatch({ type: 'result', state: lensStateFromResult(result, isEmptyRef.current, Date.now()) });
    });
  }, []);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  return { state, reload: load };
}
