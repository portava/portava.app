/**
 * useCollapsingHeader — animated styles for the "large title → compact bar"
 * collapsing header pattern on primary tab screens.
 *
 * Both styles are driven by the shared `navBarProgress` value that every tab
 * already wires its scroll handler to via `useNavBarScrollHandler()`, so no
 * additional scroll plumbing is needed per screen.
 *
 * largeHeaderStyle  — fades + slides the large AppHeader out on down-scroll.
 * compactBarStyle   — fades the compact sticky bar in once the large header
 *                     has scrolled off screen.
 * compactBarInteractive — boolean state: true when the compact bar is fully
 *                     visible. Use this for `pointerEvents` so the hidden bar
 *                     never intercepts touches meant for the scroll content.
 *
 * Reduced-motion: when `useReducedMotion()` returns true the transition is
 * instant (no cross-fade) — the bar snaps between states at the 50 % mark.
 */
import { useState } from 'react';
import {
  useAnimatedStyle,
  useAnimatedReaction,
  interpolate,
  runOnJS,
  useReducedMotion as _useReducedMotion,
} from 'react-native-reanimated';

// Reanimated's jest mock omits useReducedMotion ("ADD ME IF NEEDED" comment in
// mock.ts). Create a stable module-level fallback so the hook never crashes in
// test environments, without violating the Rules of Hooks (the fallback is
// evaluated once at module load, not conditionally per render).
const safeUseReducedMotion: () => boolean =
  (typeof _useReducedMotion === 'function'
    ? _useReducedMotion
    : () => false) as () => boolean;
import { navBarProgress } from './useNavBarCollapse.ts';

// Null-safe alias: test environments mock useNavBarCollapse without
// navBarProgress (it was added later as a module-level SharedValue), leaving
// it undefined. The plain-object fallback keeps worklets from crashing while
// still giving correct behaviour in the real Reanimated runtime.
const _progress: { value: number } =
  (navBarProgress as { value: number } | undefined) ?? { value: 0 };

export function useCollapsingHeader() {
  const reducedMotion = safeUseReducedMotion();

  // ── Large header — fades out as progress → 1 ─────────────────────────────
  const largeHeaderStyle = useAnimatedStyle(() => {
    const p = _progress.value;
    if (reducedMotion) {
      return { opacity: p < 0.5 ? 1 : 0 };
    }
    return {
      opacity: interpolate(p, [0, 0.55], [1, 0], 'clamp'),
      transform: [
        { translateY: interpolate(p, [0, 1], [0, -6], 'clamp') },
      ],
    };
  });

  // ── Compact bar — fades in as progress → 1 ───────────────────────────────
  const compactBarStyle = useAnimatedStyle(() => {
    const p = _progress.value;
    if (reducedMotion) {
      return { opacity: p >= 0.5 ? 1 : 0 };
    }
    return {
      opacity: interpolate(p, [0.45, 1], [0, 1], 'clamp'),
    };
  });

  // ── pointerEvents bridge — JS state synced from Reanimated ───────────────
  // Switches at the 50 % mark so the compact bar only intercepts touches when
  // it is meaningfully visible, leaving the scroll-content AppHeader
  // interactive when the large header is shown.
  const [compactBarInteractive, setCompactBarInteractive] = useState(false);

  useAnimatedReaction(
    () => _progress.value > 0.5,
    (isCollapsed, wasCollapsed) => {
      if (isCollapsed !== wasCollapsed) {
        runOnJS(setCompactBarInteractive)(isCollapsed);
      }
    },
  );

  return { largeHeaderStyle, compactBarStyle, compactBarInteractive };
}
