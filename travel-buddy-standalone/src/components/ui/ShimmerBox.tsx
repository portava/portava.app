/**
 * ShimmerBox — animated skeleton placeholder primitive used by all skeleton
 * components. Respects the system reduce-motion preference: when enabled, the
 * shimmer is replaced with a static muted background.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet, AccessibilityInfo, type ViewStyle } from 'react-native';
import { color } from '../../theme/tokens.ts';

interface ShimmerBoxProps {
  width?: number | `${number}%`;
  height: number;
  borderRadius?: number;
  style?: ViewStyle;
}

export function ShimmerBox({ width, height, borderRadius = 4, style }: ShimmerBoxProps) {
  const opacity = useRef(new Animated.Value(1)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) return;
      animRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.45, duration: 800, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1,    duration: 800, useNativeDriver: true }),
        ]),
      );
      animRef.current.start();
    });

    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (reduced) => {
      if (reduced) {
        animRef.current?.stop();
        opacity.setValue(1);
      } else {
        animRef.current = Animated.loop(
          Animated.sequence([
            Animated.timing(opacity, { toValue: 0.45, duration: 800, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 1,    duration: 800, useNativeDriver: true }),
          ]),
        );
        animRef.current.start();
      }
    });

    return () => {
      cancelled = true;
      animRef.current?.stop();
      sub.remove();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Animated.View
      style={[
        styles.box,
        { width: width ?? '100%', height, borderRadius, opacity },
        style,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: color.haze,
  },
});
