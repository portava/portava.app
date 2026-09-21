/**
 * MessageEntrance — subtle spring/fade entrance for newly arrived chat messages.
 *
 * Only messages that arrive *after* the screen mounts animate in. Initial
 * load, pagination backfill (older messages), and FlatList virtualization
 * remounts render statically, so there are no layout jumps or replayed
 * animations while scrolling.
 *
 * The animation only touches opacity + translateY (transform), never layout,
 * so scrollToEnd and rapid message arrival stay glitch-free.
 *
 * TELEGRAPH §11.3 — "Provide reduced-motion behavior for media, GIFs and
 * animations." The `animate` gate above is a PAGINATION rule (do not replay
 * entrances for backfilled history); it says nothing about accessibility, and
 * until this change nothing in the Telegraph tree consulted the OS setting at
 * all. `useReducedMotionSetting` — already in the tree, already the Wall's
 * mechanism for the same requirement — is now consulted here, and a viewer who
 * has asked for reduced motion gets the static View on every message.
 */
import React, { useRef, useCallback } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { useReducedMotionSetting } from '../features/wall/hooks/useReducedMotionSetting.ts';

/** Short, snappy spring: slight rise + fade, ~250ms perceived. */
const ENTERING = FadeInUp.springify().damping(18).stiffness(240).mass(0.7);

/**
 * Gate that decides, per message, whether it should play the entrance
 * animation. A message animates only the first time it is rendered AND
 * only if it was created after the screen mounted (small clock-skew grace).
 */
export function useMessageEntranceGate() {
  const mountTimeRef = useRef(Date.now());
  const seenIdsRef = useRef<Set<string>>(new Set());

  return useCallback((id: string, createdAt: string): boolean => {
    if (seenIdsRef.current.has(id)) return false;
    seenIdsRef.current.add(id);
    // Older messages (initial load / pagination) never animate.
    const ts = new Date(createdAt).getTime();
    return Number.isFinite(ts) && ts >= mountTimeRef.current - 2000;
  }, []);
}

export function MessageEntrance({
  animate,
  style,
  children,
}: {
  animate: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotionSetting();
  if (!animate || reduceMotion) {
    return <View style={style}>{children}</View>;
  }
  return (
    <Animated.View style={style} entering={ENTERING}>
      {children}
    </Animated.View>
  );
}
