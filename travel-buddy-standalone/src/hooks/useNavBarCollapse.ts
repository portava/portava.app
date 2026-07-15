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

// ── Spring config: fast snap, no bounce ────────────────────────────────────

const SPRING_CONFIG = { damping: 25, stiffness: 350 };

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
 */
export function useNavBarScrollHandler() {
  const lastY = useRef(0);

  return useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y;
    const delta = y - lastY.current;
    lastY.current = y;

    // Ignore tiny jitter; collapse on down-scroll, restore on up-scroll
    if (delta > 4) {
      navBarProgress.value = withSpring(1, SPRING_CONFIG);
    } else if (delta < -4) {
      navBarProgress.value = withSpring(0, SPRING_CONFIG);
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
