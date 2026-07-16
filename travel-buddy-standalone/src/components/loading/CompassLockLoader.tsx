/**
 * CompassLockLoader — Travel Buddy's AI / recommendation "thinking" animation
 * ("Compass Lock").
 *
 * The compass needle spins fast, overshoots, and settles locking onto a
 * direction; a sparkle pops to signal a result was found. Text explains that
 * Compass is planning or ranking options.
 *
 * Use for: Compass AI recommendations, Discovery ranking, Trip Flow optimization,
 * Layover recommendations, Hidden Gems suggestions, personalized feed refresh.
 *
 * Accessibility: respects OS "Reduce Motion" — renders a static locked needle +
 * sparkle, no spin, per spec §10.
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
import Svg, { Circle, Path, Line, G, Text as SvgText } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  withDelay,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { color, space, type as t, font } from '../../theme/tokens.ts';

const AnimatedG = Animated.createAnimatedComponent(G);

const DEFAULT_MESSAGES = [
  'Compass is finding the best fit…',
  'Ranking nearby options…',
  'Building your route…',
  'Checking your travel vibe…',
  'Finding the best flow…',
];

// One full loop: spin → lock → sparkle → hold → reset.
const LOOP_MS = 3000;
// Final resting angle of the needle (degrees). 650 = ~290° after ~1.8 turns.
const LOCK_ANGLE = 650;

export interface CompassLockLoaderProps {
  /** Override rotating copy. Single-item array for a fixed message. */
  messages?: string[];
  /** Compact mode: hide text, just the spinning compass (inline use). */
  compact?: boolean;
  /** Diameter of the compass graphic in px. Default 120. */
  size?: number;
  style?: ViewStyle;
  accessibilityLabel?: string;
}

export function CompassLockLoader({
  messages = DEFAULT_MESSAGES,
  compact = false,
  size = 120,
  style,
  accessibilityLabel = 'Finding recommendations',
}: CompassLockLoaderProps) {
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

  const angle = useSharedValue(0);   // needle rotation, degrees
  const sparkle = useSharedValue(0); // 0 hidden → 1 popped

  useEffect(() => {
    if (reduceMotion) {
      angle.value = LOCK_ANGLE;
      sparkle.value = 1;
      return;
    }

    // Spin to overshoot, settle back to LOCK_ANGLE, hold, snap reset.
    angle.value = withRepeat(
      withSequence(
        withTiming(LOCK_ANGLE + 30, { duration: LOOP_MS * 0.55, easing: Easing.out(Easing.cubic) }),
        withTiming(LOCK_ANGLE - 10, { duration: LOOP_MS * 0.12, easing: Easing.inOut(Easing.quad) }),
        withTiming(LOCK_ANGLE, { duration: LOOP_MS * 0.1, easing: Easing.out(Easing.quad) }),
        withDelay(LOOP_MS * 0.23, withTiming(0, { duration: 0 })),
      ),
      -1,
      false,
    );

    // Sparkle pops once the needle has locked (~78% in).
    sparkle.value = withRepeat(
      withSequence(
        withDelay(LOOP_MS * 0.78, withTiming(1, { duration: LOOP_MS * 0.12, easing: Easing.out(Easing.back(2)) })),
        withDelay(LOOP_MS * 0.1, withTiming(0, { duration: 0 })),
      ),
      -1,
      false,
    );

    return () => {
      cancelAnimation(angle);
      cancelAnimation(sparkle);
    };
  }, [reduceMotion]);

  const needleProps = useAnimatedProps(() => ({
    transform: [{ rotate: `${angle.value}deg` }],
  }));

  const sparkleStyle = useAnimatedStyle(() => ({
    opacity: sparkle.value,
    transform: [{ scale: 0.4 + sparkle.value * 0.6 }],
  }));

  return (
    <View
      style={[compact ? styles.rootCompact : styles.root, style]}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: true }}
    >
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <Svg viewBox="0 0 100 100" width={size} height={size}>
          {/* Glow + face */}
          <Circle cx={50} cy={50} r={46} fill={color.deep} opacity={0.12} />
          <Circle cx={50} cy={50} r={38} fill={color.paperRaised} stroke={color.haze} strokeWidth={1} />
          <Circle cx={50} cy={50} r={38} fill="none" stroke={color.deep} strokeWidth={1} opacity={0.25} />

          {/* Cardinal letters */}
          <G fill={color.faint} fontFamily={font.stamp} fontSize={7} fontWeight="700" textAnchor="middle">
            <SvgText x={50} y={20}>N</SvgText>
            <SvgText x={50} y={86}>S</SvgText>
            <SvgText x={16} y={53}>W</SvgText>
            <SvgText x={84} y={53}>E</SvgText>
          </G>

          {/* Cardinal ticks */}
          <Line x1={50} y1={14} x2={50} y2={20} stroke={color.deep} strokeWidth={1} opacity={0.4} />
          <Line x1={50} y1={80} x2={50} y2={86} stroke={color.deep} strokeWidth={1} opacity={0.4} />
          <Line x1={14} y1={50} x2={20} y2={50} stroke={color.deep} strokeWidth={1} opacity={0.4} />
          <Line x1={80} y1={50} x2={86} y2={50} stroke={color.deep} strokeWidth={1} opacity={0.4} />

          {/* Needle (rotates) */}
          <AnimatedG originX={50} originY={50} animatedProps={needleProps}>
            <Path d="M50 22 L 56 50 L 50 46 L 44 50 Z" fill={color.signal} />
            <Path d="M50 78 L 44 50 L 50 54 L 56 50 Z" fill={color.faint} />
          </AnimatedG>

          {/* Hub */}
          <Circle cx={50} cy={50} r={4} fill={color.ink} />
          <Circle cx={50} cy={50} r={1.6} fill={color.paper} />
        </Svg>

        {/* Sparkle — pops on lock */}
        <Animated.View style={[styles.sparkle, { left: size * 0.62, top: size * 0.18 }, sparkleStyle]}>
          <Svg viewBox="0 0 16 16" width={size * 0.16} height={size * 0.16}>
            <Path d="M8 0 L 9.5 6.5 L 16 8 L 9.5 9.5 L 8 16 L 6.5 9.5 L 0 8 L 6.5 6.5 Z" fill={color.signal} />
          </Svg>
        </Animated.View>
      </View>

      {!compact && (
        <View style={styles.textRow}>
          <View style={styles.dots}>
            <Dot delay={0} reduceMotion={reduceMotion} />
            <Dot delay={150} reduceMotion={reduceMotion} />
            <Dot delay={300} reduceMotion={reduceMotion} />
          </View>
          <Text style={styles.loadingText} accessibilityLiveRegion="polite">
            {messages[msgIndex]}
          </Text>
        </View>
      )}
    </View>
  );
}

function Dot({ delay, reduceMotion }: { delay: number; reduceMotion: boolean }) {
  const opacity = useSharedValue(0.3);
  useEffect(() => {
    if (reduceMotion) { opacity.value = 0.6; return; }
    opacity.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(0.5, { duration: 600, easing: Easing.inOut(Easing.quad) }),
          withTiming(0.3, { duration: 600, easing: Easing.inOut(Easing.quad) }),
        ),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(opacity);
  }, [reduceMotion]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.dot, dotStyle]} />;
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    paddingVertical: space.xl,
  },
  rootCompact: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  sparkle: {
    position: 'absolute',
  },
  textRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 22,
  },
  dots: { flexDirection: 'row', gap: 4 },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
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

export default CompassLockLoader;
