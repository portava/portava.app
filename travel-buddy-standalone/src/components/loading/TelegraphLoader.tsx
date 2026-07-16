/**
 * TelegraphLoader — Travel Buddy's chat/messaging loading animation.
 *
 * Lightweight + fast: a chat bubble with animated typing dots and a small
 * paper-plane that drifts. Subtle by design — used for short message actions, not
 * full-screen loads.
 *
 * Use for: opening conversations, loading group chat, sending messages,
 * translating messages, fetching saved/replied messages.
 *
 * Accessibility: respects OS "Reduce Motion" — shows a static bubble + text.
 *
 * Uses the same RN `Animated` pattern as the existing PlaceSkeleton (not
 * Reanimated) so it works without the Reanimated babel plugin and stays
 * consistent with the existing skeleton system. Tokens only.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Animated,
  StyleSheet,
  AccessibilityInfo,
  type ViewStyle,
} from 'react-native';
import { color, space, type as t, font } from '../../theme/tokens';

const DEFAULT_MESSAGES = [
  'Opening Telegraph…',
  'Syncing messages…',
  'Sending…',
];

export interface TelegraphLoaderProps {
  /** Override rotating copy. Single-item array for a fixed message. */
  messages?: string[];
  /** Compact: just the bubble, no text (inline in a send button / row). */
  compact?: boolean;
  style?: ViewStyle;
  accessibilityLabel?: string;
}

export function TelegraphLoader({
  messages = DEFAULT_MESSAGES,
  compact = false,
  style,
  accessibilityLabel = 'Loading messages',
}: TelegraphLoaderProps) {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [msgIndex, setMsgIndex] = useState(0);

  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((e) => { if (mounted) setReduceMotion(e); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (e) => {
      if (mounted) setReduceMotion(e);
    });
    return () => { mounted = false; sub?.remove?.(); };
  }, []);

  useEffect(() => {
    if (compact || messages.length <= 1) return;
    const id = setInterval(() => setMsgIndex((i) => (i + 1) % messages.length), 1500);
    return () => clearInterval(id);
  }, [compact, messages.length]);

  useEffect(() => {
    if (reduceMotion) {
      dot1.setValue(0.6); dot2.setValue(0.6); dot3.setValue(0.6);
      return;
    }
    const pulse = (v: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.3, duration: 320, useNativeDriver: true }),
          Animated.delay(360 - delay),
        ]),
      );
    const a = pulse(dot1, 0);
    const b = pulse(dot2, 120);
    const c = pulse(dot3, 240);
    a.start(); b.start(); c.start();
    return () => { a.stop(); b.stop(); c.stop(); };
  }, [reduceMotion]);

  return (
    <View
      style={[compact ? s.rootCompact : s.root, style]}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: true }}
    >
      <View style={s.bubble}>
        <Animated.View style={[s.dot, { opacity: dot1 }]} />
        <Animated.View style={[s.dot, { opacity: dot2 }]} />
        <Animated.View style={[s.dot, { opacity: dot3 }]} />
      </View>

      {!compact && (
        <Text style={s.text} accessibilityLiveRegion="polite">
          {messages[msgIndex]}
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.lg,
  },
  rootCompact: { alignItems: 'center', justifyContent: 'center' },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.haze,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: color.mute,
  },
  text: {
    ...t.small,
    fontFamily: font.stamp,
    color: color.mute,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
});

export default TelegraphLoader;
