/**
 * PostCardStampBurst — card-local double-tap stamp burst.
 *
 * Unlike StampAnimationProvider (a screen-level singleton used by StampButton
 * for the button→content "traveling stamp" animation), this burst is
 * rendered and animated entirely INSIDE the post card that triggered it.
 * The parent post card must set `overflow: 'hidden'` so the burst can never
 * paint outside the card's bounds.
 *
 * Usage: mount once inside a card with `position: 'absolute'` covering the
 * card, then call `ref.current?.play()` on double-tap.
 */
import React, { forwardRef, useImperativeHandle } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
  withDelay,
  Easing,
} from 'react-native-reanimated';
import { StampIcon } from './StampIcon.tsx';

export interface PostCardStampBurstHandle {
  /** Plays the centered burst-in/fade-out animation. */
  play: () => void;
}

const BURST_SIZE = 96;

export const PostCardStampBurst = forwardRef<PostCardStampBurstHandle>((_props, ref) => {
  const scale = useSharedValue(0);
  const opacity = useSharedValue(0);

  useImperativeHandle(ref, () => ({
    play: () => {
      scale.value = 0.3;
      opacity.value = 1;
      scale.value = withSequence(
        withTiming(1.15, { duration: 220, easing: Easing.out(Easing.back(1.6)) }),
        withTiming(1, { duration: 120, easing: Easing.out(Easing.quad) }),
      );
      opacity.value = withDelay(450, withTiming(0, { duration: 220 }));
    },
  }), [scale, opacity]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, s.center]}>
      <Animated.View style={[s.burst, style]}>
        <StampIcon size={BURST_SIZE} active color="rgba(255,255,255,0.95)" />
      </Animated.View>
    </Animated.View>
  );
});

PostCardStampBurst.displayName = 'PostCardStampBurst';

const s = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  burst: {
    width: BURST_SIZE,
    height: BURST_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
});
