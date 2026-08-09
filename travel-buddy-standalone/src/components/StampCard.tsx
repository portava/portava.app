/**
 * StampCard — medium stamp badge for stamp grids and strips.
 * Size range: 64–120px. SVG frame + icon + label text.
 * Shimmer animation for epic/legendary stamps (respects reduced-motion).
 * Locked → grayscale + lock icon overlay.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Animated, AccessibilityInfo } from 'react-native';
import {
  MapPin, Users, Gem, ShieldCheck, Crown, Ticket, Lock, Sparkles,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import type { PassportStamp } from '../types/models.ts';
import { resolveArtwork } from '../lib/stampArtworkResolver.ts';
import { STAMP_RARITY_COLORS } from '../types/stampArtwork.ts';
import { StampSvgFrame } from './StampSvgFrame.tsx';
import { dot } from '../theme/tokens.ts';

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const ICON_MAP: Record<string, IconCmp> = {
  MapPin, Users, Gem, ShieldCheck, Crown, Ticket, Sparkles,
};

function resolveIcon(key: string): IconCmp {
  return ICON_MAP[key] ?? MapPin;
}

interface StampCardProps {
  stamp: PassportStamp;
  /** Width = height of the stamp square. Default 88. */
  size?: number;
  /** Optional tilt in degrees. */
  rotate?: number;
  onPress?: () => void;
}

export function StampCard({ stamp, size = 88, rotate = 0, onPress }: StampCardProps) {
  const art = resolveArtwork(stamp);
  const Icon = resolveIcon(art.iconKey);
  const iconSize = Math.round(size * 0.26);
  const labelSize = Math.round(size * 0.12);
  const captionSize = Math.round(size * 0.095);

  // Reduced-motion gate — respects system accessibility setting
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  // Shimmer sweep animation for epic/legendary (skipped when reduceMotion is on)
  const shimmerAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!art.hasShimmer || reduceMotion) return;
    const loop = Animated.loop(
      Animated.timing(shimmerAnim, {
        toValue: 1,
        duration: 1800,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [art.hasShimmer, shimmerAnim, reduceMotion]);

  const shimmerTranslate = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-size, size * 2],
  });

  const rarityColor = STAMP_RARITY_COLORS[art.rarity];

  const inner = (
    <View
      style={[
        styles.wrap,
        { width: size, height: size, transform: [{ rotate: `${rotate}deg` }] },
      ]}
      accessible
      accessibilityLabel={art.accessibilityLabel}
      accessibilityRole="image"
    >
      {/* SVG frame (background + border) */}
      <StampSvgFrame
        size={size}
        shape={art.shape}
        borderStyle={art.borderStyle}
        borderWeight={art.borderWeight}
        accent={art.accent}
        background={art.background}
        pattern={art.pattern}
        locked={art.locked}
      />

      {/* Content stack */}
      <View style={styles.content} pointerEvents="none">
        <View style={{ opacity: art.locked ? 0.5 : 1 }}>
          <Icon size={iconSize} color={art.accent} strokeWidth={2.2} />
        </View>
        <Text
          style={[styles.label, { color: art.accent, fontSize: labelSize }]}
          numberOfLines={1}
        >
          {stamp.label}
        </Text>
        {art.captionText ? (
          <Text
            style={[styles.caption, { color: art.accent, fontSize: captionSize }]}
            numberOfLines={1}
          >
            {art.captionText}
          </Text>
        ) : null}
      </View>

      {/* Shimmer sweep */}
      {art.hasShimmer && (
        <Animated.View
          style={[
            styles.shimmer,
            { transform: [{ translateX: shimmerTranslate }] },
          ]}
          pointerEvents="none"
        />
      )}

      {/* Lock overlay */}
      {art.locked && (
        <View style={styles.lockOverlay} pointerEvents="none">
          <Lock size={iconSize * 0.9} color="#9CA3AF" strokeWidth={1.8} />
        </View>
      )}

      {/* Rarity pip */}
      <View style={[styles.rarityPip, { backgroundColor: rarityColor }]} />
    </View>
  );

  return onPress ? (
    <Pressable onPress={onPress} hitSlop={4}>
      {inner}
    </Pressable>
  ) : inner;
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  content: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 6,
  },
  label: {
    fontFamily: 'Courier',
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 0.8,
  },
  caption: {
    fontFamily: 'Courier',
    textAlign: 'center',
    letterSpacing: 0.5,
    opacity: 0.8,
  },
  shimmer: {
    ...StyleSheet.absoluteFillObject,
    width: 60,
    backgroundColor: 'rgba(255,255,255,0.22)',
    transform: [{ skewX: '-20deg' }],
  },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rarityPip: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: dot.s5, height: dot.s5,
    borderRadius: dot.s5 / 2,
    opacity: 0.7,
  },
});
