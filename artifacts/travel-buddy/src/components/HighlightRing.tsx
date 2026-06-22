/**
 * HighlightRing — wraps any avatar/child with an animated gradient ring.
 *
 * Ring states:
 *   hasActive=true, allViewed=false → bright gradient ring (unviewed)
 *   hasActive=true, allViewed=true  → muted grey ring (all viewed)
 *   hasActive=false                 → no ring, transparent pass-through
 *
 * Props:
 *   hasActive   — the user has active (unexpired) highlights
 *   allViewed   — the viewer has seen all of them
 *   isOwner     — this is the viewer's own avatar (tap opens composer)
 *   size        — avatar diameter (ring is drawn outside it)
 *   onPress     — tap handler (viewer opens HighlightViewer; owner opens composer)
 *   ringWidth   — stroke width of the ring (default 2.5)
 *   gap         — gap between avatar and ring (default 2)
 */
import React, { useEffect, useRef } from 'react';
import { View, Animated, Pressable, StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Circle } from 'react-native-svg';

const GRADIENT_COLORS = ['#F5A623', '#E91E8C', '#9C27B0'] as const;
const GRADIENT_VIEWED = ['#C0C0C0', '#A0A0A0'] as const;

interface Props {
  hasActive: boolean;
  allViewed: boolean;
  isOwner?: boolean;
  size: number;
  onPress?: () => void;
  ringWidth?: number;
  gap?: number;
  children: React.ReactNode;
}

export function HighlightRing({
  hasActive,
  allViewed,
  size,
  onPress,
  ringWidth = 2.5,
  gap = 2,
  children,
}: Props) {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!hasActive || allViewed) {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.06, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [hasActive, allViewed, pulseAnim]);

  if (!hasActive) {
    if (!onPress) return <>{children}</>;
    return (
      <Pressable onPress={onPress} style={{ width: size, height: size }}>
        {children}
      </Pressable>
    );
  }

  const totalSize = size + (ringWidth + gap) * 2;
  const r = totalSize / 2 - ringWidth / 2;
  const cx = totalSize / 2;
  const cy = totalSize / 2;
  const colors = allViewed ? GRADIENT_VIEWED : GRADIENT_COLORS;

  const gradId = `hlRingGrad_${size}_${allViewed ? 'v' : 'u'}`;

  return (
    <Pressable onPress={onPress} hitSlop={4}>
      <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
        <View style={{ width: totalSize, height: totalSize, alignItems: 'center', justifyContent: 'center' }}>
          <Svg
            width={totalSize}
            height={totalSize}
            style={StyleSheet.absoluteFill}
          >
            <Defs>
              <LinearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
                {colors.map((c, i) => (
                  <Stop
                    key={i}
                    offset={`${(i / (colors.length - 1)) * 100}%`}
                    stopColor={c}
                    stopOpacity="1"
                  />
                ))}
              </LinearGradient>
            </Defs>
            <Circle
              cx={cx}
              cy={cy}
              r={r}
              stroke={`url(#${gradId})`}
              strokeWidth={ringWidth}
              fill="none"
            />
          </Svg>
          <View
            style={{
              width: size + gap * 2,
              height: size + gap * 2,
              borderRadius: (size + gap * 2) / 2,
              overflow: 'hidden',
              backgroundColor: 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {children}
          </View>
        </View>
      </Animated.View>
    </Pressable>
  );
}
