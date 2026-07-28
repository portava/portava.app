/**
 * useStampAnimation — Reanimated animation hook for the stamp interaction.
 *
 * Animation sequence (stamp):
 *   1. Button scales to ~92% over 70ms (press feel)
 *   2. Springs back to 1.0
 *   3. Haptic fires at the scale bottom (caller injects via `onHaptic`)
 *   4. Ink-stamp overlay fades in (0 → 1) + scales (0.4 → 1.0) with random
 *      rotation (±4°) and offset (±4px); fades out after ~600ms
 *   5. Count label pops with a spring
 *
 * Un-stamp sequence:
 *   Button bounces, overlay fades instantly, count deflates.
 */
import { useCallback } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  withSequence,
  withDelay,
  Easing,
} from 'react-native-reanimated';

export interface StampAnimationControls {
  /** Animated style for the button/icon wrapper — applies the press scale. */
  buttonStyle: StyleProp<ViewStyle>;
  /** Animated style for the PortavaInkStamp overlay. */
  overlayStyle: StyleProp<ViewStyle>;
  /** Animated style for the count label (spring pop). */
  countStyle: StyleProp<ViewStyle>;
  /**
   * Trigger the stamp-in animation.
   * @param onHaptic called at the moment the scale hits the bottom (~70ms in);
   *   use this to fire expo-haptics so the feedback feels physically correct.
   */
  playStamp: (onHaptic?: () => void) => void;
  /** Trigger the stamp-out (un-stamp) animation. */
  playUnstamp: () => void;
}

export function useStampAnimation(): StampAnimationControls {
  // --- button press ---
  const buttonScale = useSharedValue(1);

  // --- overlay ---
  const overlayOpacity = useSharedValue(0);
  const overlayScale = useSharedValue(0.4);
  const overlayRotation = useSharedValue(0); // degrees
  const overlayOffsetX = useSharedValue(0);  // px
  const overlayOffsetY = useSharedValue(0);  // px

  // --- count label ---
  const countScale = useSharedValue(1);

  // -------------------------------------------------------------------------
  const playStamp = useCallback(
    (onHaptic?: () => void) => {
      // Compute random values on the JS thread before entering worklet land.
      const rot = Math.random() * 8 - 4;   // ±4°
      const ox  = Math.random() * 8 - 4;   // ±4 px
      const oy  = Math.random() * 8 - 4;   // ±4 px

      overlayRotation.value = rot;
      overlayOffsetX.value  = ox;
      overlayOffsetY.value  = oy;

      // Reset overlay so re-stamps always restart cleanly.
      overlayOpacity.value = 0;
      overlayScale.value   = 0.4;

      // 1 + 2: button press bounce
      buttonScale.value = withSequence(
        withTiming(0.92, { duration: 70, easing: Easing.out(Easing.quad) }),
        withSpring(1.0, { damping: 12, stiffness: 220 }),
      );

      // 3: haptic at scale nadir (~70ms)
      if (onHaptic) {
        setTimeout(onHaptic, 70);
      }

      // 4: overlay — fade in, hold, fade out
      overlayOpacity.value = withSequence(
        withTiming(1, { duration: 160, easing: Easing.out(Easing.quad) }),
        withDelay(520, withTiming(0, { duration: 260, easing: Easing.in(Easing.quad) })),
      );
      overlayScale.value = withSpring(1.0, { damping: 14, stiffness: 180 });

      // 5: count pop
      countScale.value = withSequence(
        withSpring(1.28, { damping: 7, stiffness: 280 }),
        withSpring(1.0,  { damping: 12, stiffness: 200 }),
      );
    },
    // shared values are stable refs — no deps needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // -------------------------------------------------------------------------
  const playUnstamp = useCallback(() => {
    buttonScale.value = withSequence(
      withTiming(0.92, { duration: 70, easing: Easing.out(Easing.quad) }),
      withSpring(1.0, { damping: 12, stiffness: 220 }),
    );

    overlayOpacity.value = withTiming(0, { duration: 180 });

    countScale.value = withSequence(
      withSpring(0.78, { damping: 10, stiffness: 280 }),
      withSpring(1.0,  { damping: 12, stiffness: 200 }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  const buttonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
    transform: [
      { scale: overlayScale.value },
      { rotate: `${overlayRotation.value}deg` },
      { translateX: overlayOffsetX.value },
      { translateY: overlayOffsetY.value },
    ],
  }));

  const countStyle = useAnimatedStyle(() => ({
    transform: [{ scale: countScale.value }],
  }));

  return { buttonStyle, overlayStyle, countStyle, playStamp, playUnstamp };
}
