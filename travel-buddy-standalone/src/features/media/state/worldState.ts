/**
 * features/media — World/NOW load state machine (spec §4.1/§39).
 *
 * A pure reducer describing how the NOW dashboard moves between loading, ready,
 * empty, and error — and how it stale-while-revalidates. Kept framework-free so
 * the exact degrade behaviour (endpoint 404 / empty → clean empty state, NEVER
 * throw) is unit-testable without a renderer.
 *
 * No react-native imports — safe for node:test.
 */
import type {
  MediaWorldProjection,
  MediaLens,
  PresentationMode,
} from '../types/mediaContext.ts';
import type { ProjectionErrorKind, ProjectionResult } from '../types/media.ts';

export type LoadStatus = 'idle' | 'loading' | 'revalidating' | 'ready' | 'empty' | 'error';

export interface WorldViewState {
  status: LoadStatus;
  /** Last successfully-loaded projection, retained across revalidation (SWR). */
  data: MediaWorldProjection | null;
  /** Epoch ms the retained data was loaded, for SWR staleness checks. */
  loadedAt: number | null;
  errorKind: ProjectionErrorKind | null;
}

export const INITIAL_WORLD_STATE: WorldViewState = {
  status: 'idle',
  data: null,
  loadedAt: null,
  errorKind: null,
};

export type WorldAction =
  | { type: 'load_start' }
  | { type: 'load_result'; result: ProjectionResult<MediaWorldProjection>; at: number };

/**
 * True when a world projection carries nothing worth rendering as a dashboard —
 * no city visual state, no "for you now", no "changing now". Such a payload is
 * treated as an EMPTY state (clean empty UI), not an error and not a throw.
 * This is the core of graceful degradation while the backend projection PR is
 * still landing.
 */
export function isWorldProjectionEmpty(p: MediaWorldProjection | null | undefined): boolean {
  if (!p) return true;
  const zones = p.cityVisualState?.length ?? 0;
  const forYou = p.forYouNow?.length ?? 0;
  const changing = p.changingNow?.length ?? 0;
  return zones === 0 && forYou === 0 && changing === 0;
}

export function worldReducer(state: WorldViewState, action: WorldAction): WorldViewState {
  switch (action.type) {
    case 'load_start': {
      // A refresh over existing data revalidates (keep showing stale data);
      // a cold load shows the loading skeleton.
      return {
        ...state,
        status: state.data && !isWorldProjectionEmpty(state.data) ? 'revalidating' : 'loading',
        errorKind: null,
      };
    }
    case 'load_result': {
      const { result, at } = action;
      if (result.ok) {
        if (isWorldProjectionEmpty(result.data)) {
          // Successful fetch but nothing to show → clean empty state.
          return { status: 'empty', data: result.data, loadedAt: at, errorKind: null };
        }
        return { status: 'ready', data: result.data, loadedAt: at, errorKind: null };
      }
      // Failure: if we still have good stale data, keep showing it (SWR) rather
      // than blanking the screen; otherwise surface the error state.
      if (state.data && !isWorldProjectionEmpty(state.data)) {
        return { ...state, status: 'ready', errorKind: result.errorKind };
      }
      return { status: 'error', data: null, loadedAt: null, errorKind: result.errorKind };
    }
    default:
      return state;
  }
}

/**
 * SWR staleness check: should we kick a background revalidation?
 * `ttlMs` defaults to 90s — the NOW dashboard is time-sensitive but must not
 * hammer the endpoint. Returns false when there is no prior load.
 */
export function shouldRevalidate(
  loadedAt: number | null,
  now: number,
  ttlMs = 90_000,
): boolean {
  if (loadedAt == null) return false;
  return now - loadedAt >= ttlMs;
}

// ── Per-lens generic load state (used by scaffolded lens screens) ─────────────

export interface LensLoadState<T> {
  status: LoadStatus;
  data: T | null;
  loadedAt: number | null;
  errorKind: ProjectionErrorKind | null;
}

export function lensStateFromResult<T>(
  result: ProjectionResult<T>,
  isEmpty: (data: T) => boolean,
  at: number,
): LensLoadState<T> {
  if (result.ok) {
    return {
      status: isEmpty(result.data) ? 'empty' : 'ready',
      data: result.data,
      loadedAt: at,
      errorKind: null,
    };
  }
  return { status: 'error', data: null, loadedAt: null, errorKind: result.errorKind };
}

/**
 * Stale-while-revalidate variant (§39): fold a fresh result into the previous
 * lens state. A FAILED refresh over previously-good (non-empty) data keeps that
 * data on screen (status → 'ready', error kind recorded) instead of blanking it;
 * a cold failure (no prior good data) surfaces the error state. Success and
 * empty are classified exactly as `lensStateFromResult`.
 */
export function lensStateWithSwr<T>(
  prev: LensLoadState<T>,
  result: ProjectionResult<T>,
  isEmpty: (data: T) => boolean,
  at: number,
): LensLoadState<T> {
  const hadGoodData = prev.data != null && !isEmpty(prev.data);
  if (!result.ok && hadGoodData) {
    return { status: 'ready', data: prev.data, loadedAt: prev.loadedAt, errorKind: result.errorKind };
  }
  return lensStateFromResult(result, isEmpty, at);
}

/** A lens is described by its active mode too, so the shell can persist it. */
export interface LensScreenKey {
  lens: MediaLens;
  mode: PresentationMode;
}
