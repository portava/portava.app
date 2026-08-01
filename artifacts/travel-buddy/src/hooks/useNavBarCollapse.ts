/**
 * useNavBarCollapse — floating nav bar collapse shared state and scroll handler.
 *
 * A single module-level SharedValue drives the pill animation across all screens
 * without requiring a Context provider.
 *
 *   navBarProgress: 0 = full size, 1 = collapsed (shrunk)
 *
 * Usage:
 *   const scrollHandler = useNavBarScrollHandler();
 *   <FlatList onScroll={scrollHandler} scrollEventThrottle={16} ... />
 *
 * Add <NavBarFiller /> as the last element in every scrollable container so
 * content can always scroll fully above the floating pill.
 */
import { useRef, useCallback } from 'react';
import type { NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { View } from 'react-native';
import { makeMutable, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React from 'react';

// ── Spring configs ──────────────────────────────────────────────────────────

/**
 * Collapse spring: moderately stiff so the bar animates in smoothly even on
 * fast flings (stiffness 200 ≈ 250 ms settle vs 350 ≈ 150 ms which felt like
 * an instant pop at high velocity).
 */
const COLLAPSE_SPRING = { damping: 28, stiffness: 200 };

/**
 * Restore spring: slightly softer so the large header fades back in gently
 * when the user scrolls back up.
 */
const RESTORE_SPRING = { damping: 30, stiffness: 180 };

/**
 * Scroll distance (px) over which the header fully collapses when the user
 * scrolls down slowly.  On fast flings `contentOffset.y` jumps past this in a
 * single frame, so the proportional target jumps directly to 1 — but the
 * spring still animates smoothly from whatever value it was at, preventing the
 * "instant pop" at the very start of a fling.
 */
export const NAV_BAR_COLLAPSE_THRESHOLD = 80;

// ── Module-level shared value (singleton — same instance across all screens) ─
// makeMutable creates a Reanimated SharedValue outside of React component scope.

export const navBarProgress = makeMutable(0);

// ── Constants ───────────────────────────────────────────────────────────────

/** Height of the filler without the safe-area inset (each consumer adds insets.bottom). */
export const NAV_BAR_FILLER_HEIGHT = 96; // 64 pill + 12 offset + 20 clearance

// ── Scroll handler factory ──────────────────────────────────────────────────

/**
 * Returns a regular JS onScroll handler that drives navBarProgress via
 * withSpring (which schedules animation on the UI thread).
 * Attach to FlatList / ScrollView with scrollEventThrottle={16}.
 *
 * The target for the collapse direction is derived proportionally from
 * `contentOffset.y` relative to `NAV_BAR_COLLAPSE_THRESHOLD` so that:
 *  - Slow deliberate scrolls animate the bar in gradually (progress 0 → 1
 *    tracks the finger rather than snapping immediately).
 *  - Fast flings jump the target to 1, but the spring still animates from the
 *    current progress value, eliminating the "pop in from nothing" feel.
 *
 * Restore (up-scroll) always targets 0 so the large header snaps back cleanly.
 */
export function useNavBarScrollHandler() {
  const lastY = useRef(0);

  return useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y;
    const delta = y - lastY.current;
    lastY.current = y;

    // Ignore tiny jitter; collapse on down-scroll, restore on up-scroll
    if (delta > 4) {
      // Proportional target: reaches 1 at NAV_BAR_COLLAPSE_THRESHOLD px down.
      // Clamped so it never exceeds 1 even if y >> threshold.
      const target = Math.min(y / NAV_BAR_COLLAPSE_THRESHOLD, 1);
      navBarProgress.value = withSpring(target, COLLAPSE_SPRING);
    } else if (delta < -4) {
      navBarProgress.value = withSpring(0, RESTORE_SPRING);
    }
  }, []);
}

// ── NavBarFiller component ──────────────────────────────────────────────────

/**
 * Transparent spacer whose height equals the full floating bar clearance
 * (NAV_BAR_FILLER_HEIGHT + insets.bottom).
 *
 * Place this as the last element in every scrollable container so content
 * can always scroll fully above the floating pill.
 */
export function NavBarFiller() {
  const insets = useSafeAreaInsets();
  return React.createElement(View, {
    style: { height: NAV_BAR_FILLER_HEIGHT + insets.bottom },
  });
}
