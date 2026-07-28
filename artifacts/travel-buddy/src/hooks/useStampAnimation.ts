/**
 * useStampAnimation — local button-level animation for the stamp interaction.
 *
 * Since Task #3048, the full stamp choreography (traveling seal, shadow, haptic
 * at impact) is handled by StampAnimationContext at the screen level. This hook
 * provides only the complementary LOCAL feedback:
 *
 *   - Button press: scales to ~92% → springs back (tactile feel on press-down)
 *   - Count label: spring-pops on stamp-in, deflates on stamp-out
 *
 * Both are purely visual embellishments — they do not duplicate the haptic or
 * the screen-level ink-stamp travel animation.
 *
 * Kept as a standalone hook so StampButton stays simple and the two concerns
 * (local press bounce vs. screen-level travel) remain independent.
 */
import { useCallback } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  withSequence,
  Easing,
} from 'react-native-reanimated';

export interface StampAnimationControls {
  /** Animated style for the button/icon wrapper — 92% press-scale bounce. */
  buttonStyle: StyleProp<ViewStyle>;
  /** Animated style for the count label — spring pop on stamp, deflate on un-stamp. */
  countStyle: StyleProp<ViewStyle>;
  /** Play the stamp-in local button bounce. No haptic — handled by context. */
  playStamp: () => void;
  /** Play the stamp-out (un-stamp) button bounce. */
  playUnstamp: () => void;
}

export function useStampAnimation(): StampAnimationControls {
  const buttonScale = useSharedValue(1);
  const countScale  = useSharedValue(1);

  const playStamp = useCallback(() => {
    // 92% scale → spring back
    buttonScale.value = withSequence(
      withTiming(0.92, { duration: 70, easing: Easing.out(Easing.quad) }),
      withSpring(1.0, { damping: 12, stiffness: 220 }),
    );

    // Count label pop: spring up → settle
    countScale.value = withSequence(
      withSpring(1.28, { damping: 7,  stiffness: 280 }),
      withSpring(1.0,  { damping: 12, stiffness: 200 }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const playUnstamp = useCallback(() => {
    buttonScale.value = withSequence(
      withTiming(0.92, { duration: 70, easing: Easing.out(Easing.quad) }),
      withSpring(1.0, { damping: 12, stiffness: 220 }),
    );

    countScale.value = withSequence(
      withSpring(0.78, { damping: 10, stiffness: 280 }),
      withSpring(1.0,  { damping: 12, stiffness: 200 }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buttonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const countStyle = useAnimatedStyle(() => ({
    transform: [{ scale: countScale.value }],
  }));

  return { buttonStyle, countStyle, playStamp, playUnstamp };
}
