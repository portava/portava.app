/**
 * Bottom-inset module — unified end-of-scroll clearance for every finite
 * scroll surface in the app.
 *
 * The floating tab pill renders ONLY inside the tabs layout and never overlays
 * pushed stack routes, so bottom clearance is tiered:
 *
 *  ── Tier 1 · Tab surfaces (pill floats over content) ──────────────────────
 *     const bottomInset = useBottomInset();
 *     <FlatList contentContainerStyle={{ paddingBottom: bottomInset }} ... />
 *     // or place <NavBarFiller /> (from useNavBarCollapse) as the last child.
 *     Value: NAV_BAR_FILLER_HEIGHT (96 = 64 pill + 12 offset + 20 clearance)
 *            + insets.bottom.
 *     For paginated feeds put the spacer AFTER the loading footer so the last
 *     loaded item stays clear of the pill while the spinner shows.
 *
 *  ── Tier 2 · Stack screens with their own sticky bottom bar ───────────────
 *     const { inset: barInset, onBarLayout } = useStickyBarInset();
 *     <ScrollView contentContainerStyle={{ paddingBottom: barInset }} ... />
 *     <View style={styles.stickyBar} onLayout={onBarLayout}>…</View>
 *     Value: measured bar height (which already includes its own safe-area
 *            padding) + BOTTOM_BREATHING_ROOM. Until first layout, a sensible
 *            fallback (fallbackBarHeight + insets.bottom) is used.
 *
 *  ── Tier 3 · Plain stack screens, forms, and modal/bottom sheets ──────────
 *     const plainInset = usePlainBottomInset();
 *     <ScrollView contentContainerStyle={{ paddingBottom: plainInset }} ... />
 *     Value: insets.bottom + BOTTOM_BREATHING_ROOM — a modest, deliberate
 *            buffer; no oversized void where nothing floats.
 *
 *  ── Keyboard compatibility ─────────────────────────────────────────────────
 *     KeyboardAvoidingView adds its own padding while the keyboard is open,
 *     so large static insets can stack into a dead gap above the keyboard.
 *     Consumers that show a keyboard can suppress the inset while it is open:
 *
 *     const keyboardVisible = useKeyboardVisible();
 *     const inset = useBottomInset();
 *     paddingBottom: keyboardVisible ? space.md : inset
 *
 * On desktop (sidebar layout) insets.bottom is typically 0 and the pill is
 * hidden, so all returned values remain safe to use.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Keyboard, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { NAV_BAR_FILLER_HEIGHT } from './useNavBarCollapse.ts';
import {
  LAYOVER_PILL_BOTTOM_OFFSET,
  LAYOVER_PILL_HEIGHT,
} from '../components/layover/layoverPillGeometry.ts';
import { getActiveLayoverSession } from '../services/layover.ts';

/** Breathing room above the layover pill top edge (pt). */
const LAYOVER_PILL_TOP_GAP = 16;

/** Breathing room added below the last content item on non-pill surfaces. */
export const BOTTOM_BREATHING_ROOM = 24;

/**
 * Tier 1 — full floating-pill clearance for tab-layout surfaces.
 * (96 px pill clearance + safe-area inset.)
 */
export function useBottomInset(): number {
  const insets = useSafeAreaInsets();
  return NAV_BAR_FILLER_HEIGHT + insets.bottom;
}

/**
 * Tier 1 — layover-aware variant of useBottomInset.
 *
 * When a layover session is active the persistent pill floats above the tab
 * bar, so the feed needs additional clearance to keep the last item fully
 * visible:
 *
 *   active   → insets.bottom + LAYOVER_PILL_BOTTOM_OFFSET
 *                             + LAYOVER_PILL_HEIGHT + LAYOVER_PILL_TOP_GAP
 *            = insets.bottom + 74 + 44 + 16 = insets.bottom + 134
 *
 *   inactive → NAV_BAR_FILLER_HEIGHT + insets.bottom  (same as useBottomInset)
 *            = insets.bottom + 96
 *
 * The layover state is refreshed via useFocusEffect so it tracks the user
 * starting / finishing a layover session while the Pulse tab is in use.
 *
 * Use this instead of useBottomInset() on any screen that renders
 * <ActiveLayoverPill />.
 */
export function useLayoverAwareBottomInset(): number {
  const insets = useSafeAreaInsets();
  const [layoverActive, setLayoverActive] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      getActiveLayoverSession()
        .then((res) => { if (alive) setLayoverActive(!!res?.session); })
        .catch(() => { if (alive) setLayoverActive(false); });
      return () => { alive = false; };
    }, []),
  );

  if (layoverActive) {
    return insets.bottom + LAYOVER_PILL_BOTTOM_OFFSET + LAYOVER_PILL_HEIGHT + LAYOVER_PILL_TOP_GAP;
  }
  return NAV_BAR_FILLER_HEIGHT + insets.bottom;
}

/**
 * Tier 3 — modest buffer for bar-less stack screens, forms, and sheets.
 * (safe-area inset + BOTTOM_BREATHING_ROOM.)
 */
export function usePlainBottomInset(): number {
  const insets = useSafeAreaInsets();
  return insets.bottom + BOTTOM_BREATHING_ROOM;
}

/**
 * Tier 3 spacer twin of usePlainBottomInset — drop-in last child for scroll
 * containers on bar-less stack screens and sheets (the modest-buffer sibling
 * of NavBarFiller, which is reserved for tab surfaces under the pill).
 */
export function PlainBottomFiller() {
  const inset = usePlainBottomInset();
  return React.createElement(View, { style: { height: inset } });
}

export interface StickyBarInset {
  /** paddingBottom for the scroll container behind the bar. */
  inset: number;
  /** Attach to the sticky bar's outer <View onLayout={…}> to measure it. */
  onBarLayout: (e: LayoutChangeEvent) => void;
}

/**
 * Tier 2 — clearance matched to a screen's own fixed bottom bar.
 *
 * Measures the bar via onLayout so the scroll clearance always equals the
 * actual bar height (including the safe-area padding the bar applies to
 * itself) plus breathing room. Before the first layout event a fallback of
 * `fallbackBarHeight + insets.bottom` is used so content is never covered
 * on first paint.
 */
export function useStickyBarInset(fallbackBarHeight = 76): StickyBarInset {
  const insets = useSafeAreaInsets();
  const [barHeight, setBarHeight] = useState<number | null>(null);

  const onBarLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setBarHeight((prev) => (prev === h ? prev : h));
  }, []);

  const inset =
    (barHeight ?? fallbackBarHeight + insets.bottom) + BOTTOM_BREATHING_ROOM;
  return { inset, onBarLayout };
}

/**
 * True while the software keyboard is open. Use to suppress a static bottom
 * inset so it never stacks with KeyboardAvoidingView padding.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => setVisible(true));
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);
  return visible;
}
