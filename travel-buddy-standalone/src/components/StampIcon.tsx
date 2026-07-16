/**
 * StampIcon — compact stamp badge for use in feeds, lists, and chips.
 * Size range: 24–60px. Uses a simple round/oval border, lucide icon.
 * No shimmer (too small). Locked → grayscale + dim opacity.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import {
  MapPin, Users, Gem, ShieldCheck, Crown, Ticket,
  Lock, Sparkles,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import type { PassportStamp } from '../types/models';
import { resolveArtwork } from '../lib/stampArtworkResolver';

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const ICON_MAP: Record<string, IconCmp> = {
  MapPin, Users, Gem, ShieldCheck, Crown, Ticket, Sparkles,
};

function resolveIcon(key: string): IconCmp {
  return ICON_MAP[key] ?? MapPin;
}

interface StampIconProps {
  stamp: PassportStamp;
  size?: number;
}

export function StampIcon({ stamp, size = 40 }: StampIconProps) {
  const art = resolveArtwork(stamp);
  const Icon = resolveIcon(art.iconKey);
  const iconSize = Math.round(size * 0.38);
  const borderRadius = art.shape === 'round' || art.shape === 'oval' ? size / 2 : size * 0.15;
  const borderWidth = Math.max(1, art.borderWeight);

  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius,
          borderWidth,
          borderColor: art.accent,
          backgroundColor: art.background,
          opacity: art.locked ? 0.55 : 1,
        },
      ]}
      accessible
      accessibilityLabel={art.accessibilityLabel}
      accessibilityRole="image"
    >
      <Icon size={iconSize} color={art.accent} strokeWidth={2.2} />
      {art.locked && (
        <View style={[styles.lockOverlay, { borderRadius }]}>
          <Lock size={iconSize * 0.7} color="#6B7280" strokeWidth={2} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    borderStyle: 'solid',
  },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
