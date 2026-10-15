/**
 * useLensProjection — generic loader for a lens projection (spec §42/§43).
 *
 * A small stale-while-revalidate loader used by the wired lens screens
 * (Places / Experiences / People / My World). Given a fetcher that returns a
 * ProjectionResult and an emptiness predicate, it exposes a LensLoadState the
 * screen renders through LensStateView. Cancels in flight on unmount/reload and
 * never throws.
 *
 * Degrade behavior (§33/§39):
 *   • a 404 / empty result becomes a clean empty state, never an error/throw;
 *   • SWR — a FAILED refresh over previously-good data keeps showing that stale
 *     data (status returns to 'ready', the error kind is recorded) rather than
 *     blanking the screen. A cold failure (no prior good data) surfaces 'error'.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  lensStateWithSwr,
  type LensLoadState,
} from '../state/worldState.ts';
import type { ProjectionResult } from '../types/media.ts';

type Action<T> = { scope: readonly unknown[] } & (
  | { type: 'start' }
  | { type: 'result'; result: ProjectionResult<T>; isEmpty: (data: T) => boolean; at: number }
);

interface ScopedLensState<T> {
  scope: readonly unknown[];
  state: LensLoadState<T>;
}

function sameScope(current: readonly unknown[], next: readonly unknown[]): boolean {
  return current.length === next.length && current.every((value, index) => Object.is(value, next[index]));
}

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

  const [scopedState, dispatch] = useReducer((current: ScopedLensState<T>, action: Action<T>): ScopedLensState<T> => {
    const previous = sameScope(current.scope, action.scope) ? current.state : initial;
    switch (action.type) {
      case 'start':
        return { scope: action.scope, state: { ...previous, status: previous.data ? 'revalidating' : 'loading', errorKind: null } };
      case 'result':
        return { scope: action.scope, state: lensStateWithSwr(previous, action.result, action.isEmpty, action.at) };
      default:
        return current;
    }
  }, { scope: deps, state: initial });

  const abortRef = useRef<AbortController | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;
  const scopeRef = useRef(deps);
  scopeRef.current = deps;

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const scope = scopeRef.current;
    const isEmpty = isEmptyRef.current;
    dispatch({ type: 'start', scope });
    void fetcherRef.current({ signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      // SWR: fold the result into the state that was on screen when we started,
      // so a failed refresh keeps the last good data (§39).
      dispatch({
        type: 'result',
        scope,
        result,
        isEmpty,
        at: Date.now(),
      });
    });
  }, []);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  return { state: sameScope(scopedState.scope, deps) ? scopedState.state : initial, reload: load };
}
