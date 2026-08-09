/**
 * StampDetailArtwork — full-size artwork for the stamp detail modal.
 * Size: 120–200px. Shows icon, primary label, caption, sublabel, rarity badge.
 * Animated shimmer for epic/legendary. Outer glow ring for legendary.
 * Locked stamps show grayscale + "Keep traveling to unlock" message.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, AccessibilityInfo } from 'react-native';
import {
  MapPin, Users, Gem, ShieldCheck, Crown, Ticket, Lock, Sparkles, Star,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import type { PassportStamp } from '../types/models.ts';
import { resolveArtwork } from '../lib/stampArtworkResolver.ts';
import { STAMP_RARITY_LABELS, STAMP_RARITY_COLORS } from '../types/stampArtwork.ts';
import { StampSvgFrame } from './StampSvgFrame.tsx';
import { color, space, type as t, dot } from '../theme/tokens.ts';

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const ICON_MAP: Record<string, IconCmp> = {
  MapPin, Users, Gem, ShieldCheck, Crown, Ticket, Sparkles, Star,
};

function resolveIcon(key: string): IconCmp {
  return ICON_MAP[key] ?? MapPin;
}

interface StampDetailArtworkProps {
  stamp: PassportStamp;
  size?: number;
}

export function StampDetailArtwork({ stamp, size = 148 }: StampDetailArtworkProps) {
  const art = resolveArtwork(stamp);
  const Icon = resolveIcon(art.iconKey);
  const iconSize = Math.round(size * 0.28);
  const labelSize = Math.round(size * 0.13);
  const captionSize = Math.round(size * 0.10);
  const sublabelSize = Math.round(size * 0.09);
  const rarityColor = STAMP_RARITY_COLORS[art.rarity];
  const rarityLabel = STAMP_RARITY_LABELS[art.rarity];

  // Reduced-motion gate — respects system accessibility setting
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  // Shimmer animation (skipped when reduceMotion is on)
  const shimmerAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!art.hasShimmer || reduceMotion) return;
    const loop = Animated.loop(
      Animated.timing(shimmerAnim, {
        toValue: 1,
        duration: 2000,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [art.hasShimmer, shimmerAnim, reduceMotion]);

  const shimmerTranslate = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-size * 0.8, size * 2],
  });

  // Glow pulse animation for legendary (skipped when reduceMotion is on)
  const glowAnim = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    if (!art.hasGlow || reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0.4, duration: 1000, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [art.hasGlow, glowAnim, reduceMotion]);

  return (
    <View style={styles.container} accessible accessibilityLabel={art.accessibilityLabel} accessibilityRole="image">
      {/* Outer glow ring for legendary */}
      {art.hasGlow && (
        <Animated.View
          style={[
            styles.glowRing,
            {
              width: size + 24,
              height: size + 24,
              borderRadius: size / 2 + 12,
              borderColor: rarityColor,
              opacity: glowAnim,
            },
          ]}
          pointerEvents="none"
        />
      )}

      {/* Stamp frame */}
      <View style={{ width: size, height: size, overflow: 'hidden' }}>
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

        {/* Content */}
        <View style={styles.content} pointerEvents="none">
          <View style={{ opacity: art.locked ? 0.45 : 1 }}>
            <Icon size={iconSize} color={art.accent} strokeWidth={2} />
          </View>
          <Text style={[styles.label, { color: art.accent, fontSize: labelSize }]} numberOfLines={1}>
            {stamp.label}
          </Text>
          {art.captionText ? (
            <Text style={[styles.caption, { color: art.accent, fontSize: captionSize }]} numberOfLines={1}>
              {art.captionText}
            </Text>
          ) : null}
          {stamp.sublabel ? (
            <Text style={[styles.sublabel, { color: art.accent, fontSize: sublabelSize }]} numberOfLines={1}>
              {stamp.sublabel}
            </Text>
          ) : null}
        </View>

        {/* Shimmer sweep */}
        {art.hasShimmer && (
          <Animated.View
            style={[
              styles.shimmer,
              { width: size * 0.5, transform: [{ translateX: shimmerTranslate }, { skewX: '-18deg' }] },
            ]}
            pointerEvents="none"
          />
        )}

        {/* Lock overlay */}
        {art.locked && (
          <View style={styles.lockOverlay} pointerEvents="none">
            <Lock size={iconSize * 0.85} color="#9CA3AF" strokeWidth={1.8} />
          </View>
        )}
      </View>

      {/* Rarity badge */}
      <View style={[styles.rarityBadge, { backgroundColor: rarityColor + '22', borderColor: rarityColor + '55' }]}>
        <View style={[styles.rarityDot, { backgroundColor: rarityColor }]} />
        <Text style={[styles.rarityText, { color: rarityColor }]}>{rarityLabel}</Text>
      </View>

      {/* Locked message */}
      {art.locked && (
        <Text style={styles.lockedMsg}>Keep traveling to unlock</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: space.sm,
  },
  glowRing: {
    position: 'absolute',
    borderWidth: 3,
    top: -12,
    left: -12,
  },
  content: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 10,
  },
  label: {
    fontFamily: 'Courier',
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 1,
  },
  caption: {
    fontFamily: 'Courier',
    textAlign: 'center',
    letterSpacing: 0.6,
    opacity: 0.85,
  },
  sublabel: {
    fontFamily: 'Courier',
    textAlign: 'center',
    opacity: 0.7,
    letterSpacing: 0.4,
  },
  shimmer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.20)',
  },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.52)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rarityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  rarityDot: {
    width: dot.s6,
    height: dot.s6,
    borderRadius: dot.s6 / 2,
  },
  rarityText: {
    fontFamily: 'Courier',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  lockedMsg: {
    fontFamily: 'Courier',
    fontSize: 11,
    color: color.faint,
    textAlign: 'center',
    letterSpacing: 0.4,
  },
});
