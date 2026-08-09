/**
 * PulsePinLoader — Travel Buddy's location/GPS loading animation ("Pulse Pin").
 *
 * Smaller, inline-friendly loader. A location pin sits center; soft rings pulse
 * outward like radar; a GPS dot locks on. Text explains the current action.
 *
 * Use for: getting current location, GPS permission check, nearby recommendations,
 * geofence checks, delayed-post location checks, Layover airport lookup, Trip Flow
 * checkpoint detection, map centering.
 *
 * Accessibility: respects OS "Reduce Motion" — renders a static pin + text,
 * no pulsing, per spec §10.
 *
 * Tokens only — no hardcoded brand colors.
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  AccessibilityInfo,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withDelay,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { color, space, type as t, font, dot} from '../../theme/tokens.ts';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const DEFAULT_MESSAGES = [
  'Finding your location…',
  'Checking nearby plans…',
  'Looking around this area…',
];

const RING_MS = 2200;
const CENTER = 40; // svg is 80x80, pin anchored at center-x

export interface PulsePinLoaderProps {
  /** Override rotating copy. Pass a single-item array for a fixed message. */
  messages?: string[];
  /** Compact mode: hide text, just the animated pin (for inline button/card use). */
  compact?: boolean;
  /** Diameter of the pulse graphic in px. Default 80. */
  size?: number;
  style?: ViewStyle;
  accessibilityLabel?: string;
}

export function PulsePinLoader({
  messages = DEFAULT_MESSAGES,
  compact = false,
  size = 80,
  style,
  accessibilityLabel = 'Finding location',
}: PulsePinLoaderProps) {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [msgIndex, setMsgIndex] = useState(0);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => { if (mounted) setReduceMotion(enabled); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => { if (mounted) setReduceMotion(enabled); },
    );
    return () => { mounted = false; sub?.remove?.(); };
  }, []);

  useEffect(() => {
    if (compact || messages.length <= 1) return;
    const id = setInterval(() => {
      setMsgIndex((i) => (i + 1) % messages.length);
    }, 1700);
    return () => clearInterval(id);
  }, [compact, messages.length]);

  // Two staggered radar rings.
  const ring1 = useSharedValue(0);
  const ring2 = useSharedValue(0);
  // Center GPS dot "lock" pulse.
  const lock = useSharedValue(0.6);

  useEffect(() => {
    if (reduceMotion) {
      ring1.value = 0;
      ring2.value = 0;
      lock.value = 1;
      return;
    }
    ring1.value = withRepeat(
      withTiming(1, { duration: RING_MS, easing: Easing.out(Easing.quad) }),
      -1,
      false,
    );
    ring2.value = withDelay(
      RING_MS / 2,
      withRepeat(
        withTiming(1, { duration: RING_MS, easing: Easing.out(Easing.quad) }),
        -1,
        false,
      ),
    );
    lock.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(ring1);
      cancelAnimation(ring2);
      cancelAnimation(lock);
    };
  }, [reduceMotion]);

  // Ring expands from r=6 to r=34 and fades out as it grows.
  const ring1Props = useAnimatedProps(() => ({
    r: 6 + ring1.value * 28,
    opacity: 0.5 * (1 - ring1.value),
  }));
  const ring2Props = useAnimatedProps(() => ({
    r: 6 + ring2.value * 28,
    opacity: 0.5 * (1 - ring2.value),
  }));
  const lockStyle = useAnimatedStyle(() => ({ opacity: lock.value }));

  return (
    <View
      style={[compact ? styles.rootCompact : styles.root, style]}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: true }}
    >
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <Svg viewBox="0 0 80 80" width={size} height={size}>
          {/* Radar rings */}
          <AnimatedCircle cx={CENTER} cy={CENTER} fill="none" stroke={color.signal} strokeWidth={1.5} animatedProps={ring1Props} />
          <AnimatedCircle cx={CENTER} cy={CENTER} fill="none" stroke={color.signal} strokeWidth={1.5} animatedProps={ring2Props} />

          {/* Pin sitting at center */}
          <Path
            d="M40 26 C 33 26 28 31 28 38 C 28 47 40 56 40 56 C 40 56 52 47 52 38 C 52 31 47 26 40 26 Z"
            fill={color.signal}
          />
          <Circle cx={40} cy={38} r={4.5} fill={color.paper} />
        </Svg>

        {/* GPS lock dot, overlaid, gently pulsing */}
        <Animated.View style={[styles.lockDot, lockStyle]} />
      </View>

      {!compact && (
        <Text style={styles.loadingText} accessibilityLiveRegion="polite">
          {messages[msgIndex]}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingVertical: space.xl,
  },
  rootCompact: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockDot: {
    position: 'absolute',
    bottom: 12,
    width: dot.s5,
    height: dot.s5,
    borderRadius: dot.s5 / 2,
    backgroundColor: color.deep,
  },
  loadingText: {
    ...t.small,
    fontFamily: font.stamp,
    color: color.mute,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
});

export default PulsePinLoader;
