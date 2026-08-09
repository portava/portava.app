/**
 * PassportStampLoader — Portava's primary full-screen loading animation
 * ("Passport Stamp Journey").
 *
 * Motion sequence (looping):
 *   1. A dotted teal travel route draws left-to-right across a passport page.
 *   2. A vermilion location pin drops onto the route's endpoint with a bounce.
 *   3. A circular stamp lands with a soft overshoot.
 *   4. Loading text rotates underneath.
 *
 * Use for: app startup, large screen loads, first-time Discovery load,
 * Trips load, Passport/Profile load, heavy Compass operations.
 *
 * Accessibility: respects the OS "Reduce Motion" setting. When enabled, renders
 * a static passport + stamp with the loading text (no motion), per spec §10.
 *
 * Tokens only — no hardcoded brand colors. Pulls from src/theme/tokens.
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  AccessibilityInfo,
  type ViewStyle,
} from 'react-native';
import Svg, { Rect, Path, Circle, G, Line, Text as SvgText } from 'react-native-svg';
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
import { color, space, type as t, font, dot } from '../../theme/tokens.ts';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedG = Animated.createAnimatedComponent(G);

const DEFAULT_MESSAGES = [
  'Finding your next adventure…',
  'Checking the local vibe…',
  'Mapping your trip flow…',
  'Loading nearby plans…',
  'Syncing your Passport…',
  'Getting your crew ready…',
];

// Route arc drawn across the passport page. Length measured for dash math.
const ROUTE_D = 'M50 118 Q 96 60 150 96 T 196 78';
const ROUTE_LEN = 260;

// Full loop duration (ms). Each phase is a fraction of this.
const LOOP_MS = 3400;

export interface PassportStampLoaderProps {
  /** Stamp label, e.g. a destination ("CEBU '26"). Defaults to a compass mark. */
  stampLabel?: string;
  /** Override the rotating loading messages. */
  messages?: string[];
  /** Container style override. */
  style?: ViewStyle;
  /** Accessibility label for the whole loader. */
  accessibilityLabel?: string;
}

export function PassportStampLoader({
  stampLabel,
  messages = DEFAULT_MESSAGES,
  style,
  accessibilityLabel = 'Loading',
}: PassportStampLoaderProps) {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [msgIndex, setMsgIndex] = useState(0);

  // ── Reduced-motion detection ──────────────────────────────────────────────
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

  // ── Rotating loading text (runs in both motion + reduced-motion modes) ─────
  useEffect(() => {
    if (messages.length <= 1) return;
    const id = setInterval(() => {
      setMsgIndex((i) => (i + 1) % messages.length);
    }, 1700);
    return () => clearInterval(id);
  }, [messages.length]);

  // ── Shared animation values ───────────────────────────────────────────────
  const routeProgress = useSharedValue(ROUTE_LEN); // dashoffset: LEN→0 draws it
  const pinProgress = useSharedValue(0);           // 0 hidden → 1 landed
  const stampProgress = useSharedValue(0);         // 0 hidden → 1 landed

  useEffect(() => {
    if (reduceMotion) {
      // Park everything in its final, settled state. No looping.
      routeProgress.value = 0;
      pinProgress.value = 1;
      stampProgress.value = 1;
      return;
    }

    // Route draws over the first ~45% of the loop, then resets.
    routeProgress.value = withRepeat(
      withSequence(
        withTiming(0, { duration: LOOP_MS * 0.45, easing: Easing.inOut(Easing.cubic) }),
        withDelay(LOOP_MS * 0.45, withTiming(ROUTE_LEN, { duration: 0 })),
      ),
      -1,
      false,
    );

    // Pin drops at ~40% in.
    pinProgress.value = withRepeat(
      withSequence(
        withDelay(LOOP_MS * 0.4, withTiming(1, { duration: LOOP_MS * 0.18, easing: Easing.out(Easing.back(2)) })),
        withDelay(LOOP_MS * 0.42, withTiming(0, { duration: 0 })),
      ),
      -1,
      false,
    );

    // Stamp lands at ~62% in.
    stampProgress.value = withRepeat(
      withSequence(
        withDelay(LOOP_MS * 0.62, withTiming(1, { duration: LOOP_MS * 0.16, easing: Easing.out(Easing.back(1.6)) })),
        withDelay(LOOP_MS * 0.22, withTiming(0, { duration: 0 })),
      ),
      -1,
      false,
    );

    return () => {
      cancelAnimation(routeProgress);
      cancelAnimation(pinProgress);
      cancelAnimation(stampProgress);
    };
  }, [reduceMotion]);

  // ── Animated props ────────────────────────────────────────────────────────
  const routeAnimatedProps = useAnimatedProps(() => ({
    strokeDashoffset: routeProgress.value,
  }));

  const pinAnimatedProps = useAnimatedProps(() => {
    const p = pinProgress.value;
    const ty = (1 - p) * -18;            // drop in from above
    const s = 0.6 + p * 0.4;             // scale up to 1
    return {
      opacity: p,
      transform: [{ translateY: ty }, { scale: s }],
    };
  });

  const stampAnimatedProps = useAnimatedProps(() => {
    const p = stampProgress.value;
    // overshoot: big → settle. scale eases from 2.2 down to 1.
    const s = 2.2 - p * 1.2;
    return {
      opacity: p,
      transform: [{ scale: s }],
    };
  });

  const label = stampLabel ?? 'VISITED';
  const subLabel = stampLabel ? '' : 'PORTAVA';

  return (
    <View
      style={[styles.root, style]}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: true }}
    >
      <View style={styles.page}>
        <Svg viewBox="0 0 240 168" width={240} height={168}>
          {/* Passport page */}
          <Rect x={14} y={14} width={212} height={140} rx={9} fill={color.paperRaised} stroke={color.haze} strokeWidth={1} />
          <Line x1={14} y1={46} x2={226} y2={46} stroke={color.haze} strokeWidth={1} strokeDasharray="3 4" />
          <SvgText x={26} y={35} fontFamily={font.stamp} fontSize={9} letterSpacing={1.5} fill={color.faint}>
            PORTAVA · PASSPORT
          </SvgText>

          {/* Route glow underlay */}
          <Path d={ROUTE_D} fill="none" stroke={color.deep} strokeWidth={7} strokeLinecap="round" opacity={0.1} />

          {/* Animated dotted route */}
          <AnimatedPath
            d={ROUTE_D}
            fill="none"
            stroke={color.deep}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={ROUTE_LEN}
            animatedProps={routeAnimatedProps}
          />
          {/* Origin dot */}
          <Circle cx={50} cy={118} r={4} fill={color.deep} />

          {/* Pin (drops onto route endpoint 196,78) */}
          <AnimatedG originX={196} originY={78} animatedProps={pinAnimatedProps}>
            <Path
              d="M196 64 C 188 64 182 70 182 78 C 182 88 196 98 196 98 C 196 98 210 88 210 78 C 210 70 204 64 196 64 Z"
              fill={color.signal}
            />
            <Circle cx={196} cy={78} r={5} fill={color.paper} />
          </AnimatedG>

          {/* Stamp (lands center) */}
          <AnimatedG originX={150} originY={122} animatedProps={stampAnimatedProps}>
            <G rotation={-14} origin="150, 122">
              <Circle cx={150} cy={122} r={26} fill="none" stroke={color.signal} strokeWidth={2.5} opacity={0.85} />
              <Circle cx={150} cy={122} r={21} fill="none" stroke={color.signal} strokeWidth={1} strokeDasharray="2 3" opacity={0.7} />
              <SvgText x={150} y={subLabel ? 119 : 126} textAnchor="middle" fontFamily={font.stamp} fontSize={8} fontWeight="700" letterSpacing={1} fill={color.signalDim}>
                {label}
              </SvgText>
              {subLabel ? (
                <SvgText x={150} y={130} textAnchor="middle" fontFamily={font.stamp} fontSize={7} letterSpacing={1} fill={color.signalDim}>
                  {subLabel}
                </SvgText>
              ) : null}
            </G>
          </AnimatedG>
        </Svg>
      </View>

      {/* Loading text */}
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
    </View>
  );
}

// ── Bouncing dot ─────────────────────────────────────────────────────────────
function Dot({ delay, reduceMotion }: { delay: number; reduceMotion: boolean }) {
  const opacity = useSharedValue(0.3);
  useEffect(() => {
    if (reduceMotion) { opacity.value = 0.6; return; }
    opacity.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 480, easing: Easing.inOut(Easing.quad) }),
          withTiming(0.3, { duration: 480, easing: Easing.inOut(Easing.quad) }),
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
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xl,
    backgroundColor: color.paper,
  },
  page: {
    width: 240,
    height: 168,
    borderRadius: 14,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
    // shadow.card equivalent
    shadowColor: color.ink,
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  textRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 22,
  },
  dots: { flexDirection: 'row', gap: 4 },
  dot: {
    width: dot.s6, height: dot.s6,
    borderRadius: dot.s6 / 2,
    backgroundColor: color.signal,
  },
  loadingText: {
    ...t.small,
    fontFamily: font.stamp,
    color: color.mute,
    letterSpacing: 0.3,
  },
});

export default PassportStampLoader;
