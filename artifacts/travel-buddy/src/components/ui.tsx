import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ViewStyle,
  StyleProp,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { color, space, radius, type as t } from '../theme/tokens.ts';

/** Passport-stamp tag: monospace, uppercased, slightly rotated. The signature device. */
export function Stamp({
  label,
  tone = 'ink',
  rotate = -3,
  style,
}: {
  label: string;
  tone?: 'ink' | 'signal' | 'deep' | 'onInk';
  rotate?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const border =
    tone === 'signal' ? color.signal : tone === 'deep' ? color.deep : tone === 'onInk' ? color.onInk : color.ink;
  const ink = border;
  return (
    <View
      style={[
        styles.stamp,
        { borderColor: border, transform: [{ rotate: `${rotate}deg` }] },
        style,
      ]}
    >
      <Text style={[styles.stampText, { color: ink }]} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

/** Soft pill chip for filters / categories (non-stamp, quieter). */
export function Chip({
  label,
  active,
  count,
  onPress,
}: {
  label: string;
  active?: boolean;
  /** When provided, appends "· N" after the label. 0 dims the chip. */
  count?: number;
  onPress?: () => void;
}) {
  const isEmpty = count !== undefined && count === 0;
  const displayLabel = count !== undefined && count > 0 ? `${label} · ${count}` : label;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive, isEmpty && styles.chipEmpty]}
      accessibilityRole="button"
    >
      <Text style={[styles.chipText, active && styles.chipTextActive, isEmpty && styles.chipTextEmpty]}>
        {displayLabel}
      </Text>
    </Pressable>
  );
}

import { CachedImage, withStorageParams } from './CachedImage.tsx';

export function Avatar({ uri, size = 36 }: { uri: string; size?: number }) {
  return (
    <CachedImage
      source={{ uri: withStorageParams(uri, 'width=100&quality=80') }}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.haze }}
    />
  );
}

/** Bottom-up gradient scrim — readability rule for any text-over-image. */
export function Scrim({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <LinearGradient
      colors={[color.scrimTop, color.scrimBottom]}
      locations={[0.35, 1]}
      style={[StyleSheet.absoluteFill, style]}
      pointerEvents="none"
    />
  );
}

/** brightness > 0.62 means overlay text won't hold contrast -> use caption-below fallback. */
export function needsContrastFallback(brightness?: number) {
  return (brightness ?? 0) > 0.62;
}

const styles = StyleSheet.create({
  stamp: {
    borderWidth: 1.5,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    backgroundColor: 'transparent',
  },
  stampText: { ...t.stamp, fontFamily: 'Courier' },
  chip: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  chipActive: { backgroundColor: color.ink, borderColor: color.ink },
  chipEmpty: { opacity: 0.45 },
  chipText: { ...t.small, fontWeight: '600', color: color.ink },
  chipTextActive: { color: color.onInk },
  chipTextEmpty: { color: color.mute },
});
