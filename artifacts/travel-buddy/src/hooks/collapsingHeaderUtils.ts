/**
 * collapsingHeaderUtils.ts
 *
 * Pure interpolation helpers for the collapsing header pattern.
 * No React Native or Reanimated imports — safe to load in any environment
 * including node:test without a native transform pipeline.
 *
 * Consumed by:
 *   useCollapsingHeader.ts  — worklets read LARGE_FADE_END / COMPACT_FADE_START
 *   useCollapsingHeader.test.ts — verifies the no-overlap invariant
 */

// ── Interpolation thresholds ────────────────────────────────────────────────
//
// The large header fades out over [0, LARGE_FADE_END].
// The compact bar starts fading in only from COMPACT_FADE_START onward so both
// are never simultaneously visible — preventing the double-title flicker on
// slow devices where navBarProgress can snap to 1 before the first animation
// frame completes.
export const LARGE_FADE_END     = 0.55; // large header reaches opacity 0
export const COMPACT_FADE_START = 0.55; // compact bar begins from here → 1

// ── Pure opacity helper ─────────────────────────────────────────────────────
/**
 * Returns the large-header and compact-bar opacity values for a given
 * `progress` (0 = large header fully visible, 1 = compact bar fully visible).
 *
 * This is the same arithmetic used inside the Reanimated worklets so tests can
 * verify the no-overlap invariant without a Reanimated runtime.
 */
export function _computeCollapsingOpacities(progress: number): {
  largeHeaderOpacity: number;
  compactBarOpacity: number;
} {
  const p = Math.max(0, Math.min(1, progress)); // clamp to [0, 1]

  const largeHeaderOpacity =
    p <= 0
      ? 1
      : p >= LARGE_FADE_END
        ? 0
        : 1 - p / LARGE_FADE_END;

  const compactBarOpacity =
    p <= COMPACT_FADE_START
      ? 0
      : p >= 1
        ? 1
        : (p - COMPACT_FADE_START) / (1 - COMPACT_FADE_START);

  return { largeHeaderOpacity, compactBarOpacity };
}
