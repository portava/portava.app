/**
 * RoutePathLoader — Travel Buddy's route-planning / Trip Flow loading animation
 * ("Route Path"), itinerary-card style.
 *
 * A vertical itinerary builds itself: numbered stops appear in sequence, each
 * with a name + time, connectors drawing between them. Reads like a real trip
 * plan rather than a generic map spinner.
 *
 * Use for: creating a walking path, optimizing activity order, rerouting after a
 * skipped stop, loading directions, calculating checkpoint progress, Trip Flow.
 *
 * Accessibility: respects OS "Reduce Motion" — renders the full itinerary
 * statically with no staggered reveal, per spec §10.
 *
 * Tokens only — no hardcoded brand colors. Stops are configurable via props so
 * callers can show real itinerary data; defaults are illustrative.
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  AccessibilityInfo,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withRepeat,
  withSequence,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { color, space, radius, type as t, font, shadow } from '../../theme/tokens';

export interface RouteStop {
  label: string;
  detail?: string;
}

const DEFAULT_STOPS: RouteStop[] = [
  { label: 'Sunset Café', detail: '6:30 PM · coffee' },
  { label: 'Mactan Beach', detail: '7:45 PM · walk' },
  { label: 'Rooftop Bar', detail: '9:00 PM · drinks' },
];

const DEFAULT_MESSAGES = [
  'Finding the best walking path…',
  'Optimizing your night flow…',
  'Ordering your stops…',
  'Checking route safety…',
  'Building your checkpoint map…',
];

// Per-stop reveal stagger and the full loop length.
const STOP_STAGGER_MS = 420;
const HOLD_MS = 1100;

export interface RoutePathLoaderProps {
  /** Itinerary stops to show. Defaults to an illustrative 3-stop night out. */
  stops?: RouteStop[];
  /** Header eyebrow text. */
  title?: string;
  /** Override rotating copy. */
  messages?: string[];
  style?: ViewStyle;
  accessibilityLabel?: string;
}

export function RoutePathLoader({
  stops = DEFAULT_STOPS,
  title = 'Day 1 · Tonight',
  messages = DEFAULT_MESSAGES,
  style,
  accessibilityLabel = 'Building your route',
}: RoutePathLoaderProps) {
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
    if (messages.length <= 1) return;
    const id = setInterval(() => {
      setMsgIndex((i) => (i + 1) % messages.length);
    }, 1700);
    return () => clearInterval(id);
  }, [messages.length]);

  return (
    <View
      style={[styles.root, style]}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: true }}
    >
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.eyebrow}>{title.toUpperCase()}</Text>
          <Text style={styles.stopCount}>{stops.length} stops</Text>
        </View>

        <View>
          {stops.map((stop, i) => (
            <Stop
              key={`${stop.label}-${i}`}
              stop={stop}
              index={i}
              isLast={i === stops.length - 1}
              reduceMotion={reduceMotion}
            />
          ))}
        </View>
      </View>

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

// ── One itinerary stop: number badge + connector + name/detail ───────────────
function Stop({
  stop,
  index,
  isLast,
  reduceMotion,
}: {
  stop: RouteStop;
  index: number;
  isLast: boolean;
  reduceMotion: boolean;
}) {
  const progress = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) { progress.value = 1; return; }
    progress.value = withRepeat(
      withSequence(
        withDelay(index * STOP_STAGGER_MS, withTiming(1, { duration: 360, easing: Easing.out(Easing.back(1.5)) })),
        withDelay(HOLD_MS + (2 - index) * STOP_STAGGER_MS, withTiming(0, { duration: 0 })),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [reduceMotion, index]);

  const badgeStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.4 + progress.value * 0.6 }],
  }));
  const bodyStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateX: (1 - progress.value) * -6 }],
  }));
  const connectorStyle = useAnimatedStyle(() => ({
    opacity: progress.value * 0.6,
    transform: [{ scaleY: progress.value }],
  }));

  // First stop badge is vermilion (origin), the rest teal.
  const badgeColor = index === 0 ? color.signal : color.deep;

  return (
    <View style={styles.stopRow}>
      <View style={styles.stopRail}>
        <Animated.View style={[styles.badge, { backgroundColor: badgeColor }, badgeStyle]}>
          <Text style={styles.badgeText}>{index + 1}</Text>
        </Animated.View>
        {!isLast && (
          <Animated.View style={[styles.connector, connectorStyle]} />
        )}
      </View>

      <Animated.View style={[styles.stopBody, bodyStyle]}>
        <Text style={styles.stopLabel}>{stop.label}</Text>
        {stop.detail ? <Text style={styles.stopDetail}>{stop.detail}</Text> : null}
      </Animated.View>
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
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    paddingVertical: space.xl,
  },
  card: {
    width: 280,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    ...shadow.card,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  eyebrow: {
    fontFamily: font.stamp,
    fontSize: 11,
    letterSpacing: 1.5,
    color: color.faint,
  },
  stopCount: {
    fontFamily: font.stamp,
    fontSize: 11,
    color: color.signal,
  },
  stopRow: {
    flexDirection: 'row',
    gap: space.md,
  },
  stopRail: {
    alignItems: 'center',
    width: 24,
  },
  badge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontFamily: font.stamp,
    fontSize: 11,
    fontWeight: '700',
    color: color.onInk,
  },
  connector: {
    width: 2,
    height: 22,
    backgroundColor: color.haze,
    marginVertical: 1,
  },
  stopBody: {
    flex: 1,
    paddingBottom: space.md,
  },
  stopLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: color.ink,
  },
  stopDetail: {
    fontFamily: font.stamp,
    fontSize: 10,
    color: color.faint,
    marginTop: 1,
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
    backgroundColor: color.signal,
  },
  loadingText: {
    ...t.small,
    fontFamily: font.stamp,
    color: color.mute,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
});

export default RoutePathLoader;
