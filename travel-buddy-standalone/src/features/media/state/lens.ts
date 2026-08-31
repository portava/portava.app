/**
 * features/media — lens + presentation-mode logic (spec §3/§5).
 *
 * Pure, framework-free. The 6-lens primary navigation and the supported
 * presentation modes per lens live here so they can be unit-tested without a
 * renderer, and reused by the shell, the tab bar, and the mode bar.
 *
 * No react-native imports — safe for node:test.
 */
import type { MediaLens, PresentationMode } from '../types/mediaContext.ts';

export interface LensDef {
  key: MediaLens;
  /** Display label used in the primary nav (§3). */
  label: string;
  /** Supported presentation modes, in order (§5). */
  modes: PresentationMode[];
}

/**
 * §3 order: NOW · PLACES · EXPERIENCES · HIDDEN GEMS · PEOPLE · MY WORLD.
 * §5 supported modes per lens.
 */
export const LENSES: readonly LensDef[] = [
  { key: 'now', label: 'Now', modes: ['overview', 'map', 'time'] },
  { key: 'places', label: 'Places', modes: ['overview', 'visual', 'map', 'time'] },
  { key: 'experiences', label: 'Experiences', modes: ['overview', 'visual', 'map'] },
  { key: 'gems', label: 'Hidden Gems', modes: ['overview', 'visual', 'map'] },
  { key: 'people', label: 'People', modes: ['visual'] },
  { key: 'my_world', label: 'My World', modes: ['grid', 'timeline', 'map'] },
] as const;

const LENS_BY_KEY: Record<MediaLens, LensDef> = LENSES.reduce(
  (acc, l) => {
    acc[l.key] = l;
    return acc;
  },
  {} as Record<MediaLens, LensDef>,
);

/** Human labels for presentation modes (§5). */
export const MODE_LABELS: Record<PresentationMode, string> = {
  overview: 'Overview',
  visual: 'Visual',
  map: 'Map',
  time: 'Time',
  grid: 'Grid',
  timeline: 'Timeline',
};

export function lensDef(lens: MediaLens): LensDef {
  return LENS_BY_KEY[lens];
}

export function isLens(value: string): value is MediaLens {
  return value in LENS_BY_KEY;
}

/** Modes a lens supports (§5). Never empty for a valid lens. */
export function modesForLens(lens: MediaLens): PresentationMode[] {
  return LENS_BY_KEY[lens]?.modes ?? ['overview'];
}

/** The default (first supported) presentation mode for a lens. */
export function defaultModeForLens(lens: MediaLens): PresentationMode {
  return modesForLens(lens)[0];
}

export function isModeSupported(lens: MediaLens, mode: PresentationMode): boolean {
  return modesForLens(lens).includes(mode);
}

// ── Nav reducer ───────────────────────────────────────────────────────────────

export interface LensNavState {
  lens: MediaLens;
  mode: PresentationMode;
}

export type LensNavAction =
  | { type: 'select_lens'; lens: MediaLens }
  | { type: 'select_mode'; mode: PresentationMode };

export const INITIAL_LENS_NAV: LensNavState = {
  lens: 'now',
  mode: defaultModeForLens('now'),
};

/**
 * Reduce a nav action.
 *
 * Invariants this guarantees:
 *  - selecting a lens always lands on a mode that lens supports (resets to the
 *    lens default when the current mode is not carried over);
 *  - selecting an unsupported mode is a no-op (the bar can only offer supported
 *    modes, but the reducer refuses to enter an invalid state regardless).
 */
export function lensNavReducer(state: LensNavState, action: LensNavAction): LensNavState {
  switch (action.type) {
    case 'select_lens': {
      if (!isLens(action.lens)) return state;
      if (action.lens === state.lens) return state;
      // Carry the current mode over only if the target lens also supports it;
      // otherwise fall back to that lens's default mode.
      const nextMode = isModeSupported(action.lens, state.mode)
        ? state.mode
        : defaultModeForLens(action.lens);
      return { lens: action.lens, mode: nextMode };
    }
    case 'select_mode': {
      if (!isModeSupported(state.lens, action.mode)) return state;
      if (action.mode === state.mode) return state;
      return { ...state, mode: action.mode };
    }
    default:
      return state;
  }
}
