/**
 * StampItBurst — passport-stamp overlay animation triggered on long-press like.
 *
 * Usage:
 *   const ref = useRef<StampItBurstHandle>(null);
 *   ref.current?.trigger();
 *   <StampItBurst ref={ref} />
 */
import React, {
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from 'react';
import { View, Text, Animated, StyleSheet, Dimensions } from 'react-native';
import { color } from '../../theme/tokens.ts';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export interface StampItBurstHandle {
  trigger: () => void;
}

export const StampItBurst = forwardRef<StampItBurstHandle, object>(
  function StampItBurst(_props, ref) {
    const scaleAnim  = useRef(new Animated.Value(0)).current;
    const opacityAnim = useRef(new Animated.Value(1)).current;
    const rotateAnim  = useRef(new Animated.Value(-12)).current;
    const isAnimating = useRef(false);

    const trigger = useCallback(() => {
      if (isAnimating.current) return;
      isAnimating.current = true;

      // Reset values
      scaleAnim.setValue(0);
      opacityAnim.setValue(1);
      rotateAnim.setValue(-12);

      Animated.sequence([
        // Phase 1: slam in with slight overshoot
        Animated.parallel([
          Animated.spring(scaleAnim, {
            toValue: 1.12,
            friction: 4,
            tension: 180,
            useNativeDriver: true,
          }),
          Animated.timing(rotateAnim, {
            toValue: 0,
            duration: 220,
            useNativeDriver: true,
          }),
        ]),
        // Phase 2: settle to 1.0
        Animated.spring(scaleAnim, {
          toValue: 1.0,
          friction: 6,
          tension: 200,
          useNativeDriver: true,
        }),
        // Phase 3: hold briefly
        Animated.delay(300),
        // Phase 4: fade out
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start(() => {
        isAnimating.current = false;
        scaleAnim.setValue(0);
        opacityAnim.setValue(1);
      });
    }, [scaleAnim, opacityAnim, rotateAnim]);

    useImperativeHandle(ref, () => ({ trigger }), [trigger]);

    const rotate = rotateAnim.interpolate({
      inputRange: [-12, 0],
      outputRange: ['-12deg', '0deg'],
    });

    return (
      <Animated.View
        style={[
          s.container,
          {
            opacity: opacityAnim,
            transform: [{ scale: scaleAnim }, { rotate }],
          },
        ]}
        pointerEvents="none"
      >
        {/* Stamp border ring */}
        <View style={s.stampOuter}>
          <View style={s.stampInner}>
            {/* Passport icon */}
            <Text style={s.stampEmoji}>🛂</Text>
            <Text style={s.stampLabel}>STAMPED</Text>
            <Text style={s.stampSub}>PORTAVA</Text>
          </View>
          {/* Dashed ring */}
          <View style={s.ring} />
        </View>
        {/* Ink splatter dots */}
        {INK_DOTS.map((dot, i) => (
          <View key={i} style={[s.inkDot, dot]} />
        ))}
      </Animated.View>
    );
  },
);

// Pre-computed ink splatter positions (relative to center)
const INK_DOTS = [
  { top: SCREEN_H / 2 - 80, left: SCREEN_W / 2 - 80, width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,70,70,0.55)', position: 'absolute' as const },
  { top: SCREEN_H / 2 - 70, left: SCREEN_W / 2 + 72, width: 4, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,70,70,0.45)', position: 'absolute' as const },
  { top: SCREEN_H / 2 + 74, left: SCREEN_W / 2 - 68, width: 5, height: 5, borderRadius: 2.5, backgroundColor: 'rgba(255,70,70,0.4)', position: 'absolute' as const },
  { top: SCREEN_H / 2 + 60, left: SCREEN_W / 2 + 80, width: 4, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,70,70,0.5)', position: 'absolute' as const },
  { top: SCREEN_H / 2 - 90, left: SCREEN_W / 2 - 10, width: 3, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,70,70,0.35)', position: 'absolute' as const },
];

const STAMP_SIZE = 160;

const s = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  stampOuter: {
    width: STAMP_SIZE,
    height: STAMP_SIZE,
    borderRadius: STAMP_SIZE / 2,
    borderWidth: 5,
    borderColor: color.signal,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,60,60,0.12)',
  },
  stampInner: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  ring: {
    position: 'absolute',
    width: STAMP_SIZE - 14,
    height: STAMP_SIZE - 14,
    borderRadius: (STAMP_SIZE - 14) / 2,
    borderWidth: 2,
    borderColor: color.signal,
    borderStyle: 'solid',
    opacity: 0.4,
  },
  stampEmoji: {
    fontSize: 36,
  },
  stampLabel: {
    fontSize: 13,
    fontWeight: '900',
    color: color.signal,
    letterSpacing: 3,
  },
  stampSub: {
    fontSize: 9,
    fontWeight: '700',
    color: color.signal,
    letterSpacing: 2,
    opacity: 0.7,
  },
  inkDot: {
    position: 'absolute',
  },
});
